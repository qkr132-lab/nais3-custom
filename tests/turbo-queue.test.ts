import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GenerationQueue,
  type LaneInfo,
  type TurboHooks,
  type TurboVerdict
} from '../src/main/queue/generation-queue'
import { RateLimitError } from '../src/main/nai/client'
import type { GenerationRequest, TurboNotice, TurboStatus } from '../src/shared/types'

/**
 * 고속 모드(번개 버튼) 큐 시험 — NAI 호출 없이 가짜 generate·가짜 계정 훅만 쓴다.
 * 계정은 a1(활성)·a2 두 개.
 */

// GenerationRequest를 흉내낸 최소 객체 (큐는 seed·model 외 필드를 건드리지 않는다)
type Req = GenerationRequest & { __label: string }
const mk = (label: string, model = 'nai-diffusion-5-full'): Req =>
  ({ __label: label, seed: 0, model }) as unknown as Req

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await tick()
}
function deferred<T = void>(): { p: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const p = new Promise<T>((res) => (resolve = res))
  return { p, resolve }
}
function waitIdle(q: GenerationQueue): Promise<void> {
  return new Promise((resolve) => {
    if (!q.status().running) return resolve()
    const check = (st: { running: boolean }): void => {
      if (!st.running) {
        q.off('changed', check)
        resolve()
      }
    }
    q.on('changed', check)
  })
}

interface World {
  /** 고속 모드 저장값 */
  enabled: boolean
  accounts: { id: string; label: string; key?: string }[]
  active: string | null
  /** 계정 id → 실제 NAI 계정(토큰). 없으면 id 그대로 — 같은 토큰을 두 계정으로 넣은 경우를 흉내 낸다 */
  tokenOf: Record<string, string>
  /** 계정별 한도 판정 — 기본은 전부 남음 */
  verdict: (accountId: string, model: string) => TurboVerdict
  admitCalls: string[]
  /** 한도 기록을 버리라고 받은 계정 */
  forgot: string[]
}

function world(patch: Partial<World> = {}): World {
  return {
    enabled: true,
    accounts: [
      { id: 'a1', label: '계정 1' },
      { id: 'a2', label: '계정 2' }
    ],
    active: 'a1',
    tokenOf: {},
    verdict: () => ({ ok: true, checked: true }),
    admitCalls: [],
    forgot: [],
    ...patch
  }
}

const isV5Model = (model: string): boolean => model.startsWith('nai-diffusion-5')

/** 이 계정 id 가 실제로 쓰는 NAI 계정 */
const naiOf = (w: World, id: string | null): string =>
  id === null ? 'none' : (w.tokenOf[id] ?? id)

function hooksOf(w: World): TurboHooks {
  return {
    enabled: () => w.enabled,
    accounts: () => w.accounts,
    activeKey: () => (w.active === null ? null : naiOf(w, w.active)),
    admit: async (id, request) => {
      w.admitCalls.push(id)
      return w.verdict(id, request.model)
    },
    needsQuota: (request) => isV5Model(request.model),
    forget: (id) => w.forgot.push(id)
  }
}

interface Rig {
  generate: (req: Req, id: string, signal: AbortSignal, lane: LaneInfo) => Promise<string>
  started: { label: string; accountId: string | null }[]
  finishedBy: Map<string, string | null>
  hold: (label: string) => ReturnType<typeof deferred>
  failOnce: Map<string, (lane: LaneInfo) => Error | null>
  /** 기본 작업자가 계정을 고르는 단계(자동 전환)를 흉내 낸다 — 이게 끝난 뒤에 claim 한다 */
  beforeClaim: Map<string, () => Promise<void>>
  attempts: Map<string, number>
  /** 동시에 생성 중이던 계정 수의 최댓값 */
  readonly peak: number
  /** 같은 계정으로 두 장이 겹친 적이 있는가 */
  readonly overlap: boolean
  /** 취소 신호를 받은 장 수 */
  readonly aborted: number
}

/** 가짜 생성 — 계정별 동시 실행을 기록하고, 라벨마다 문(gate)으로 붙잡아 둘 수 있다 */
function rig(w: World): Rig {
  const started: { label: string; accountId: string | null }[] = []
  const finishedBy = new Map<string, string | null>()
  const gates = new Map<string, ReturnType<typeof deferred>>()
  const failOnce = new Map<string, (lane: LaneInfo) => Error | null>()
  const beforeClaim = new Map<string, () => Promise<void>>()
  const attempts = new Map<string, number>()
  const live = new Set<string>() // 지금 생성 중인 실제 계정 (기본 레인은 활성 계정)
  let peak = 0
  let overlap = false
  let aborted = 0

  const hold = (label: string): ReturnType<typeof deferred> => {
    const g = deferred()
    gates.set(label, g)
    return g
  }

  const generate = async (
    req: Req,
    _id: string,
    signal: AbortSignal,
    lane: LaneInfo
  ): Promise<string> => {
    // 기본 작업자는 실제 생성 파이프라인처럼 계정을 고른 뒤(자동 전환) 그때의 활성 계정으로 보낸다
    const pre = beforeClaim.get(req.__label)
    if (pre) await pre()
    lane.claim?.()
    const account = lane.accountId !== null ? naiOf(w, lane.accountId) : naiOf(w, w.active)
    if (live.has(account)) overlap = true // 같은 계정으로 두 장이 겹침
    live.add(account)
    peak = Math.max(peak, live.size)
    started.push({ label: req.__label, accountId: lane.accountId })
    attempts.set(req.__label, (attempts.get(req.__label) ?? 0) + 1)
    try {
      const gate = gates.get(req.__label)
      if (gate) {
        await new Promise<void>((resolve, reject) => {
          void gate.p.then(resolve)
          signal.addEventListener('abort', () => {
            aborted++
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          })
        })
      }
      const err = failOnce.get(req.__label)?.(lane)
      if (err) throw err
      finishedBy.set(req.__label, lane.accountId)
      return `/img/${req.__label}.png`
    } finally {
      live.delete(account)
    }
  }

  return {
    generate,
    started,
    finishedBy,
    hold,
    failOnce,
    beforeClaim,
    attempts,
    get peak() {
      return peak
    },
    get overlap() {
      return overlap
    },
    get aborted() {
      return aborted
    }
  }
}

