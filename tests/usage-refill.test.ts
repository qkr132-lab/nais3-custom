import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  availableRefills,
  itemExpiry,
  itemFitsInAllowance,
  parseInventory,
  parsePerk,
  refillAmount,
  refillBlock,
  refillBlockText,
  refillNoticeAction,
  type InventoryItem,
  type RefillStatus
} from '../src/shared/usage-refill'
import type { OpusUsage } from '../src/shared/opus-usage'
import type { GenerationRequest, TurboNotice } from '../src/shared/types'

/**
 * 충전 아이템(Opus Usage Boost) — 인벤토리 판정·조회·사용.
 * 가짜 계정 저장소와 가짜 fetch(가짜 NAI)만 쓴다. 실제 NAI 호출은 없고, 토큰은 시험용 문자열이다.
 */

const DAY = 86_400_000
const NOW = Date.now()

const state = vi.hoisted(() => ({
  tokens: new Map<string, string>(),
  accounts: [] as { id: string; label: string }[],
  active: 'a1',
  settings: new Map<string, string>()
}))

vi.mock('../src/main/db/settings', () => ({
  getSetting: (key: string) => state.settings.get(key) ?? null,
  getNaiToken: () => state.tokens.get(state.active) ?? null
}))
vi.mock('../src/main/db/accounts', () => ({
  accountToken: (id: string) => state.tokens.get(id) ?? null,
  activeAccountId: () => state.active,
  listAccounts: () =>
    state.accounts.map((a) => ({
      ...a,
      prefix: (state.tokens.get(a.id) ?? '').slice(0, 4),
      active: a.id === state.active
    })),
  setActiveAccount: (id: string) => {
    if (!state.tokens.has(id)) return false
    state.active = id
    return true
  }
}))

