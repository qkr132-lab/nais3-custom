import { readFileSync } from 'fs'
import { join } from 'path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { blendRegions, renderCensored } from '../src/main/censor/apply'
import { copyPngText, pickNaiExif } from '../src/main/censor/meta-copy'
import { metadataFromImage, metadataFromWebp } from '../src/main/images/metadata'

/**
 * 검열본 출력 — 가린 영역 밖은 그대로, NAI 메타데이터는 옮기고 썸네일은 버린다.
 * 원본 EXIF에 안 가린 미리보기 썸네일(IFD1)이 들어 있으면 검열본에 따라가면 안 된다.
 */

const THUMB = Buffer.from('UNCENSORED-THUMBNAIL-BYTES')

function crc32(buf: Buffer): number {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
  }
  return ~c >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** TIFF(II·MM)의 IFD0 뒤에 썸네일 IFD1을 붙인다 */
function withThumbnail(tiff: Buffer): Buffer {
  const le = tiff.toString('latin1', 0, 2) === 'II'
  const u16 = (b: Buffer, o: number): number => (le ? b.readUInt16LE(o) : b.readUInt16BE(o))
  const u32 = (b: Buffer, o: number): number => (le ? b.readUInt32LE(o) : b.readUInt32BE(o))
  const w16 = (b: Buffer, v: number, o: number): void => {
    if (le) b.writeUInt16LE(v, o)
    else b.writeUInt16BE(v, o)
  }
  const w32 = (b: Buffer, v: number, o: number): void => {
    if (le) b.writeUInt32LE(v, o)
    else b.writeUInt32BE(v, o)
  }
  const first = u32(tiff, 4)
  const n = u16(tiff, first)
  const ifd1At = tiff.length + (tiff.length % 2)
  const thumbAt = ifd1At + 2 + 2 * 12 + 4
  const ifd1 = Buffer.alloc(2 + 2 * 12 + 4)
  w16(ifd1, 2, 0)
  w16(ifd1, 513, 2) // JPEGInterchangeFormat
  w16(ifd1, 4, 4)
  w32(ifd1, 1, 6)
  w32(ifd1, thumbAt, 10)
  w16(ifd1, 514, 14) // JPEGInterchangeFormatLength
  w16(ifd1, 4, 16)
  w32(ifd1, 1, 18)
  w32(ifd1, THUMB.length, 22)
  const out = Buffer.concat([tiff, Buffer.alloc(ifd1At - tiff.length), ifd1, THUMB])
  w32(out, ifd1At, first + 2 + n * 12)
  return out
}

function webpChunks(buf: Buffer): { fourcc: string; data: Buffer }[] {
  const out: { fourcc: string; data: Buffer }[] = []
  let p = 12
  while (p + 8 <= buf.length) {
    const size = buf.readUInt32LE(p + 4)
    out.push({ fourcc: buf.toString('latin1', p, p + 4), data: buf.subarray(p + 8, p + 8 + size) })
    p += 8 + size + (size % 2)
  }
  return out
}

function riff(chunks: { fourcc: string; data: Buffer }[]): Buffer {
  const body = chunks.map((c) => {
    const head = Buffer.alloc(8)
    head.write(c.fourcc, 0, 'latin1')
    head.writeUInt32LE(c.data.length, 4)
    return Buffer.concat([head, c.data, Buffer.alloc(c.data.length % 2)])
  })
  const payload = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...body])
  const head = Buffer.alloc(8)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(payload.length, 4)
  return Buffer.concat([head, payload])
}

/** 실제 V5 fixture의 EXIF(썸네일 추가)를 64×64 WebP에 싣는다 */
async function naiWebp(): Promise<Buffer> {
  const fixture = readFileSync(join(__dirname, 'fixtures', 'v5', 'v5-qt-standard.webp'))
  const exif = webpChunks(fixture).find((c) => c.fourcc === 'EXIF')!.data
  const img = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 120, b: 80 } }
  })
    .webp({ quality: 95 })
    .toBuffer()
  const vp8x = Buffer.alloc(10)
  vp8x[0] = 0x08
  vp8x.writeUIntLE(63, 4, 3)
  vp8x.writeUIntLE(63, 7, 3)
  return riff([
    { fourcc: 'VP8X', data: vp8x },
    ...webpChunks(img).filter((c) => c.fourcc !== 'VP8X'),
    { fourcc: 'EXIF', data: withThumbnail(Buffer.from(exif)) }
  ])
}

