import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpusUsage } from '../src/shared/opus-usage'
import type { GenerationRequest } from '../src/shared/types'

/**
 * 고속 모드 — 계정별 Anlas 안전 판정. V5 는 무료분이 '남음' 으로 확인된 계정만 통과한다.
 * 가짜 계정 저장소·가짜 잔액 조회만 쓴다 (NAI 호출 없음, 토큰 값은 시험용 문자열).
 */

const state = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  tokens: new Map<string, string>(),
  usage: new Map<string, OpusUsage | null>(),
  fetchCalls: [] as string[],
  gate: null as null | Promise<void>,
  /** 잔액 조회가 실패하는 횟수 (남은 만큼 연달아 실패) */
  failFetches: 0,
  /** 등록 계정 목록 (id·이름만, 토큰은 tokens 에서) */
  accounts: [] as { id: string; label: string }[],
  active: 'a1'
}))

vi.mock('../src/main/db/settings', () => ({
  getSetting: (key: string) => state.settings.get(key) ?? null
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
  setActiveAccount: () => false
}))
vi.mock('../src/main/nai/client', () => ({
  fetchAnlasBalance: async (token: string) => {
    state.fetchCalls.push(token)
    if (state.gate) await state.gate
    if (state.failFetches > 0) {
      state.failFetches--
      return { anlas: null, tier: null, opusUsage: null }
    }
    const id = [...state.tokens.entries()].find(([, t]) => t === token)?.[0] ?? ''
    const usage = state.usage.get(id) ?? null
    return { anlas: 100, tier: 'opus', opusUsage: usage }
  },
  RateLimitError: class extends Error {}
}))

import { turboEnabled, turboHooks, turboVerdict } from '../src/main/nai/turbo'
import { probeAccount, refreshAccountUsage, resetProbeCache } from '../src/main/nai/account-switch'

/** 모델·소스만 가진 최소 요청 (판정은 그 둘만 본다) */
const req = (patch: object): GenerationRequest => patch as unknown as GenerationRequest
const v5 = req({ model: 'nai-diffusion-5-full' })
const free = (percent: number): OpusUsage => ({
  percent,
  isNegative: false,
  timeUntilNextPercent: 3600
})
const spent: OpusUsage = { percent: 0, isNegative: true, timeUntilNextPercent: 3600 }

beforeEach(() => {
  state.settings.clear()
  state.tokens = new Map([
    ['a1', 'test-token-1'],
    ['a2', 'test-token-2']
  ])
  state.usage = new Map()
  state.fetchCalls = []
  state.gate = null
  state.failFetches = 0
  state.accounts = [
    { id: 'a1', label: '계정 1' },
    { id: 'a2', label: '계정 2' }
  ]
  state.active = 'a1'
  resetProbeCache()
})

describe('고속 모드 저장값', () => {
  it('저장값이 없으면 꺼짐, 1 일 때만 켬', () => {
    expect(turboEnabled()).toBe(false)
    state.settings.set('turbo_mode', '0')
    expect(turboEnabled()).toBe(false)
    state.settings.set('turbo_mode', '1')
    expect(turboEnabled()).toBe(true)
  })
})

describe('계정별 한도 판정 (V5)', () => {
  it('무료분이 남은 계정은 통과하고 한도를 확인했다고 알린다', async () => {
    state.usage.set('a1', free(40))
    expect(await turboVerdict('a1', v5)).toEqual({ ok: true, checked: true })
  })

  it('한도를 넘겨 쓴 계정은 소진으로 뺀다', async () => {
    state.usage.set('a1', spent)
    expect(await turboVerdict('a1', v5)).toEqual({ ok: false, reason: 'exhausted' })
  })

  it('0% 구간(소수점 이하가 남았을 수 있음)은 모름으로 뺀다', async () => {
    state.usage.set('a1', free(0))
    expect(await turboVerdict('a1', v5)).toEqual({ ok: false, reason: 'unknown' })
  })

  it('한도 정보가 없는 계정(Opus 아님·조회 실패)도 모름으로 뺀다', async () => {
    state.usage.set('a1', null)
    expect(await turboVerdict('a1', v5)).toEqual({ ok: false, reason: 'unknown' })
  })

  it('토큰이 없는 계정은 뺀다', async () => {
    state.tokens.delete('a1')
    expect(await turboVerdict('a1', v5)).toEqual({ ok: false, reason: 'unknown' })
  })

  it('계정마다 따로 판정한다 — 한 계정이 소진이어도 다른 계정은 통과', async () => {
    state.usage.set('a1', spent)
    state.usage.set('a2', free(10))
    expect((await turboVerdict('a1', v5)).ok).toBe(false)
    expect((await turboVerdict('a2', v5)).ok).toBe(true)
  })
})