/** 가짜 NAI — 토큰별 구독·인벤토리. 모든 fetch 가 여기서 끝난다 */
const nai = {
  subs: new Map<string, { tier: number; expiresAt?: number; usage?: Record<string, unknown> }>(),
  inv: new Map<string, Record<string, unknown>[]>(),
  calls: [] as { method: string; url: string; token: string }[],
  inventoryStatus: 200,
  consumeStatus: 200,
  /** 이 토큰의 구독 조회를 붙잡아 두는 문 */
  holdSubscription: new Map<string, Promise<void>>()
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

async function fakeFetch(input: unknown, init?: RequestInit): Promise<Response> {
  const url = String(input)
  const method = init?.method ?? 'GET'
  const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? ''
  const token = auth.replace(/^Bearer /, '')
  nai.calls.push({ method, url, token })
  if (!url.startsWith('https://image.novelai.net/user/')) throw new Error(`예상 밖 주소: ${url}`)
  const path = url.slice('https://image.novelai.net'.length)
  if (path === '/user/subscription' && method === 'GET') {
    const hold = nai.holdSubscription.get(token)
    if (hold) await hold
    const sub = nai.subs.get(token)
    if (!sub) return json({}, 401)
    return json({
      tier: sub.tier,
      expiresAt: sub.expiresAt ?? NOW / 1000 + 30 * 86400,
      trainingStepsLeft: { fixedTrainingStepsLeft: 100, purchasedTrainingSteps: 0 },
      usage: sub.usage
    })
  }
  if (path === '/user/inventory' && method === 'GET') {
    if (nai.inventoryStatus !== 200) return json({}, nai.inventoryStatus)
    return json({ items: nai.inv.get(token) ?? [] })
  }
  const m = /^\/user\/inventory\/([^/]+)\/consume$/.exec(path)
  if (m && method === 'POST') {
    expect(init?.body).toBeUndefined()
    if (nai.consumeStatus !== 200) return new Response('서버 오류', { status: nai.consumeStatus })
    const id = decodeURIComponent(m[1])
    const item = (nai.inv.get(token) ?? []).find((i) => i.id === id)
    if (!item || item.isUsed) return new Response('', { status: 400 })
    item.isUsed = true
    // 추가분이 생기면 초과 사용 상태도 풀린다
    const usage = nai.subs.get(token)?.usage
    if (usage) {
      usage.purchasedPercent = Number(usage.purchasedPercent ?? 0) + 100
      usage.isNegative = false
    }
    return new Response(null, { status: 204 })
  }
  return new Response('', { status: 404 })
}
vi.stubGlobal('fetch', fakeFetch)
afterAll(() => {
  vi.unstubAllGlobals()
})

import { consumeRefill, refillStatus, refillStatusAll } from '../src/main/nai/usage-refill'
import { ENDPOINTS } from '../src/main/nai/endpoints'
import {
  ensureQuotaAccount,
  forgetProbe,
  probeAccount,
  resetProbeCache
} from '../src/main/nai/account-switch'
import { turboHooks, turboVerdict } from '../src/main/nai/turbo'
import { GenerationQueue, type LaneInfo } from '../src/main/queue/generation-queue'

const item = (patch: Partial<InventoryItem> & { id: string }): InventoryItem => ({
  itemId: 'refill_usage_limits',
  perk: 'usage_limit_add:100',
  isUsable: true,
  isUsed: false,
  expiryDate: new Date(NOW + 100 * DAY).toISOString(),
  createdAt: new Date(NOW - DAY).toISOString(),
  ...patch
})
const usage = (percent: number, purchasedPercent = 0, isNegative = false): OpusUsage => ({
  percent,
  purchasedPercent,
  isNegative,
  timeUntilNextPercent: 3600
})
const spentUsage = (): Record<string, unknown> => ({
  percent: 0,
  purchasedPercent: 0,
  isNegative: true,
  timeUntilNextPercent: 3600
})
const consumeCalls = (): { url: string; token: string }[] =>
  nai.calls.filter((c) => c.method === 'POST')
const subscriptionCalls = (token: string): number =>
  nai.calls.filter((c) => c.url.endsWith('/user/subscription') && c.token === token).length

beforeEach(() => {
  state.tokens = new Map([
    ['a1', 'test-token-1'],
    ['a2', 'test-token-2']
  ])
  state.accounts = [
    { id: 'a1', label: '계정 1' },
    { id: 'a2', label: '계정 2' }
  ]
  state.active = 'a1'
  state.settings = new Map()
  nai.subs = new Map([
    ['test-token-1', { tier: 3, usage: spentUsage() }],
    ['test-token-2', { tier: 3, usage: spentUsage() }]
  ])
  nai.inv = new Map()
  nai.calls = []
  nai.inventoryStatus = 200
  nai.consumeStatus = 200
  nai.holdSubscription = new Map()
  resetProbeCache()
})

describe('인벤토리 파싱', () => {
  it('items 가 없으면 빈 목록, 모양이 어긋난 항목은 버리고 빠진 필드는 기본값', () => {
    expect(parseInventory(null)).toEqual([])
    expect(parseInventory({})).toEqual([])
    expect(parseInventory({ items: 'x' })).toEqual([])
    expect(parseInventory({ items: [null, 3, { id: '' }, { itemId: 'x' }, { id: 'ok' }] })).toEqual(
      [
        {
          id: 'ok',
          itemId: '',
          perk: '',
          isUsable: false,
          isUsed: false,
          expiryDate: '',
          createdAt: ''
        }
      ]
    )
  })

  it('perk 은 마지막 : 뒤가 양', () => {
    expect(parsePerk('usage_limit_add:100')).toEqual({ kind: 'usage_limit_add', amount: 100 })
    expect(parsePerk('a:b:50')).toEqual({ kind: 'a:b', amount: 50 })
    expect(parsePerk('nocolon')).toBeNull()
    expect(parsePerk(':5')).toBeNull()
    expect(parsePerk('usage_limit_add:abc')).toBeNull()
    expect(refillAmount(item({ id: 'x' }))).toBe(100)
    expect(refillAmount(item({ id: 'x', perk: 'other_perk:100' }))).toBe(0)
  })

  it('만료 — 못 읽는 날짜는 만료 없음', () => {
    expect(itemExpiry(item({ id: 'x', expiryDate: '2027-01-01T00:00:00.000Z' }))).toBe(
      Date.parse('2027-01-01T00:00:00.000Z')
    )
    expect(itemExpiry(item({ id: 'x', expiryDate: 'garbage' }))).toBe(Infinity)
  })

  it('쓸 수 있는 것만, 만료가 가까운 것부터', () => {
    const items = [
      item({ id: 'late', expiryDate: new Date(NOW + 300 * DAY).toISOString() }),
      item({ id: 'used', isUsed: true }),
      item({ id: 'unusable', isUsable: false }),
      item({ id: 'expired', expiryDate: new Date(NOW - DAY).toISOString() }),
      item({ id: 'other', itemId: 'something_else' }),
      item({ id: 'badperk', perk: 'mystery' }),
      item({ id: 'nodate', expiryDate: '' }),
      item({ id: 'soon', expiryDate: new Date(NOW + 2 * DAY).toISOString() })
    ]
    expect(availableRefills(items, NOW).map((i) => i.id)).toEqual(['soon', 'late', 'nodate'])
  })

  it('추가분 상한 400% — 300 + 100 은 되고 301 + 100 은 안 된다. 한도 정보가 없으면 막지 않는다', () => {
    const one = item({ id: 'x' })
    expect(itemFitsInAllowance(usage(0, 300), one)).toBe(true)
    expect(itemFitsInAllowance(usage(0, 301), one)).toBe(false)
    expect(itemFitsInAllowance(null, one)).toBe(true)
  })

  it('쓸 수 없는 이유 — Opus 아님이 먼저, 그다음 보유 없음, 자리 없음', () => {
    const items = [item({ id: 'x' })]
    expect(refillBlock({ usage: usage(0), opusActive: false, items, now: NOW })).toBe('notOpus')
    expect(refillBlock({ usage: usage(0), opusActive: true, items: [], now: NOW })).toBe('none')
    expect(refillBlock({ usage: usage(0, 350), opusActive: true, items, now: NOW })).toBe('full')
    expect(refillBlock({ usage: usage(0, 300), opusActive: true, items, now: NOW })).toBeNull()
    expect(refillBlockText('none')).toBe('보유 없음')
    expect(refillBlockText('notOpus')).toBe('Opus 구독 아님')
    expect(refillBlockText('full', 100)).toBe('추가분이 300% 넘음 (100% 들어갈 자리 없음)')
  })
})

describe('소진 알림 버튼 고르기', () => {
  const st = (patch: Partial<RefillStatus>): RefillStatus => ({
    ok: true,
    accountId: 'a1',
    label: '계정 1',
    active: false,
    count: 0,
    nearestExpiry: null,
    amount: 0,
    blocked: 'none',
    ...patch
  })

  it('쓸 수 있는 계정이 있으면 사용 — 활성 계정을 먼저', () => {
    expect(
      refillNoticeAction([
        st({ accountId: 'a2', label: '계정 2', blocked: null, count: 1, amount: 100 }),
        st({ accountId: 'a1', active: true, blocked: null, count: 2, amount: 100 })
      ])
    ).toEqual({ kind: 'use', accountId: 'a1', label: '계정 1', amount: 100 })
    expect(
      refillNoticeAction([
        st({ active: true, blocked: 'none' }),
        st({ accountId: 'a2', label: '계정 2', blocked: null, count: 1, amount: 100 })
      ])
    ).toEqual({ kind: 'use', accountId: 'a2', label: '계정 2', amount: 100 })
  })

  it('보유가 없으면 구매 — 활성 계정 이름으로 안내', () => {
    expect(
      refillNoticeAction([st({}), st({ accountId: 'a2', label: '계정 2', active: true })])
    ).toEqual({ kind: 'buy', label: '계정 2' })
  })

  it('조회 실패만 있으면 버튼 없음, Opus 아님·자리 없음도 버튼 없음', () => {
    expect(refillNoticeAction([])).toBeNull()
    expect(refillNoticeAction([st({ ok: false, blocked: null })])).toBeNull()
    expect(refillNoticeAction([st({ blocked: 'notOpus' })])).toBeNull()
    expect(refillNoticeAction([st({ blocked: 'full', count: 1, amount: 100 })])).toBeNull()
    // 실패한 계정은 빼고 읽힌 계정으로 고른다
    expect(refillNoticeAction([st({ ok: false, blocked: null }), st({ accountId: 'a2' })])).toEqual(
      {
        kind: 'buy',
        label: '계정 1'
      }
    )
  })
})

describe('충전 아이템 조회 (메인)', () => {
  it('지금 쓰는 계정의 보유 수·가장 가까운 만료·양 — 토큰은 응답에 없다', async () => {
    const soon = new Date(NOW + 30 * DAY).toISOString()
    nai.inv.set('test-token-1', [
      item({ id: 'late', expiryDate: new Date(NOW + 300 * DAY).toISOString() }),
      item({ id: 'soon', expiryDate: soon }),
      item({ id: 'used', isUsed: true })
    ])
    const status = await refillStatus()
    expect(status).toEqual({
      ok: true,
      accountId: 'a1',
      label: '계정 1',
      active: true,
      count: 2,
      nearestExpiry: soon,
      amount: 100,
      blocked: null
    })
    expect(JSON.stringify(status)).not.toContain('test-token')
    // 한도와 인벤토리를 그 계정 토큰으로 한 번씩 읽는다
    expect(nai.calls.map((c) => [c.method, c.url.split('/user/')[1], c.token])).toEqual([
      ['GET', 'subscription', 'test-token-1'],
      ['GET', 'inventory', 'test-token-1']
    ])
  })

  it('다른 계정을 고르면 그 계정 토큰으로 — 활성 아님', async () => {
    const status = await refillStatus('a2')
    expect(status).toMatchObject({ ok: true, accountId: 'a2', label: '계정 2', active: false })
    expect(status.blocked).toBe('none')
    expect(nai.calls.every((c) => c.token === 'test-token-2')).toBe(true)
  })

  it('Opus 가 아니거나 구독이 끝났으면 Opus 구독 아님, 추가분이 300% 넘으면 자리 없음', async () => {
    nai.inv.set('test-token-1', [item({ id: 'x' })])
    nai.subs.set('test-token-1', { tier: 2 })
    expect((await refillStatus()).blocked).toBe('notOpus')
    nai.subs.set('test-token-1', { tier: 3, expiresAt: NOW / 1000 - 60, usage: spentUsage() })
    expect((await refillStatus()).blocked).toBe('notOpus')
    nai.subs.set('test-token-1', {
      tier: 3,
      usage: { percent: 0, purchasedPercent: 310, isNegative: false, timeUntilNextPercent: 60 }
    })
    expect((await refillStatus()).blocked).toBe('full')
  })

  it('인벤토리나 한도를 못 읽으면 ok 가 아니다', async () => {
    nai.inventoryStatus = 500
    expect((await refillStatus()).ok).toBe(false)
    nai.inventoryStatus = 200
    nai.subs.delete('test-token-1')
    expect((await refillStatus()).ok).toBe(false)
    state.tokens.delete('a2')
    expect(await refillStatus('a2')).toMatchObject({ ok: false, accountId: 'a2' })
  })

  it('모든 계정 — 같은 토큰을 두 계정으로 넣어 두었으면 한 번만 읽는다', async () => {
    state.accounts.push({ id: 'a3', label: '계정 3' })
    state.tokens.set('a3', 'test-token-2')
    const items = await refillStatusAll()
    expect(items.map((s) => s.accountId)).toEqual(['a1', 'a2'])
    expect(nai.calls.filter((c) => c.token === 'test-token-2')).toHaveLength(2)
    expect(JSON.stringify(items)).not.toContain('test-token')
  })
})

describe('충전 아이템 사용 (메인)', () => {
  const hooks = (): {
    changed: ReturnType<typeof vi.fn>
  } => ({ changed: vi.fn() })

  it('만료가 가장 가까운 것 하나를 그 계정 토큰으로 쓰고, 성공 뒤 한도 기록을 버린 다음 알린다', async () => {
    nai.inv.set('test-token-1', [
      item({ id: 'late one', expiryDate: new Date(NOW + 300 * DAY).toISOString() }),
      item({ id: 'soon/1', expiryDate: new Date(NOW + 5 * DAY).toISOString() })
    ])
    // 판정이 한 번 소진으로 찍어 둔 상태 (20초 캐시)
    await probeAccount('a1', 'test-token-1')
    const before = subscriptionCalls('test-token-1')
    const h = hooks()
    const result = await consumeRefill(undefined, h)
    expect(result).toEqual({ ok: true, amount: 100, label: '계정 1' })
    expect(JSON.stringify(result)).not.toContain('test-token')
    expect(consumeCalls()).toEqual([
      {
        method: 'POST',
        url: 'https://image.novelai.net/user/inventory/soon%2F1/consume',
        token: 'test-token-1'
      }
    ])
    expect(h.changed).toHaveBeenCalledWith({ accountIds: ['a1'], active: true })
    // 쓰기 직전에 한도·인벤토리를 다시 읽었고, 기록을 버렸으니 다음 판정은 새로 조회해 추가분을 본다
    const after = subscriptionCalls('test-token-1')
    expect(after).toBe(before + 1)
    expect(await probeAccount('a1', 'test-token-1')).toEqual(usage(0, 100, false))
    expect(subscriptionCalls('test-token-1')).toBe(after + 1)
  })

  it('조건이 안 맞으면 보내지 않는다 — 보유 없음·Opus 아님·자리 없음', async () => {
    const h = hooks()
    expect(await consumeRefill(undefined, h)).toEqual({ ok: false, error: '보유 없음' })
    nai.inv.set('test-token-1', [item({ id: 'x' })])
    nai.subs.set('test-token-1', { tier: 2 })
    expect(await consumeRefill(undefined, h)).toEqual({ ok: false, error: 'Opus 구독 아님' })
    nai.subs.set('test-token-1', {
      tier: 3,
      usage: { percent: 0, purchasedPercent: 301, isNegative: false, timeUntilNextPercent: 60 }
    })
    expect(await consumeRefill(undefined, h)).toEqual({
      ok: false,
      error: '추가분이 300% 넘음 (100% 들어갈 자리 없음)'
    })
    nai.inventoryStatus = 500
    expect(await consumeRefill(undefined, h)).toEqual({
      ok: false,
      error: '인벤토리를 읽지 못했습니다'
    })
    expect(consumeCalls()).toHaveLength(0)
    expect(h.changed).not.toHaveBeenCalled()
  })

  it('같은 계정 요청이 겹치면 하나만 보낸다', async () => {
    nai.inv.set('test-token-1', [item({ id: 'x' }), item({ id: 'y' })])
    let release!: () => void
    nai.holdSubscription.set('test-token-1', new Promise<void>((r) => (release = r)))
    const h = hooks()
    const first = consumeRefill('a1', h)
    // 같은 NAI 계정 — 활성 토큰으로 부르든 계정 id 로 부르든 겹침
    expect(await consumeRefill(undefined, h)).toEqual({ ok: false, error: '이미 처리 중입니다' })
    expect(await consumeRefill('a1', h)).toEqual({ ok: false, error: '이미 처리 중입니다' })
    release()
    expect((await first).ok).toBe(true)
    expect(consumeCalls()).toHaveLength(1)
    // 끝난 뒤에는 다시 쓸 수 있다
    nai.holdSubscription.clear()
    expect((await consumeRefill('a1', h)).ok).toBe(true)
    expect(consumeCalls()).toHaveLength(2)
  })

  it('다른 계정의 요청은 겹쳐도 각자 나간다', async () => {
    nai.inv.set('test-token-1', [item({ id: 'x' })])
    nai.inv.set('test-token-2', [item({ id: 'y' })])
    const h = hooks()
    const [r1, r2] = await Promise.all([consumeRefill('a1', h), consumeRefill('a2', h)])
    expect(r1.ok && r2.ok).toBe(true)
    expect(
      consumeCalls()
        .map((c) => c.token)
        .sort()
    ).toEqual(['test-token-1', 'test-token-2'])
    expect(h.changed).toHaveBeenCalledWith({ accountIds: ['a2'], active: false })
  })

  it('실패하면 다시 보내지 않고 오류를 돌려준다 — 그래도 한도 기록은 버리고 알린다', async () => {
    nai.inv.set('test-token-1', [item({ id: 'x' }), item({ id: 'y' })])
    nai.consumeStatus = 500
    const h = hooks()
    const result = await consumeRefill('a1', h)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toContain('500')
    expect(consumeCalls()).toHaveLength(1)
    expect(h.changed).toHaveBeenCalledTimes(1)
  })

  it('네트워크 오류도 한 번뿐이다', async () => {
    nai.inv.set('test-token-1', [item({ id: 'x' })])
    const h = hooks()
    const real = fakeFetch
    let posts = 0
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts++
        throw new TypeError('fetch failed')
      }
      return real(input, init)
    })
    try {
      expect(await consumeRefill('a1', h)).toEqual({ ok: false, error: 'fetch failed' })
    } finally {
      vi.stubGlobal('fetch', fakeFetch)
    }
    expect(posts).toBe(1)
  })

  it('알림 처리기가 실패해도 결과는 그대로', async () => {
    nai.inv.set('test-token-1', [item({ id: 'x' })])
    const result = await consumeRefill('a1', {
      changed: () => {
        throw new Error('방송 실패')
      }
    })
    expect(result.ok).toBe(true)
  })

  it('엔드포인트 표는 문자열만 — 사용 주소는 인벤토리 주소 뒤에 붙인다 (모바일 대체본과 키·값 대조)', () => {
    expect(Object.values(ENDPOINTS).every((v) => typeof v === 'string')).toBe(true)
    expect(ENDPOINTS.inventory).toBe('https://image.novelai.net/user/inventory')
    expect('consume' in ENDPOINTS).toBe(false)
  })

  it('토큰이 없는 계정은 아무것도 보내지 않는다', async () => {
    state.tokens.delete('a2')
    expect(await consumeRefill('a2', hooks())).toEqual({ ok: false, error: '계정 토큰이 없습니다' })
    expect(nai.calls).toHaveLength(0)
  })
})

