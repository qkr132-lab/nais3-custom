import { gunzipSync, inflateSync } from 'zlib'
import sharp from 'sharp'
import type { ImageMetadata } from '../../shared/types'
import {
  QUALITY_TAGS_SUFFIX,
  UC_PRESETS_V45_FULL,
  UC_PRESETS_V45_WEB_FULL
} from '../../shared/nai-presets'

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const STEALTH_MAGIC = 'stealth_pngcomp'
const LOCAL_PARAM_KEYS = ['nais3-params', 'nais2-params']

/** PNG tEXt/zTXt/iTXt 청크에서 keyword→text 추출 */
function parsePngTextChunks(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return out
  let off = 8
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const dataStart = off + 8
    const dataEnd = dataStart + len
    if (dataEnd > buf.length) break
    const data = buf.subarray(dataStart, dataEnd)
    try {
      if (type === 'tEXt') {
        const nul = data.indexOf(0)
        if (nul >= 0) out[data.toString('latin1', 0, nul)] = data.toString('latin1', nul + 1)
      } else if (type === 'zTXt') {
        const nul = data.indexOf(0)
        if (nul >= 0) {
          const key = data.toString('latin1', 0, nul)
          // data[nul+1] = compression method(0=zlib), 이후 압축 텍스트
          out[key] = inflateSync(data.subarray(nul + 2)).toString('latin1')
        }
      } else if (type === 'iTXt') {
        const nul = data.indexOf(0)
        if (nul >= 0) {
          const key = data.toString('latin1', 0, nul)
          const compFlag = data[nul + 1]
          // nul+3부터 lang\0translated\0text
          let p = nul + 3
          const langEnd = data.indexOf(0, p)
          p = langEnd + 1
          const transEnd = data.indexOf(0, p)
          p = transEnd + 1
          const textBuf = data.subarray(p)
          out[key] =
            compFlag === 1 ? inflateSync(textBuf).toString('utf8') : textBuf.toString('utf8')
        }
      } else if (type === 'IEND') {
        break
      }
    } catch {
      // 개별 청크 파싱 실패는 무시
    }
    off = dataEnd + 4 // + CRC
  }
  return out
}

/** RIFF 청크를 훑어 EXIF 청크 페이로드(TIFF 헤더로 시작)를 꺼낸다 */
function webpExifChunk(buf: Buffer): Buffer | null {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF') return null
  if (buf.toString('ascii', 8, 12) !== 'WEBP') return null
  let off = 12
  while (off + 8 <= buf.length) {
    const type = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (off + 8 + size > buf.length) break
    if (type === 'EXIF') return buf.subarray(off + 8, off + 8 + size)
    off += 8 + size + (size % 2) // 청크는 짝수 정렬
  }
  return null
}

/** TIFF 타입별 바이트 크기 (1=BYTE … 12=DOUBLE) */
const TIFF_TYPE_SIZE: Record<number, number> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  6: 1,
  7: 1,
  8: 2,
  9: 4,
  10: 8,
  11: 4,
  12: 8
}

const TIFF_TAGS: Record<number, string> = {
  0x010e: 'ImageDescription',
  0x0131: 'Software',
  0x9286: 'UserComment'
}

/** WebP EXIF에서 필요한 문자열 태그만 뽑는다 (ExifIFD 1단계까지) */
function parseWebpExifTags(buf: Buffer): Record<string, string> | null {
  const e = webpExifChunk(buf)
  if (!e || e.length < 8) return null
  const order = e.toString('ascii', 0, 2)
  if (order !== 'II' && order !== 'MM') return null
  const le = order === 'II'
  const u16 = (o: number): number => (le ? e.readUInt16LE(o) : e.readUInt16BE(o))
  const u32 = (o: number): number => (le ? e.readUInt32LE(o) : e.readUInt32BE(o))

  const out: Record<string, string> = {}
  const walk = (ifdOffset: number, depth: number): void => {
    if (depth > 2 || ifdOffset <= 0 || ifdOffset + 2 > e.length) return
    const count = u16(ifdOffset)
    for (let i = 0; i < count; i++) {
      const p = ifdOffset + 2 + i * 12
      if (p + 12 > e.length) break
      const tag = u16(p)
      const type = u16(p + 2)
      const size = (TIFF_TYPE_SIZE[type] ?? 1) * u32(p + 4)
      // ExifIFD 포인터: 값 자리에 하위 IFD 오프셋이 들어 있다
      if (tag === 0x8769) {
        walk(u32(p + 8), depth + 1)
        continue
      }
      const name = TIFF_TAGS[tag]
      if (!name) continue
      const valueOffset = size > 4 ? u32(p + 8) : p + 8
      if (valueOffset + size > e.length) continue
      const raw = e.subarray(valueOffset, valueOffset + size)
      if (type === 2) {
        out[name] = raw.toString('utf8').replace(/\0+$/, '')
      } else if (type === 7) {
        // UNDEFINED: 앞 8바이트가 인코딩 표기(ASCII\0\0\0 / UNICODE\0)
        const head = raw.subarray(0, 8).toString('ascii')
        if (head.startsWith('UNICODE')) {
          out[name] = Buffer.from(raw.subarray(8)).swap16().toString('utf16le')
        } else {
          const body = head.startsWith('ASCII') ? raw.subarray(8) : raw
          out[name] = body.toString('utf8').replace(/\0+$/, '')
        }
      }
    }
    const nextOffset = ifdOffset + 2 + count * 12
    if (nextOffset + 4 <= e.length) {
      const next = u32(nextOffset)
      if (next > 0 && next < e.length) walk(next, depth + 1)
    }
  }
  walk(u32(4), 0)
  return Object.keys(out).length ? out : null
}

