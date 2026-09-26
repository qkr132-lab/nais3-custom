import { readFileSync } from 'node:fs'
import sharp from 'sharp'
import {
  decodeYolo,
  letterbox,
  nms,
  partOfLabel,
  unletterbox,
  type Detection
} from '../../shared/censor'
import { parseImgsz, parseNames, readOnnxMetadata } from './onnx-meta'

/**
 * 검열 부위 탐지기 (커스텀) — YOLO ONNX 모델을 onnxruntime-node(CPU)로 돌린다.
 * 추론은 비동기라 메인 프로세스에서 돌려도 화면이 멈추지 않는다.
 *
 * onnxruntime-node가 없는 환경(인텔 맥 — 1.24부터 x64 맥 바이너리가 빠졌다)에선 불러오기가
 * 실패하고, 그때는 기능을 끈 채 이유를 알려준다.
 */

type Ort = typeof import('onnxruntime-node')
type Session = Awaited<ReturnType<Ort['InferenceSession']['create']>>

let ortPromise: Promise<Ort | null> | null = null
let ortError = ''

export function loadOrt(): Promise<Ort | null> {
  ortPromise ??= import('onnxruntime-node')
    .then((m) => (m as unknown as { default?: Ort }).default ?? (m as unknown as Ort))
    .catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e)
      // 윈도우에서 DLL을 못 찾으면 대개 VC++ 런타임이 없어서다 (설치본은 곁에 두지만 지워졌을 때 등)
      ortError =
        process.platform === 'win32' &&
        /specified (module|procedure) could not be found/i.test(message)
          ? 'Microsoft Visual C++ 2015-2022 재배포 가능 패키지(x64)를 설치한 뒤 다시 여세요'
          : message
      // 다음 호출 때 다시 시도한다
      ortPromise = null
      return null
    })
  return ortPromise
}

/** 탐지 실행기를 쓸 수 없는 이유 (쓸 수 있으면 빈 문자열) */
export async function runtimeProblem(): Promise<string> {
  const ort = await loadOrt()
  return ort ? '' : `탐지 실행기를 불러오지 못했습니다 (${ortError || '지원하지 않는 기기'})`
}

export interface DetectorInfo {
  labels: string[]
  /** 입력 한 변 크기 */
  size: number
}

/** 모델 파일에서 라벨·입력 크기 — ultralytics 메타데이터가 없으면 넘겨준 기본값 */
export function readModelInfo(path: string, fallback?: Partial<DetectorInfo>): DetectorInfo {
  const meta = readOnnxMetadata(readFileSync(path))
  const labels = parseNames(meta.names) ?? fallback?.labels
  if (!labels?.length) throw new Error('모델에서 라벨 이름을 읽지 못했습니다')
  return { labels, size: parseImgsz(meta.imgsz) ?? fallback?.size ?? 640 }
}

export interface DetectResult {
  width: number
  height: number
  detections: Detection[]
}

export class Detector {
  private constructor(
    private readonly ort: Ort,
    private readonly session: Session,
    readonly info: DetectorInfo
  ) {}

  static async open(path: string, fallback?: Partial<DetectorInfo>): Promise<Detector> {
    const ort = await loadOrt()
    if (!ort) throw new Error(await runtimeProblem())
    const info = readModelInfo(path, fallback)
    const session = await ort.InferenceSession.create(path, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all'
    })
    return new Detector(ort, session, info)
  }

  /**
   * 부위 박스를 찾는다 — conf 이상인 것만 (부위별 기준은 호출 쪽에서 한 번 더 거른다).
   * ultralytics와 같게 비율을 지켜 줄이고 114 회색으로 채운다.
   */
  async detect(input: string | Buffer, conf: number): Promise<DetectResult> {
    const meta = await sharp(input, { failOn: 'none' }).metadata()
    const width = meta.width ?? 0
    const height = meta.height ?? 0
    if (!width || !height) throw new Error('이미지 크기를 읽지 못했습니다')
    const size = this.info.size
    const lb = letterbox(width, height, size)
    const raw = await sharp(input, { failOn: 'none' })
      .removeAlpha()
      .resize(lb.innerWidth, lb.innerHeight, { fit: 'fill' })
      .extend({
        top: lb.padY,
        bottom: size - lb.innerHeight - lb.padY,
        left: lb.padX,
        right: size - lb.innerWidth - lb.padX,
        background: { r: 114, g: 114, b: 114 }
      })
      .raw()
      .toBuffer()
    const plane = size * size
    const data = new Float32Array(3 * plane)
    for (let i = 0; i < plane; i++) {
      data[i] = raw[i * 3] / 255
      data[plane + i] = raw[i * 3 + 1] / 255
      data[2 * plane + i] = raw[i * 3 + 2] / 255
    }
    const feeds = {
      [this.session.inputNames[0]]: new this.ort.Tensor('float32', data, [1, 3, size, size])
    }
    const out = await this.session.run(feeds)
    const tensor = out[this.session.outputNames[0]]
    const decoded = nms(
      decodeYolo(tensor.data as Float32Array, tensor.dims, this.info.labels.length, conf)
    )
    const detections: Detection[] = []
    for (const d of decoded) {
      const label = this.info.labels[d.labelIndex] ?? ''
      const part = partOfLabel(label)
      if (!part) continue
      detections.push({
        box: unletterbox(d.box, lb),
        part,
        label,
        score: d.score,
        source: 'detector'
      })
    }
    return { width, height, detections }
  }

  async close(): Promise<void> {
    await this.session.release().catch(() => undefined)
  }
}
