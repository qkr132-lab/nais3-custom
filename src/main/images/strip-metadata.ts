import sharp from 'sharp'
import { crc32, deflateSync, inflateSync } from 'zlib'

/**
 * 이미지 파일에서 생성 메타데이터(프롬프트·시드 등)를 무손실로 걷어낸다.
 * 색 데이터는 다시 인코딩하지 않고 메타데이터 청크만 빼서 이어 붙인다.
 * - PNG: tEXt / iTXt / zTXt / eXIf 청크 제거 (IHDR·PLTE·tRNS·IDAT·IEND·색 청크는 그대로)
 *   알파 LSB에 숨은 stealth 정보가 있으면 그 비트만 지운 IDAT로 바꾼다 (RGB는 그대로)
 * - WebP: EXIF / XMP 청크 제거 + VP8X 플래그 비트 끄기 + RIFF 크기 보정
 *   NAI WebP는 알파 LSB에도 stealth 정보를 숨긴다 — 있으면 알파 LSB만 지운다
 *   · 손실(VP8X+ALPH+VP8): ALPH 청크만 새로 만든다 (VP8 색 청크는 바이트 그대로)
 *   · 무손실(VP8L, 알파가 색과 한 덩어리): VP8L을 무손실로 다시 압축한다 (보이는 색은 그대로)
 * - 그 밖의 포맷이나 구조가 깨진 파일은 손대지 않고 그대로 돌려준다.
 * WebP 알파를 읽고 다시 압축하는 데 sharp(libwebp)가 필요해 비동기다.
 */

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_DROP = new Set(['tEXt', 'iTXt', 'zTXt', 'eXIf'])
const WEBP_DROP = new Set(['EXIF', 'XMP '])
// VP8X 플래그 바이트: Rsv(2) ICC(1) Alpha(1) EXIF(1) XMP(1) Anim(1) R(1) — 상위 비트부터
const VP8X_EXIF_FLAG = 0x08
const VP8X_XMP_FLAG = 0x04
// ALPH 헤더 바이트: Rsv(2) 전처리(2) 필터(2) 압축(2) — 전처리·필터 없음 + 압축 1(VP8L) / 0(비압축)
const ALPH_LOSSLESS = 0x01
const ALPH_RAW = 0x00
// 알파 LSB stealth 매직 (압축 / 비압축) — 둘 다 15바이트
const STEALTH_MAGICS = ['stealth_pngcomp', 'stealth_pnginfo'].map((m) => Buffer.from(m, 'ascii'))
const STEALTH_MAGIC_BITS = 15 * 8

export async function stripImageMetadata(buf: Buffer): Promise<Buffer> {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return stripPng(buf)
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  )
    return clearWebpStealthAlpha(stripWebp(buf))
  return buf
}

interface PngChunk {
  type: string
  bytes: Buffer // 길이·타입·데이터·CRC 전체
}

function stripPng(buf: Buffer): Buffer {
  const chunks: PngChunk[] = []
  let dropped = false
  let sawEnd = false
  let off = 8
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const end = off + 12 + len // 길이(4) + 타입(4) + 데이터 + CRC(4)
    if (end > buf.length) return buf // 잘린 청크 — 건드리지 않음
    const type = buf.toString('ascii', off + 4, off + 8)
    if (PNG_DROP.has(type)) dropped = true
    else chunks.push({ type, bytes: buf.subarray(off, end) })
    off = end
    if (type === 'IEND') {
      sawEnd = true
      break
    }
  }
  if (!sawEnd && off !== buf.length) return buf // 청크 경계가 안 맞는 꼬리 — 건드리지 않음
  const idat = clearStealthAlpha(chunks)
  if (!dropped && !idat) return buf
  // 걷어낼 게 있으면 IEND까지만 이어 붙인다 (IEND 뒤 덧붙은 바이트도 버림)
  const parts: Buffer[] = [buf.subarray(0, 8)]
  let idatDone = false
  for (const c of chunks) {
    if (idat && c.type === 'IDAT') {
      // 새 IDAT 하나를 첫 IDAT 자리에 넣고 나머지 조각은 버린다
      if (!idatDone) parts.push(idat)
      idatDone = true
    } else parts.push(c.bytes)
  }
  return Buffer.concat(parts)
}