/** stealth 메타데이터 (알파 채널 LSB, column-major, magic + gzip JSON) */
async function extractStealthComment(buf: Buffer): Promise<Record<string, unknown> | null> {
  try {
    const { data, info } = await sharp(buf)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const { width, height, channels } = info
    const total = width * height
    const bytes = new Uint8Array(Math.ceil(total / 8))
    let bitIdx = 0
    // column-major 알파 LSB → MSB-first 패킹 (np.packbits와 동일)
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        const a = data[(y * width + x) * channels + 3] & 1
        if (a) bytes[bitIdx >> 3] |= 1 << (7 - (bitIdx & 7))
        bitIdx++
      }
    }
    const magic = Buffer.from(STEALTH_MAGIC, 'ascii')
    for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic[i]) return null
    let off = magic.length
    const lengthBits =
      (bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]
    off += 4
    const lengthBytes = Math.ceil(lengthBits / 8)
    const compressed = Buffer.from(bytes.slice(off, off + lengthBytes))
    const json = JSON.parse(gunzipSync(compressed).toString('utf8')) as Record<string, unknown>
    if (typeof json.Comment === 'string') json.Comment = JSON.parse(json.Comment)
    return json
  } catch {
    return null
  }
}

interface Params {
  steps?: number
  scale?: number
  cfg_rescale?: number
  sampler?: string
  noise_schedule?: string
  seed?: number
  width?: number
  height?: number
  skip_cfg_above_sigma?: number | null
  negative_prompt?: string
  ucPreset?: number
  qualityToggle?: boolean
  use_coords?: boolean
  v4_prompt?: {
    use_coords?: boolean
    caption?: { char_captions?: { char_caption?: string; centers?: { x: number; y: number }[] }[] }
  }
  v4_negative_prompt?: { caption?: { char_captions?: { char_caption?: string }[] } }
}

interface LocalParams {
  promptParts?: ImageMetadata['promptParts']
  fragmentPrompts?: ImageMetadata['fragmentPrompts']
}

function parseLocalParams(text: Record<string, string>): LocalParams | undefined {
  for (const key of LOCAL_PARAM_KEYS) {
    const raw = text[key]
    if (!raw) continue
    try {
      return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as LocalParams
    } catch {
      try {
        return JSON.parse(raw) as LocalParams
      } catch {
        // 다음 후보 확인
      }
    }
  }
  return undefined
}

/** 병합된 네거티브에서 UC 프리셋 인덱스 역추적 (프리셋 텍스트가 접두인 것 중 가장 긴 것) */
function inferUcPreset(uc: string): number | undefined {
  let best: number | undefined
  let bestLen = -1
  for (const [k, preset] of Object.entries(UC_PRESETS_V45_FULL)) {
    const candidates = [
      preset,
      UC_PRESETS_V45_WEB_FULL[Number(k) as keyof typeof UC_PRESETS_V45_WEB_FULL]
    ]
    for (const candidate of new Set(candidates)) {
      if (!candidate) continue
      if ((uc === candidate || uc.startsWith(candidate + ', ')) && candidate.length > bestLen) {
        best = Number(k)
        bestLen = candidate.length
      }
    }
  }
  return best
}

