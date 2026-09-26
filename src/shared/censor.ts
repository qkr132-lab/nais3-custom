/**
 * 자동 검열 (커스텀) — 탐지 결과 해석·박스 넓히기·모자이크를 순수 함수로 둔다 (테스트 가능하게).
 *
 * 흐름: 이미지 → 탐지기(YOLO ONNX)가 부위 박스 → 부위별로 넓혀 모자이크 격자에 맞춤 →
 * 겹치는 박스 합치기 → 모자이크(또는 가림막). 원본 파일은 건드리지 않는다.
 */

export type CensorPart = 'vulva' | 'penis' | 'testicles' | 'anus' | 'nipples'

export const CENSOR_PARTS: { id: CensorPart; label: string; defaultOn: boolean }[] = [
  { id: 'vulva', label: '여성 성기', defaultOn: true },
  { id: 'penis', label: '남성 성기', defaultOn: true },
  { id: 'testicles', label: '고환', defaultOn: true },
  { id: 'anus', label: '항문', defaultOn: true },
  { id: 'nipples', label: '유두', defaultOn: false }
]

/** 모델 라벨 이름 → 검열 부위 (모델마다 이름이 달라 이름으로 맞춘다) */
export function partOfLabel(label: string): CensorPart | null {
  const l = label.toLowerCase()
  if (/pussy|vagina|vulva|clitoris/.test(l)) return 'vulva'
  if (/testic|scrotum|balls/.test(l)) return 'testicles'
  if (/penis|dick|cock/.test(l)) return 'penis'
  if (/anus|anal/.test(l)) return 'anus'
  if (/nipple/.test(l)) return 'nipples'
  return null
}

export interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** 검열 방식 — 모자이크·검은 막대·흰 가림은 이 PC에서 바로, NAI는 인페인팅으로 검열 태그를 그린다 */
export type CensorMethod = 'mosaic' | 'black' | 'white' | 'nai'

/** 자동 검열 설정 — settings의 censor_options에 JSON으로 저장 */
export interface CensorOptions {
  /** 원본 폴더 */
  folder: string
  /** 하위 폴더까지 */
  recursive: boolean
  /** 저장 폴더 — 비우면 원본 폴더 옆 "<이름>_검열" */
  outputFolder: string
  parts: CensorPart[]
  method: CensorMethod
  /** 모자이크 칸 배율 (1 = 긴 변 1/100) */
  mosaicScale: number
  /** 가리는 범위 배율 (1 = 부위별 기본) */
  expandScale: number
  /** 민감도 — 높이면 더 많이 잡고 엉뚱한 곳도 더 가린다 */
  sensitivity: 'normal' | 'high'
  /** 항문·남성 성기 보강 모델도 함께 (받아서 씀, 5.9MB) */
  extraModel: boolean
  /** 이 PC의 Gemma로 낮은 점수 박스를 한 번 더 확인 (여성 성기를 더 잘 찾는다) */
  gemma: boolean
  /** 아무것도 안 찾은 그림도 저장 폴더에 그대로 복사 */
  copyClean: boolean
  /** 저장 폴더에 같은 이름이 있으면 덮어쓰기 (끄면 건너뜀) */
  overwrite: boolean
  /** NAI 방식에서 그릴 검열 태그 */
  naiTag: 'mosaic censoring' | 'bar censor' | 'blank censor' | 'heart censor'
}

export const DEFAULT_CENSOR_OPTIONS: CensorOptions = {
  folder: '',
  recursive: true,
  outputFolder: '',
  parts: CENSOR_PARTS_DEFAULT(),
  method: 'mosaic',
  mosaicScale: 1,
  expandScale: 1,
  sensitivity: 'normal',
  extraModel: true,
  gemma: false,
  copyClean: true,
  overwrite: false,
  naiTag: 'mosaic censoring'
}

function CENSOR_PARTS_DEFAULT(): CensorPart[] {
  return ['vulva', 'penis', 'testicles', 'anus']
}

