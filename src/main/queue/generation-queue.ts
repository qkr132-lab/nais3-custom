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
  /** 기본 작업자가 이 장에 쓸 토큰을 정한 직후 부른다 (await 없이) — 켜고 끄는 교대 구간에
   *  그 계정의 고속 작업자만 기다리게 한다. 부르기 전에는 모든 계정 작업자가 기다린다 */
  claim?: () => void
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
  /** 작업자로 쓸 계정 (토큰이 있는 것). key 는 작업자 이름 — 같은 NAI 계정이면 같은 값(없으면 id) */
  accounts(): { id: string; label: string; key?: string }[]
  /** 지금 활성 계정의 작업자 이름(accounts 의 key) — 꺼진 상태의 작업자가 쓰는 계정 */
  activeKey(): string | null
  /** 이 계정으로 이 요청을 지금 보내도 되는가 */
  admit(accountId: string, request: GenerationRequest): Promise<TurboVerdict>
  /** 이 요청이 V5 무료 한도를 쓰는가 — 아니면(V4.5 이하·인페인트 짝 모델) 한도로 빠진 계정도 잡는다 */
  needsQuota(request: GenerationRequest): boolean
  /** 요청이 나간 뒤 실패했을 수 있을 때 — 이 계정의 한도 기록을 버려 다음 판정이 새로 조회하게 */
  forget?(accountId: string): void
}

