// 메타데이터 테스트용 합성 이미지 도우미 — 실제 생성물 없이 NAI와 같은 모양의 청크만 흉내 낸다.
import sharp from 'sharp'
import { deflateSync, gzipSync } from 'zlib'

export const W = 5
export const H = 3
export const RAW = Buffer.from(Array.from({ length: W * H * 4 }, (_, i) => (i * 37 + 11) % 256))
export const rawInput = { raw: { width: W, height: H, channels: 4 as const } }
export const NAI_COMMENT = JSON.stringify({
  prompt: '1girl, solo',
  uc: 'lowres',
  seed: 42,
  steps: 28
})
export const XMP = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF/></x:xmpmeta>'

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(bytes: Buffer): number {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])))
  return Buffer.concat([head, data, crc])
}

export function pngChunks(buf: Buffer): { type: string; bytes: Buffer }[] {
  const out: { type: string; bytes: Buffer }[] = []
  let off = 8
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off)
    out.push({
      type: buf.toString('ascii', off + 4, off + 8),
      bytes: buf.subarray(off, off + 12 + len)
    })
    off += 12 + len
  }
  return out
}

export function riffChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.write(type, 0, 'ascii')
  head.writeUInt32LE(data.length, 4)
  return Buffer.concat([head, data, Buffer.alloc(data.length % 2)])
}

export function riff(chunks: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), ...chunks])
  const head = Buffer.alloc(8)
  head.write('RIFF', 0, 'ascii')
  head.writeUInt32LE(body.length, 4)
  return Buffer.concat([head, body])
}

export function webpChunks(buf: Buffer): { type: string; bytes: Buffer }[] {
  const out: { type: string; bytes: Buffer }[] = []
  let off = 12
  while (off + 8 <= buf.length) {
    const size = buf.readUInt32LE(off + 4)
    out.push({
      type: buf.toString('ascii', off, off + 4),
      bytes: buf.subarray(off, off + 8 + size)
    })
    off += 8 + size + (size % 2)
  }
  return out
}

/** NAI webp와 같은 모양 — EXIF IFD0에 UserComment(0x9286, UNDEFINED)로 파라미터 JSON. 홀수 크기 */
export function naiExif(): Buffer {
  const text = Buffer.concat([
    Buffer.from('ASCII\0\0\0', 'ascii'),
    Buffer.from(JSON.stringify({ Comment: NAI_COMMENT }), 'utf8')
  ])
  const ifd = Buffer.alloc(2 + 12 + 4)
  ifd.writeUInt16LE(1, 0)
  ifd.writeUInt16LE(0x9286, 2)
  ifd.writeUInt16LE(7, 4)
  ifd.writeUInt32LE(text.length, 6)
  ifd.writeUInt32LE(8 + ifd.length, 10) // 값 오프셋 = TIFF 헤더(8) + IFD 뒤
  const head = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00])
  const out = Buffer.concat([head, ifd, text])
  return out.length % 2 ? out : Buffer.concat([out, Buffer.from([0])])
}

/** NAI PNG 모양 — IHDR 바로 뒤에 tEXt Comment(파라미터 JSON)·Software */
export async function naiPng(): Promise<Buffer> {
  const base = await sharp(RAW, rawInput).png().toBuffer()
  return Buffer.concat([
    base.subarray(0, 33),
    pngChunk('tEXt', Buffer.from(`Comment\0${NAI_COMMENT}`, 'latin1')),
    pngChunk('tEXt', Buffer.from('Software\0NovelAI', 'latin1')),
    base.subarray(33)
  ])
}