function newQueue(w: World): {
  q: GenerationQueue
  r: Rig
  notices: TurboNotice[]
  statuses: TurboStatus[]
} {
  const r = rig(w)
  const q = new GenerationQueue(r.generate, hooksOf(w))
  q.setDelayMs(0)
  const notices: TurboNotice[] = []
  const statuses: TurboStatus[] = []
  q.on('turbo', (status: TurboStatus, notice?: TurboNotice) => {
    statuses.push(status)
    if (notice) notices.push(notice)
  })
  return { q, r, notices, statuses }
}

const states = (q: GenerationQueue): string[] => q.status().items.map((i) => i.state)

afterEach(() => {
  vi.useRealTimers()
})

describe('고속 모드 — 계정마다 작업자 하나', () => {
  it('계정이 둘이면 동시에 두 장을 뽑고, 같은 계정으로는 겹치지 않는다', async () => {
    const w = world()
    const { q, r } = newQueue(w)
    const g1 = r.hold('A')
    const g2 = r.hold('B')
    q.enqueueMany([mk('A'), mk('B'), mk('C'), mk('D')])
    await settle()
    // A·B 가 동시에 생성 중, 서로 다른 계정
    expect(states(q)).toEqual(['generating', 'generating', 'pending', 'pending'])
    expect(r.started.map((s) => s.accountId).sort()).toEqual(['a1', 'a2'])
    g1.resolve()
    g2.resolve()
    await waitIdle(q)
    expect(states(q)).toEqual(['done', 'done', 'done', 'done'])
    expect(r.peak).toBe(2)
    expect(r.overlap).toBe(false)
    // 고속 모드의 작업자는 항상 자기 계정으로 보낸다 (활성 계정 자동 전환 경로가 아니다)
    expect(r.started.every((s) => s.accountId === 'a1' || s.accountId === 'a2')).toBe(true)
  })

  it('항목이 하나뿐이면 한 계정만 쓰고, 그동안 다른 작업자가 같은 항목을 또 잡지 않는다', async () => {
    const w = world()
    const { q, r } = newQueue(w)
    const g = r.hold('A')
    q.enqueueMany([mk('A')])
    await settle()
    expect(r.started).toHaveLength(1)
    g.resolve()
    await waitIdle(q)
    expect(r.started).toHaveLength(1)
    expect(r.attempts.get('A')).toBe(1)
  })

  it('꺼져 있으면 예전과 같은 순차 — 동시 1장, 계정 판정은 한 번도 하지 않는다', async () => {
    const w = world({ enabled: false })
    const { q, r } = newQueue(w)
    const g = r.hold('A')
    q.enqueueMany([mk('A'), mk('B'), mk('C')])
    await settle()
    expect(states(q)).toEqual(['generating', 'pending', 'pending'])
    g.resolve()
    await waitIdle(q)
    expect(states(q)).toEqual(['done', 'done', 'done'])
    expect(r.peak).toBe(1)
    expect(r.started.every((s) => s.accountId === null)).toBe(true)
    expect(w.admitCalls).toEqual([])
    expect(r.started.map((s) => s.label)).toEqual(['A', 'B', 'C'])
  })

  it('훅이 없는 큐(예전 생성자)는 그대로 순차로 돈다', async () => {
    const order: string[] = []
    const q = new GenerationQueue(async (req) => {
      const label = (req as Req).__label
      order.push(label)
      return `/img/${label}.png`
    })
    q.setDelayMs(0)
    q.enqueueMany([mk('A'), mk('B')])
    await waitIdle(q)
    expect(order).toEqual(['A', 'B'])
  })

  it('계정이 하나뿐이면 켜 놓았어도 평소 방식으로 돈다', async () => {
    const w = world({ accounts: [{ id: 'a1', label: '계정 1' }] })
    const { q, r } = newQueue(w)
    q.enqueueMany([mk('A'), mk('B')])
    await waitIdle(q)
    expect(r.started.every((s) => s.accountId === null)).toBe(true)
    expect(w.admitCalls).toEqual([])
  })

  it('고속 모드에서 새치기(enqueueNext)는 생성 중인 항목들 중 마지막 바로 뒤에 들어간다', async () => {
    const w = world()
    const { q, r } = newQueue(w)
    const g1 = r.hold('A')
    const g2 = r.hold('B')
    q.enqueueMany([mk('A'), mk('B'), mk('C')])
    await settle()
    q.enqueueNext([mk('X')])
    const labels = q.pendingItems().map((p) => (p.request as Req).__label)
    expect(labels).toEqual(['X', 'C'])
    g1.resolve()
    g2.resolve()
    await waitIdle(q)
    expect(r.started.map((s) => s.label)).toEqual(['A', 'B', 'X', 'C'])
  })
})