/** 저장해둔 설정을 읽어 모르는 값은 기본으로 */
export function normalizeCensorOptions(value: unknown): CensorOptions {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<CensorOptions>
  const d = DEFAULT_CENSOR_OPTIONS
  const num = (x: unknown, lo: number, hi: number, fb: number): number =>
    typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : fb
  const bool = (x: unknown, fb: boolean): boolean => (typeof x === 'boolean' ? x : fb)
  const allParts: CensorPart[] = ['vulva', 'penis', 'testicles', 'anus', 'nipples']
  return {
    folder: typeof v.folder === 'string' ? v.folder : d.folder,
    recursive: bool(v.recursive, d.recursive),
    outputFolder: typeof v.outputFolder === 'string' ? v.outputFolder : d.outputFolder,
    parts: Array.isArray(v.parts) ? allParts.filter((p) => v.parts!.includes(p)) : d.parts,
    method: (['mosaic', 'black', 'white', 'nai'] as const).includes(v.method as CensorMethod)
      ? (v.method as CensorMethod)
      : d.method,
    mosaicScale: num(v.mosaicScale, 1, 4, d.mosaicScale),
    expandScale: num(v.expandScale, 0.8, 2.5, d.expandScale),
    sensitivity: v.sensitivity === 'high' ? 'high' : 'normal',
    extraModel: bool(v.extraModel, d.extraModel),
    gemma: bool(v.gemma, d.gemma),
    copyClean: bool(v.copyClean, d.copyClean),
    overwrite: bool(v.overwrite, d.overwrite),
    naiTag: (['mosaic censoring', 'bar censor', 'blank censor', 'heart censor'] as const).includes(
      v.naiTag as CensorOptions['naiTag']
    )
      ? (v.naiTag as CensorOptions['naiTag'])
      : d.naiTag
  }
}

/** 한 장 처리 결과 */
export interface CensorFileResult {
  /** 원본 폴더 기준 상대 경로 */
  file: string
  status: 'censored' | 'clean' | 'skipped' | 'failed'
  parts: CensorPart[]
  error?: string
}

export interface CensorProgress {
  running: boolean
  phase: 'idle' | 'model' | 'gemma' | 'scan' | 'work' | 'done' | 'cancelled' | 'error'
  done: number
  total: number
  censored: number
  clean: number
  skipped: number
  failed: number
  current: string
  outputFolder: string
  message: string
  /** 모델 받는 중 진행 (0~1) */
  download?: number
}

export interface RawDetection {
  box: Box
  labelIndex: number
  score: number
}

export interface Detection {
  box: Box
  part: CensorPart
  label: string
  score: number
  /** 어디서 나온 박스인지 — 탐지기 기준 이상 / Gemma 확인으로 살린 낮은 점수 */
  source: 'detector' | 'confirmed'
}

const area = (b: Box): number => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0)

export function iou(a: Box, b: Box): number {
  const x0 = Math.max(a.x0, b.x0)
  const y0 = Math.max(a.y0, b.y0)
  const x1 = Math.min(a.x1, b.x1)
  const y1 = Math.min(a.y1, b.y1)
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0)
  const union = area(a) + area(b) - inter
  return union > 0 ? inter / union : 0
}

/**
 * YOLO 출력 해석. 두 모양을 받는다.
 *  - [1, 4+C(+M), N]  ultralytics 검출·분할 (xywh + 클래스 점수, 분할이면 마스크 계수 M개가 뒤에)
 *  - [1, N, 6(+M)]    end-to-end(NMS 없는 모델): x0,y0,x1,y1,score,class
 * 좌표는 모델 입력(레터박스) 기준으로 돌려준다.
 */
export function decodeYolo(
  data: ArrayLike<number>,
  dims: readonly number[],
  numClasses: number,
  conf: number
): RawDetection[] {
  const out: RawDetection[] = []
  if (dims.length !== 3) return out
  const [, a, b] = dims
  const endToEnd = a !== 4 + numClasses && b >= 6 && b <= 6 + 64 && a > b
  if (endToEnd) {
    for (let i = 0; i < a; i++) {
      const o = i * b
      const score = data[o + 4]
      if (!(score >= conf)) continue
      out.push({
        box: { x0: data[o], y0: data[o + 1], x1: data[o + 2], y1: data[o + 3] },
        labelIndex: Math.round(data[o + 5]),
        score
      })
    }
    return out
  }
  const N = b
  for (let i = 0; i < N; i++) {
    let best = -1
    let bestScore = 0
    for (let c = 0; c < numClasses; c++) {
      const s = data[(4 + c) * N + i]
      if (s > bestScore) {
        bestScore = s
        best = c
      }
    }
    if (best < 0 || !(bestScore >= conf)) continue
    const cx = data[i]
    const cy = data[N + i]
    const w = data[2 * N + i]
    const h = data[3 * N + i]
    out.push({
      box: { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 },
      labelIndex: best,
      score: bestScore
    })
  }
  return out
}

