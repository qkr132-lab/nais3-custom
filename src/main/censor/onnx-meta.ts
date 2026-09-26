/**
 * ONNX 모델 파일에서 metadata_props(키-값)만 읽는다 (커스텀 — 자동 검열).
 * ultralytics로 내보낸 모델은 여기에 라벨 이름(names)과 입력 크기(imgsz)를 적는다.
 * onnxruntime JS API는 이 값을 주지 않아 protobuf를 직접 훑는다.
 *
 * ModelProto에서 metadata_props는 14번 필드(StringStringEntryProto 반복: key=1, value=2).
 * 나머지 필드(그래프 등)는 길이만큼 건너뛴다.
 */

function readVarint(buf: Uint8Array, pos: number): [number, number] {
  let value = 0
  let shift = 0
  let p = pos
  for (;;) {
    if (p >= buf.length) throw new Error('varint past end')
    const byte = buf[p++]
    value += (byte & 0x7f) * 2 ** shift
    if (!(byte & 0x80)) break
    shift += 7
    if (shift > 63) throw new Error('varint too long')
  }
  return [value, p]
}

function skip(buf: Uint8Array, pos: number, wire: number): number {
  switch (wire) {
    case 0:
      return readVarint(buf, pos)[1]
    case 1:
      return pos + 8
    case 2: {
      const [len, p] = readVarint(buf, pos)
      return p + len
    }
    case 5:
      return pos + 4
    default:
      throw new Error(`unsupported wire type ${wire}`)
  }
}

const decoder = new TextDecoder()

function readEntry(buf: Uint8Array): [string, string] {
  let key = ''
  let value = ''
  let pos = 0
  while (pos < buf.length) {
    const [tag, p] = readVarint(buf, pos)
    const field = Math.floor(tag / 8)
    const wire = tag & 7
    if (wire === 2 && (field === 1 || field === 2)) {
      const [len, start] = readVarint(buf, p)
      const text = decoder.decode(buf.subarray(start, start + len))
      if (field === 1) key = text
      else value = text
      pos = start + len
    } else pos = skip(buf, p, wire)
  }
  return [key, value]
}

/** metadata_props 전부 (없거나 깨졌으면 빈 객체) */
export function readOnnxMetadata(buf: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    let pos = 0
    while (pos < buf.length) {
      const [tag, p] = readVarint(buf, pos)
      const field = Math.floor(tag / 8)
      const wire = tag & 7
      if (field === 14 && wire === 2) {
        const [len, start] = readVarint(buf, p)
        const [k, v] = readEntry(buf.subarray(start, start + len))
        if (k) out[k] = v
        pos = start + len
      } else pos = skip(buf, p, wire)
    }
  } catch {
    // 끝까지 못 읽어도 그때까지 모은 건 쓴다
  }
  return out
}

/** ultralytics names 문자열 "{0: 'nipples', 1: 'pussy'}" → ['nipples', 'pussy'] */
export function parseNames(text: string | undefined): string[] | null {
  if (!text) return null
  const names: string[] = []
  for (const m of text.matchAll(/(\d+)\s*:\s*(['"])(.*?)\2/g)) names[Number(m[1])] = m[3]
  return names.length && names.every((n) => typeof n === 'string') ? names : null
}

/** imgsz "[1024, 1024]" 또는 "640" → 한 변 크기 */
export function parseImgsz(text: string | undefined): number | null {
  if (!text) return null
  const nums = [...text.matchAll(/\d+/g)].map((m) => Number(m[0]))
  const n = Math.max(...nums)
  return Number.isFinite(n) && n >= 64 && n <= 4096 ? n : null
}
