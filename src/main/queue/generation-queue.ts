import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import type {
  GenerationRequest,
  QueueItem,
  QueueStatus,
  QueueStatusLite,
  TurboNotice,
  TurboStatus
} from '../../shared/types'
import { RateLimitError } from '../nai/client'

/** 429 재시도 상한 (커스텀) */
const MAX_RATE_RETRIES = 6
/** 429 대기 1회 상한 (Retry-After가 과하게 길어도 여기서 자름) */
const MAX_RATE_WAIT_MS = 30_000
/** 생성 취소(abort) 직후 다음 요청까지 쿨다운 — NAI 속도창을 넘겨 429 폭주 예방 */
const ABORT_COOLDOWN_MS = 3_000
/** 고속 모드에서 뺀 계정을 다시 확인하는 간격 — 한도 조회 간격(account-switch 20초)보다 조금 길게 */
const TURBO_RECHECK_MS = 21_000
/** 고속 모드가 꺼져 있을 때 일하는 단일 작업자의 이름 */
const DEFAULT_LANE = 'default'

/** 작업자 한 명이 지금 쓰는 계정. accountId 가 null 이면 활성 계정(고속 모드 꺼짐 — 예전 그대로) */
export interface LaneInfo {
  accountId: string | null
  label: string
}

export type GenerateFn = (
  request: GenerationRequest,
  id: string,
  signal: AbortSignal,
  lane: LaneInfo
) => Promise<string>

/** 고속 모드 판정 결과 — Anlas 가 나갈 수 있으면 보내지 않는다 */
export type TurboVerdict =
  | { ok: true; /** 한도를 실제로 확인했는가 (V5 가 아니면 확인하지 않는다) */ checked: boolean }
  | { ok: false; reason: 'exhausted' | 'unknown' }

/**
 * 고속 모드(번개 버튼) 연결부 (커스텀). 큐는 NAI 를 모르고, 계정에 관한 것은 이 훅에게만 묻는다.
 * 훅이 없거나 꺼져 있으면 큐는 예전처럼 작업자 하나로 차례대로 뽑는다.
 */
export interface TurboHooks {
  /** 고속 모드 저장값이 켜져 있는가 */
  enabled(): boolean
  /** 작업자로 쓸 계정 (토큰이 있는 것) */
  accounts(): { id: string; label: string }[]
  /** 지금 활성 계정 id — 꺼진 상태의 작업자가 쓰는 계정 */
  activeId(): string | null
  /** 이 계정으로 이 요청을 지금 보내도 되는가 */
  admit(accountId: string, request: GenerationRequest): Promise<TurboVerdict>
}

interface Lane {
  key: string
  accountId: string | null
  label: string
  /** 지금 항목을 생성 중 */
  busy: boolean
  /** 그만두는 중 — 지금 장만 마치고 나간다 (고속 모드를 끄거나 계정이 빠질 때) */
  retire: boolean
  /** 이번에 뜬 뒤로 한도 판정을 한 번 받았다 — 지난 실행의 기록만 믿고 멈추지 않으려고 */
  judged: boolean
}

interface LaneSpec {
  key: string
  accountId: string | null
  label: string
}

/**
 * 생성 큐. 메인 프로세스 상주 — 렌더러가 리로드/크래시해도 큐는 살아있다.
 *
 * NAIS2에서 고치는 버그들의 구조적 해결 지점:
 * - 예약 취소 후 재예약 시 UI와 실제 큐 상태 불일치 → 큐가 단일 진실 공급원, UI는 'changed' 구독만
 * - 씬 모드에서 생성 지연시간 미적용 → 지연은 큐 루프 한 곳에서만 적용
 * - 429(속도 제한) 폭주 → 실패로 버리지 않고 잠시 기다렸다 같은 항목 재시도 (커스텀)
 *
 * 고속 모드(커스텀): 켜면 등록 계정마다 작업자(레인) 하나씩 같은 대기열에서 하나씩 가져간다.
 * 한 계정에는 작업자가 하나뿐이라 한 계정으로 동시에 두 장이 나가는 일은 없다.
 */