/** 클래스별 NMS (ultralytics 기본과 같게 클래스끼리만 겹침 제거) */
export function nms(dets: RawDetection[], threshold = 0.7): RawDetection[] {
  const sorted = [...dets].sort((a, b) => b.score - a.score)
  const kept: RawDetection[] = []
  for (const d of sorted) {
    if (kept.some((k) => k.labelIndex === d.labelIndex && iou(k.box, d.box) > threshold)) continue
    kept.push(d)
  }
  return kept
}

export interface Letterbox {
  size: number
  scale: number
  padX: number
  padY: number
  /** 줄인 그림 크기 (패딩 제외) */
  innerWidth: number
  innerHeight: number
  width: number
  height: number
}

/** 비율을 지키며 size×size 안에 넣고 가운데 정렬 (ultralytics와 같은 114 회색 패딩은 호출 쪽) */
export function letterbox(width: number, height: number, size: number): Letterbox {
  const scale = Math.min(size / width, size / height)
  const innerWidth = Math.max(1, Math.round(width * scale))
  const innerHeight = Math.max(1, Math.round(height * scale))
  return {
    size,
    scale,
    padX: Math.floor((size - innerWidth) / 2),
    padY: Math.floor((size - innerHeight) / 2),
    innerWidth,
    innerHeight,
    width,
    height
  }
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** 레터박스 좌표 → 원본 이미지 좌표 */
export function unletterbox(box: Box, lb: Letterbox): Box {
  const fx = (x: number): number => clamp((x - lb.padX) / lb.scale, 0, lb.width)
  const fy = (y: number): number => clamp((y - lb.padY) / lb.scale, 0, lb.height)
  return { x0: fx(box.x0), y0: fy(box.y0), x1: fx(box.x1), y1: fy(box.y1) }
}

/** 가운데를 기준으로 factor배 넓히고, 한 변이 minSide보다 작으면 늘린다. 이미지 밖은 자른다 */
export function expandBox(
  box: Box,
  factor: number,
  width: number,
  height: number,
  minSide = 0
): Box {
  const cx = (box.x0 + box.x1) / 2
  const cy = (box.y0 + box.y1) / 2
  const w = Math.max((box.x1 - box.x0) * factor, minSide)
  const h = Math.max((box.y1 - box.y0) * factor, minSide)
  return {
    x0: clamp(cx - w / 2, 0, width),
    y0: clamp(cy - h / 2, 0, height),
    x1: clamp(cx + w / 2, 0, width),
    y1: clamp(cy + h / 2, 0, height)
  }
}

/**
 * 모자이크 칸 크기 — 일본 판매처(FANZA·DLsite) 기준 "긴 변의 1/100, 최소 4px".
 * multiplier로 더 거칠게 할 수 있다.
 */
export function mosaicBlockSize(width: number, height: number, multiplier = 1): number {
  const base = Math.max(4, Math.ceil(Math.max(width, height) / 100))
  return Math.max(4, Math.round(base * Math.max(1, multiplier)))
}

/** 박스를 이미지 전체 격자(block 간격)에 맞춰 바깥쪽으로 넓힌다 — 칸 경계가 박스마다 어긋나지 않게 */
export function alignToGrid(box: Box, block: number, width: number, height: number): Box {
  return {
    x0: clamp(Math.floor(box.x0 / block) * block, 0, width),
    y0: clamp(Math.floor(box.y0 / block) * block, 0, height),
    x1: clamp(Math.ceil(box.x1 / block) * block, 0, width),
    y1: clamp(Math.ceil(box.y1 / block) * block, 0, height)
  }
}

/** 겹치거나 맞닿은 박스를 하나로 합친다 (합쳐진 박스가 또 겹치면 다시 합친다) */
export function mergeBoxes(boxes: Box[]): Box[] {
  const out = boxes.map((b) => ({ ...b }))
  let merged = true
  while (merged) {
    merged = false
    outer: for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]
        const b = out[j]
        if (a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1) {
          out[i] = {
            x0: Math.min(a.x0, b.x0),
            y0: Math.min(a.y0, b.y0),
            x1: Math.max(a.x1, b.x1),
            y1: Math.max(a.y1, b.y1)
          }
          out.splice(j, 1)
          merged = true
          break outer
        }
      }
    }
  }
  return out
}

