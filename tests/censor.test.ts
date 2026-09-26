import { describe, expect, it } from 'vitest'
import {
  alignToGrid,
  censorRegions,
  combineDetections,
  decodeYolo,
  expandBox,
  fillRegion,
  letterbox,
  mergeBoxes,
  mosaicBlockSize,
  nms,
  normalizeCensorOptions,
  parseGemmaBoxes,
  partOfLabel,
  pixelateRegion,
  thresholdsFor,
  unletterbox,
  type Detection
} from '../src/shared/censor'
import { parseImgsz, parseNames, readOnnxMetadata } from '../src/main/censor/onnx-meta'

const det = (
  part: Detection['part'],
  score: number,
  box = { x0: 10, y0: 10, x1: 30, y1: 30 }
): Detection => ({
  box,
  part,
  label: part,
  score,
  source: 'detector'
})

describe('모델 라벨 → 검열 부위', () => {
  it('모델마다 다른 이름을 부위로 맞춘다', () => {
    expect(partOfLabel('pussy')).toBe('vulva')
    expect(partOfLabel('vagina')).toBe('vulva')
    expect(partOfLabel('nipple_f')).toBe('nipples')
    expect(partOfLabel('testicles')).toBe('testicles')
    expect(partOfLabel('anus')).toBe('anus')
    expect(partOfLabel('female face')).toBeNull()
    expect(partOfLabel('pubic hair')).toBeNull()
  })
})

describe('YOLO 출력 해석', () => {
  it('[1, 4+C, N] — 가장 높은 클래스, 기준 미만은 버림', () => {
    // N=2, C=2. 열 우선: [cx..., cy..., w..., h..., c0..., c1...]
    const data = [100, 300, 100, 300, 20, 40, 20, 40, 0.9, 0.1, 0.05, 0.2]
    const out = decodeYolo(data, [1, 6, 2], 2, 0.25)
    expect(out).toHaveLength(1)
    expect(out[0].labelIndex).toBe(0)
    expect(out[0].box).toEqual({ x0: 90, y0: 90, x1: 110, y1: 110 })
  })

  it('분할 모델처럼 뒤에 마스크 계수가 붙어도 클래스 수만큼만 본다', () => {
    const N = 1
    const C = 2
    const data = [50, 50, 10, 10, 0.1, 0.8, ...Array(32).fill(5)]
    const out = decodeYolo(data, [1, 4 + C + 32, N], C, 0.25)
    expect(out).toHaveLength(1)
    expect(out[0].labelIndex).toBe(1)
    expect(out[0].score).toBeCloseTo(0.8)
  })

  it('end-to-end [1, N, 6] 모양도 읽는다', () => {
    const data = [1, 2, 3, 4, 0.7, 2, 0, 0, 0, 0, 0.01, 1, ...Array(6 * 298).fill(0)]
    const out = decodeYolo(data, [1, 300, 6], 3, 0.25)
    expect(out).toEqual([{ box: { x0: 1, y0: 2, x1: 3, y1: 4 }, labelIndex: 2, score: 0.7 }])
  })

  it('NMS는 같은 클래스끼리만 겹침을 지운다', () => {
    const a = { box: { x0: 0, y0: 0, x1: 10, y1: 10 }, labelIndex: 0, score: 0.9 }
    const b = { box: { x0: 1, y0: 1, x1: 10, y1: 10 }, labelIndex: 0, score: 0.5 }
    const c = { box: { x0: 1, y0: 1, x1: 10, y1: 10 }, labelIndex: 1, score: 0.5 }
    expect(nms([b, a, c])).toEqual([a, c])
  })
})

describe('레터박스', () => {
  it('비율을 지켜 넣고 좌표를 되돌린다', () => {
    const lb = letterbox(832, 1216, 640)
    expect(lb.innerHeight).toBe(640)
    expect(lb.padY).toBe(0)
    expect(lb.padX).toBe(Math.floor((640 - lb.innerWidth) / 2))
    const back = unletterbox({ x0: lb.padX, y0: 0, x1: lb.padX + lb.innerWidth, y1: 640 }, lb)
    expect(back.x0).toBeCloseTo(0)
    expect(back.x1).toBeCloseTo(832, 0)
    expect(back.y1).toBeCloseTo(1216, 0)
  })
})