/** NAI WebP 모양 — VP8X(알파+EXIF+XMP) + VP8L + EXIF + XMP */
export async function naiWebp(): Promise<{ webp: Buffer; vp8l: Buffer }> {
  const lossless = await sharp(RAW, rawInput).webp({ lossless: true }).toBuffer()
  const vp8l = webpChunks(lossless).find((c) => c.type === 'VP8L')!.bytes
  const vp8x = Buffer.alloc(10)
  vp8x[0] = 0x10 | 0x08 | 0x04 // 알파 + EXIF + XMP
  vp8x.writeUIntLE(W - 1, 4, 3)
  vp8x.writeUIntLE(H - 1, 7, 3)
  const webp = riff([
    riffChunk('VP8X', vp8x),
    vp8l,
    riffChunk('EXIF', naiExif()),
    riffChunk('XMP ', Buffer.from(XMP, 'utf8'))
  ])
  return { webp, vp8l }
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** 8비트 RGBA PNG를 직접 인코딩 — 행마다 필터 0~4를 돌려 쓰고 IDAT를 두 조각으로 나눈다 */
export function encodeRgbaPng(
  width: number,
  height: number,
  pixels: Buffer,
  extra: Buffer[] = []
): Buffer {
  const stride = width * 4
  const rows = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    const f = y % 5
    rows[y * (stride + 1)] = f
    for (let i = 0; i < stride; i++) {
      const p = y * stride + i
      const a = i >= 4 ? pixels[p - 4] : 0
      const b = y > 0 ? pixels[p - stride] : 0
      const c = i >= 4 && y > 0 ? pixels[p - stride - 4] : 0
      const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][f]
      rows[y * (stride + 1) + 1 + i] = (pixels[p] - pred) & 0xff
    }
  }
  const z = deflateSync(rows)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 비트 깊이
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    ...extra,
    pngChunk('IDAT', z.subarray(0, z.length >> 1)),
    pngChunk('IDAT', z.subarray(z.length >> 1)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

export const SW = 48
export const SH = 40

/**
 * NAI PNG 모양 stealth — 알파 최하위 비트(column-major)에 매직 + 비트 길이 + gzip JSON.
 * 불투명 그림이라 알파는 254/255만 쓴다. pixels는 인코딩 전 RGBA 원본.
 */
export function stealthPng(
  magic = 'stealth_pngcomp',
  extra: Buffer[] = []
): { png: Buffer; pixels: Buffer } {
  const pixels = Buffer.alloc(SW * SH * 4)
  for (let p = 0; p < SW * SH; p++) {
    pixels[p * 4] = (p * 37 + 11) % 256
    pixels[p * 4 + 1] = (p * 91 + 5) % 256
    pixels[p * 4 + 2] = (p * 13) % 256
    pixels[p * 4 + 3] = 255
  }
  embedStealth(pixels, magic)
  return { png: encodeRgbaPng(SW, SH, pixels, extra), pixels }
}

/** SW×SH RGBA 알파 LSB(column-major)에 매직 + 비트 길이 + gzip JSON을 심는다 (알파 윗비트는 그대로) */
function embedStealth(pixels: Buffer, magic: string): void {
  const payload = gzipSync(JSON.stringify({ Comment: NAI_COMMENT, Software: 'NovelAI' }))
  const bitLength = Buffer.alloc(4)
  bitLength.writeUInt32BE(payload.length * 8)
  const bits = Buffer.concat([Buffer.from(magic, 'ascii'), bitLength, payload])
  if (bits.length * 8 > SW * SH) throw new Error('stealth 테스트 그림이 너무 작음')
  for (let k = 0; k < bits.length * 8; k++) {
    const x = Math.floor(k / SH)
    const y = k % SH
    const i = (y * SW + x) * 4 + 3
    pixels[i] = (pixels[i] & 0xfe) | ((bits[k >> 3] >> (7 - (k & 7))) & 1)
  }
}

/**
 * NAI WebP 모양 stealth — 손실 색(VP8) + 무손실 알파(ALPH) 알파 LSB에 stealth, 뒤에 EXIF.
 * transparent면 알파에 0·1·반투명·255를 섞는다 (아니면 NAI처럼 254/255만).
 * pixels는 인코딩 전 RGBA 원본 — 알파는 무손실이라 디코딩해도 같다.
 */
export async function stealthWebp(
  opts: { magic?: string; transparent?: boolean; exif?: boolean } = {}
): Promise<{ webp: Buffer; pixels: Buffer }> {
  const { magic = 'stealth_pngcomp', transparent = false, exif = true } = opts
  const pixels = Buffer.alloc(SW * SH * 4)
  for (let y = 0; y < SH; y++)
    for (let x = 0; x < SW; x++) {
      const p = (y * SW + x) * 4
      pixels[p] = (x * 5 + y * 3) % 256
      pixels[p + 1] = (x * y) % 256
      pixels[p + 2] = (200 - y * 4) % 256
      pixels[p + 3] = transparent ? [0, 1, 96, 173, 255][(x * 3 + y) % 5] : 255
    }
  embedStealth(pixels, magic)
  const lossy = await sharp(pixels, { raw: { width: SW, height: SH, channels: 4 } })
    .webp({ quality: 90, alphaQuality: 100 })
    .toBuffer()
  // 청크를 패딩까지 다시 싸서 이어 붙이고, EXIF를 달면 VP8X 플래그도 켠다
  const chunks = webpChunks(lossy).map((c) => riffChunk(c.type, c.bytes.subarray(8)))
  if (exif) {
    chunks[0][8] |= 0x08
    chunks.push(riffChunk('EXIF', naiExif()))
  }
  return { webp: riff(chunks), pixels }
}

/**
 * NAI V5 무손실 WebP 모양 — VP8X(알파·EXIF) + VP8L(색과 알파가 한 비트스트림) + EXIF.
 * 알파 LSB에 stealth. magic을 빈 문자열로 주면 stealth 없이 만든다.
 */
export async function stealthWebpLossless(
  opts: { magic?: string; transparent?: boolean } = {}
): Promise<{ webp: Buffer; pixels: Buffer }> {
  const { magic = 'stealth_pngcomp', transparent = false } = opts
  const pixels = Buffer.alloc(SW * SH * 4)
  for (let y = 0; y < SH; y++)
    for (let x = 0; x < SW; x++) {
      const p = (y * SW + x) * 4
      pixels[p] = (x * 7 + y * 11) % 256
      pixels[p + 1] = (x * y + 3) % 256
      pixels[p + 2] = (180 - y * 3) % 256
      pixels[p + 3] = transparent ? [0, 1, 96, 173, 255][(x + y * 2) % 5] : 255
    }
  if (magic) embedStealth(pixels, magic)
  const lossless = await sharp(pixels, { raw: { width: SW, height: SH, channels: 4 } })
    .webp({ lossless: true })
    .toBuffer()
  const vp8l = webpChunks(lossless).find((c) => c.type === 'VP8L')!
  const vp8x = Buffer.alloc(10)
  vp8x[0] = 0x10 | 0x08 // 알파 + EXIF
  vp8x.writeUIntLE(SW - 1, 4, 3)
  vp8x.writeUIntLE(SH - 1, 7, 3)
  return {
    webp: riff([
      riffChunk('VP8X', vp8x),
      riffChunk('VP8L', vp8l.bytes.subarray(8)),
      riffChunk('EXIF', naiExif())
    ]),
    pixels
  }
}

/** 알파 LSB(column-major) 앞 15바이트 — stealth 매직 자리 */
export async function alphaMagic(buf: Buffer): Promise<string> {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const head = Buffer.alloc(15)
  for (let k = 0; k < 120; k++) {
    const x = Math.floor(k / info.height)
    const y = k % info.height
    if (data[(y * info.width + x) * 4 + 3] & 1) head[k >> 3] |= 0x80 >> (k & 7)
  }
  return head.toString('latin1')
}

/** 디코딩한 RGBA 픽셀 — 무손실 여부 비교용 */
export const rawPixels = (buf: Buffer): Promise<Buffer> => sharp(buf).ensureAlpha().raw().toBuffer()

/** 파일 안에 생성 메타데이터 청크가 남아 있는지 (PNG 텍스트·EXIF / WebP EXIF·XMP) */
export function hasMetadataChunks(buf: Buffer): boolean {
  if (buf.toString('ascii', 8, 12) === 'WEBP')
    return webpChunks(buf).some((c) => c.type === 'EXIF' || c.type === 'XMP ')
  return pngChunks(buf).some((c) => ['tEXt', 'zTXt', 'iTXt', 'eXIf'].includes(c.type))
}
