import { describe, expect, it } from 'vitest'
import {
  alignmentPositions,
  dataCodewordCount,
  encodeQr,
  formatBits,
  makeQrSvg,
  reedSolomonRemainder,
  versionBits
} from '../../cloud/src/core/qr'

/**
 * QR 인코더 검증. 스캐너로 읽어 볼 수 없으니 두 갈래로 확인한다.
 * 1) 표준에 실린 값과 대조: 형식 정보 15비트 8종(오류정정 M), 버전 정보(7~10), ISO 18004 예제의 오류정정 코드워드,
 *    버전별 용량.
 * 2) 이 파일 안에서 표준 문서대로 따로 짠 「디코더」로 만든 행렬을 거꾸로 읽는다 — 형식 정보 두 벌, 마스크 해제,
 *    지그재그 읽기, 블록 분리, 블록마다 리드솔로몬 검산, 바이트 모드 본문 복원. 인코더와 코드를 공유하지 않는다.
 */

// ── 표준 값 ─────────────────────────────────────────────────────────

/** 표준 부록 C 형식 정보 표 — 오류정정 M, 마스크 0~7 */
const FORMAT_M = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0]
/** 버전 정보 표 (7~10) */
const VERSION_INFO: Record<number, number> = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3 }
/** 오류정정 M: [블록당 오류정정 수, 그룹1 블록 수, 그룹1 데이터 수, 그룹2 블록 수, 그룹2 데이터 수] */
const BLOCKS_M: Record<number, [number, number, number, number, number]> = {
  1: [10, 1, 16, 0, 0],
  2: [16, 1, 28, 0, 0],
  3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0],
  5: [24, 2, 43, 0, 0],
  6: [16, 4, 27, 0, 0],
  7: [18, 4, 31, 0, 0],
  8: [22, 2, 38, 2, 39],
  9: [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44]
}
const ALIGN: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50]
}

describe('QR — 표준 값 대조', () => {
  it('형식 정보 15비트가 표준 표와 같다 (오류정정 M · 마스크 0~7)', () => {
    for (let mask = 0; mask < 8; mask++) expect(formatBits(mask)).toBe(FORMAT_M[mask])
  })

  it('버전 정보 18비트가 표준 표와 같다 (7~10)', () => {
    for (const [ver, bits] of Object.entries(VERSION_INFO))
      expect(versionBits(Number(ver))).toBe(bits)
  })

  it('ISO 18004 예제 「01234567」(버전 1-M)의 오류정정 코드워드가 같다', () => {
    // 숫자 모드 0001 · 길이 0000001000 · 012 · 345 · 67 → 종결·패딩 (표준 부록의 데이터 코드워드 16개)
    const data = [
      0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11
    ]
    expect(reedSolomonRemainder(data, 10)).toEqual([
      0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55
    ])
  })

  it('버전별 데이터 용량이 표준 표와 같다 (M)', () => {
    for (const [ver, [ec, n1, d1, n2, d2]] of Object.entries(BLOCKS_M)) {
      expect(dataCodewordCount(Number(ver))).toBe(n1 * d1 + n2 * d2)
      expect(ec).toBeGreaterThan(0)
    }
    // 바이트 모드로 넣을 수 있는 최대 글자 수 (표준 표: 14·26·42·62·84·106·122·152·180·213)
    const capacity = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213]
    capacity.forEach((max, i) => {
      const ver = i + 1
      expect(encodeQr('a'.repeat(max)).version).toBe(ver)
      if (ver < 10) expect(encodeQr('a'.repeat(max + 1)).version).toBe(ver + 1)
    })
  })

  it('정렬 무늬 위치가 표준 표와 같다', () => {
    for (let ver = 1; ver <= 10; ver++) expect(alignmentPositions(ver)).toEqual(ALIGN[ver])
  })

  it('213바이트를 넘으면 던진다', () => {
    expect(() => encodeQr('a'.repeat(214))).toThrow()
  })
})

// ── 따로 짠 디코더 ─────────────────────────────────────────────────

/** GF(256) 곱셈 (x^8+x^4+x^3+x^2+1) — 인코더의 로그표와 다른 방식 */
function gmul(a: number, b: number): number {
  let r = 0
  while (b) {
    if (b & 1) r ^= a
    a <<= 1
    if (a & 0x100) a ^= 0x11d
    b >>= 1
  }
  return r
}