describe('고속 모드 — Anlas 안전 (V5 는 무료분이 남은 계정만)', () => {
  it('무료분을 다 쓴 계정은 빠지고 남은 계정만으로 계속 뽑는다 — 빠진 계정으로는 한 장도 안 나간다', async () => {
    const w = world({
      verdict: (id) =>
        id === 'a2' ? { ok: false, reason: 'exhausted' } : { ok: true, checked: true }
    })
    const { q, r, notices } = newQueue(w)
    q.enqueueMany([mk('A'), mk('B'), mk('C')])
    await waitIdle(q)
    expect(states(q)).toEqual(['done', 'done', 'done'])
    expect(r.started.every((s) => s.accountId === 'a1')).toBe(true)
    // 빠진다는 알림은 한 번, 남은 참여 계정 수(×1)와 함께
    expect(notices).toEqual([{ kind: 'dropped', label: '계정 2', reason: 'exhausted', active: 1 }])
    expect(q.turboStatus().accounts.map((a) => [a.id, a.excluded])).toEqual([
      ['a1', false],
      ['a2', true]
    ])
  })

  it('남은 양을 모르는 계정(0% 구간·조회 실패)도 뺀다', async () => {
    const w = world({
      verdict: (id) =>
        id === 'a1' ? { ok: false, reason: 'unknown' } : { ok: true, checked: true }
    })
    const { q, r, notices } = newQueue(w)
    q.enqueueMany([mk('A'), mk('B')])
    await waitIdle(q)
    expect(r.started.every((s) => s.accountId === 'a2')).toBe(true)
    expect(notices).toEqual([{ kind: 'dropped', label: '계정 1', reason: 'unknown', active: 1 }])
  })

  it('V4.5 이하는 한도와 무관해 모든 계정이 쓴다 — 한도를 확인하지 않았으니 빠진 기록도 건드리지 않는다', async () => {
    const w = world({
      verdict: (_id, model) =>
        model.startsWith('nai-diffusion-5')
          ? { ok: false, reason: 'exhausted' }
          : { ok: true, checked: false }
    })
    const { q, r, notices } = newQueue(w)
    const ga = r.hold('A')
    const gb = r.hold('B')
    q.enqueueMany([mk('A', 'nai-diffusion-4-5-full'), mk('B', 'nai-diffusion-4-5-full')])
    await settle()
    expect(states(q)).toEqual(['generating', 'generating'])
    ga.resolve()
    gb.resolve()
    await waitIdle(q)
    expect(r.started.map((s) => s.accountId).sort()).toEqual(['a1', 'a2'])
    expect(notices).toEqual([])
  })

  it('모든 계정이 빠지면 멈춘다 — 항목은 대기로 남고 알림은 한 번, 생성은 한 장도 안 나간다', async () => {
    const w = world({ verdict: () => ({ ok: false, reason: 'exhausted' }) })
    const { q, r, notices } = newQueue(w)
    q.enqueueMany([mk('A'), mk('B'), mk('C')])
    await settle(10)
    expect(q.status().running).toBe(false)
    expect(states(q)).toEqual(['pending', 'pending', 'pending'])
    expect(r.started).toEqual([])
    expect(notices.filter((n) => n.kind === 'allDropped')).toHaveLength(1)
    expect(notices.map((n) => n.kind)).toEqual(['dropped', 'allDropped'])
  })

  it('멈춘 뒤 번개를 끄면 평소대로(활성 계정 하나로) 이어진다', async () => {
    const w = world({ verdict: () => ({ ok: false, reason: 'exhausted' }) })
    const { q, r } = newQueue(w)
    q.enqueueMany([mk('A'), mk('B')])
    await settle(10)
    expect(q.status().running).toBe(false)
    w.enabled = false
    q.reconcile()
    await waitIdle(q)
    expect(states(q)).toEqual(['done', 'done'])
    expect(r.started.every((s) => s.accountId === null)).toBe(true)
  })

  it('모두 빠진 뒤 새 항목을 넣으면 다시 판정해 같은 알림이 다시 한 번 난다', async () => {
    const w = world({ verdict: () => ({ ok: false, reason: 'exhausted' }) })
    const { q, notices } = newQueue(w)
    q.enqueueMany([mk('A')])
    await settle(10)
    q.enqueueMany([mk('B')])
    await settle(10)
    expect(notices.filter((n) => n.kind === 'allDropped')).toHaveLength(2)
    // 빠진 계정은 이미 빠진 채라 「뺐습니다」 알림은 처음 한 번뿐
    expect(notices.filter((n) => n.kind === 'dropped')).toHaveLength(1)
  })

  it('빠진 계정은 확인 간격이 지나면 다시 판정받고, 돌아오면 다시 일한다', async () => {
    vi.useFakeTimers()
    const w = world()
    let a2Free = false
    w.verdict = (id) =>
      id === 'a2' && !a2Free ? { ok: false, reason: 'exhausted' } : { ok: true, checked: true }
    const { q, r, statuses } = newQueue(w)
    const g = r.hold('A')
    q.enqueueMany([mk('A'), mk('B')])
    await vi.advanceTimersByTimeAsync(50)
    // a1 이 A 를 붙잡고 있고, a2 는 빠진 채 쉰다
    expect(r.started.map((s) => s.label)).toEqual(['A'])
    expect(q.turboStatus().accounts[1].excluded).toBe(true)
    a2Free = true
    await vi.advanceTimersByTimeAsync(22_000)
    // 쉬던 a2 가 다시 판정을 받고 B 를 잡았다
    expect(r.started.map((s) => [s.label, s.accountId])).toEqual([
      ['A', 'a1'],
      ['B', 'a2']
    ])
    expect(q.turboStatus().accounts[1].excluded).toBe(false)
    expect(statuses[statuses.length - 1].accounts[1].excluded).toBe(false)
    g.resolve()
    await vi.advanceTimersByTimeAsync(500)
    expect(states(q)).toEqual(['done', 'done'])
  })

  it('이전 실행에서 빠진 기록만 보고 멈추지 않는다 — 이번에 판정을 받은 뒤에만 멈춘다', async () => {
    const w = world({ verdict: () => ({ ok: false, reason: 'exhausted' }) })
    const { q, r, notices } = newQueue(w)
    q.enqueueMany([mk('A')])
    await settle(10)
    expect(notices.filter((n) => n.kind === 'allDropped')).toHaveLength(1)
    // 이제 a2 가 회복했다 — 두 번째 실행에서 a2 는 옛 기록(빠짐)이 남아 있어도 다시 판정받아 일한다
    w.verdict = (id) =>
      id === 'a2' ? { ok: true, checked: true } : { ok: false, reason: 'exhausted' }
    q.enqueueMany([mk('B')])
    await waitIdle(q)
    expect(states(q)).toEqual(['done', 'done'])
    expect(r.started.every((s) => s.accountId === 'a2')).toBe(true)
    expect(notices.filter((n) => n.kind === 'allDropped')).toHaveLength(1)
  })

  it('판정이 던져도(조회 실패) 큐가 죽지 않고 그 계정만 뺀다', async () => {
    const w = world()
    const r = rig(w)
    const hooks = hooksOf(w)
    hooks.admit = async (id) => {
      if (id === 'a2') throw new Error('조회 실패')
      return { ok: true, checked: true }
    }
    const q = new GenerationQueue(r.generate, hooks)
    q.setDelayMs(0)
    q.enqueueMany([mk('A'), mk('B')])
    await waitIdle(q)
    expect(states(q)).toEqual(['done', 'done'])
    expect(r.started.every((s) => s.accountId === 'a1')).toBe(true)
  })
})