async function naiPng(): Promise<Buffer> {
  const png = await sharp({
    create: { width: 64, height: 64, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } }
  })
    .png()
    .toBuffer()
  const comment = JSON.stringify({ prompt: 'sample prompt', uc: 'lowres', steps: 23, seed: 7 })
  const text = (k: string, v: string): Buffer =>
    pngChunk('tEXt', Buffer.concat([Buffer.from(k, 'latin1'), Buffer.alloc(1), Buffer.from(v)]))
  // eXIf에 썸네일을 넣은 원본
  const exif = withThumbnail(Buffer.from('49492a000800000000000000', 'hex'))
  const at = png.indexOf(Buffer.from('IDAT')) - 4
  return Buffer.concat([
    png.subarray(0, at),
    text('Software', 'NovelAI'),
    text('Comment', comment),
    pngChunk('eXIf', exif),
    png.subarray(at)
  ])
}

const REGION = [{ x0: 16, y0: 16, x1: 48, y1: 48 }]

describe('검열본 메타데이터', () => {
  it('WebP: NAI 파라미터는 남고 썸네일(IFD1)은 빠진다', async () => {
    const original = await naiWebp()
    expect(original.includes(THUMB)).toBe(true)
    const before = metadataFromWebp(original)!
    const out = await renderCensored(original, REGION, 'black', 8)
    expect(out.includes(THUMB)).toBe(false)
    const after = metadataFromWebp(out)!
    expect(after).not.toBeNull()
    expect(after.prompt).toBe(before.prompt)
    expect(after.seed).toBe(before.seed)
    expect(after.software).toBe(before.software)
    // 새 EXIF는 다음 IFD가 없다
    const exif = webpChunks(out).find((c) => c.fourcc === 'EXIF')!.data
    const first = exif.readUInt32LE(4)
    expect(exif.readUInt32LE(first + 2 + exif.readUInt16LE(first) * 12)).toBe(0)
    // 그림은 제대로 읽힌다
    const meta = await sharp(out).metadata()
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 64, 64])
  })

  it('PNG: 텍스트 청크만 옮기고 eXIf는 버린다', async () => {
    const original = await naiPng()
    const out = await renderCensored(original, REGION, 'mosaic', 8)
    expect(out.includes(THUMB)).toBe(false)
    expect(out.includes(Buffer.from('eXIf'))).toBe(false)
    const meta = await metadataFromImage(out)
    expect(meta?.prompt).toBe('sample prompt')
    expect(meta?.seed).toBe(7)
  })

  it('pickNaiExif는 고른 항목이 없으면 null', () => {
    expect(pickNaiExif(Buffer.from('49492a000800000000000000', 'hex'))).toBeNull()
    expect(pickNaiExif(Buffer.from('not a tiff'))).toBeNull()
  })

  it('copyPngText는 PNG가 아니면 그대로 돌려준다', () => {
    const b = Buffer.from('plain')
    expect(copyPngText(b, b)).toBe(b)
  })
})

describe('검열본 픽셀', () => {
  it('영역 밖 픽셀·알파는 원본 그대로 (PNG 무손실)', async () => {
    const w = 64
    const raw = Buffer.alloc(w * w * 4)
    for (let i = 0; i < w * w; i++) {
      raw[i * 4] = i % 251
      raw[i * 4 + 1] = (i * 7) % 253
      raw[i * 4 + 2] = (i * 13) % 255
      raw[i * 4 + 3] = 40 + (i % 200) // 반투명 섞음
    }
    const png = await sharp(raw, { raw: { width: w, height: w, channels: 4 } })
      .png()
      .toBuffer()
    const out = await renderCensored(png, REGION, 'black', 8)
    const got = await sharp(out).raw().toBuffer()
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4
        const inBox = x >= 16 && x < 48 && y >= 16 && y < 48
        // 알파는 어디든 원본 그대로
        expect(got[o + 3]).toBe(raw[o + 3])
        if (inBox) expect([got[o], got[o + 1], got[o + 2]]).toEqual([0, 0, 0])
        else expect([got[o], got[o + 1], got[o + 2]]).toEqual([raw[o], raw[o + 1], raw[o + 2]])
      }
    }
  })

  it('blendRegions는 넓힌 영역+가장자리 밖을 건드리지 않는다', () => {
    const w = 100
    const h = 60
    const data = Buffer.alloc(w * h * 4, 10)
    const result = Buffer.alloc(w * h * 3, 250)
    blendRegions(
      { data, width: w, height: h, channels: 4 },
      result,
      [{ x0: 40, y0: 20, x1: 60, y1: 40 }],
      4,
      6
    )
    const px = (x: number, y: number): number => data[(y * w + x) * 4]
    expect(px(50, 30)).toBe(250) // 안쪽 = 결과
    expect(px(36, 30)).toBe(250) // grow 4 안
    expect(px(33, 30)).toBeGreaterThan(10) // 가장자리 섞임
    expect(px(33, 30)).toBeLessThan(250)
    expect(px(29, 30)).toBe(10) // grow+feather 밖 = 원본
    expect(px(5, 5)).toBe(10)
    // 알파는 안 바뀐다
    for (let i = 3; i < data.length; i += 4) expect(data[i]).toBe(10)
  })
})
