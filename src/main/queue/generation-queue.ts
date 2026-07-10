import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import type { GenerationRequest, QueueItem, QueueStatus } from '../../shared/types'
import { RateLimitError } from '../nai/client'

/** 429 재시도 상한 (커스텀) */
const MAX_RATE_RETRIES = 6
/** 429 대기 1회 상한 (Retry-After가 과하게 길어도 여기서 자름) */
const MAX_RATE_WAIT_MS = 30_000
/** 생성 취소(abort) 직후 다음 요청까지 쿨다운 — NAI 속도창을 넘겨 429 폭주 예방 */
const ABORT_COOLDOWN_MS = 3_000

/**
 * 생성 큐. 메인 프로세스 상주 — 렌더러가 리로드/크래시해도 큐는 살아있다.
 *
 * NAIS2에서 고치는 버그들의 구조적 해결 지점:
 * - 예약 취소 후 재예약 시 UI와 실제 큐 상태 불일치 → 큐가 단일 진실 공급원, UI는 'changed' 구독만
 * - 씬 모드에서 생성 지연시간 미적용 → 지연은 큐 루프 한 곳에서만 적용
 * - 429(속도 제한) 폭주 → 실패로 버리지 않고 잠시 기다렸다 같은 항목 재시도 (커스텀)
 */
export class GenerationQueue extends EventEmitter {
  private items = new Map<string, QueueItem>()
  private controllers = new Map<string, AbortController>()
  private retries = new Map<string, number>()
  private running = false
  private delayMs = 600
  /** 이 시각(ms epoch) 전까지는 새 요청을 쏘지 않는다 (취소 직후 쿨다운) */
  private cooldownUntil = 0

  constructor(
    private readonly generate: (
      request: GenerationRequest,
      id: string,
      signal: AbortSignal
    ) => Promise<string>
  ) {
    super()
  }

  enqueue(request: GenerationRequest, count: number): string[] {
    const ids: string[] = []
    for (let i = 0; i < count; i++) {
      const id = randomUUID()
      // 배치는 장마다 시드+i — 같은 시드 N장(동일 그림 N장) 방지, 시드 고정 시에도 각 장 재현 가능
      const req = i === 0 ? request : { ...request, seed: (request.seed + i) % 4294967296 }
      this.items.set(id, { id, state: 'pending', request: req })
      ids.push(id)
    }
    this.emitChanged()
    void this.run()
    return ids
  }

  /** 여러 요청을 한 번에 등록 — 씬 예약/큐 반복이 건별 IPC로 넣는 동안 취소가
   *  새로 도착하는 항목을 놓치는 문제 방지 (등록이 원자적이면 취소가 전부 커버) */
  enqueueMany(requests: GenerationRequest[]): string[] {
    const ids: string[] = []
    for (const request of requests) {
      const id = randomUUID()
      this.items.set(id, { id, state: 'pending', request })
      ids.push(id)
    }
    this.emitChanged()
    void this.run()
    return ids
  }

  /**
   * 우선 등록 (커스텀) — 생성 중에 추가한 예약을 맨 뒤가 아니라 "지금 생성 중인 항목 바로 다음"에
   * 끼워넣는다. Map은 삽입 순서를 유지하고 nextPending()이 앞에서부터 스캔하므로,
   * 새 Map을 [생성 중 항목 + 새 항목 + 나머지] 순으로 재구성하면 다음 차례로 올라온다.
   */
  enqueueNext(requests: GenerationRequest[]): string[] {
    const ids: string[] = []
    const fresh: Array<[string, QueueItem]> = requests.map((request) => {
      const id = randomUUID()
      ids.push(id)
      return [id, { id, state: 'pending', request } as QueueItem]
    })
    const entries = [...this.items.entries()]
    // 생성 중 항목의 위치 바로 뒤에 삽입 (없으면 맨 앞)
    const genIdx = entries.findIndex(([, it]) => it.state === 'generating')
    const at = genIdx >= 0 ? genIdx + 1 : 0
    const rebuilt = [...entries.slice(0, at), ...fresh, ...entries.slice(at)]
    this.items = new Map(rebuilt)
    this.emitChanged()
    void this.run()
    return ids
  }

  cancel(ids: string[]): void {
    for (const id of ids) {
      const item = this.items.get(id)
      if (item && item.state === 'pending') {
        item.state = 'cancelled'
      } else if (item && item.state === 'generating') {
        this.controllers.get(id)?.abort()
        // 취소로 서버가 잠시 붐빔 → 다음 요청 전 쿨다운을 걸어 429 폭주 예방
        this.cooldownUntil = Date.now() + ABORT_COOLDOWN_MS
      }
    }
    this.emitChanged()
  }

  setDelayMs(ms: number): void {
    this.delayMs = ms
  }

  status(): QueueStatus {
    return { items: [...this.items.values()], running: this.running, delayMs: this.delayMs }
  }

  private async run(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      let next: QueueItem | undefined
      while ((next = this.nextPending())) {
        // 취소 직후 쿨다운 — 대기 중 이 항목이 취소되면 건너뜀
        const wait = this.cooldownUntil - Date.now()
        if (wait > 0) {
          await sleep(wait)
          if (next.state !== 'pending') continue
        }

        next.state = 'generating'
        const controller = new AbortController()
        this.controllers.set(next.id, controller)
        this.emitChanged()

        let retryMs: number | null = null
        try {
          next.filePath = await this.generate(next.request, next.id, controller.signal)
          next.state = 'done'
        } catch (e) {
          if (controller.signal.aborted || isAbortError(e)) {
            next.state = 'cancelled'
          } else if (e instanceof RateLimitError && (this.retries.get(next.id) ?? 0) < MAX_RATE_RETRIES) {
            retryMs = Math.min(e.retryAfterMs, MAX_RATE_WAIT_MS)
          } else {
            next.state = 'failed'
            next.error = e instanceof Error ? e.message : String(e)
          }
        } finally {
          this.controllers.delete(next.id)
        }

        if (retryMs != null) {
          // 429: 실패로 버리지 않고 pending으로 되돌린 뒤 잠시 대기 → 같은 항목이 다시 잡힘
          this.retries.set(next.id, (this.retries.get(next.id) ?? 0) + 1)
          next.state = 'pending'
          this.emitChanged()
          await sleep(retryMs)
          continue
        }

        this.retries.delete(next.id)
        this.emitChanged()
        if (this.nextPending()) {
          await sleep(this.delayMs)
        }
      }
    } finally {
      this.running = false
      this.emitChanged()
    }
  }

  private nextPending(): QueueItem | undefined {
    for (const item of this.items.values()) {
      if (item.state === 'pending') return item
    }
    return undefined
  }

  private emitChanged(): void {
    this.emit('changed', this.status())
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isAbortError(e: unknown): boolean {
  return (
    e instanceof Error && (e.name === 'AbortError' || e.message.toLowerCase().includes('abort'))
  )
}