describe('고속 모드 — 429·취소·켜고 끄기', () => {
  it('429 는 그 계정 작업자만 쉬고, 항목은 대기로 돌아가 다른 계정이 잡아도 된다', async () => {
    vi.useFakeTimers()
    const w = world()
    const { q, r } = newQueue(w)
    // a1 은 X 에서 429(2초 쉬어라) — 한 번만
    r.failOnce.set('X', (lane) => (lane.accountId === 'a1' ? new RateLimitError(2000) : null))
    r.failOnce.set('Y', () => null)
    q.enqueueMany([mk('X'), mk('Y'), mk('Z')])
    await vi.advanceTimersByTimeAsync(300)
    // a1 이 쉬는 동안 a2 가 Y, Z, 그리고 되돌아온 X 까지 뽑았다
    expect(q.status().items.map((i) => i.state)).toEqual(['done', 'done', 'done'])
    expect(r.finishedBy.get('X')).toBe('a2')
    expect(r.attempts.get('X')).toBe(2)
    await vi.advanceTimersByTimeAsync(3000)
    expect(q.status().running).toBe(false)
  })

  it('429 재시도 상한은 계정이 둘이어도 항목 하나당 그대로다', async () => {
    const w = world()
    const { q, r } = newQueue(w)
    r.failOnce.set('X', () => new RateLimitError(0))
    q.enqueueMany([mk('X')])
    await waitIdle(q)
    expect(q.status().items[0].state).toBe('failed')
    expect(r.attempts.get('X')).toBe(7) // 최초 1 + 재시도 6
  })

  it('일반 오류는 한 계정의 항목만 실패 처리하고 다른 작업자는 계속 돈다', async () => {
    const w = world()
    const { q, r } = newQueue(w)
    r.failOnce.set('A', () => new Error('생성 실패 400: bad prompt'))
    q.enqueueMany([mk('A'), mk('B'), mk('C')])
    await waitIdle(q)
    expect(states(q)).toEqual(['failed', 'done', 'done'])
  })

  it('취소는 생성 중인 장만 끊고 쿨다운 동안 모든 작업자가 새 항목을 시작하지 않는다', async () => {
    vi.useFakeTimers()
    const w = world()
    const { q, r } = newQueue(w)
    const ga = r.hold('A')
    const gb = r.hold('B')
    q.enqueueMany([mk('A'), mk('B'), mk('C'), mk('D')])
    await vi.advanceTimersByTimeAsync(50)
    const idA = q.status().items[0].id
    q.cancel([idA])
    await vi.advanceTimersByTimeAsync(50)
    expect(q.status().items[0].state).toBe('cancelled')
    expect(r.aborted).toBe(1)
    gb.resolve() // B 는 끝나지만 쿨다운(3초) 중이라 C 는 아직
    await vi.advanceTimersByTimeAsync(1500)
    expect(q.status().items[1].state).toBe('done')
    expect(
      q
        .status()
        .items.slice(2)
        .map((i) => i.state)
    ).toEqual(['pending', 'pending'])
    await vi.advanceTimersByTimeAsync(2500)
    expect(
      q
        .status()
        .items.slice(2)
        .map((i) => i.state)
    ).toEqual(['done', 'done'])
    ga.resolve()
    await vi.advanceTimersByTimeAsync(100)
    expect(r.overlap).toBe(false)
  })

  it('대기 중인 항목 취소는 어느 작업자도 그 항목을 시작하지 않는다', async () => {
    const w = world()
    const { q, r } = newQueue(w)
    const ga = r.hold('A')
    const gb = r.hold('B')
    q.enqueueMany([mk('A'), mk('B'), mk('C')])
    await settle()
    q.cancel([q.status().items[2].id])
    ga.resolve()
    gb.resolve()
    await waitIdle(q)
    expect(states(q)).toEqual(['done', 'done', 'cancelled'])
    expect(r.started.map((s) => s.label)).toEqual(['A', 'B'])
  })

  it('생성 중에 켜면 다른 계정의 작업자가 곧바로 잡고, 돌던 장은 취소되지 않는다', async () => {
    const w = world({ enabled: false })
    const { q, r } = newQueue(w)
    const g1 = r.hold('A')
    const g2 = r.hold('B')
    q.enqueueMany([mk('A'), mk('B'), mk('C'), mk('D')])
    await settle()
    expect(states(q)).toEqual(['generating', 'pending', 'pending', 'pending'])
    // 켠다 — 활성 계정(a1)은 돌던 기본 작업자가 끝나길 기다리고, a2 는 곧바로 시작
    w.enabled = true
    q.reconcile()
    await settle()
    expect(states(q)).toEqual(['generating', 'generating', 'pending', 'pending'])
    expect(r.started.map((s) => [s.label, s.accountId])).toEqual([
      ['A', null],
      ['B', 'a2']
    ])
    g1.resolve()
    g2.resolve()
    await waitIdle(q)
    expect(states(q)).toEqual(['done', 'done', 'done', 'done'])
    expect(r.aborted).toBe(0)
    expect(r.overlap).toBe(false)
    // A 는 켜기 전에 시작한 기본 작업자(활성 계정)가 끝까지 마쳤다
    expect(r.finishedBy.get('A')).toBeNull()
    // 이후는 계정 작업자들만
    expect(r.started.slice(2).every((s) => s.accountId !== null)).toBe(true)
  })

  it('생성 중에 끄면 두 계정의 지금 장은 끝까지 마치고, 그 뒤 활성 계정 하나로 이어간다', async () => {
    const w = world()
    const { q, r } = newQueue(w)
    const g1 = r.hold('A')
    const g2 = r.hold('B')
    q.enqueueMany([mk('A'), mk('B'), mk('C'), mk('D')])
    await settle()
    expect(states(q)).toEqual(['generating', 'generating', 'pending', 'pending'])
    w.enabled = false
    q.reconcile()
    await settle()
    // 기본 작업자는 계정 작업자들이 끝날 때까지 시작하지 않는다 — 활성 계정과 겹치지 않게
    expect(states(q)).toEqual(['generating', 'generating', 'pending', 'pending'])
    g1.resolve()
    await settle()
    // a1 의 장이 끝나도 a2 의 장이 아직이면 기본 작업자는 기다린다
    expect(states(q)).toEqual(['done', 'generating', 'pending', 'pending'])
    g2.resolve()
    await waitIdle(q)
    expect(states(q)).toEqual(['done', 'done', 'done', 'done'])
    expect(r.aborted).toBe(0)
    expect(r.overlap).toBe(false)
    expect(r.started.slice(2).every((s) => s.accountId === null)).toBe(true)
    expect(r.peak).toBe(2)
  })

  it('계정이 하나로 줄면 나간 계정의 장은 마치고 평소 방식으로 이어간다', async () => {
    const w = world()
    const { q, r, statuses } = newQueue(w)
    const g1 = r.hold('A')
    const g2 = r.hold('B')
    q.enqueueMany([mk('A'), mk('B'), mk('C')])
    await settle()
    w.accounts = [{ id: 'a1', label: '계정 1' }]
    q.reconcile()
    await settle()
    expect(q.turboStatus().accounts).toEqual([{ id: 'a1', label: '계정 1', excluded: false }])
    expect(statuses[statuses.length - 1].accounts).toHaveLength(1)
    g1.resolve()
    g2.resolve()
    await waitIdle(q)
    expect(states(q)).toEqual(['done', 'done', 'done'])
    expect(r.overlap).toBe(false)
    expect(r.started[2].accountId).toBeNull()
  })

  it('계정이 늘면 새 계정의 작업자가 바로 합류한다', async () => {
    const w = world({
      accounts: [
        { id: 'a1', label: '계정 1' },
        { id: 'a2', label: '계정 2' }
      ]
    })
    const { q, r } = newQueue(w)
    const ga = r.hold('A')
    const gb = r.hold('B')
    const gc = r.hold('C')
    q.enqueueMany([mk('A'), mk('B'), mk('C'), mk('D')])
    await settle()
    w.accounts = [...w.accounts, { id: 'a3', label: '계정 3' }]
    q.reconcile()
    await settle()
    expect(states(q)).toEqual(['generating', 'generating', 'generating', 'pending'])
    expect(r.started.map((s) => s.accountId)).toEqual(['a1', 'a2', 'a3'])
    ga.resolve()
    gb.resolve()
    gc.resolve()
    await waitIdle(q)
    expect(r.peak).toBe(3)
    expect(r.overlap).toBe(false)
  })

  it('이름만 바뀐 경우는 작업자를 새로 띄우지 않고 표시만 갱신한다', async () => {
    const w = world()
    const { q, r, statuses } = newQueue(w)
    const g = r.hold('A')
    q.enqueueMany([mk('A')])
    await settle()
    w.accounts = [
      { id: 'a1', label: '새 이름' },
      { id: 'a2', label: '계정 2' }
    ]
    q.reconcile(false)
    expect(statuses[statuses.length - 1].accounts[0].label).toBe('새 이름')
    g.resolve()
    await waitIdle(q)
    expect(r.started).toHaveLength(1)
  })

  it('큐 밖 요청(exclusive)이 도는 동안은 어느 작업자도 새 항목을 시작하지 않는다', async () => {
    const w = world()
    const { q, r } = newQueue(w)
    const ga = r.hold('A')
    const gb = r.hold('B')
    q.enqueueMany([mk('A'), mk('B'), mk('C')])
    await settle()
    expect(states(q)).toEqual(['generating', 'generating', 'pending'])
    let outsideDone = false
    const outside = q.exclusive(async () => {
      await new Promise((res) => setTimeout(res, 350))
      outsideDone = true
      return 'ok'
    })
    ga.resolve()
    gb.resolve()
    await outside
    expect(outsideDone).toBe(true)
    // 바깥 요청이 끝나기 전에는 C 가 시작되지 않았다
    expect(r.started.map((s) => s.label)).toEqual(['A', 'B'])
    await waitIdle(q)
    expect(states(q)).toEqual(['done', 'done', 'done'])
  })
})