interface Lane {
  key: string
  accountId: string | null
  label: string
  /** 지금 항목을 생성 중 */
  busy: boolean
  /** 그만두는 중 — 지금 장만 마치고 나간다 (고속 모드를 끄거나 계정이 빠질 때) */
  retire: boolean
  /** 이번에 뜬 뒤로 한도 판정을 한 번 받았다 — 지난 실행의 기록만 믿고 멈추지 않으려고.
   *  한도를 실제로 확인했거나 빠진 판정일 때만 선다 */
  judged: boolean
  /** 판정에 걸려 이 시각(ms epoch)까지 쉰다 — 그동안 같은 판정을 되풀이하지 않는다 */
  restUntil: number
  /** 쉬는 동안에도 한도와 무관한 항목은 잡는다 (V5 한도로만 걸렸을 때) */
  restFreeOk: boolean
  /** 한도와 무관한 항목으로 지금 참여 중 — ×N 표시용 (빠짐 기록은 그대로 둔다) */
  free: boolean
  /** 기본 작업자가 지금 장에 쓰는 계정의 작업자 이름. undefined 는 아직 고르는 중 */
  using?: string | null
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
  /** 고속 모드에서 뺀 계정 (id → 이유). 실행이 끝나도 남겨 ×N 표시와 알림 중복 방지에 쓴다 (새로 켜면 비운다) */
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
      // 작업자 이름(key)은 메인 안에서만 쓴다 — 렌더러로 내보내지 않는다.
      // 한도로 빠진 계정도 한도와 무관한 항목으로 지금 생성 중이면 참여 중으로 센다
      accounts: accounts.map((a) => ({
        id: a.id,
        label: a.label,
        excluded: this.excluded.has(a.id) && !this.lanes.get(a.key ?? a.id)?.free
      }))
    }
  }

  /**
   * 작업자를 지금 설정에 맞춘다 (커스텀). 고속 모드를 켜고 끌 때, 계정을 추가·삭제·바꿀 때 부른다.
   * - 켜면: 계정마다 작업자가 생겨 곧바로 대기 항목을 잡는다. 돌던 기본 작업자는 지금 장만 마치고 나간다.
   * - 끄면: 계정 작업자들은 지금 장만 마치고(취소하지 않는다) 나가고, 그 뒤 기본 작업자 하나가 이어받는다.
   * restart=false 는 이름 바뀜처럼 작업자를 새로 띄울 필요가 없을 때.
   */
  reconcile(restart = true): void {
    // 작업자 구성이 바뀌면(켜고 끄기·계정 추가·삭제) 멈춤을 풀고 새로 뜬 작업자가 다시 판정받는다
    if (restart) this.stopped = false
    this.sync(restart)
    // 지워진 계정의 기록 정리
    if (this.excluded.size > 0) {
      const known = new Set((this.hooks?.accounts() ?? []).map((a) => a.id))
      for (const id of [...this.excluded.keys()]) if (!known.has(id)) this.excluded.delete(id)
    }
    this.emitTurbo()
  }

  /**
   * 이 계정들을 곧바로 다시 판정받게 한다 (충전 아이템을 쓴 뒤 — 커스텀). 한도로 쉬던 작업자는
   * 쉬는 시간을 끊고, 모든 계정이 빠져 멈춰 있었으면 작업자를 다시 띄운다. 판정은 새로 조회한
   * 한도로 한다 (부르는 쪽이 그 계정의 한도 기록을 먼저 버린다). 새 판정이 나오기 전에 다른 계정이
   * 빠져도 옛 빠짐 판정으로 「모두 빠짐」이 되지 않게 판정 기록도 무른다.
   */
  recheck(accountIds: string[]): void {
    for (const lane of this.lanes.values()) {
      if (lane.accountId !== null && accountIds.includes(lane.accountId)) {
        lane.restUntil = 0
        lane.judged = false
      }
    }
    this.reconcile()
  }

  /** 새 항목이 들어왔을 때 — 멈춰 있었다면 풀고 작업자를 띄운다 */
  private kick(): void {
    this.stopped = false
    this.sync(true)
  }

  private sync(restart: boolean): void {
    const wasTurbo = this.specs.some((s) => s.accountId !== null)
    const specs = this.computeSpecs()
    this.specs = specs
    const turbo = specs.some((s) => s.accountId !== null)
    // 고속 모드를 새로 켜면 지난번 빠짐 기록은 버리고 다시 판정받는다 (켜자마자 ×0 으로 보이지 않게)
    if (turbo && !wasTurbo) this.excluded.clear()
    // 계정 작업자가 없으면 멈출 대상도 없다
    if (!turbo) this.stopped = false
    const byKey = new Map(specs.map((s) => [s.key, s]))
    for (const lane of this.lanes.values()) {
      const spec = byKey.get(lane.key)
      lane.retire = !spec
      if (!spec) continue
      lane.label = spec.label
      if (lane.accountId !== spec.accountId && spec.accountId !== null) {
        // 같은 NAI 계정(같은 토큰)의 다른 항목이 이어받았다 — 작업자는 그대로 두고 계정 id 만 바꾼다
        // (지금 장을 마치는 작업자 옆에 같은 토큰으로 새 작업자가 뜨면 한 계정으로 두 장이 겹친다)
        const old = lane.accountId
        const reason = old !== null ? this.excluded.get(old) : undefined
        if (old !== null && reason) {
          this.excluded.delete(old)
          this.excluded.set(spec.accountId, reason)
        }
        lane.accountId = spec.accountId
        // 이어받은 id 의 한도 기록은 이 작업자가 쓴 적이 없다 — 다음 판정은 새로 조회한다
        this.hooks?.forget?.(spec.accountId)
      }
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
        return accounts.map((a) => ({ key: a.key ?? a.id, accountId: a.id, label: a.label }))
      }
    }
    return [{ key: DEFAULT_LANE, accountId: null, label: '' }]
  }

  private hasPending(): boolean {
    return this.nextPending() !== undefined
  }

  private startLane(spec: LaneSpec): void {
    const lane: Lane = {
      ...spec,
      busy: false,
      retire: false,
      judged: false,
      restUntil: 0,
      restFreeOk: true,
      free: false
    }
    this.lanes.set(lane.key, lane)
    void this.laneLoop(lane)
  }

  /** 작업자 한 명의 루프. 판단하고 나가는 것과 lanes 에서 빠지는 것 사이에 await 가 없어야 한다 —
   *  그래야 방금 들어온 항목을 아무도 안 잡는 틈이 생기지 않는다. */
  private async laneLoop(lane: Lane): Promise<void> {
    try {
      for (;;) {
        if (lane.retire) break
        const first = this.nextPending()
        if (!first) break
        let next = first
        // 모든 계정이 빠져 멈춘 것은 계정 작업자에게만 걸린다 — 번개를 끄면 기본 작업자는 그대로 이어간다.
        // V5 한도로 빠져 쉬는 동안·멈춘 뒤에는 한도와 무관한 항목만 잡는다 (등급으로 걸렸으면 그것도 쉰다)
        if (lane.accountId !== null && (this.stopped || lane.restUntil > Date.now())) {
          const resting = lane.restUntil > Date.now()
          const free = resting && !lane.restFreeOk ? undefined : this.nextFree()
          if (!free) {
            if (this.stopped || this.stopIfAllOut()) break
            await this.nap(lane.restUntil - Date.now())
            continue
          }
          next = free
        }
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
          if (next.state !== 'pending' || lane.retire) continue
          const quota = this.hooks.needsQuota(next.request)
          if (this.stopped && quota) continue
          // 한도를 실제로 보지 않은 통과(V4.5 이하)는 판정으로 치지 않는다 — 옛 빠짐 기록으로 멈추지 않게
          if (!verdict.ok || verdict.checked) lane.judged = true
          if (!verdict.ok) {
            lane.restUntil = Date.now() + TURBO_RECHECK_MS
            lane.restFreeOk = quota
            this.markFree(lane, false)
            // 모든 계정이 빠졌고 잡을 수 있는 항목도 없으면 멈춘다. 항목은 대기로 남는다
            if (this.exclude(lane, verdict.reason)) break
            continue
          }
          if (verdict.checked) {
            lane.restUntil = 0
            this.include(lane)
          }
          this.markFree(lane, !verdict.checked)
          if (this.holds > 0 || this.cooldownUntil > Date.now() || this.blocked(lane)) continue
        }

        next.state = 'generating'
        lane.busy = true
        if (lane.accountId === null) lane.using = undefined
        const controller = new AbortController()
        this.controllers.set(next.id, controller)
        this.emitChanged()

        let retryMs: number | null = null
        try {
          next.filePath = await this.generate(next.request, next.id, controller.signal, {
            accountId: lane.accountId,
            label: lane.label,
            claim:
              lane.accountId === null
                ? () => {
                    lane.using = this.hooks?.activeKey() ?? null
                    this.wakeAll()
                  }
                : undefined
          })
          next.state = 'done'
        } catch (e) {
          // 요청이 나간 뒤 끊기거나 취소·저장 실패였을 수 있다 — 이 계정의 한도 기록을 믿지 않는다
          // (429 는 서버가 받지 않은 것이라 그대로)
          if (lane.accountId !== null && !(e instanceof RateLimitError)) {
            this.hooks?.forget?.(lane.accountId)
          }
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
          // 켜는 교대 구간에 평소 작업자가 마친 장 — 자동 전환이 이 장을 보내기 전에 찍은 그 계정의
          // 한도 기록은 믿지 않는다 (그 계정 작업자의 첫 판정이 새로 조회하게. 성공·실패 모두)
          if (lane.accountId === null && lane.retire && lane.using != null) {
            const used = this.specs.find((s) => s.key === lane.using)?.accountId
            if (used) this.hooks?.forget?.(used)
          }
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
        if (
          this.nextPending() &&
          !lane.retire &&
          !(this.stopped && lane.accountId !== null && !this.nextFree())
        ) {
          await sleep(this.delayMs)
        }
      }
    } finally {
      this.lanes.delete(lane.key)
      const halted = this.stopped
      if (this.lanes.size === 0) this.stopped = false
      // 그만두던 작업자 뒤에 대기 항목이 남았으면(교대 구간에 마지막 장이 429 로 돌아온 경우 등)
      // 있어야 할 작업자를 띄운다. 모두 빠져 멈춘 경우는 띄우지 않는다 (판정·알림을 되풀이하지 않게)
      if (lane.retire && !halted && this.hasPending()) this.sync(true)
      if (lane.free) this.emitTurbo()
      this.wakeAll()
      this.emitChanged()
    }
  }

  /**
   * 이 작업자가 지금 시작하면 다른 작업자와 같은 계정으로 겹치는가.
   * 고속 모드를 끄면 기본 작업자(활성 계정)는 계정 작업자들이 다 끝난 뒤에 시작하고,
   * 켜면 돌던 기본 작업자가 계정을 고르는 동안은 모든 계정 작업자가, 고른 뒤에는 그 계정의 작업자만
   * 그 장이 끝나길 기다린다. 기본 작업자가 실제로 쓴 계정을 보므로 그사이 활성 계정이 바뀌어도 겹치지 않는다.
   */
  private blocked(lane: Lane): boolean {
    for (const other of this.lanes.values()) {
      if (other === lane || !other.busy) continue
      if (lane.accountId === null) return true
      if (other.accountId === null && (other.using === undefined || other.using === lane.key))
        return true
    }
    return false
  }

  /** 계정을 뺀다. 멈추게 되면 true. 이번에 처음 빠진 것이면 알린다 */
  private exclude(lane: Lane, reason: 'exhausted' | 'unknown'): boolean {
    const id = lane.accountId
    if (id === null) return false
    const first = !this.excluded.has(id)
    this.excluded.set(id, reason)
    if (this.stopIfAllOut()) return true
    if (first)
      this.emitTurbo({ kind: 'dropped', id, label: lane.label, reason, active: this.activeCount() })
    else this.emitTurbo()
    return false
  }

  /**
   * 모든 계정이 빠졌고, 대기 항목 중 지금 누가 잡을 수 있는 것(한도와 무관한 항목)도 없으면 멈춘다 —
   * 알림은 한 번. 계정 작업자들은 지금 장만 마치고 나가고, 항목은 대기로 남는다.
   */
  private stopIfAllOut(): boolean {
    if (this.stopped) return true
    if (!this.everyoneOut()) return false
    if (this.nextFree()) {
      const now = Date.now()
      const someone = this.specs.some((spec) => {
        const lane = this.lanes.get(spec.key)
        return !!lane && !lane.retire && (lane.restFreeOk || lane.restUntil <= now)
      })
      if (someone) return false
    }
    this.stopped = true
    this.wakeAll()
    this.emitTurbo({ kind: 'allDropped' })
    return true
  }

  /** 한도와 무관한 항목으로 지금 참여 중인지 (×N 표시용) — 바뀔 때만 상태를 보낸다 */
  private markFree(lane: Lane, free: boolean): void {
    if (lane.free === free) return
    lane.free = free
    this.emitTurbo()
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

  /** 지금 참여 중인 계정 수 (×N) — 번개 버튼과 같은 기준 */
  private activeCount(): number {
    return this.specs.filter(
      (s) =>
        s.accountId !== null && (!this.excluded.has(s.accountId) || !!this.lanes.get(s.key)?.free)
    ).length
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

  /** 한도와 무관한 첫 대기 항목 (V4.5 이하·인페인트 짝 모델) */
  private nextFree(): QueueItem | undefined {
    const hooks = this.hooks
    if (!hooks) return undefined
    for (const item of this.items.values()) {
      if (item.state === 'pending' && !hooks.needsQuota(item.request)) return item
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