/** PNG 필터 예측값 (a=왼쪽, b=위, c=왼쪽 위) */
function predict(filter: number, a: number, b: number, c: number): number {
  switch (filter) {
    case 1:
      return a
    case 2:
      return b
    case 3:
      return (a + b) >> 1
    case 4: {
      const p = a + b - c
      const pa = Math.abs(p - a)
      const pb = Math.abs(p - b)
      const pc = Math.abs(p - c)
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
    }
    default:
      return 0
  }
}

/**
 * NAI PNG는 텍스트 청크와 따로 알파 채널 최하위 비트(column-major)에도 같은 생성 정보를
 * 숨긴다(stealth_pngcomp). 매직이 있으면 알파 LSB를 모두 1로 채운 IDAT 청크를 새로 만든다.
 * RGB와 다른 청크는 그대로이고 알파는 최대 1만 바뀐다(NAI 결과물의 254/255 → 255).
 * 8비트 RGBA·인터레이스 없음만 다룬다 — 그 밖이거나 매직이 없으면 null.
 */
function clearStealthAlpha(chunks: PngChunk[]): Buffer | null {
  const ihdr = chunks[0]
  if (ihdr?.type !== 'IHDR' || ihdr.bytes.length < 25) return null
  const width = ihdr.bytes.readUInt32BE(8)
  const height = ihdr.bytes.readUInt32BE(12)
  // 비트 깊이 8 · 색 형식 6(RGBA) · 인터레이스 없음
  if (ihdr.bytes[16] !== 8 || ihdr.bytes[17] !== 6 || ihdr.bytes[20] !== 0) return null
  if (width * height < STEALTH_MAGIC_BITS) return null
  const stride = width * 4
  const size = height * (stride + 1) // 행마다 필터 바이트 1 + 픽셀
  let rows: Buffer
  try {
    const data = chunks
      .filter((c) => c.type === 'IDAT')
      .map((c) => c.bytes.subarray(8, c.bytes.length - 4))
    rows = inflateSync(Buffer.concat(data))
  } catch {
    return null
  }
  if (rows.length < size) return null
  rows = rows.subarray(0, size)

  // 필터 풀기
  const px = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = rows[y * (stride + 1)]
    if (filter > 4) return null
    const src = y * (stride + 1) + 1
    const dst = y * stride
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? px[dst + i - 4] : 0
      const b = y > 0 ? px[dst + i - stride] : 0
      const c = i >= 4 && y > 0 ? px[dst + i - stride - 4] : 0
      px[dst + i] = (rows[src + i] + predict(filter, a, b, c)) & 0xff
    }
  }
  if (!hasStealthMagic(px, width, height, 4)) return null

  for (let i = 3; i < px.length; i += 4) px[i] |= 1
  // 행마다 원래 필터를 그대로 다시 건다 (inflate 결과는 새 버퍼라 덮어써도 원본은 그대로)
  for (let y = 0; y < height; y++) {
    const filter = rows[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const dst = y * stride
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? px[dst + i - 4] : 0
      const b = y > 0 ? px[dst + i - stride] : 0
      const c = i >= 4 && y > 0 ? px[dst + i - stride - 4] : 0
      rows[src + i] = (px[dst + i] - predict(filter, a, b, c)) & 0xff
    }
  }
  return pngChunk('IDAT', deflateSync(rows))
}

/**
 * 알파 LSB를 column-major로 읽은 앞 15바이트가 stealth 매직인지 (metadata.ts 읽기와 같은 순서).
 * channels = 픽셀당 바이트 수, 알파는 마지막 바이트 (RGBA면 4, 알파 평면만이면 1)
 */