describe('충전한 계정은 무료분이 남은 계정이다', () => {
  const v5 = { model: 'nai-diffusion-5-full' } as unknown as GenerationRequest

  it('고속 모드 — 일반분 0% + 추가분 100% 계정은 통과', async () => {
    nai.subs.set('test-token-2', {
      tier: 3,
      usage: { percent: 0, purchasedPercent: 100, isNegative: false, timeUntilNextPercent: 60 }
    })
    expect(await turboVerdict('a2', v5)).toEqual({ ok: true, checked: true })
    expect(await turboVerdict('a1', v5)).toEqual({ ok: false, reason: 'exhausted' })
  })

  it('자동 전환 — 소진된 활성 계정에서 충전한 계정으로 바꾼다', async () => {
    state.settings.set('auto_switch_account', '1')
    nai.subs.set('test-token-2', {
      tier: 3,
      usage: { percent: 0, purchasedPercent: 100, isNegative: false, timeUntilNextPercent: 60 }
    })
    expect(await ensureQuotaAccount('nai-diffusion-5-full')).toEqual({
      switched: true,
      label: '계정 2'
    })
    expect(state.active).toBe('a2')
  })

  it('서버가 추가분 키를 안 보내면 예전과 똑같다 — 0% 구간 계정으로는 바꾸지 않는다', async () => {
    state.settings.set('auto_switch_account', '1')
    nai.subs.set('test-token-2', {
      tier: 3,
      usage: { percent: 0, isNegative: false, timeUntilNextPercent: 60 }
    })
    expect(await ensureQuotaAccount('nai-diffusion-5-full')).toEqual({
      switched: false,
      allExhausted: true
    })
    expect(state.active).toBe('a1')
    resetProbeCache()
    expect(await turboVerdict('a2', v5)).toEqual({ ok: false, reason: 'unknown' })
  })
})

