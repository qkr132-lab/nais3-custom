/**
 * 검열본에 원본의 NAI 메타데이터만 옮겨 적는다 (커스텀).
 *
 * sharp의 keepMetadata는 EXIF를 통째로 옮겨, 원본 EXIF에 든 미리보기 썸네일(IFD1)이나
 * Photoshop 썸네일까지 검열본에 남는다 — 가린 그림 안에 안 가린 작은 그림이 따라가는 셈이다.
 * 그래서 NAI가 쓰는 항목만 골라 새로 만든다:
 *  - PNG: 텍스트 청크(tEXt·zTXt·iTXt)만 — eXIf 등 나머지는 버린다
 *  - WebP: EXIF에서 Software·DocumentName·ImageDescription·UserComment만 담은 새 EXIF
 *  - JPEG: 옮기지 않는다 (NAI는 JPEG를 만들지 않는다)
 */

// ── PNG ─────────────────────────────────────────────────────────────────

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const TEXT_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt'])

interface Chunk {
  type: string
  /** 길이·타입·데이터·CRC 전체 */
  bytes: Buffer
}

function pngChunks(buf: Buffer): Chunk[] | null {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null
  const out: Chunk[] = []
  let p = 8
  while (p + 12 <= buf.length) {
    const len = buf.readUInt32BE(p)
    const end = p + 12 + len
    if (end > buf.length) break
    out.push({ type: buf.toString('latin1', p + 4, p + 8), bytes: buf.subarray(p, end) })
    p = end
  }
  return out
}

/** 원본 PNG의 텍스트 청크를 새 PNG의 첫 IDAT 앞에 넣는다 */
export function copyPngText(original: Buffer, encoded: Buffer): Buffer {
  const src = pngChunks(original)
  const dst = pngChunks(encoded)
  if (!src || !dst) return encoded
  const texts = src.filter((c) => TEXT_CHUNKS.has(c.type)).map((c) => c.bytes)
  if (!texts.length) return encoded
  const parts: Buffer[] = [PNG_SIG]
  let inserted = false
  for (const c of dst) {
    if (TEXT_CHUNKS.has(c.type)) continue // 인코더가 넣은 것은 원본 것으로 바꾼다
    if (!inserted && c.type === 'IDAT') {
      parts.push(...texts)
      inserted = true
    }
    parts.push(c.bytes)
  }
  return Buffer.concat(parts)
}

// ── EXIF (TIFF) ─────────────────────────────────────────────────────────

const KEEP_IFD0 = new Set([269, 270, 305]) // DocumentName, ImageDescription, Software
const EXIF_POINTER = 34665
const USER_COMMENT = 37510

interface Tag {
  tag: number
  type: number
  count: number
  data: Buffer
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }

function readIfd(
  tiff: Buffer,
  offset: number,
  le: boolean
): { tags: Tag[]; pointer: number | null } {
  const u16 = (o: number): number => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o))
  const u32 = (o: number): number => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o))
  const tags: Tag[] = []
  let pointer: number | null = null
  if (offset + 2 > tiff.length) return { tags, pointer }
  const n = u16(offset)
  for (let i = 0; i < n; i++) {
    const e = offset + 2 + i * 12
    if (e + 12 > tiff.length) break
    const tag = u16(e)
    const type = u16(e + 2)
    const count = u32(e + 4)
    const size = (TYPE_SIZE[type] ?? 1) * count
    if (tag === EXIF_POINTER) {
      pointer = u32(e + 8)
      continue
    }
    const at = size <= 4 ? e + 8 : u32(e + 8)
    if (at + size > tiff.length) continue
    tags.push({ tag, type, count, data: Buffer.from(tiff.subarray(at, at + size)) })
  }
  return { tags, pointer }
}

/** 원본 EXIF(TIFF)에서 NAI가 쓰는 항목만 뽑는다 */
export function pickNaiExif(tiff: Buffer): { ifd0: Tag[]; exif: Tag[] } | null {
  if (tiff.length < 8) return null
  const mark = tiff.toString('latin1', 0, 2)
  if (mark !== 'II' && mark !== 'MM') return null
  const le = mark === 'II'
  const first = le ? tiff.readUInt32LE(4) : tiff.readUInt32BE(4)
  try {
    const ifd0 = readIfd(tiff, first, le)
    // 멀티바이트 값(SHORT 등)은 바이트 순서를 바꿔야 하지만, 고르는 항목은 전부 ASCII·UNDEFINED라 그대로 옮긴다
    const keep0 = ifd0.tags.filter((t) => KEEP_IFD0.has(t.tag) && (t.type === 2 || t.type === 7))
    const exif =
      ifd0.pointer != null
        ? readIfd(tiff, ifd0.pointer, le).tags.filter((t) => t.tag === USER_COMMENT && t.type === 7)
        : []
    if (!keep0.length && !exif.length) return null
    return { ifd0: keep0, exif }
  } catch {
    return null
  }
}