function rsRemainder(data: number[], ecLen: number): number[] {
  // 생성 다항식 (x-1)(x-2)(x-4)… 를 곱해 만든 뒤 긴 나눗셈
  let gen = [1]
  let root = 1
  for (let i = 0; i < ecLen; i++) {
    const next = new Array(gen.length + 1).fill(0)
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j]
      next[j + 1] ^= gmul(gen[j], root)
    }
    gen = next
    root = gmul(root, 2)
  }
  const buf = [...data, ...new Array(ecLen).fill(0)]
  for (let i = 0; i < data.length; i++) {
    const factor = buf[i]
    if (!factor) continue
    for (let j = 0; j < gen.length; j++) buf[i + j] ^= gmul(gen[j], factor)
  }
  return buf.slice(data.length)
}

function maskBit(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0
    case 1:
      return row % 2 === 0
    case 2:
      return col % 3 === 0
    case 3:
      return (row + col) % 3 === 0
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0
    default:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0
  }
}

/** 형식 정보 BCH 검산: 데이터 5비트로 만든 15비트가 읽은 값과 같은가 */
function bchFormat(data5: number): number {
  let v = data5 << 10
  for (let i = 14; i >= 10; i--) if (v & (1 << i)) v ^= 0x537 << (i - 10)
  return ((data5 << 10) | v) ^ 0x5412
}

function decodeQr(modules: boolean[][]): { text: string; mask: number; version: number } {
  const size = modules.length
  const version = (size - 17) / 4
  expect(Number.isInteger(version)).toBe(true)
  const at = (col: number, row: number): boolean => modules[row][col]

  // 형식 정보 — 첫째 벌(왼쪽 위)과 둘째 벌(오른쪽 위·왼쪽 아래)
  const firstCopy: [number, number][] = [
    [8, 0],
    [8, 1],
    [8, 2],
    [8, 3],
    [8, 4],
    [8, 5],
    [8, 7],
    [8, 8],
    [7, 8],
    [5, 8],
    [4, 8],
    [3, 8],
    [2, 8],
    [1, 8],
    [0, 8]
  ]
  const secondCopy: [number, number][] = [
    ...[0, 1, 2, 3, 4, 5, 6, 7].map((i): [number, number] => [size - 1 - i, 8]),
    ...[8, 9, 10, 11, 12, 13, 14].map((i): [number, number] => [8, size - 15 + i])
  ]
  const readBits = (cells: [number, number][]): number =>
    cells.reduce((acc, [c, r], i) => acc | ((at(c, r) ? 1 : 0) << i), 0)
  const first = readBits(firstCopy)
  const second = readBits(secondCopy)
  expect(second).toBe(first)
  const data5 = (first ^ 0x5412) >> 10
  expect(bchFormat(data5)).toBe(first)
  expect(data5 >> 3).toBe(0) // 오류정정 M
  const mask = data5 & 7

  // 기능 칸 표시
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const mark = (c0: number, r0: number, c1: number, r1: number): void => {
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) reserved[r][c] = true
  }
  mark(0, 0, 8, 8)
  mark(size - 8, 0, size - 1, 8)
  mark(0, size - 8, 8, size - 1)
  for (let i = 0; i < size; i++) {
    reserved[6][i] = true
    reserved[i][6] = true
  }
  const pos = ALIGN[version]
  pos.forEach((r, i) =>
    pos.forEach((c, j) => {
      const nearFinder =
        (i === 0 && j === 0) ||
        (i === 0 && j === pos.length - 1) ||
        (i === pos.length - 1 && j === 0)
      if (!nearFinder) mark(c - 2, r - 2, c + 2, r + 2)
    })
  )
  if (version >= 7) {
    mark(size - 11, 0, size - 9, 5)
    mark(0, size - 11, 5, size - 9)
    // 버전 정보 값도 읽어 표와 맞는지 본다
    let bits = 0
    for (let i = 0; i < 18; i++) bits |= (at(size - 11 + (i % 3), Math.floor(i / 3)) ? 1 : 0) << i
    expect(bits).toBe(VERSION_INFO[version])
  }
  expect(at(8, size - 8)).toBe(true) // 어두운 칸

  // 지그재그 읽기 (오른쪽 아래에서 위로 시작, 두 칸 폭, 세로 타이밍 열은 건너뜀)
  const bits: number[] = []
  const rights: number[] = []
  for (let c = size - 1; c > 6; c -= 2) rights.push(c)
  for (let c = 5; c >= 1; c -= 2) rights.push(c)
  rights.forEach((right, pairIndex) => {
    const rows = [...Array(size).keys()]
    if (pairIndex % 2 === 0) rows.reverse()
    for (const row of rows) {
      for (const col of [right, right - 1]) {
        if (reserved[row][col]) continue
        bits.push(at(col, row) !== maskBit(mask, row, col) ? 1 : 0)
      }
    }
  })
  const codewords: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    codewords.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0))
  }

  // 블록 나누기 (표준의 교차 규칙) + 블록마다 리드솔로몬 검산
  const [ecLen, n1, d1, n2, d2] = BLOCKS_M[version]
  const dataLens = [...Array(n1).fill(d1), ...Array(n2).fill(d2)] as number[]
  const total = dataLens.reduce((a, b) => a + b, 0) + ecLen * dataLens.length
  expect(codewords.length).toBeGreaterThanOrEqual(total)
  const blocks = dataLens.map(() => ({ data: [] as number[], ec: [] as number[] }))
  let cursor = 0
  for (let i = 0; i < Math.max(...dataLens); i++) {
    dataLens.forEach((len, b) => {
      if (i < len) blocks[b].data.push(codewords[cursor++])
    })
  }
  for (let i = 0; i < ecLen; i++) blocks.forEach((block) => block.ec.push(codewords[cursor++]))
  for (const block of blocks) expect(rsRemainder(block.data, ecLen)).toEqual(block.ec)

  // 바이트 모드 본문
  const stream = blocks.flatMap((b) => b.data)
  const bitString = stream.map((b) => b.toString(2).padStart(8, '0')).join('')
  expect(bitString.slice(0, 4)).toBe('0100')
  const countBits = version <= 9 ? 8 : 16
  const length = parseInt(bitString.slice(4, 4 + countBits), 2)
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i++) {
    bytes[i] = parseInt(bitString.slice(4 + countBits + i * 8, 4 + countBits + i * 8 + 8), 2)
  }
  return { text: new TextDecoder().decode(bytes), mask, version }
}

