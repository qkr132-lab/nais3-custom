import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { app } from 'electron'

/**
 * 자동 검열 탐지 모델 (커스텀).
 *
 * 앱에 싣지 않고 처음 쓸 때 HuggingFace에서 받는다 — 커밋까지 고정한 주소와 SHA256으로 확인.
 * 사용자가 가진 다른 ONNX(ultralytics로 내보낸 검출·분할 모델)도 "사용자 모델"로 쓸 수 있다.
 */

export interface BuiltinModel {
  id: string
  name: string
  url: string
  sha256: string
  bytes: number
  /** 모델 파일에 라벨이 없을 때 쓸 이름 (deepghs 모델은 names만 있고 imgsz가 없다) */
  labels: string[]
  size: number
  license: string
  source: string
}

export const BUILTIN_MODELS: BuiltinModel[] = [
  {
    id: 'deepghs-censor-s',
    name: 'deepghs 애니 검열 탐지 v1.0 (s)',
    url: 'https://huggingface.co/deepghs/anime_censor_detection/resolve/0cf62fd6b28213b40ae0c0055f92e7ae6a96bdc2/censor_detect_v1.0_s/model.onnx',
    sha256: '2c2524824d7d320c5619a0a73702a2e2186f619067c823d211e94f7cfe489cba',
    bytes: 44586353,
    labels: ['nipple_f', 'penis', 'pussy'],
    size: 640,
    license: 'MIT',
    source: 'https://huggingface.co/deepghs/anime_censor_detection'
  },
  {
    // 보강 모델 — 위 모델에 없는 항문을 잡고, 남성 성기도 더 잘 잡는다 (실측 항문 72%, 44ms)
    id: 'miku-nsfw-nano',
    name: '01miku 애니 NSFW 분할 nano',
    url: 'https://huggingface.co/01miku/anime-nsfw-segm-yolo26/resolve/1697d5d1827b6a818b350b44bf3ec27f08837a2a/nsfw-anime-nano-x640.onnx',
    sha256: '570d4a1ee7f1c1a0c5c1221ffd20fd73e01e32cafe371e312a8a16353209aa42',
    bytes: 5902685,
    labels: ['anus', 'nipple', 'penis', 'vagina', 'female face', 'male face', 'pubic hair'],
    size: 640,
    license: 'MIT (모델 카드)',
    source: 'https://huggingface.co/01miku/anime-nsfw-segm-yolo26'
  }
]

export function modelsDir(): string {
  return join(app.getPath('userData'), 'censor-models')
}

export function builtinPath(id: string): string {
  return join(modelsDir(), id, 'model.onnx')
}

export function isInstalled(model: BuiltinModel): boolean {
  const path = builtinPath(model.id)
  return existsSync(path) && statSync(path).size === model.bytes
}

const downloads = new Map<string, Promise<void>>()

/**
 * 모델 받기 — 임시 파일에 받으며 SHA256을 재고, 맞으면 이름을 바꿔 확정한다.
 * 이미 받는 중이면 그 작업을 기다린다.
 */
export function downloadModel(
  model: BuiltinModel,
  onProgress: (received: number, total: number) => void
): Promise<void> {
  if (isInstalled(model)) return Promise.resolve()
  const running = downloads.get(model.id)
  if (running) return running
  const job = (async () => {
    const dir = join(modelsDir(), model.id)
    mkdirSync(dir, { recursive: true })
    const temp = join(dir, `model.onnx.${process.pid}.part`)
    try {
      const res = await fetch(model.url, { signal: AbortSignal.timeout(10 * 60 * 1000) })
      if (!res.ok || !res.body) throw new Error(`모델을 받지 못했습니다 (HTTP ${res.status})`)
      const total = Number(res.headers.get('content-length')) || model.bytes
      const hash = createHash('sha256')
      let received = 0
      let last = 0
      const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)
      body.on('data', (chunk: Buffer) => {
        hash.update(chunk)
        received += chunk.length
        if (received > model.bytes * 1.1)
          body.destroy(new Error('모델 파일 크기가 예상과 다릅니다'))
        const now = Date.now()
        if (now - last > 200) {
          last = now
          onProgress(received, total)
        }
      })
      await pipeline(body, createWriteStream(temp, { flags: 'w' }))
      const digest = hash.digest('hex')
      if (digest !== model.sha256 || received !== model.bytes) {
        throw new Error('받은 모델 파일이 손상됐습니다 (SHA256 불일치)')
      }
      renameSync(temp, builtinPath(model.id))
      onProgress(received, total)
    } finally {
      rmSync(temp, { force: true })
    }
  })().finally(() => {
    downloads.delete(model.id)
  })
  downloads.set(model.id, job)
  return job
}