/** 고른 항목으로 새 EXIF(리틀 엔디언 TIFF)를 만든다 — 썸네일(IFD1) 없음 */
export function buildExif(picked: { ifd0: Tag[]; exif: Tag[] }): Buffer {
  const ifd0 = [...picked.ifd0].sort((a, b) => a.tag - b.tag)
  const exif = [...picked.exif].sort((a, b) => a.tag - b.tag)
  const withPointer = exif.length > 0
  const ifd0Count = ifd0.length + (withPointer ? 1 : 0)
  const ifd0Size = 2 + ifd0Count * 12 + 4
  const exifSize = withPointer ? 2 + exif.length * 12 + 4 : 0
  let dataAt = 8 + ifd0Size + exifSize
  const chunks: Buffer[] = []
  const entry = (t: Tag): Buffer => {
    const e = Buffer.alloc(12)
    e.writeUInt16LE(t.tag, 0)
    e.writeUInt16LE(t.type, 2)
    e.writeUInt32LE(t.count, 4)
    if (t.data.length <= 4) t.data.copy(e, 8)
    else {
      e.writeUInt32LE(dataAt, 8)
      const padded = t.data.length % 2 ? Buffer.concat([t.data, Buffer.alloc(1)]) : t.data
      chunks.push(padded)
      dataAt += padded.length
    }
    return e
  }
  const head = Buffer.alloc(8)
  head.write('II', 0, 'latin1')
  head.writeUInt16LE(42, 2)
  head.writeUInt32LE(8, 4)
  const exifOffset = 8 + ifd0Size
  const all0 = [...ifd0]
  const ifd0Entries: Buffer[] = []
  // 태그 번호 순서를 지킨다 — 포인터(34665)는 고른 IFD0 태그들보다 크다
  for (const t of all0) ifd0Entries.push(entry(t))
  if (withPointer) {
    const p = Buffer.alloc(12)
    p.writeUInt16LE(EXIF_POINTER, 0)
    p.writeUInt16LE(4, 2)
    p.writeUInt32LE(1, 4)
    p.writeUInt32LE(exifOffset, 8)
    ifd0Entries.push(p)
  }
  const ifd0Buf = Buffer.concat([
    Buffer.from([ifd0Count & 0xff, ifd0Count >> 8]),
    ...ifd0Entries,
    Buffer.alloc(4) // 다음 IFD 없음 — 썸네일 IFD1을 만들지 않는다
  ])
  const exifEntries = exif.map(entry)
  const exifBuf = withPointer
    ? Buffer.concat([
        Buffer.from([exif.length & 0xff, exif.length >> 8]),
        ...exifEntries,
        Buffer.alloc(4)
      ])
    : Buffer.alloc(0)
  return Buffer.concat([head, ifd0Buf, exifBuf, ...chunks])
}

// ── WebP ────────────────────────────────────────────────────────────────

function webpChunks(buf: Buffer): { fourcc: string; data: Buffer }[] | null {
  if (
    buf.length < 12 ||
    buf.toString('latin1', 0, 4) !== 'RIFF' ||
    buf.toString('latin1', 8, 12) !== 'WEBP'
  )
    return null
  const out: { fourcc: string; data: Buffer }[] = []
  let p = 12
  while (p + 8 <= buf.length) {
    const fourcc = buf.toString('latin1', p, p + 4)
    const size = buf.readUInt32LE(p + 4)
    if (p + 8 + size > buf.length) break
    out.push({ fourcc, data: buf.subarray(p + 8, p + 8 + size) })
    p += 8 + size + (size % 2)
  }
  return out
}

function chunk(fourcc: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.write(fourcc, 0, 'latin1')
  head.writeUInt32LE(data.length, 4)
  return Buffer.concat([head, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)])
}

/** 원본 WebP EXIF에서 NAI 항목만 새 WebP에 넣는다 (VP8X가 없으면 만든다) */
export function copyWebpExif(
  original: Buffer,
  encoded: Buffer,
  width: number,
  height: number,
  hasAlpha: boolean
): Buffer {
  const src = webpChunks(original)
  const dst = webpChunks(encoded)
  if (!src || !dst) return encoded
  const exifChunk = src.find((c) => c.fourcc === 'EXIF')
  if (!exifChunk) return encoded
  let tiff = exifChunk.data
  if (tiff.toString('latin1', 0, 6) === 'Exif\0\0') tiff = tiff.subarray(6)
  const picked = pickNaiExif(tiff)
  if (!picked) return encoded
  const exif = buildExif(picked)
  const body = dst.filter((c) => c.fourcc !== 'EXIF' && c.fourcc !== 'XMP ')
  let vp8x = body.find((c) => c.fourcc === 'VP8X')
  const rest = body.filter((c) => c.fourcc !== 'VP8X')
  const flags = Buffer.alloc(10)
  if (vp8x) vp8x.data.copy(flags, 0, 0, 10)
  else {
    flags.writeUIntLE(width - 1, 4, 3)
    flags.writeUIntLE(height - 1, 7, 3)
    if (hasAlpha) flags[0] |= 0x10
  }
  flags[0] |= 0x08 // EXIF 있음
  flags[0] &= ~0x04 // XMP는 싣지 않는다
  vp8x = { fourcc: 'VP8X', data: flags }
  const payload = Buffer.concat([
    Buffer.from('WEBP', 'latin1'),
    chunk('VP8X', vp8x.data),
    ...rest.map((c) => chunk(c.fourcc, c.data)),
    chunk('EXIF', exif)
  ])
  const head = Buffer.alloc(8)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(payload.length, 4)
  return Buffer.concat([head, payload])
}