function hasStealthMagic(px: Buffer, width: number, height: number, channels: number): boolean {
  const head = Buffer.alloc(STEALTH_MAGIC_BITS / 8)
  for (let k = 0; k < STEALTH_MAGIC_BITS; k++) {
    const x = Math.floor(k / height)
    const y = k % height
    if (px[(y * width + x) * channels + channels - 1] & 1) head[k >> 3] |= 0x80 >> (k & 7)
  }
  return STEALTH_MAGICS.some((m) => m.equals(head))
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

interface WebpChunk {
  type: string
  bytes: Buffer // 타입·크기·데이터·패딩 전체
}

/** RIFF 청크 목록 — 잘렸거나 청크 경계가 안 맞으면 null */
function webpChunks(buf: Buffer): WebpChunk[] | null {
  const riffEnd = 8 + buf.readUInt32LE(4)
  if (riffEnd > buf.length) return null // 잘린 파일
  const chunks: WebpChunk[] = []
  let off = 12
  while (off + 8 <= riffEnd) {
    const type = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (off + 8 + size > riffEnd) return null
    // 청크는 짝수 정렬 — 홀수 크기면 패딩 1바이트 (마지막 청크에 패딩이 빠진 파일도 허용)
    const end = Math.min(off + 8 + size + (size % 2), riffEnd)
    chunks.push({ type, bytes: buf.subarray(off, end) })
    off = end
  }
  return chunks
}

/** 원본 RIFF 헤더 뒤에 청크를 이어 붙이고 RIFF 크기를 고친다 */
function joinWebp(buf: Buffer, chunks: Buffer[]): Buffer {
  const out = Buffer.concat([buf.subarray(0, 12), ...chunks])
  out.writeUInt32LE(out.length - 8, 4)
  return out
}

function riffChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(8 + data.length + (data.length % 2)) // 홀수면 패딩 0 한 바이트
  out.write(type, 0, 'ascii')
  out.writeUInt32LE(data.length, 4)
  data.copy(out, 8)
  return out
}

function stripWebp(buf: Buffer): Buffer {
  const chunks = webpChunks(buf)
  if (!chunks?.some((c) => WEBP_DROP.has(c.type))) return buf // 깨졌거나 뺄 게 없음
  const parts: Buffer[] = []
  for (const c of chunks) {
    if (WEBP_DROP.has(c.type)) continue
    if (c.type === 'VP8X' && c.bytes.length > 8) {
      const chunk = Buffer.from(c.bytes) // 원본 버퍼는 바꾸지 않는다
      chunk[8] &= ~(VP8X_EXIF_FLAG | VP8X_XMP_FLAG) & 0xff
      parts.push(chunk)
    } else parts.push(c.bytes)
  }
  return joinWebp(buf, parts)
}

/**
 * NAI WebP는 EXIF와 따로 ALPH(무손실 알파)의 LSB(column-major)에도 PNG와 같은 stealth 정보를 숨긴다.
 * 디코딩한 알파에 매직이 있으면 ALPH 청크 하나만 새 알파로 바꾸고 나머지 청크는 바이트 그대로 둔다.
 * 새 알파 = 2 이상은 LSB를 1로, 0·1은 0으로 (NAI 결과물의 254/255 → 255, 투명 0은 그대로 투명).
 * 최대 1만 바뀌어 보이는 투명도는 그대로이고, LSB가 (알파 ≥ 2)만 뜻하게 되어 숨은 비트는 남지 않는다.
 * 매직이 없거나 ALPH+VP8 구성이 아니거나 디코딩에 실패하면 받은 버퍼를 그대로 돌려준다.
 */
async function clearWebpStealthAlpha(buf: Buffer): Promise<Buffer> {
  const chunks = webpChunks(buf)
  if (chunks?.some((c) => c.type === 'VP8L')) return clearVp8lStealthAlpha(buf, chunks)
  const vp8x = chunks?.[0]
  if (!chunks || vp8x?.type !== 'VP8X' || vp8x.bytes.length < 18) return buf
  const alphAt = chunks.findIndex((c) => c.type === 'ALPH')
  if (alphAt < 0 || !chunks.some((c) => c.type === 'VP8 ')) return buf
  // VP8X 캔버스 크기 (24비트, 1을 뺀 값) = ALPH 알파 평면 크기
  const width = vp8x.bytes.readUIntLE(12, 3) + 1
  const height = vp8x.bytes.readUIntLE(15, 3) + 1
  if (width * height < STEALTH_MAGIC_BITS) return buf

  let alpha: Buffer
  try {
    const { data, info } = await sharp(buf)
      .extractChannel('alpha')
      .raw()
      .toBuffer({ resolveWithObject: true })
    if (info.width !== width || info.height !== height || info.channels !== 1) return buf
    alpha = data
  } catch {
    return buf
  }
  if (!hasStealthMagic(alpha, width, height, 1)) return buf

  for (let i = 0; i < alpha.length; i++) alpha[i] = alpha[i] >= 2 ? alpha[i] | 1 : 0
  const alph = riffChunk('ALPH', await encodeAlph(alpha, width, height))
  return joinWebp(
    buf,
    chunks.map((c, i) => (i === alphAt ? alph : c.bytes))
  )
}