describe('고속 모드 — 상태 알림', () => {
  it('켜고 끌 때마다 상태 이벤트가 나가고 값이 같으면 다시 보내지 않는다', async () => {
    const w = world({ enabled: false })
    const { q, statuses } = newQueue(w)
    q.reconcile()
    expect(statuses.map((s) => s.enabled)).toEqual([false])
    q.reconcile()
    expect(statuses).toHaveLength(1)
    w.enabled = true
    q.reconcile()
    expect(statuses.map((s) => s.enabled)).toEqual([false, true])
  })

  it('지워진 계정의 빠짐 기록은 정리된다', async () => {
    const w = world({
      verdict: (id) =>
        id === 'a2' ? { ok: false, reason: 'exhausted' } : { ok: true, checked: true }
    })
    const { q } = newQueue(w)
    q.enqueueMany([mk('A'), mk('B')])
    await waitIdle(q)
    expect(q.turboStatus().accounts[1].excluded).toBe(true)
    w.accounts = [{ id: 'a1', label: '계정 1' }]
    q.reconcile()
    w.accounts = [
      { id: 'a1', label: '계정 1' },
      { id: 'a2', label: '계정 2' }
    ]
    expect(q.turboStatus().accounts[1].excluded).toBe(false)
  })
})

const V45 = 'nai-diffusion-4-5-full'
const OK: TurboVerdict = { ok: true, checked: true }
const UNCHECKED: TurboVerdict = { ok: true, checked: false }
const EXHAUSTED: TurboVerdict = { ok: false, reason: 'exhausted' }
const UNKNOWN: TurboVerdict = { ok: false, reason: 'unknown' }
const excludedOf = (q: GenerationQueue): boolean[] =>
  q.turboStatus().accounts.map((a) => a.excluded)