export class GenerationQueue extends EventEmitter {
  private items = new Map<string, QueueItem>()
  private controllers = new Map<string, AbortController>()
  private retries = new Map<string, number>()
  /** 일하고 있는 작업자. 고속 꺼짐=기본 레인 하나, 켜짐=계정마다 하나. 비어 있으면 큐는 쉬는 중 */
  private lanes = new Map<string, Lane>()
  /** 지금 있어야 할 작업자 (reconcile 이 갱신) */
  private specs: LaneSpec[] = [{ key: DEFAULT_LANE, accountId: null, label: '' }]
  /** 고속 모드에서 뺀 계정 (id → 이유). 실행이 끝나도 남겨 ×N 표시와 알림 중복 방지에 쓴다 */
  private excluded = new Map<string, 'exhausted' | 'unknown'>()
  /** 모든 계정이 빠져 멈추는 중 — 작업자들이 지금 장만 마치고 나간다 */
  private stopped = false
  private delayMs = 600
  /** 이 시각(ms epoch) 전까지는 새 요청을 쏘지 않는다 (취소 직후 쿨다운) */
  private cooldownUntil = 0
  /** 큐 밖에서 NAI에 요청 중인 수 (자동 검열 NAI) — 0이 될 때까지 새 항목을 시작하지 않는다 */
  private holds = 0
  /** 쉬는 작업자를 일찍 깨우는 손잡이 */
  private wakers = new Set<() => void>()
  private lastTurboJson = ''

  constructor(
    private readonly generate: GenerateFn,
    private readonly hooks?: TurboHooks
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
    this.kick()
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
    this.kick()
    return ids
  }

  /**
   * 우선 등록 (커스텀) — 생성 중에 추가한 예약을 맨 뒤가 아니라 "지금 생성 중인 항목 바로 다음"에
   * 끼워넣는다. Map은 삽입 순서를 유지하고 nextPending()이 앞에서부터 스캔하므로,
   * 새 Map을 [생성 중 항목 + 새 항목 + 나머지] 순으로 재구성하면 다음 차례로 올라온다.
   * 고속 모드로 여러 장이 동시에 생성 중이면 그중 마지막 항목 바로 뒤에 넣는다.
   */
  enqueueNext(requests: GenerationRequest[]): string[] {
    const ids: string[] = []
    const fresh: Array<[string, QueueItem]> = requests.map((request) => {
      const id = randomUUID()
      ids.push(id)
      return [id, { id, state: 'pending', request } as QueueItem]
    })
    const entries = [...this.items.entries()]
    // 생성 중 항목 중 마지막의 바로 뒤에 삽입 (없으면 맨 앞)
    let genIdx = -1
    entries.forEach(([, it], index) => {
      if (it.state === 'generating') genIdx = index
    })
    const at = genIdx >= 0 ? genIdx + 1 : 0
    const rebuilt = [...entries.slice(0, at), ...fresh, ...entries.slice(at)]
    this.items = new Map(rebuilt)
    this.emitChanged()
    this.kick()
    return ids
  }

  /** 대기(pending) 항목의 요청만 최신값으로 교체 (커스텀 — 생성 중 편집 반영).
   *  generating/done/cancelled 은 이미 확정됐으므로 건드리지 않는다. */
  updatePending(updates: { id: string; request: GenerationRequest }[]): void {
    let changed = false
    for (const { id, request } of updates) {
      const item = this.items.get(id)
      if (item && item.state === 'pending') {
        item.request = request
        changed = true
      }
    }
    if (changed) this.emitChanged()
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

  /**
   * 큐 밖에서 NAI에 요청을 보낼 때 (커스텀 — 자동 검열 NAI 모드).
   * 지금 생성 중인 항목이 끝나길 기다렸다가 fn을 돌리고, 그동안 큐는 새 항목을 시작하지 않는다 —
   * 두 요청이 겹쳐 429가 나거나 잔액 비교가 섞이지 않게. 큐 전체가 빌 때까지 기다리지는 않는다.
   */
  async exclusive<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.holds++
    try {
      while ([...this.items.values()].some((i) => i.state === 'generating')) {
        if (signal?.aborted) throw new Error('중단했습니다')
        await sleep(300)
      }
      return await fn()
    } finally {
      this.holds--
    }
  }