describe('V4.5 이하와 인페인트', () => {
  it('V4.5 는 한도와 무관 — 조회도 하지 않고 통과', async () => {
    state.usage.set('a1', spent)
    const v = await turboVerdict('a1', req({ model: 'nai-diffusion-4-5-full' }))
    expect(v).toEqual({ ok: true, checked: false })
    expect(state.fetchCalls).toEqual([])
  })

  it('V5 Curated 인페인트는 V4.5 Curated 인페인트로 나가므로 한도와 무관', async () => {
    state.usage.set('a1', spent)
    const v = await turboVerdict(
      'a1',
      req({
        model: 'nai-diffusion-5-curated',
        source: { imageBase64: 'x', maskBase64: 'y', strength: 1, noise: 0 }
      })
    )
    expect(v).toEqual({ ok: true, checked: false })
  })

  it('V5 Full 인페인트는 V5 한도를 그대로 따른다', async () => {
    state.usage.set('a1', spent)
    const v = await turboVerdict(
      'a1',
      req({
        model: 'nai-diffusion-5-full',
        source: { imageBase64: 'x', maskBase64: 'y', strength: 1, noise: 0 }
      })
    )
    expect(v).toEqual({ ok: false, reason: 'exhausted' })
  })

  it('마스크 없는 i2i 는 모델 그대로 판정', async () => {
    state.usage.set('a1', spent)
    const v = await turboVerdict(
      'a1',
      req({
        model: 'nai-diffusion-5-full',
        source: { imageBase64: 'x', strength: 0.7, noise: 0 }
      })
    )
    expect(v.ok).toBe(false)
  })
})

describe('조회 캐시와 생성 뒤 갱신', () => {
  it('20초 안에는 같은 계정을 다시 조회하지 않는다', async () => {
    state.usage.set('a1', free(40))
    await turboVerdict('a1', v5)
    await turboVerdict('a1', v5)
    expect(state.fetchCalls).toEqual(['test-token-1'])
  })

  it('생성 뒤 갱신이 끝나기 전에는 낡은 값으로 판정하지 않고 그 결과를 기다린다', async () => {
    // 1) 남음으로 한 번 조회해 캐시에 둔다
    state.usage.set('a1', free(1))
    expect((await turboVerdict('a1', v5)).ok).toBe(true)
    // 2) 방금 끝난 생성으로 한도가 바닥났고, 갱신 조회는 아직 진행 중
    state.usage.set('a1', spent)
    let release!: () => void
    state.gate = new Promise<void>((r) => (release = r))
    const refreshing = refreshAccountUsage('a1', 'test-token-1')
    // 3) 다음 장 판정 — 갱신이 끝날 때까지 기다린 뒤 새 값(소진)으로 판정해야 한다
    const verdict = turboVerdict('a1', v5)
    let settled = false
    void verdict.then(() => (settled = true))
    await new Promise((r) => setTimeout(r, 20))
    expect(settled).toBe(false)
    release()
    await refreshing
    expect(await verdict).toEqual({ ok: false, reason: 'exhausted' })
  })

  it('갱신 조회가 성공하면 그 값이 캐시가 되어 바로 다음 판정은 다시 조회하지 않는다', async () => {
    state.usage.set('a1', free(30))
    await refreshAccountUsage('a1', 'test-token-1')
    expect(state.fetchCalls).toHaveLength(1)
    expect(await probeAccount('a1', 'test-token-1')).toEqual(free(30))
    expect(state.fetchCalls).toHaveLength(1)
  })

  it('갱신 조회가 실패하면 옛 「남음」 기록을 믿지 않고 다음 판정에서 새로 조회한다', async () => {
    // 1) 남음(1%)으로 조회해 캐시에 둔다
    state.usage.set('a1', free(1))
    expect((await turboVerdict('a1', v5)).ok).toBe(true)
    // 2) 방금 장이 한도를 다 쓴 상태인데 갱신 조회가 실패했다
    state.usage.set('a1', spent)
    state.failFetches = 1
    await refreshAccountUsage('a1', 'test-token-1')
    // 3) 20초 안이어도 옛 기록(남음)으로 통과시키지 않고 다시 조회해 소진으로 뺀다
    expect(await turboVerdict('a1', v5)).toEqual({ ok: false, reason: 'exhausted' })
    expect(state.fetchCalls).toHaveLength(3)
  })

  it('갱신 조회에 이어 새 조회도 실패하면 모름으로 뺀다', async () => {
    state.usage.set('a1', free(40))
    expect((await turboVerdict('a1', v5)).ok).toBe(true)
    state.failFetches = 2
    await refreshAccountUsage('a1', 'test-token-1')
    expect(await turboVerdict('a1', v5)).toEqual({ ok: false, reason: 'unknown' })
  })
})

describe('작업자로 쓸 계정', () => {
  it('토큰을 풀 수 있는 등록 계정을 그대로 낸다', () => {
    const hooks = turboHooks()
    expect(hooks.accounts()).toEqual([
      { id: 'a1', label: '계정 1' },
      { id: 'a2', label: '계정 2' }
    ])
    expect(hooks.activeId()).toBe('a1')
  })

  it('토큰을 풀 수 없는 계정은 뺀다', () => {
    state.tokens.delete('a2')
    expect(
      turboHooks()
        .accounts()
        .map((a) => a.id)
    ).toEqual(['a1'])
  })

  it('같은 토큰을 두 계정으로 넣어 두면 하나로 센다 — 한 NAI 계정에 동시에 두 장이 나가지 않게', () => {
    state.tokens.set('a2', 'test-token-1')
    const hooks = turboHooks()
    expect(hooks.accounts().map((a) => a.id)).toEqual(['a1'])
    // 활성 계정이 빠진 쪽이면 같은 토큰으로 남은 쪽을 활성으로 본다
    state.active = 'a2'
    expect(hooks.activeId()).toBe('a1')
  })
})