/** 부위별 기본 넓힘 배율 — 작은 유두는 더 넓게, 남성 성기는 고환 쪽까지 */
export const DEFAULT_EXPAND: Record<CensorPart, number> = {
  vulva: 1.5,
  penis: 1.5,
  testicles: 1.5,
  anus: 1.6,
  nipples: 1.8
}

export interface CensorRegionOptions {
  parts: ReadonlySet<CensorPart>
  /** 부위별 넓힘 배율에 곱하는 전체 배율 (1 = 기본) */
  expandScale: number
  width: number
  height: number
  block: number
}

/** 검열할 영역 — 고른 부위만, 넓히고, 격자에 맞추고, 겹치면 합친다 */
export function censorRegions(dets: Detection[], opts: CensorRegionOptions): Box[] {
  const withTesticles = opts.parts.has('testicles')
  const boxes = dets
    .filter((d) => opts.parts.has(d.part) || (withTesticles && d.part === 'penis'))
    .map((d) => {
      // 고환을 고르면 남성 성기 박스를 더 넓혀 함께 덮는다 (고환만 잡는 모델이 없다)
      const factor =
        DEFAULT_EXPAND[d.part] * opts.expandScale * (d.part === 'penis' && withTesticles ? 1.25 : 1)
      // 한 변은 적어도 모자이크 4칸 — 작은 박스가 한두 칸짜리로 뭉개지지 않게
      const grown = expandBox(d.box, factor, opts.width, opts.height, opts.block * 4)
      return alignToGrid(grown, opts.block, opts.width, opts.height)
    })
    .filter((b) => area(b) > 0)
  return mergeBoxes(boxes)
}

/**
 * 모자이크 — box 안을 block 칸마다 평균색으로 채운다. RGB만 바꾸고 알파는 그대로 둔다
 * (NAI PNG의 알파 채널에 숨은 메타데이터를 덜 건드리게). buf는 제자리에서 바뀐다.
 */
export function pixelateRegion(
  buf: Uint8Array,
  width: number,
  height: number,
  channels: number,
  box: Box,
  block: number
): void {
  const x0 = clamp(Math.floor(box.x0), 0, width)
  const y0 = clamp(Math.floor(box.y0), 0, height)
  const x1 = clamp(Math.ceil(box.x1), 0, width)
  const y1 = clamp(Math.ceil(box.y1), 0, height)
  const color = Math.min(3, channels)
  for (let by = y0; by < y1; by += block) {
    for (let bx = x0; bx < x1; bx += block) {
      const ex = Math.min(bx + block, x1)
      const ey = Math.min(by + block, y1)
      const sum = [0, 0, 0]
      let n = 0
      for (let y = by; y < ey; y++) {
        for (let x = bx; x < ex; x++) {
          const o = (y * width + x) * channels
          for (let c = 0; c < color; c++) sum[c] += buf[o + c]
          n++
        }
      }
      if (!n) continue
      const avg = sum.map((s) => Math.round(s / n))
      for (let y = by; y < ey; y++) {
        for (let x = bx; x < ex; x++) {
          const o = (y * width + x) * channels
          for (let c = 0; c < color; c++) buf[o + c] = avg[c]
        }
      }
    }
  }
}

/** 가림막 — box 안을 한 색으로 채운다 (알파는 그대로) */
export function fillRegion(
  buf: Uint8Array,
  width: number,
  height: number,
  channels: number,
  box: Box,
  rgb: readonly [number, number, number]
): void {
  const x0 = clamp(Math.floor(box.x0), 0, width)
  const y0 = clamp(Math.floor(box.y0), 0, height)
  const x1 = clamp(Math.ceil(box.x1), 0, width)
  const y1 = clamp(Math.ceil(box.y1), 0, height)
  const color = Math.min(3, channels)
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * width + x) * channels
      for (let c = 0; c < color; c++) buf[o + c] = rgb[c]
    }
  }
}

/**
 * 모델별 부위 기준 점수 — 실측으로 정했다 (사용자 NAI 원본 520장, WD 태거 v3 eva02를 심판으로).
 * 보통 기준의 찾은 비율/헛짚은 비율: 여성 성기 81%/5%, 남성 성기 88%/5%, 유두 86%/7%,
 * 항문(보강 모델) 61%/3%. 고환만 잡는 모델은 없어 남성 성기 박스를 넓혀 덮는다.
 */