  setDelayMs(ms: number): void {
    this.delayMs = ms
  }

  status(): QueueStatus {
    return {
      items: [...this.items.values()],
      running: this.lanes.size > 0,
      delayMs: this.delayMs
    }
  }

  /** 렌더러용 요약 상태 (커스텀 — 성능). 수천 장 큐에서 request(프롬프트 등)까지
   *  매 변경마다 직렬화하면 장마다 렉 — UI에 필요한 최소 필드만 내보낸다. */
  statusLite(): QueueStatusLite {
    const items = [...this.items.values()].map((i) => ({
      id: i.id,
      state: i.state,
      sceneId: i.request.sceneId,
      error: i.error,
      filePath: i.filePath
    }))
    return { items, running: this.lanes.size > 0, delayMs: this.delayMs }
  }

  /** 대기 항목의 전체 request — 재구성(생성 중 편집 반영) 등 상세가 필요할 때만 조회 */
  pendingItems(): { id: string; request: GenerationRequest }[] {
    return [...this.items.values()]
      .filter((i) => i.state === 'pending')
      .map((i) => ({ id: i.id, request: i.request }))
  }

  /** 고속 모드 상태 — 번개 버튼과 ×N 표시용 */
  turboStatus(): TurboStatus {
    const accounts = this.hooks?.accounts() ?? []
    return {
      enabled: this.hooks?.enabled() ?? false,
      accounts: accounts.map((a) => ({ ...a, excluded: this.excluded.has(a.id) }))
    }
  }

  /**
   * 작업자를 지금 설정에 맞춘다 (커스텀). 고속 모드를 켜고 끌 때, 계정을 추가·삭제·바꿀 때 부른다.
   * - 켜면: 계정마다 작업자가 생겨 곧바로 대기 항목을 잡는다. 돌던 기본 작업자는 지금 장만 마치고 나간다.
   * - 끄면: 계정 작업자들은 지금 장만 마치고(취소하지 않는다) 나가고, 그 뒤 기본 작업자 하나가 이어받는다.
   * restart=false 는 이름 바뀜처럼 작업자를 새로 띄울 필요가 없을 때.
   */
  reconcile(restart = true): void {
    this.sync(restart)
    // 지워진 계정의 기록 정리
    if (this.excluded.size > 0) {
      const known = new Set((this.hooks?.accounts() ?? []).map((a) => a.id))
      for (const id of [...this.excluded.keys()]) if (!known.has(id)) this.excluded.delete(id)
    }
    this.emitTurbo()
  }

  /** 새 항목이 들어왔을 때 — 멈춰 있었다면 풀고 작업자를 띄운다 */
  private kick(): void {
    this.stopped = false
    this.sync(true)
  }

  private sync(restart: boolean): void {
    const specs = this.computeSpecs()
    this.specs = specs
    const byKey = new Map(specs.map((s) => [s.key, s]))
    for (const lane of this.lanes.values()) {
      const spec = byKey.get(lane.key)
      lane.retire = !spec
      if (spec) lane.label = spec.label
    }
    if (restart && this.hasPending()) {
      for (const spec of specs) if (!this.lanes.has(spec.key)) this.startLane(spec)
    }
    this.wakeAll()
  }

  private computeSpecs(): LaneSpec[] {
    const hooks = this.hooks
    if (hooks && hooks.enabled()) {
      const accounts = hooks.accounts()
      // 계정이 둘 미만이면 고속 모드를 켜 놓았어도 평소 방식으로 돈다
      if (accounts.length >= 2) {
        return accounts.map((a) => ({ key: a.id, accountId: a.id, label: a.label }))
      }
    }
    return [{ key: DEFAULT_LANE, accountId: null, label: '' }]
  }

  private hasPending(): boolean {
    return this.nextPending() !== undefined
  }

  private startLane(spec: LaneSpec): void {
    const lane: Lane = { ...spec, busy: false, retire: false, judged: false }
    this.lanes.set(lane.key, lane)
    void this.laneLoop(lane)
  }

