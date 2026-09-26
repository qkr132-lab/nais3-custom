import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import sharp from 'sharp'
import { fillRegion, pixelateRegion, type Box } from '../../shared/censor'
import { copyPngText, copyWebpExif } from './meta-copy'

export type CensorPaint = 'mosaic' | 'black' | 'white'

interface Raw {
  data: Buffer
  width: number
  height: number
  channels: number
}

async function decode(input: Buffer): Promise<Raw & { format: string | undefined }> {
  const format = (await sharp(input, { failOn: 'none' }).metadata()).format
  const { data, info } = await sharp(input, { failOn: 'none' })
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height, channels: info.channels, format }
}

/**
 * 원본과 같은 형식으로 다시 쓰고 NAI 메타데이터만 옮긴다 (썸네일 등 나머지는 버림 — meta-copy).
 * PNG는 무손실이라 영역 밖 픽셀이 원본 그대로, WebP·JPEG는 다시 압축된다.
 */
async function encode(original: Buffer, raw: Raw, format: string | undefined): Promise<Buffer> {
  const pipe = sharp(raw.data, {
    raw: { width: raw.width, height: raw.height, channels: raw.channels as 1 | 2 | 3 | 4 }
  })
  if (format === 'webp') {
    const out = await pipe.webp({ quality: 95 }).toBuffer()
    return copyWebpExif(original, out, raw.width, raw.height, raw.channels === 4)
  }
  if (format === 'jpeg') return pipe.jpeg({ quality: 95 }).toBuffer()
  const out = await pipe.png({ compressionLevel: 6 }).toBuffer()
  return format === 'png' ? copyPngText(original, out) : out
}

/**
 * 가린 그림 — 픽셀을 직접 고친다(모자이크 칸 평균·단색). RGB만 바꾸고 알파는 그대로라
 * 반투명 픽셀 아래로 원본이 비치지 않는다.
 */
export async function renderCensored(
  input: string | Buffer,
  regions: Box[],
  paint: CensorPaint,
  block: number
): Promise<Buffer> {
  const original = Buffer.isBuffer(input) ? input : readFileSync(input)
  const raw = await decode(original)
  for (const r of regions) {
    if (paint === 'mosaic') pixelateRegion(raw.data, raw.width, raw.height, raw.channels, r, block)
    else
      fillRegion(
        raw.data,
        raw.width,
        raw.height,
        raw.channels,
        r,
        paint === 'black' ? [0, 0, 0] : [255, 255, 255]
      )
  }
  return encode(original, raw, raw.format)
}

/** 임시 파일에 쓰고 이름을 바꿔, 끊겨도 반쯤 쓴 파일이 남지 않게 */
export function writeAtomic(dest: string, data: Buffer): void {
  const temp = `${dest}.part`
  try {
    writeFileSync(temp, data)
    renameSync(temp, dest)
  } finally {
    rmSync(temp, { force: true })
  }
}

export async function writeCensored(
  input: string,
  output: string,
  regions: Box[],
  paint: CensorPaint,
  block: number
): Promise<void> {
  writeAtomic(output, await renderCensored(input, regions, paint, block))
}

/**
 * NAI 결과를 가린 영역에만 섞는다 — 영역을 grow만큼 넓히고 가장자리를 feather 픽셀에 걸쳐
 * 부드럽게. 영역 밖은 원본 픽셀 그대로, 알파도 원본 그대로.
 */
export function blendRegions(
  original: Raw,
  result: Buffer,
  regions: Box[],
  grow = 16,
  feather = 12
): void {
  const { data, width, height, channels } = original
  const color = Math.min(3, channels)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // 가장 가까운 영역 안쪽까지의 거리로 섞는 비율을 정한다
      let a = 0
      for (const r of regions) {
        const x0 = r.x0 - grow
        const y0 = r.y0 - grow
        const x1 = r.x1 + grow
        const y1 = r.y1 + grow
        if (x < x0 - feather || x >= x1 + feather || y < y0 - feather || y >= y1 + feather) continue
        const dx = Math.max(x0 - x, 0, x - (x1 - 1))
        const dy = Math.max(y0 - y, 0, y - (y1 - 1))
        const d = Math.max(dx, dy)
        a = Math.max(a, d === 0 ? 1 : Math.max(0, 1 - d / feather))
        if (a === 1) break
      }
      if (a === 0) continue
      const o = (y * width + x) * channels
      const s = (y * width + x) * 3
      for (let c = 0; c < color; c++)
        data[o + c] = Math.round(data[o + c] * (1 - a) + result[s + c] * a)
    }
  }
}

/** NAI 결과(PNG)를 원본에 영역만 붙여, 원본 형식·메타데이터로 */
export async function pasteNaiResult(
  input: string,
  resultPng: Buffer,
  regions: Box[]
): Promise<Buffer> {
  const original = readFileSync(input)
  const raw = await decode(original)
  const res = await sharp(resultPng)
    .resize(raw.width, raw.height, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer()
  blendRegions(raw, res, regions)
  return encode(original, raw, raw.format)
}

/** 미리보기용 — 긴 변 maxSide의 JPEG data URL */
export async function previewDataUrl(image: string | Buffer, maxSide = 900): Promise<string> {
  const jpg = await sharp(image, { failOn: 'none' })
    .resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 85 })
    .toBuffer()
  return `data:image/jpeg;base64,${jpg.toString('base64')}`
}
