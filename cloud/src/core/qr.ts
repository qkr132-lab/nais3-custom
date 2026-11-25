/**
 * QR 코드 인코더 — 바이트 모드, 오류정정 M, 버전 1~10 자동 선택, SVG 출력.
 *
 * 외부 서비스·라이브러리 없이 ISO/IEC 18004 규칙대로 직접 만든다
 * (데이터 비트열 → 리드솔로몬 오류정정 → 블록 교차 → 기능 패턴 → 지그재그 배치 → 마스크 8종 중 감점 최소).
 * 폰 연결 주소(`<워커 주소>/#pair=<코드>`) 하나를 그리는 용도라 숫자·영숫자 모드와 높은 버전은 두지 않았다.
 * 버전 10·M 에서 바이트 213개까지 들어간다.
 */

/** 버전별 오류정정 코드워드 수(블록당)와 블록 수 — 오류정정 M. 인덱스 = 버전 */
const EC_PER_BLOCK_M = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26]
const NUM_BLOCKS_M = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5]

export const QR_MAX_VERSION = 10

/** 형식 정보의 오류정정 수준 비트 (M = 00) */
const FORMAT_EC_BITS_M = 0

export interface QrCode {
  version: number
  size: number
  mask: number
  /** modules[행][열] — true 가 검은 칸 */
  modules: boolean[][]
}

// ── GF(256) · 리드솔로몬 ────────────────────────────────────────────

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
}

function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]
}

const generatorCache = new Map<number, number[]>()

/** (x-α⁰)(x-α¹)…(x-α^(degree-1)) 의 계수 — 최고차(1)부터, 길이 degree+1 */
function generatorPoly(degree: number): number[] {
  const cached = generatorCache.get(degree)
  if (cached) return cached
  let poly = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]
      next[j + 1] ^= gfMul(poly[j], EXP[i])
    }
    poly = next
  }
  generatorCache.set(degree, poly)
  return poly
}

/** 데이터를 생성 다항식으로 나눈 나머지 = 오류정정 코드워드 (테스트가 표준 예제와 대조한다) */
export function reedSolomonRemainder(data: number[], degree: number): number[] {
  const gen = generatorPoly(degree)
  const rem = new Array<number>(degree).fill(0)
  for (const byte of data) {
    const factor = byte ^ (rem.shift() as number)
    rem.push(0)
    for (let i = 0; i < degree; i++) rem[i] ^= gfMul(gen[i + 1], factor)
  }
  return rem
}

// ── 용량 ────────────────────────────────────────────────────────────

/** 기능 패턴을 뺀, 데이터·오류정정이 들어가는 칸 수 */
function rawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (ver >= 7) result -= 36
  }
  return result
}

/** 버전의 데이터 코드워드 수 (오류정정 M) */
export function dataCodewordCount(ver: number): number {
  return Math.floor(rawDataModules(ver) / 8) - EC_PER_BLOCK_M[ver] * NUM_BLOCKS_M[ver]
}

function appendBits(bits: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
}

/** 바이트 모드 데이터 비트열 → 패딩까지 마친 데이터 코드워드 */
export function buildDataCodewords(bytes: Uint8Array, ver: number): number[] {
  const bits: number[] = []
  appendBits(bits, 0b0100, 4)
  appendBits(bits, bytes.length, ver <= 9 ? 8 : 16)
  for (const b of bytes) appendBits(bits, b, 8)
  const capacityBits = dataCodewordCount(ver) * 8
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length))
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) appendBits(bits, pad, 8)
  const out: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]
    out.push(v)
  }
  return out
}

/** 블록으로 나눠 각각 오류정정을 붙이고 열 순서로 교차한 최종 코드워드 열 */
export function addEccAndInterleave(data: number[], ver: number): number[] {
  const numBlocks = NUM_BLOCKS_M[ver]
  const blockEcLen = EC_PER_BLOCK_M[ver]
  const rawCodewords = Math.floor(rawDataModules(ver) / 8)
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks)
  const shortBlockLen = Math.floor(rawCodewords / numBlocks)
  const blocks: number[][] = []
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEcLen + (i < numShortBlocks ? 0 : 1))
    k += dat.length
    const ecc = reedSolomonRemainder(dat, blockEcLen)
    // 짧은 블록은 자리 맞춤용 빈칸을 하나 끼웠다가 교차할 때 건너뛴다
    if (i < numShortBlocks) dat.push(0)
    blocks.push(dat.concat(ecc))
  }
  const result: number[] = []
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEcLen || j >= numShortBlocks) result.push(block[i])
    })
  }
  return result
}