describe('고속 모드 — 멈춤과 교대 구간', () => {
  it('모두 빠져 멈춘 뒤 다른 계정이 아직 생성 중일 때 번개를 끄면, 그 장이 끝난 뒤 평소대로 이어진다', async () => {
    const w = world()
    const spentNow = new Set(['a1'])
    w.verdict = (id, model) => (!isV5Model(model) ? UNCHECKED : spentNow.has(id) ? EXHAUSTED : OK)
    const { q, r, notices } = newQueue(w)
    const gx1 = r.hold('X1')
    const gy = r.hold('Y')
    q.enqueueMany([mk('X1'), mk('Y', V45), mk('X2')])
    await settle(10)
    // a1 은 X1 에서 빠지고 한도와 무관한 Y 를, a2 는 X1 을 생성 중
    expect(states(q)).toEqual(['generating', 'generating', 'pending'])
    spentNow.add('a2')
    gx1.resolve()
    await settle(10)
    // a2 가 X2 판정에서 빠져 모두 빠짐 — 멈추고 알림 한 번 (Y 는 아직 생성 중)
    expect(notices.map((n) => n.kind)).toEqual(['dropped', 'allDropped'])
    expect(states(q)).toEqual(['done', 'generating', 'pending'])
    // 안내대로 번개를 끈다
    w.enabled = false
    q.reconcile()
    gy.resolve()
    await waitIdle(q)
    expect(states(q)).toEqual(['done', 'done', 'done'])
    expect(r.finishedBy.get('X2')).toBeNull()
    expect(r.overlap).toBe(false)
    expect(r.aborted).toBe(0)
  })

  it('끄는 교대 구간에 마지막 한 장이 429 로 돌아와도 평소 작업자가 이어받는다', async () => {
    const w = world()
    const { q, r } = newQueue(w)
    const g = r.hold('X')
    r.failOnce.set('X', (lane) => (lane.accountId !== null ? new RateLimitError(20) : null))
    q.enqueueMany([mk('X')])
    await settle()
    expect(states(q)).toEqual(['generating'])
    w.enabled = false
    q.reconcile()
    g.resolve()
    await waitIdle(q)
    expect(states(q)).toEqual(['done'])
    expect(r.attempts.get('X')).toBe(2)
    expect(r.finishedBy.get('X')).toBeNull()
  })

  it('켜는 교대 구간에 평소 작업자의 마지막 한 장이 429 로 돌아와도 계정 작업자가 이어받는다', async () => {
    const w = world({ enabled: false })
    const { q, r } = newQueue(w)
    const g = r.hold('X')
    r.failOnce.set('X', (lane) => (lane.accountId === null ? new RateLimitError(20) : null))
    q.enqueueMany([mk('X')])
    await settle()
    w.enabled = true
    q.reconcile()
    g.resolve()
    await waitIdle(q)
    expect(states(q)).toEqual(['done'])
    expect(r.attempts.get('X')).toBe(2)
    expect(r.finishedBy.get('X')).not.toBeNull()
  })

  it('켜는 교대 구간에 활성 계정을 바꿔도 평소 작업자가 쓴 계정으로는 두 장이 겹치지 않는다', async () => {
    const w = world({ enabled: false })
    const { q, r } = newQueue(w)
    const ga = r.hold('A')
    const gb = r.hold('B')
    q.enqueueMany([mk('A'), mk('B'), mk('C'), mk('D')])
    await settle()
    // 평소 작업자가 활성 a1 으로 A 를 생성 중일 때 켠다
    w.enabled = true
    q.reconcile()
    await settle()
    expect(r.started.map((s) => [s.label, s.accountId])).toEqual([
      ['A', null],
      ['B', 'a2']
    ])
    // 계정 화면에서 활성을 a2 로 바꾼다 — a1 작업자는 A(a1 토큰)가 끝날 때까지 기다려야 한다
    w.active = 'a2'
    q.reconcile(false)
    await settle()
    expect(r.started).toHaveLength(2)
    ga.resolve()
    await settle()
    expect(r.started[2]).toEqual({ label: 'C', accountId: 'a1' })
    gb.resolve()
    await waitIdle(q)
    expect(states(q)).toEqual(['done', 'done', 'done', 'done'])
    expect(r.overlap).toBe(false)
  })

  it('평소 작업자가 계정을 고르는 동안 켜면 고른 뒤에야 계정 작업자가 들어온다 — 자동 전환으로 바뀐 계정과 겹치지 않게', async () => {
    const w = world({ enabled: false })
    const { q, r } = newQueue(w)
    const choose = deferred()
    // 자동 전환: a1 이 소진이라 a2 로 바꾼 뒤 보낸다
    r.beforeClaim.set('A', async () => {
      await choose.p
      w.active = 'a2'
    })
    const ga = r.hold('A')
    const gb = r.hold('B')
    q.enqueueMany([mk('A'), mk('B'), mk('C')])
    await settle()
    w.enabled = true
    q.reconcile()
    await settle()
    // 고르는 중에는 어느 계정 작업자도 시작하지 않는다
    expect(r.started).toEqual([])
    expect(w.admitCalls).toEqual([])
    choose.resolve()
    await settle()
    // 평소 작업자는 a2 로 보냈다 — a2 작업자는 기다리고 a1 작업자만 들어온다
    expect(r.started.map((s) => [s.label, s.accountId])).toEqual([
      ['A', null],
      ['B', 'a1']
    ])
    ga.resolve()
    gb.resolve()
    await waitIdle(q)
    expect(states(q)).toEqual(['done', 'done', 'done'])
    expect(r.overlap).toBe(false)
  })

  it('같은 토큰의 계정 중 생성 중인 쪽을 지우면 남은 쪽이 그 작업자를 이어받는다 — 같은 토큰으로 두 장이 겹치지 않게', async () => {
    const w = world({
      accounts: [
        { id: 'a1', label: '계정 1' },
        { id: 'x', label: '계정 X', key: 'T2' }
      ],
      tokenOf: { x: 'T2', y: 'T2' }
    })
    const { q, r } = newQueue(w)
    const ga = r.hold('A')
    const gb = r.hold('B')
    q.enqueueMany([mk('A'), mk('B'), mk('C')])
    await settle()
    expect(r.started.map((s) => [s.label, s.accountId])).toEqual([
      ['A', 'a1'],
      ['B', 'x']
    ])
    // 중복으로 넣어 둔 x 를 지운다 — 같은 토큰의 y 가 남는다
    w.accounts = [
      { id: 'a1', label: '계정 1' },
      { id: 'y', label: '계정 Y', key: 'T2' }
    ]
    q.reconcile()
    await settle()
    // 같은 토큰으로 새 작업자가 뜨지 않는다
    expect(r.started).toHaveLength(2)
    gb.resolve()
    await settle()
    // 이어받은 작업자가 y 이름으로 다음 장을 뽑는다
    expect(r.started[2]).toEqual({ label: 'C', accountId: 'y' })
    ga.resolve()
    await waitIdle(q)
    expect(r.overlap).toBe(false)
    // 이어받은 id 의 한도 기록은 새로 조회하게
    expect(w.forgot).toEqual(['y'])
    // 작업자 이름은 렌더러로 내보내지 않는다
    expect(q.turboStatus().accounts).toEqual([
      { id: 'a1', label: '계정 1', excluded: false },
      { id: 'y', label: '계정 Y', excluded: false }
    ])
  })
})