describe('사용 뒤 고속 모드 재판정', () => {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  async function waitFor(check: () => boolean): Promise<void> {
    for (let i = 0; i < 400 && !check(); i++) await sleep(5)
  }

  it('모든 계정이 빠져 멈춘 뒤 한 계정에 충전 아이템을 쓰면 그 계정으로 이어서 뽑는다', async () => {
    state.settings.set('turbo_mode', '1')
    const sent: string[] = []
    const generate = async (
      _r: GenerationRequest,
      _id: string,
      _s: AbortSignal,
      lane: LaneInfo
    ): Promise<string> => {
      sent.push(lane.accountId ?? 'default')
      return '/img.png'
    }
    const q = new GenerationQueue(generate, turboHooks())
    q.setDelayMs(0)
    const notices: TurboNotice[] = []
    q.on('turbo', (_s: unknown, notice?: TurboNotice) => {
      if (notice) notices.push(notice)
    })
    q.enqueueMany([{ model: 'nai-diffusion-5-full', seed: 0 } as unknown as GenerationRequest])
    await waitFor(() => notices.some((n) => n.kind === 'allDropped') && !q.status().running)
    expect(sent).toEqual([])
    // 마지막 계정이 빠지는 순간은 「모두 빠짐」 하나로 알린다 (예전 그대로)
    expect(notices.map((n) => n.kind)).toEqual(['dropped', 'allDropped'])
    // 빠진 알림에는 계정 id 가 담긴다 (알림 버튼이 그 계정을 조회한다)
    expect(notices[0]).toEqual({
      kind: 'dropped',
      id: 'a1',
      label: '계정 1',
      reason: 'exhausted',
      active: 1
    })

    nai.inv.set('test-token-2', [item({ id: 'x' })])
    const result = await consumeRefill('a2', {
      changed: ({ accountIds }) => q.recheck(accountIds)
    })
    expect(result.ok).toBe(true)
    await waitFor(() => q.status().items.every((i) => i.state === 'done'))
    expect(sent).toEqual(['a2'])
    expect(q.turboStatus().accounts.map((a) => [a.id, a.excluded])).toEqual([
      ['a1', true],
      ['a2', false]
    ])
  })

  it('쉬던 작업자도 쉬는 시간을 끊고 곧바로 다시 판정받는다', async () => {
    state.settings.set('turbo_mode', '1')
    nai.subs.set('test-token-1', {
      tier: 3,
      usage: { percent: 80, purchasedPercent: 0, isNegative: false, timeUntilNextPercent: 60 }
    })
    let release!: () => void
    const hold = new Promise<void>((r) => (release = r))
    const sent: string[] = []
    const generate = async (
      _r: GenerationRequest,
      _id: string,
      _s: AbortSignal,
      lane: LaneInfo
    ): Promise<string> => {
      sent.push(lane.accountId ?? 'default')
      if (sent.length === 1) await hold // a1 이 첫 장을 오래 붙잡는다
      return '/img.png'
    }
    const q = new GenerationQueue(generate, turboHooks())
    q.setDelayMs(0)
    const v5req = { model: 'nai-diffusion-5-full', seed: 0 } as unknown as GenerationRequest
    q.enqueueMany([v5req, v5req])
    // a1 은 첫 장을 생성 중, a2 는 소진으로 빠져 21초 쉬는 중
    await waitFor(() => q.turboStatus().accounts.some((a) => a.id === 'a2' && a.excluded))
    expect(sent).toEqual(['a1'])
    nai.inv.set('test-token-2', [item({ id: 'x' })])
    await consumeRefill('a2', { changed: ({ accountIds }) => q.recheck(accountIds) })
    await waitFor(() => sent.length === 2)
    expect(sent).toEqual(['a1', 'a2'])
    release()
    await waitFor(() => !q.status().running)
  })

  it('충전한 계정이 새 한도를 조회하는 사이 다른 계정이 바닥나도 멈추지 않는다 — 옛 빠짐 판정을 믿지 않는다', async () => {
    state.settings.set('turbo_mode', '1')
    nai.subs.set('test-token-1', {
      tier: 3,
      usage: { percent: 80, purchasedPercent: 0, isNegative: false, timeUntilNextPercent: 60 }
    })
    let releaseA1!: () => void
    const holdA1 = new Promise<void>((r) => (releaseA1 = r))
    const sent: string[] = []
    const generate = async (
      _r: GenerationRequest,
      _id: string,
      _s: AbortSignal,
      lane: LaneInfo
    ): Promise<string> => {
      sent.push(lane.accountId ?? 'default')
      if (lane.accountId === 'a1') {
        await holdA1
        // a1 은 이번 장으로 바닥난다 (생성 뒤 갱신이 새 한도를 읽은 것처럼)
        nai.subs.set('test-token-1', { tier: 3, usage: spentUsage() })
        forgetProbe('a1')
      }
      return '/img.png'
    }
    const q = new GenerationQueue(generate, turboHooks())
    q.setDelayMs(0)
    const notices: TurboNotice[] = []
    q.on('turbo', (_s: unknown, notice?: TurboNotice) => {
      if (notice) notices.push(notice)
    })
    const v5req = { model: 'nai-diffusion-5-full', seed: 0 } as unknown as GenerationRequest
    q.enqueueMany([v5req, v5req, v5req])
    // a1 은 첫 장을 생성 중, a2 는 소진으로 빠져 쉬는 중
    await waitFor(() => q.turboStatus().accounts.some((a) => a.id === 'a2' && a.excluded))
    expect(sent).toEqual(['a1'])

    // 충전 뒤 a2 의 새 한도 조회를 붙잡아 둔다
    let releaseA2!: () => void
    const holdA2 = new Promise<void>((r) => (releaseA2 = r))
    nai.inv.set('test-token-2', [item({ id: 'x' })])
    let a2Reads = 0
    const result = await consumeRefill('a2', {
      changed: ({ accountIds }) => {
        a2Reads = subscriptionCalls('test-token-2')
        nai.holdSubscription.set('test-token-2', holdA2)
        q.recheck(accountIds)
      }
    })
    expect(result.ok).toBe(true)
    await waitFor(() => subscriptionCalls('test-token-2') > a2Reads)
    expect(subscriptionCalls('test-token-2')).toBe(a2Reads + 1)

    // 그사이 a1 이 바닥나 빠진다 — a2 의 판정은 아직 안 나왔으니 「모두 빠짐」이 아니다
    releaseA1()
    await waitFor(() => notices.length === 2)
    expect(notices.map((n) => n.kind)).toEqual(['dropped', 'dropped'])
    expect(notices[1]).toMatchObject({ kind: 'dropped', id: 'a1' })

    releaseA2()
    await waitFor(() => q.status().items.every((i) => i.state === 'done'))
    expect(sent).toEqual(['a1', 'a2', 'a2'])
    expect(notices.some((n) => n.kind === 'allDropped')).toBe(false)
    expect(q.turboStatus().accounts.map((a) => [a.id, a.excluded])).toEqual([
      ['a1', true],
      ['a2', false]
    ])
    await waitFor(() => !q.status().running)
  })
})