// ── 형식·버전 정보 ──────────────────────────────────────────────────

/** 형식 정보 15비트 (오류정정 M + 마스크) — BCH(15,5) 후 0x5412 XOR */
export function formatBits(mask: number): number {
  const data = (FORMAT_EC_BITS_M << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  return ((data << 10) | rem) ^ 0x5412
}

/** 버전 정보 18비트 (버전 7 이상) — BCH(18,6) */
export function versionBits(ver: number): number {
  let rem = ver
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
  return (ver << 12) | rem
}

function getBit(value: number, i: number): boolean {
  return ((value >>> i) & 1) !== 0
}

export function alignmentPositions(ver: number): number[] {
  if (ver === 1) return []
  const numAlign = Math.floor(ver / 7) + 2
  const step = Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2
  const result = [6]
  for (let pos = ver * 4 + 10; result.length < numAlign; pos -= step) result.splice(1, 0, pos)
  return result
}

// ── 행렬 만들기 ─────────────────────────────────────────────────────

function grid(size: number): boolean[][] {
  return Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
}

function maskApplies(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0
    case 1:
      return y % 2 === 0
    case 2:
      return x % 3 === 0
    case 3:
      return (x + y) % 3 === 0
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
  }
}

const FINDER_LIKE_A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0]
const FINDER_LIKE_B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]

/** 마스크 감점 (표준 4규칙) */
function penaltyScore(modules: boolean[][]): number {
  const size = modules.length
  let result = 0
  // 1) 같은 색이 5칸 이상 이어진 줄 (가로·세로)
  for (let a = 0; a < size; a++) {
    for (const vertical of [false, true]) {
      let run = 1
      let prev = vertical ? modules[0][a] : modules[a][0]
      for (let b = 1; b < size; b++) {
        const cur = vertical ? modules[b][a] : modules[a][b]
        if (cur === prev) {
          run++
          if (run === 5) result += 3
          else if (run > 5) result += 1
        } else {
          run = 1
          prev = cur
        }
      }
    }
  }
  // 2) 같은 색 2×2 덩어리
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x]
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1])
        result += 3
    }
  }
  // 3) 찾기 무늬(1:1:3:1:1) 비슷한 줄 + 한쪽에 흰 칸 4개
  for (let a = 0; a < size; a++) {
    for (const vertical of [false, true]) {
      for (let b = 0; b + 11 <= size; b++) {
        let matchA = true
        let matchB = true
        for (let k = 0; k < 11 && (matchA || matchB); k++) {
          const v = (vertical ? modules[b + k][a] : modules[a][b + k]) ? 1 : 0
          if (v !== FINDER_LIKE_A[k]) matchA = false
          if (v !== FINDER_LIKE_B[k]) matchB = false
        }
        if (matchA) result += 40
        if (matchB) result += 40
      }
    }
  }
  // 4) 검은 칸 비율이 50% 에서 멀수록
  let dark = 0
  for (const row of modules) for (const cell of row) if (cell) dark++
  const total = size * size
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1
  if (k > 0) result += k * 10
  return result
}

