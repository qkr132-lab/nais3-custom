import { app } from 'electron'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

let worker: Worker | null = null
let sequence = 0
const pending = new Map<
  number,
  {
    resolve: (counts: number[]) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }
>()

function stop(error: Error): void {
  const old = worker
  worker = null
  for (const job of pending.values()) {
    clearTimeout(job.timer)
    job.reject(error)
  }
  pending.clear()
  if (old) {
    old.removeAllListeners()
    void old.terminate()
  }
}

function start(): Worker {
  if (worker) return worker
  const root = app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked')
  const next = new Worker(join(__dirname, 'nai-token-worker.js'), {
    workerData: { resourcesDir: join(root, 'resources') }
  })
  worker = next
  next.unref()
  next.on('error', stop)
  next.on('exit', (code) => {
    if (worker === next) stop(new Error(`Token worker exited (${code})`))
  })
  next.on('message', (message: { id: number; counts?: number[]; error?: string }) => {
    const job = pending.get(message.id)
    if (!job) return
    pending.delete(message.id)
    clearTimeout(job.timer)
    if (message.error) job.reject(new Error(message.error))
    else job.resolve(message.counts ?? [])
  })
  return next
}

export function countTokenTexts(model: string, texts: string[]): Promise<number[]> {
  if (!texts.length) return Promise.resolve([])
  if (pending.size >= 64) return Promise.reject(new Error('Token worker is busy'))
  return new Promise((resolve, reject) => {
    try {
      const next = start()
      const id = ++sequence
      const timer = setTimeout(() => stop(new Error('Token calculation timed out')), 30000)
      timer.unref()
      pending.set(id, { resolve, reject, timer })
      next.postMessage({ id, model, texts })
    } catch (error) {
      const reason = error instanceof Error ? error : new Error(String(error))
      stop(reason)
      reject(reason)
    }
  })
}