  /** 작업자 한 명의 루프. 판단하고 나가는 것과 lanes 에서 빠지는 것 사이에 await 가 없어야 한다 —
   *  그래야 방금 들어온 항목을 아무도 안 잡는 틈이 생기지 않는다. */
  private async laneLoop(lane: Lane): Promise<void> {
    try {
      for (;;) {
        if (lane.retire || this.stopped) break
        const next = this.nextPending()
        if (!next) break
        // 큐 밖 요청(자동 검열 NAI)이 끝날 때까지 새 항목을 쏘지 않는다
        if (this.holds > 0) {
          await this.nap(300)
          continue
        }
        // 취소 직후 쿨다운 — 지난 뒤 다시 처음부터 판단 (그 사이 이 항목이 취소됐을 수 있다)
        const wait = this.cooldownUntil - Date.now()
        if (wait > 0) {
          await sleep(wait)
          continue
        }
        // 같은 계정으로 두 장이 겹치지 않게 — 켜고 끄는 순간의 교대 구간
        if (this.blocked(lane)) {
          await this.nap(300)
          continue
        }

        // 고속 모드: 이 계정으로 보내도 Anlas 가 안 나가는지 보내기 직전에 확인
        if (lane.accountId !== null && this.hooks) {
          const verdict = await this.hooks
            .admit(lane.accountId, next.request)
            .catch((): TurboVerdict => ({ ok: false, reason: 'unknown' }))
          // 판정을 기다리는 사이 바뀐 것: 다른 작업자가 가져갔거나, 끄거나, 멈췄다
          if (next.state !== 'pending' || lane.retire || this.stopped) continue
          lane.judged = true
          if (!verdict.ok) {
            // 모든 계정이 빠졌으면 멈춘다. 항목은 대기로 남는다
            if (this.exclude(lane, verdict.reason)) break
            await this.nap(TURBO_RECHECK_MS)
            continue
          }
          if (verdict.checked) this.include(lane)
          if (this.holds > 0 || this.cooldownUntil > Date.now() || this.blocked(lane)) continue
        }

        next.state = 'generating'
        lane.busy = true
        const controller = new AbortController()
        this.controllers.set(next.id, controller)
        this.emitChanged()

        let retryMs: number | null = null
        try {
          next.filePath = await this.generate(next.request, next.id, controller.signal, {
            accountId: lane.accountId,
            label: lane.label
          })
          next.state = 'done'
        } catch (e) {
          if (controller.signal.aborted || isAbortError(e)) {
            next.state = 'cancelled'
          } else if (
            e instanceof RateLimitError &&
            (this.retries.get(next.id) ?? 0) < MAX_RATE_RETRIES
          ) {
            retryMs = Math.min(e.retryAfterMs, MAX_RATE_WAIT_MS)
          } else {
            next.state = 'failed'
            next.error = e instanceof Error ? e.message : String(e)
          }
        } finally {
          this.controllers.delete(next.id)
          lane.busy = false
          this.wakeAll()
        }

        if (retryMs != null) {
          // 429: 실패로 버리지 않고 pending으로 되돌린 뒤 이 작업자만 잠시 쉰다.
          // 그동안 다른 계정의 작업자가 이 항목을 잡아도 된다 (재시도 횟수는 항목에 붙어 간다)
          this.retries.set(next.id, (this.retries.get(next.id) ?? 0) + 1)
          next.state = 'pending'
          this.emitChanged()
          await sleep(retryMs)
          continue
        }

        this.retries.delete(next.id)
        this.emitChanged()
        if (this.nextPending() && !lane.retire && !this.stopped) {
          await sleep(this.delayMs)
        }
      }
    } finally {
      this.lanes.delete(lane.key)
      if (this.lanes.size === 0) this.stopped = false
      this.wakeAll()
      this.emitChanged()
    }
  }