describe('가릴 영역', () => {
  it('모자이크 칸은 긴 변의 1/100, 최소 4px', () => {
    expect(mosaicBlockSize(1024, 1024)).toBe(11)
    expect(mosaicBlockSize(832, 1216)).toBe(13)
    expect(mosaicBlockSize(300, 200)).toBe(4)
    expect(mosaicBlockSize(1024, 1024, 2)).toBe(22)
  })

  it('넓히기는 가운데 기준, 최소 한 변, 이미지 밖은 자름', () => {
    expect(expandBox({ x0: 40, y0: 40, x1: 60, y1: 60 }, 2, 100, 100)).toEqual({
      x0: 30,
      y0: 30,
      x1: 70,
      y1: 70
    })
    expect(expandBox({ x0: 0, y0: 0, x1: 10, y1: 10 }, 1, 100, 100, 40)).toEqual({
      x0: 0,
      y0: 0,
      x1: 25,
      y1: 25
    })
  })

  it('격자 맞춤과 겹친 박스 합치기', () => {
    expect(alignToGrid({ x0: 13, y0: 5, x1: 29, y1: 21 }, 10, 100, 100)).toEqual({
      x0: 10,
      y0: 0,
      x1: 30,
      y1: 30
    })
    expect(
      mergeBoxes([
        { x0: 0, y0: 0, x1: 10, y1: 10 },
        { x0: 50, y0: 50, x1: 60, y1: 60 },
        { x0: 10, y0: 5, x1: 20, y1: 15 }
      ])
    ).toEqual([
      { x0: 0, y0: 0, x1: 20, y1: 15 },
      { x0: 50, y0: 50, x1: 60, y1: 60 }
    ])
  })

  it('고른 부위만, 고환을 고르면 남성 성기 박스로 함께 덮는다', () => {
    const dets = [det('nipples', 0.9), det('penis', 0.9, { x0: 100, y0: 100, x1: 140, y1: 140 })]
    const base = { expandScale: 1, width: 400, height: 400, block: 4 }
    expect(censorRegions(dets, { ...base, parts: new Set(['vulva']) })).toEqual([])
    const withBalls = censorRegions(dets, { ...base, parts: new Set(['testicles']) })
    expect(withBalls).toHaveLength(1)
    expect(withBalls[0].x0).toBeLessThan(100)
    const onlyPenis = censorRegions(dets, { ...base, parts: new Set(['penis']) })
    // 고환까지 덮을 때가 더 넓다
    expect(withBalls[0].x1 - withBalls[0].x0).toBeGreaterThan(onlyPenis[0].x1 - onlyPenis[0].x0)
  })
})

describe('모자이크·가림막', () => {
  it('칸마다 평균색, 알파는 그대로', () => {
    const w = 4
    const h = 2
    const buf = new Uint8Array(w * h * 4)
    for (let i = 0; i < w * h; i++) buf.set([i * 10, 0, 0, 200 + i], i * 4)
    pixelateRegion(buf, w, h, 4, { x0: 0, y0: 0, x1: 2, y1: 2 }, 2)
    // (0,0)(1,0)(0,1)(1,1) = 0,10,40,50 → 평균 25
    expect(buf[0]).toBe(25)
    expect(buf[4]).toBe(25)
    expect(buf[16]).toBe(25)
    expect(buf[3]).toBe(200) // 알파 유지
    expect(buf[8]).toBe(20) // 영역 밖
  })

  it('가림막은 한 색으로', () => {
    const buf = new Uint8Array(2 * 1 * 3).fill(7)
    fillRegion(buf, 2, 1, 3, { x0: 1, y0: 0, x1: 2, y1: 1 }, [0, 0, 0])
    expect([...buf]).toEqual([7, 7, 7, 0, 0, 0])
  })
})