describe('고속 모드 — 한도와 무관한 항목·등급', () => {
  it('한도를 보지 않은 V4.5 통과는 판정으로 치지 않는다 — 지난 실행의 빠짐 기록으로 거짓 멈춤이 나지 않는다', async () => {
    const w = world()
    const spentNow = new Set(['a2'])
    w.verdict = (id, model) => (!isV5Model(model) ? UNCHECKED : spentNow.has(id) ? EXHAUSTED : OK)
    const { q, r, notices } = newQueue(w)
    q.enqueueMany([mk('Xa'), mk('Xb')])
    await waitIdle(q)
    expect(excludedOf(q)).toEqual([false, true])
    // 시간이 지나 a2 는 돌아오고 a1 이 바닥났다
    spentNow.clear()
    spentNow.add('a1')
    q.enqueueMany([mk('Ya', V45), mk('Yb', V45), mk('X1'), mk('X2')])
    await waitIdle(q)
    expect(states(q)).toEqual(['done', 'done', 'done', 'done', 'done', 'done'])
    expect(r.finishedBy.get('X1')).toBe('a2')
    expect(r.finishedBy.get('X2')).toBe('a2')
    expect(notices.filter((n) => n.kind === 'allDropped')).toEqual([])
    expect(excludedOf(q)).toEqual([true, false])
  })

  it('V5 무료분이 모두 바닥나도 한도와 무관한 항목은 뽑고 V5 만 대기로 남긴다 — 멈춤 알림은 한 번', async () => {
    const w = world({ verdict: (_id, model) => (isV5Model(model) ? EXHAUSTED : UNCHECKED) })
    const { q, r, notices } = newQueue(w)
    q.enqueueMany([mk('X'), mk('Y', V45)])
    await settle(20)
    expect(q.status().running).toBe(false)
    expect(states(q)).toEqual(['pending', 'done'])
    expect(r.started.map((s) => s.label)).toEqual(['Y'])
    expect(notices.filter((n) => n.kind === 'allDropped')).toHaveLength(1)
  })

  it('V5 한도로 빠진 계정도 V4.5 를 생성하는 동안은 참여 중으로 보이고, V5 로 돌아오면 알림 없이 다시 빠진다', async () => {
    const w = world({
      verdict: (id, model) => (!isV5Model(model) ? UNCHECKED : id === 'a1' ? EXHAUSTED : OK)
    })
    const { q, r, notices } = newQueue(w)
    q.enqueueMany([mk('X')])
    await waitIdle(q)
    expect(excludedOf(q)).toEqual([true, false])
    const ga = r.hold('A')
    const gb = r.hold('B')
    q.enqueueMany([mk('A', V45), mk('B', V45)])
    await settle()
    expect(states(q).slice(1)).toEqual(['generating', 'generating'])
    // ×2 — 두 계정이 실제로 생성 중
    expect(excludedOf(q)).toEqual([false, false])
    ga.resolve()
    gb.resolve()
    await waitIdle(q)
    expect(excludedOf(q)).toEqual([true, false])
    q.enqueueMany([mk('X2')])
    await waitIdle(q)
    expect(r.finishedBy.get('X2')).toBe('a2')
    expect(notices.filter((n) => n.kind === 'dropped')).toHaveLength(1)
  })

  it('번개를 새로 켜면 지난번 빠짐 기록을 버린다 — 켜자마자 ×0 으로 보이지 않는다', async () => {
    const w = world({ verdict: () => EXHAUSTED })
    const { q } = newQueue(w)
    q.enqueueMany([mk('X')])
    await settle(10)
    expect(excludedOf(q)).toEqual([true, true])
    w.enabled = false
    q.reconcile()
    await waitIdle(q)
    w.enabled = true
    q.reconcile()
    expect(excludedOf(q)).toEqual([false, false])
  })

  it('V4.5 에서 등급이 맞지 않는 계정(Opus 아님)은 빠지고 알림은 한 번, 나머지 계정이 다 뽑는다', async () => {
    const w = world({
      verdict: (id, model) => (id === 'a2' ? UNKNOWN : isV5Model(model) ? OK : UNCHECKED)
    })
    const { q, r, notices } = newQueue(w)
    q.enqueueMany([mk('A', V45), mk('B', V45), mk('C', V45)])
    await waitIdle(q)
    expect(states(q)).toEqual(['done', 'done', 'done'])
    expect(r.started.every((s) => s.accountId === 'a1')).toBe(true)
    expect(notices).toEqual([{ kind: 'dropped', label: '계정 2', reason: 'unknown', active: 1 }])
  })

  it('모든 계정이 V4.5 도 쓸 수 없으면 멈추고 알림 한 번 — 한 장도 안 나간다', async () => {
    const w = world({ verdict: () => UNKNOWN })
    const { q, r, notices } = newQueue(w)
    q.enqueueMany([mk('A', V45), mk('B', V45)])
    await settle(10)
    expect(q.status().running).toBe(false)
    expect(states(q)).toEqual(['pending', 'pending'])
    expect(r.started).toEqual([])
    expect(notices.map((n) => n.kind)).toEqual(['dropped', 'allDropped'])
  })

  it('요청이 나간 뒤 실패하면 그 계정의 한도 기록을 버리고, 429 는 그대로 둔다', async () => {
    const w = world()
    const { q, r } = newQueue(w)
    r.failOnce.set('A', (lane) => (lane.accountId === 'a1' ? new Error('스트림 끊김') : null))
    r.failOnce.set('B', (lane) =>
      lane.accountId === 'a2' && r.attempts.get('B') === 1 ? new RateLimitError(0) : null
    )
    q.enqueueMany([mk('A'), mk('B')])
    await waitIdle(q)
    expect(states(q)).toEqual(['failed', 'done'])
    expect(w.forgot).toEqual(['a1'])
  })
})