describe('QR — 만든 행렬을 거꾸로 읽기', () => {
  const samples = [
    'A',
    'https://nais3-cloud.example.workers.dev/#pair=ABCDEFGH',
    'http://127.0.0.1:8787/#pair=K7M2Q9XR',
    '한글 주소 ✓ ~!@#$%^&*()',
    'x'.repeat(100),
    'y'.repeat(120),
    'z'.repeat(180),
    'https://example.com/' + 'a'.repeat(193)
  ]

  for (const text of samples) {
    it(`복원된다: ${text.slice(0, 30)}… (${new TextEncoder().encode(text).length}바이트)`, () => {
      const qr = encodeQr(text)
      expect(qr.size).toBe(qr.version * 4 + 17)
      expect(qr.modules).toHaveLength(qr.size)
      const decoded = decodeQr(qr.modules)
      expect(decoded.text).toBe(text)
      expect(decoded.version).toBe(qr.version)
      expect(decoded.mask).toBe(qr.mask)
    })
  }

  it('모든 버전(1~10)이 복원된다', () => {
    const capacity = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213]
    capacity.forEach((max, i) => {
      for (const length of [max, Math.max(1, max - 3)]) {
        const text = Array.from({ length }, (_, k) =>
          String.fromCharCode(33 + ((k * 7 + i) % 90))
        ).join('')
        const qr = encodeQr(text)
        expect(qr.version).toBe(length === max ? i + 1 : qr.version)
        expect(decodeQr(qr.modules).text).toBe(text)
      }
    })
  })

  it('찾기 무늬·타이밍 무늬 모양이 맞다', () => {
    const { modules, size } = encodeQr('hello')
    const finder = (c0: number, r0: number): void => {
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 7; c++) {
          const ring = Math.max(Math.abs(c - 3), Math.abs(r - 3))
          expect(modules[r0 + r][c0 + c]).toBe(ring !== 2)
        }
      }
    }
    finder(0, 0)
    finder(size - 7, 0)
    finder(0, size - 7)
    for (let i = 8; i < size - 8; i++) {
      expect(modules[6][i]).toBe(i % 2 === 0)
      expect(modules[i][6]).toBe(i % 2 === 0)
    }
  })

  it('SVG 는 흰 바탕에 검은 경로 하나, 외부 주소가 없다', () => {
    const svg = makeQrSvg('https://nais3-cloud.test/#pair=ABCDEFGH')
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg).toContain('fill="#fff"')
    expect(svg).toContain('fill="#000"')
    expect(svg.match(/<path /g)).toHaveLength(1)
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/)
    const qr = encodeQr('https://nais3-cloud.test/#pair=ABCDEFGH')
    expect(svg).toContain(`viewBox="0 0 ${qr.size + 8} ${qr.size + 8}"`)
  })
})