describe('탐지기 + Gemma 합치기', () => {
  const th = thresholdsFor('normal')

  it('기준 이상만 채택, Gemma가 본 성기는 낮은 점수도 살린다', () => {
    const low = det('vulva', 0.08)
    expect(
      combineDetections({ primary: [low], extra: [], gemma: null, thresholds: th }).accepted
    ).toEqual([])
    const confirmed = combineDetections({
      primary: [low],
      extra: [],
      gemma: [{ part: 'vulva', box: low.box }],
      thresholds: th
    })
    expect(confirmed.accepted[0].source).toBe('confirmed')
  })

  it('유두는 Gemma 확인으로 살리지 않는다 (실측에서 틀린 확인이 더 많았다)', () => {
    const low = det('nipples', 0.08)
    const r = combineDetections({
      primary: [low],
      extra: [],
      gemma: [{ part: 'nipples', box: low.box }],
      thresholds: th
    })
    expect(r.accepted).toEqual([])
  })

  it('Gemma 혼자 본 부위는 가리지 않는다', () => {
    const gemma = [{ part: 'anus' as const, box: { x0: 0, y0: 0, x1: 5, y1: 5 } }]
    expect(combineDetections({ primary: [], extra: [], gemma, thresholds: th })).toEqual({
      accepted: []
    })
  })

  it('보강 모델은 자기 기준으로 — 항문은 보강 모델에서만', () => {
    const r = combineDetections({
      primary: [det('anus', 0.9)],
      extra: [det('anus', 0.3)],
      gemma: null,
      thresholds: th
    })
    expect(r.accepted).toHaveLength(1)
    expect(r.accepted[0].score).toBe(0.3)
  })
})

describe('Gemma 응답 읽기', () => {
  it('[y1,x1,y2,x2] 0~1000 → 픽셀, 모르는 라벨·틀린 모양은 버림', () => {
    const text =
      'sure: [{"label":"nipple","box_2d":[100,200,150,260]},{"label":"face","box_2d":[0,0,10,10]},{"label":"penis","box_2d":[1,2]}]'
    expect(parseGemmaBoxes(text, 1000, 2000)).toEqual([
      { part: 'nipples', box: { x0: 200, y0: 200, x1: 260, y1: 300 } }
    ])
    expect(parseGemmaBoxes('없음', 100, 100)).toEqual([])
  })
})

describe('설정 읽기', () => {
  it('모르는 값은 기본값, 범위 밖은 자름', () => {
    const o = normalizeCensorOptions({ method: 'laser', mosaicScale: 99, parts: ['vulva', 'x'] })
    expect(o.method).toBe('mosaic')
    expect(o.mosaicScale).toBe(4)
    expect(o.parts).toEqual(['vulva'])
    expect(normalizeCensorOptions(null).parts).toEqual(['vulva', 'penis', 'testicles', 'anus'])
  })
})

describe('ONNX 메타데이터', () => {
  // ModelProto { ir_version=1: 7, metadata_props=14: {key, value} } 를 손으로 짠다
  const enc = (s: string): number[] => [...new TextEncoder().encode(s)]
  const field = (num: number, bytes: number[]): number[] => [(num << 3) | 2, bytes.length, ...bytes]
  const entry = (k: string, v: string): number[] =>
    field(14, [...field(1, enc(k)), ...field(2, enc(v))])

  it('names·imgsz를 읽는다', () => {
    const buf = new Uint8Array([
      0x08,
      7,
      ...entry('names', "{0: 'nipples', 1: 'pussy'}"),
      ...entry('imgsz', '[1024, 1024]')
    ])
    const meta = readOnnxMetadata(buf)
    expect(parseNames(meta.names)).toEqual(['nipples', 'pussy'])
    expect(parseImgsz(meta.imgsz)).toBe(1024)
  })

  it('깨진 파일이어도 던지지 않는다', () => {
    expect(readOnnxMetadata(new Uint8Array([0xff, 0xff, 0xff]))).toEqual({})
    expect(parseNames('nothing')).toBeNull()
  })
})