export interface Thresholds {
  primary: Record<CensorPart, number>
  extra: Record<CensorPart, number>
  /** Gemma가 같은 부위를 봤을 때 살려주는 낮은 점수 */
  confirm: number
}

const NEVER = 2 // 이 모델엔 없는 부위

export function thresholdsFor(sensitivity: 'normal' | 'high'): Thresholds {
  const high = sensitivity === 'high'
  return {
    primary: {
      vulva: high ? 0.08 : 0.15,
      penis: high ? 0.1 : 0.2,
      testicles: NEVER,
      anus: NEVER,
      nipples: high ? 0.1 : 0.2
    },
    extra: {
      vulva: high ? 0.25 : 0.4,
      penis: high ? 0.3 : 0.5,
      testicles: NEVER,
      anus: high ? 0.05 : 0.08,
      nipples: high ? 0.3 : 0.5
    },
    confirm: 0.05
  }
}

/**
 * Gemma 확인을 쓰는 부위 — 실측에서 여성 성기는 확인으로 찾는 비율이 76%→87%로 올랐지만,
 * 유두는 틀린 확인이 더 많았다. Gemma 혼자 본 부위는 대부분 헛짚어 쓰지 않는다.
 */
const GEMMA_CONFIRMS: ReadonlySet<CensorPart> = new Set(['vulva', 'penis', 'anus'])

/**
 * 탐지기 두 개와 Gemma 결과를 합친다.
 *  - 모델 점수가 부위 기준 이상이면 채택
 *  - Gemma가 같은 부위를 봤으면 낮은 점수(confirm 이상) 박스도 채택 (성기·항문만)
 * 고환은 따로 잡는 모델이 없어, 고른 경우 남성 성기 박스를 더 넓혀 함께 덮는다(censorRegions 쪽).
 */
export function combineDetections(input: {
  primary: Detection[]
  extra: Detection[]
  gemma: { part: CensorPart; box: Box }[] | null
  thresholds: Thresholds
}): { accepted: Detection[] } {
  const { thresholds: th } = input
  const gemmaParts = new Set(
    (input.gemma ?? []).map((g) => g.part).filter((p) => GEMMA_CONFIRMS.has(p))
  )
  const accepted: Detection[] = []
  const take = (d: Detection, limit: number): void => {
    if (d.score >= limit) accepted.push({ ...d, source: 'detector' })
    else if (gemmaParts.has(d.part) && d.score >= th.confirm)
      accepted.push({ ...d, source: 'confirmed' })
  }
  for (const d of input.primary) take(d, th.primary[d.part])
  for (const d of input.extra) take(d, th.extra[d.part])
  return { accepted }
}

/**
 * Gemma 응답에서 부위와 박스를 뽑는다. Gemma는 [y1,x1,y2,x2]를 0~1000으로 준다.
 * JSON이 아니거나 모양이 틀린 항목은 버린다.
 */
export function parseGemmaBoxes(
  text: string,
  width: number,
  height: number
): { part: CensorPart; box: Box }[] {
  const m = /\[[\s\S]*\]/.exec(text)
  if (!m) return []
  let items: unknown
  try {
    items = JSON.parse(m[0])
  } catch {
    return []
  }
  if (!Array.isArray(items)) return []
  const out: { part: CensorPart; box: Box }[] = []
  for (const it of items) {
    const label = (it as { label?: unknown })?.label
    const b = (it as { box_2d?: unknown })?.box_2d
    const part = typeof label === 'string' ? partOfLabel(label) : null
    if (!part || !Array.isArray(b) || b.length !== 4 || !b.every((v) => typeof v === 'number'))
      continue
    const [y1, x1, y2, x2] = b as number[]
    const box = {
      x0: clamp((Math.min(x1, x2) / 1000) * width, 0, width),
      y0: clamp((Math.min(y1, y2) / 1000) * height, 0, height),
      x1: clamp((Math.max(x1, x2) / 1000) * width, 0, width),
      y1: clamp((Math.max(y1, y2) / 1000) * height, 0, height)
    }
    if (area(box) > 0) out.push({ part, box })
  }
  return out
}