/** 문자열을 UTF-8 바이트로 QR 로 만든다. 버전 10·M 에 안 들어가면 던진다 */
export function encodeQr(text: string): QrCode {
  const bytes = new TextEncoder().encode(text)
  let ver = 0
  for (let v = 1; v <= QR_MAX_VERSION; v++) {
    const header = 4 + (v <= 9 ? 8 : 16)
    if (header + bytes.length * 8 <= dataCodewordCount(v) * 8) {
      ver = v
      break
    }
  }
  if (ver === 0) throw new Error('QR 코드에 넣기에 주소가 너무 깁니다')

  const codewords = addEccAndInterleave(buildDataCodewords(bytes, ver), ver)
  const size = ver * 4 + 17
  const modules = grid(size)
  const isFunction = grid(size)
  const setFunction = (x: number, y: number, dark: boolean): void => {
    modules[y][x] = dark
    isFunction[y][x] = true
  }

  // 기능 패턴: 타이밍 → 찾기 무늬(구분선 포함) → 정렬 무늬
  for (let i = 0; i < size; i++) {
    setFunction(6, i, i % 2 === 0)
    setFunction(i, 6, i % 2 === 0)
  }
  const drawFinder = (cx: number, cy: number): void => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy))
        const x = cx + dx
        const y = cy + dy
        if (x >= 0 && x < size && y >= 0 && y < size) setFunction(x, y, dist !== 2 && dist !== 4)
      }
    }
  }
  drawFinder(3, 3)
  drawFinder(size - 4, 3)
  drawFinder(3, size - 4)
  const positions = alignmentPositions(ver)
  const last = positions.length - 1
  for (let i = 0; i <= last; i++) {
    for (let j = 0; j <= last; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFunction(
            positions[i] + dx,
            positions[j] + dy,
            Math.max(Math.abs(dx), Math.abs(dy)) !== 1
          )
        }
      }
    }
  }

  const drawFormat = (mask: number): void => {
    const bits = formatBits(mask)
    for (let i = 0; i <= 5; i++) setFunction(8, i, getBit(bits, i))
    setFunction(8, 7, getBit(bits, 6))
    setFunction(8, 8, getBit(bits, 7))
    setFunction(7, 8, getBit(bits, 8))
    for (let i = 9; i < 15; i++) setFunction(14 - i, 8, getBit(bits, i))
    for (let i = 0; i < 8; i++) setFunction(size - 1 - i, 8, getBit(bits, i))
    for (let i = 8; i < 15; i++) setFunction(8, size - 15 + i, getBit(bits, i))
    setFunction(8, size - 8, true)
  }
  drawFormat(0) // 자리만 잡는다 — 마스크가 정해지면 다시 그린다
  if (ver >= 7) {
    const bits = versionBits(ver)
    for (let i = 0; i < 18; i++) {
      const dark = getBit(bits, i)
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      setFunction(a, b, dark)
      setFunction(b, a, dark)
    }
  }

  // 데이터 배치: 오른쪽 아래부터 두 칸 폭으로 위아래를 번갈아 훑는다 (세로 타이밍 열은 건너뜀)
  let bitIndex = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vert : vert
        if (!isFunction[y][x] && bitIndex < codewords.length * 8) {
          modules[y][x] = getBit(codewords[bitIndex >>> 3], 7 - (bitIndex & 7))
          bitIndex++
        }
      }
    }
  }

  const applyMask = (mask: number): void => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!isFunction[y][x] && maskApplies(mask, x, y)) modules[y][x] = !modules[y][x]
      }
    }
  }
  let bestMask = 0
  let bestScore = Infinity
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask)
    drawFormat(mask)
    const score = penaltyScore(modules)
    if (score < bestScore) {
      bestScore = score
      bestMask = mask
    }
    applyMask(mask) // 되돌린다 (XOR)
  }
  applyMask(bestMask)
  drawFormat(bestMask)
  return { version: ver, size, mask: bestMask, modules }
}

/** 행렬 → SVG 문자열 (흰 바탕 + 검은 칸을 가로 줄 단위 경로 하나로, 둘레 흰 여백 4칸) */
export function qrToSvg(qr: QrCode, border = 4): string {
  const total = qr.size + border * 2
  const parts: string[] = []
  for (let y = 0; y < qr.size; y++) {
    let x = 0
    while (x < qr.size) {
      if (!qr.modules[y][x]) {
        x++
        continue
      }
      let end = x
      while (end < qr.size && qr.modules[y][end]) end++
      parts.push(`M${x + border} ${y + border}h${end - x}v1h${x - end}z`)
      x = end
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" fill="#fff"/><path d="${parts.join('')}" fill="#000"/></svg>`
  )
}

/** 문자열 → QR SVG */
export function makeQrSvg(text: string): string {
  return qrToSvg(encodeQr(text))
}