/** 파라미터 객체 + 프롬프트/모델 → 정규화 메타 */
function normalize(
  params: Params,
  extra: { prompt: string; uc: string; model?: string; software?: string; local?: LocalParams }
): ImageMetadata {
  const posChars = params.v4_prompt?.caption?.char_captions ?? []
  const negChars = params.v4_negative_prompt?.caption?.char_captions ?? []
  const characterPrompts = posChars.map((c, i) => ({
    prompt: c?.char_caption ?? '',
    negativePrompt: negChars[i]?.char_caption ?? '',
    center: c?.centers?.[0]
  }))
  return {
    prompt: extra.prompt,
    promptParts: extra.local?.promptParts,
    fragmentPrompts: extra.local?.fragmentPrompts,
    negativePrompt: extra.uc,
    seed: params.seed,
    steps: params.steps,
    cfgScale: params.scale,
    cfgRescale: params.cfg_rescale,
    sampler: params.sampler,
    noiseSchedule: params.noise_schedule,
    width: params.width,
    height: params.height,
    model: extra.model,
    software: extra.software,
    variety: params.skip_cfg_above_sigma != null,
    useCoords: params.v4_prompt?.use_coords ?? params.use_coords ?? false,
    // ucPreset·qualityToggle: 직접 필드 우선, 없으면 병합 문자열에서 역추적
    qualityToggle: params.qualityToggle ?? extra.prompt.endsWith(QUALITY_TAGS_SUFFIX),
    ucPreset: params.ucPreset ?? inferUcPreset(extra.uc),
    characterPrompts: characterPrompts.length > 0 ? characterPrompts : undefined
  }
}

/** 우리 payload_json({input, model, parameters}) → 정규화 메타 */
export function metadataFromPayloadJson(json: string): ImageMetadata | null {
  try {
    const p = JSON.parse(json) as {
      input?: string
      model?: string
      parameters?: Params
      nais3?: LocalParams
    }
    if (!p.parameters) return null
    return normalize(p.parameters, {
      prompt: p.input ?? '',
      uc: p.parameters.negative_prompt ?? '',
      model: p.model,
      software: 'NAIS3',
      local: p.nais3
    })
  } catch {
    return null
  }
}

/**
 * WebP 버퍼 → 정규화 메타. 없으면 null.
 *
 * NAI가 webp로 내보낸 이미지는 PNG의 tEXt 대신 **EXIF UserComment**(0x9286)에
 * `{"Comment":"{...파라미터 JSON...}"}`를 넣는다. Software(0x0131)에 모델명
 * ("NovelAI Diffusion V5 0ADF9AB7"), ImageDescription(0x010E)에 프롬프트가 들어간다.
 * 실측: tests/fixtures/v5/ 4장 + 사용자 라이브러리 V4.5 webp (2026-08-21).
 */
export function metadataFromWebp(buf: Buffer): ImageMetadata | null {
  const tags = parseWebpExifTags(buf)
  if (!tags) return null
  let comment: Params | null = null
  if (tags.UserComment) {
    try {
      const outer = JSON.parse(tags.UserComment) as { Comment?: string }
      comment = (typeof outer.Comment === 'string' ? JSON.parse(outer.Comment) : outer) as Params
    } catch {
      comment = null
    }
  }
  if (!comment) return null
  const c = comment as Params & { prompt?: string; uc?: string; model_name?: string }
  return normalize(comment, {
    prompt: c.prompt ?? tags.ImageDescription ?? '',
    uc: c.uc ?? '',
    model: c.model_name ?? tags.Software,
    software: tags.Software
  })
}

/** 확장자와 무관하게 시그니처로 판별 (PNG / WebP) */
export async function metadataFromImage(buf: Buffer): Promise<ImageMetadata | null> {
  if (buf.length >= 12 && buf.toString('ascii', 8, 12) === 'WEBP') return metadataFromWebp(buf)
  return metadataFromPng(buf)
}

/** PNG 버퍼 → 정규화 메타 (tEXt Comment → stealth 폴백). 없으면 null */
export async function metadataFromPng(buf: Buffer): Promise<ImageMetadata | null> {
  const text = parsePngTextChunks(buf)
  const local = parseLocalParams(text)
  let comment: Params | null = null
  let extra = {
    software: text.Software,
    model: text.Source,
    description: text.Description
  }
  if (text.Comment) {
    try {
      comment = JSON.parse(text.Comment) as Params
    } catch {
      comment = null
    }
  }
  if (!comment) {
    const stealth = await extractStealthComment(buf)
    if (stealth) {
      comment = (stealth.Comment as Params) ?? (stealth as Params)
      if (typeof stealth.Software === 'string') extra = { ...extra, software: stealth.Software }
      if (typeof stealth.Source === 'string') extra = { ...extra, model: stealth.Source }
    }
  }
  if (!comment) return null
  const c = comment as Params & { prompt?: string; uc?: string }
  return normalize(comment, {
    prompt: c.prompt ?? extra.description ?? '',
    uc: c.uc ?? '',
    model: extra.model,
    software: extra.software,
    local
  })
}