  /**
   * 이 작업자가 지금 시작하면 다른 작업자와 같은 계정으로 겹치는가.
   * 고속 모드를 끄면 기본 작업자(활성 계정)는 계정 작업자들이 다 끝난 뒤에 시작하고,
   * 켜면 활성 계정의 작업자는 돌던 기본 작업자가 끝난 뒤에 시작한다. 나머지 계정은 곧바로 시작.
   */
  private blocked(lane: Lane): boolean {
    for (const other of this.lanes.values()) {
      if (other === lane || !other.busy) continue
      if (lane.accountId === null) return true
      if (other.accountId === null && lane.accountId === this.hooks?.activeId()) return true
    }
    return false
  }

  /** 계정을 뺀다. 참여 계정이 하나도 없게 되면 true(멈춤). 이번에 처음 빠진 것이면 알린다 */
  private exclude(lane: Lane, reason: 'exhausted' | 'unknown'): boolean {
    const id = lane.accountId
    if (id === null) return false
    const first = !this.excluded.has(id)
    this.excluded.set(id, reason)
    if (this.everyoneOut()) {
      this.stopped = true
      this.wakeAll()
      this.emitTurbo({ kind: 'allDropped' })
      return true
    }
    if (first)
      this.emitTurbo({ kind: 'dropped', label: lane.label, reason, active: this.activeCount() })
    else this.emitTurbo()
    return false
  }

  /** 모든 계정이 빠졌는가 — 이번에 아직 판정을 받지 않은 작업자의 옛 기록은 믿지 않는다 */
  private everyoneOut(): boolean {
    return this.specs.every((spec) => {
      if (spec.accountId === null || !this.excluded.has(spec.accountId)) return false
      const lane = this.lanes.get(spec.key)
      return !lane || lane.judged
    })
  }

  /** 한도가 확인된 계정은 다시 넣는다 (알림 없이 ×N 만 바뀐다) */
  private include(lane: Lane): void {
    if (lane.accountId !== null && this.excluded.delete(lane.accountId)) this.emitTurbo()
  }

  /** 지금 참여 중인 계정 수 (×N) */
  private activeCount(): number {
    return this.specs.filter((s) => s.accountId !== null && !this.excluded.has(s.accountId)).length
  }

  private emitTurbo(notice?: TurboNotice): void {
    // 듣는 곳이 없으면(고속 모드를 안 쓰는 환경·시험) 계정 조회조차 하지 않는다
    if (this.listenerCount('turbo') === 0) return
    const status = this.turboStatus()
    const json = JSON.stringify(status)
    if (!notice && json === this.lastTurboJson) return
    this.lastTurboJson = json
    this.emit('turbo', status, notice)
  }

  private nextPending(): QueueItem | undefined {
    for (const item of this.items.values()) {
      if (item.state === 'pending') return item
    }
    return undefined
  }

  /** ms 동안 쉬되, 켜고 끄기·다른 작업자의 끝남·멈춤이 있으면 일찍 깨어난다 */
  private nap(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer)
        this.wakers.delete(wake)
        resolve()
      }
      const timer = setTimeout(wake, ms)
      this.wakers.add(wake)
    })
  }

  private wakeAll(): void {
    for (const wake of [...this.wakers]) wake()
  }

  /** 변경 알림 코얼레싱 (커스텀 — 성능): 장마다 여러 번(시작/완료/루프) 연달아 발생하는
   *  변경을 100ms 창으로 묶는다. 마지막 상태는 트레일링 발신이 보장하므로 유실 없음. */
  private emitTimer: NodeJS.Timeout | null = null
  private lastEmitAt = 0
  private emitChanged(): void {
    const now = Date.now()
    const since = now - this.lastEmitAt
    if (since >= EMIT_COALESCE_MS) {
      this.lastEmitAt = now
      this.emit('changed', this.statusLite())
      return
    }
    if (this.emitTimer) return // 이미 트레일링 발신 예약됨
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.lastEmitAt = Date.now()
      this.emit('changed', this.statusLite())
    }, EMIT_COALESCE_MS - since)
  }
}

const EMIT_COALESCE_MS = 100

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isAbortError(e: unknown): boolean {
  return (
    e instanceof Error && (e.name === 'AbortError' || e.message.toLowerCase().includes('abort'))
  )
}
