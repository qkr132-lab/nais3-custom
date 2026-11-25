/**
 * 그림 blob URL 캐시.
 *
 * 그림 요청에는 Authorization 헤더가 필요해서 <img src> 로 못 쓰고, fetch → blob → URL 로 바꿔 쓴다.
 * - 같은 키를 동시에 요청하면 한 번만 가져온다 (참조 수 세기).
 * - 화면 밖으로 나가 참조가 0 이 되면 바로 지우지 않고 「놀고 있는 목록」에 둔다. 한도를 넘기면 오래된 것부터
 *   revoke 한다. 그 사이에 다시 보이면 다시 받지 않는다.
 * - 동시 요청 수를 제한해서(기본 4) 단일 서버를 한꺼번에 두드리지 않는다.
 * - 시작 전에 참조가 0 이 된 요청(빠르게 스크롤해 지나간 것)은 가져오지 않고 취소한다.
 */

export class CancelledError extends Error {
  constructor() {
    super('취소됨')
    this.name = 'CancelledError'
  }
}

export function isCancelled(err: unknown): boolean {
  return err instanceof CancelledError
}

export type Limiter = <T>(fn: () => Promise<T>, opts?: { front?: boolean }) => Promise<T>

/** 동시에 max 개까지만 실행하는 대기열. front 면 맨 앞으로 끼어든다 */
export function createLimiter(max: number): Limiter {
  let running = 0
  const queue: Array<() => void> = []
  const next = (): void => {
    while (running < max && queue.length) {
      const start = queue.shift()!
      running++
      start()
    }
  }
  return <T>(fn: () => Promise<T>, opts?: { front?: boolean }): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const start = (): void => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            running--
            next()
          })
      }
      if (opts?.front) queue.unshift(start)
      else queue.push(start)
      next()
    })
}

interface Entry {
  key: string
  refs: number
  url: string | null
  blob: Blob | null
  bytes: number
  promise: Promise<string>
}

export interface ImageCacheOptions {
  /** 놀고 있는 그림 전체 크기 한도 (바이트) */
  maxIdleBytes?: number
  /** 놀고 있는 그림 개수 한도 */
  maxIdleCount?: number
  /** 동시 요청 수 */
  concurrency?: number
  createUrl?: (blob: Blob) => string
  revokeUrl?: (url: string) => void
}

export class ImageCache {
  private readonly entries = new Map<string, Entry>()
  /** 참조 0 으로 놀고 있는 키 — 앞쪽일수록 오래됨 */
  private readonly idle = new Set<string>()
  private readonly limit: Limiter
  private readonly maxIdleBytes: number
  private readonly maxIdleCount: number
  private readonly createUrl: (blob: Blob) => string
  private readonly revokeUrl: (url: string) => void

  constructor(opts: ImageCacheOptions = {}) {
    this.maxIdleBytes = opts.maxIdleBytes ?? 32 * 1024 * 1024
    this.maxIdleCount = opts.maxIdleCount ?? 160
    this.limit = createLimiter(opts.concurrency ?? 4)
    this.createUrl = opts.createUrl ?? ((b) => URL.createObjectURL(b))
    this.revokeUrl = opts.revokeUrl ?? ((u) => URL.revokeObjectURL(u))
  }

  /**
   * 키의 blob URL 을 얻는다. 얻은 쪽은 쓰고 나면 release(key) 를 한 번 부른다.
   * 취소되면 CancelledError 로 거절된다 (조용히 무시하면 됨).
   */
  acquire(key: string, load: () => Promise<Blob>, opts?: { priority?: boolean }): Promise<string> {
    const existing = this.entries.get(key)
    if (existing) {
      existing.refs++
      this.idle.delete(key)
      return existing.promise
    }
    const entry: Entry = { key, refs: 1, url: null, blob: null, bytes: 0, promise: null as never }
    this.entries.set(key, entry)
    entry.promise = this.limit(
      async () => {
        if (entry.refs <= 0) throw new CancelledError()
        const blob = await load()
        entry.blob = blob
        entry.url = this.createUrl(blob)
        entry.bytes = blob.size
        // 가져오는 사이에 다 놓았으면 바로 놀고 있는 목록으로
        if (entry.refs <= 0) this.markIdle(entry)
        return entry.url
      },
      { front: opts?.priority }
    ).catch((err) => {
      if (this.entries.get(key) === entry) this.entries.delete(key)
      throw err
    })
    return entry.promise
  }

  /** 이미 가져온 blob 원본 (저장·공유 때 다시 받지 않으려고). 아직이면 null */
  peekBlob(key: string): Blob | null {
    return this.entries.get(key)?.blob ?? null
  }

  release(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    entry.refs = Math.max(0, entry.refs - 1)
    if (entry.refs === 0 && entry.url) this.markIdle(entry)
  }

  /** 모두 지운다 (연결 해제 때) */
  clear(): void {
    for (const entry of this.entries.values()) if (entry.url) this.revokeUrl(entry.url)
    this.entries.clear()
    this.idle.clear()
  }

  stats(): { entries: number; idle: number; idleBytes: number } {
    return { entries: this.entries.size, idle: this.idle.size, idleBytes: this.idleBytes() }
  }

  private idleBytes(): number {
    let sum = 0
    for (const key of this.idle) sum += this.entries.get(key)?.bytes ?? 0
    return sum
  }

  private markIdle(entry: Entry): void {
    this.idle.delete(entry.key)
    this.idle.add(entry.key)
    while (this.idle.size > this.maxIdleCount || this.idleBytes() > this.maxIdleBytes) {
      const oldest = this.idle.values().next().value
      if (oldest === undefined) break
      this.evict(oldest)
    }
  }

  private evict(key: string): void {
    const entry = this.entries.get(key)
    this.idle.delete(key)
    if (!entry) return
    if (entry.url) this.revokeUrl(entry.url)
    this.entries.delete(key)
  }
}