/**
 * 무손실 WebP(VP8L) — 알파가 색과 한 비트스트림이라 ALPH만 바꿀 수 없다.
 * RGBA로 풀어 알파 LSB에 매직이 있으면 알파를 위와 같은 규칙으로 바꾸고 무손실로 다시 압축해
 * VP8L 청크만 갈아 끼운다(VP8X 등 나머지 청크는 그대로). 무손실이라 보이는 색은 그대로다
 * (libwebp는 완전 투명(알파 0) 픽셀 밑의 색은 바꿀 수 있다 — 보이지 않는 값).
 * NAI V5 무손실 WebP가 이 구성이다 (실제 결과물로 확인 — 손실 VP8+ALPH만 고쳤다가 놓쳤던 경우).
 */
async function clearVp8lStealthAlpha(buf: Buffer, chunks: WebpChunk[]): Promise<Buffer> {
  const at = chunks.findIndex((c) => c.type === 'VP8L')
  if (chunks.filter((c) => c.type === 'VP8L').length !== 1) return buf // 애니메이션 등은 손대지 않음
  let rgba: Buffer
  let width: number
  let height: number
  try {
    const { data, info } = await sharp(buf)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    if (info.channels !== 4) return buf
    rgba = data
    width = info.width
    height = info.height
  } catch {
    return buf
  }
  if (width * height < STEALTH_MAGIC_BITS || !hasStealthMagic(rgba, width, height, 4)) return buf

  for (let i = 3; i < rgba.length; i += 4) rgba[i] = rgba[i] >= 2 ? rgba[i] | 1 : 0
  try {
    const encoded = await sharp(rgba, { raw: { width, height, channels: 4 } })
      .webp({ lossless: true })
      .toBuffer()
    const vp8l = webpChunks(encoded)?.find((c) => c.type === 'VP8L')
    if (!vp8l) return buf
    return joinWebp(
      buf,
      chunks.map((c, i) => (i === at ? vp8l.bytes : c.bytes))
    )
  } catch {
    return buf
  }
}

/**
 * 알파 평면 → ALPH 청크 데이터. 알파를 회색 무손실 WebP(초록 = 알파)로 압축한 뒤
 * VP8L 5바이트 헤더(시그니처 0x2f + 크기·버전 비트)를 떼어 ALPH 압축 1(VP8L 이미지 스트림)로 싣는다.
 * sharp·Pillow(서로 다른 libwebp 판)로 디코딩해 알파·RGB가 같음을 확인한 방식.
 * 압축 결과가 예상과 다르면 비압축(압축 0, 가로×세로 바이트)으로 싣는다 — 크지만 규격상 항상 유효.
 */
async function encodeAlph(alpha: Buffer, width: number, height: number): Promise<Buffer> {
  try {
    const lossless = await sharp(alpha, { raw: { width, height, channels: 1 } })
      .webp({ lossless: true })
      .toBuffer()
    const vp8l = webpChunks(lossless)?.find((c) => c.type === 'VP8L')
    const size = vp8l?.bytes.readUInt32LE(4) ?? 0
    const data = vp8l?.bytes.subarray(8, 8 + size)
    if (data && data.length > 5 && data[0] === 0x2f) {
      // 헤더 32비트: 가로-1(14) 세로-1(14) 알파 사용(1) 버전(3) — 하위 비트부터
      const bits = data.readUInt32LE(1)
      if (
        (bits & 0x3fff) + 1 === width &&
        ((bits >>> 14) & 0x3fff) + 1 === height &&
        !(bits >>> 29)
      )
        return Buffer.concat([Buffer.from([ALPH_LOSSLESS]), data.subarray(5)])
    }
  } catch {
    // 아래 비압축으로
  }
  return Buffer.concat([Buffer.from([ALPH_RAW]), alpha])
}
