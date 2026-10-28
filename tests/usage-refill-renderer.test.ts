import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RefillStatus, RefillUseResult } from '../src/shared/types'

/**
 * 충전 아이템 — 렌더러 쪽: 확인 창 없이는 사용 요청이 나가지 않고, 한 번에 한 건,
 * 소진 알림 버튼이 보유 여부·조회 결과에 따라 갈린다. 가짜 IPC 만 쓴다.
 */

const env = vi.hoisted(() => {
  const handlers = new Map<string, (payload: unknown) => void>()
  const invoke = vi.fn<(channel: string, req?: unknown) => Promise<unknown>>(async (channel) => {
    throw new Error(`예상하지 못한 IPC: ${channel}`)
  })
  const open = vi.fn()
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() })
  vi.stubGlobal('window', {
    nais: {
      invoke,
      on: (channel: string, listener: (payload: unknown) => void) => {
        handlers.set(channel, listener)
        return () => handlers.delete(channel)
      }
    },
    open,
    setInterval: () => 0,
    clearInterval: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  })
  vi.stubGlobal('document', {
    visibilityState: 'hidden',
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  })
  return { handlers, invoke, open }
})

import {
  offerRefill,
  REFILL_SHOP_URL,
  refillShopGuide,
  useRefillStore
} from '../src/renderer/src/stores/refill-store'
import { setConfirmsDisabled, useDialogStore } from '../src/renderer/src/stores/dialog-store'
import { useToastStore } from '../src/renderer/src/stores/toast-store'
import { bindGenerationEvents } from '../src/renderer/src/stores/generation-store'

const status = (patch: Partial<RefillStatus>): RefillStatus => ({
  ok: true,
  accountId: 'a1',
  label: '계정 1',
  active: true,
  count: 0,
  nearestExpiry: null,
  amount: 0,
  blocked: 'none',
  ...patch
})
const usable = (patch: Partial<RefillStatus> = {}): RefillStatus =>
  status({
    count: 2,
    amount: 100,
    blocked: null,
    nearestExpiry: '2027-01-01T00:00:00.000Z',
    ...patch
  })

/** IPC 응답을 채널별로 정한다 (refill:use 는 호출만 센다) */
function route(table: {
  status?: (req: { accountId?: string }) => RefillStatus | Promise<RefillStatus>
  statusAll?: () => RefillStatus[] | Promise<RefillStatus[]>
  use?: () => RefillUseResult | Promise<RefillUseResult>
}): void {
  env.invoke.mockImplementation(async (channel: string, req?: unknown) => {
    if (channel === 'refill:status' && table.status)
      return table.status((req ?? {}) as { accountId?: string })
    if (channel === 'refill:statusAll' && table.statusAll) return { items: await table.statusAll() }
    if (channel === 'refill:use' && table.use) return table.use()
    if (channel === 'nai:balance') return { anlas: null, tier: null, opusUsage: null }
    throw new Error(`예상하지 못한 IPC: ${channel}`)
  })
}
const calls = (channel: string): unknown[][] =>
  env.invoke.mock.calls.filter((c) => c[0] === channel)
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}
const confirmOpen = (): boolean => useDialogStore.getState().confirm !== null
const answer = (ok: boolean): void => useDialogStore.getState()._resolveConfirm(ok)
const toasts = (): { message: string; type: string; action?: string }[] =>
  useToastStore
    .getState()
    .toasts.map((t) => ({ message: t.message, type: t.type, action: t.action?.label }))

beforeEach(() => {
  env.invoke.mockReset()
  env.open.mockReset()
  route({})
  useRefillStore.setState({ busy: false })
  useDialogStore.setState({ confirm: null, textPrompt: null })
  useToastStore.setState({ toasts: [] })
  setConfirmsDisabled(false)
})

describe('사용 — 언제나 확인 창을 거친다', () => {
  it('확인 창에서 아니오를 누르면 사용 요청은 0번', async () => {
    route({ use: () => ({ ok: true, amount: 100, label: '계정 1' }) })
    const done = useRefillStore
      .getState()
      .confirmAndUse({ accountId: 'a1', label: '계정 1', amount: 100 })
    await flush()
    expect(confirmOpen()).toBe(true)
    expect(useDialogStore.getState().confirm).toMatchObject({
      title: '충전 아이템을 쓸까요?',
      message: 'Opus 한도에 100%가 더해지고 되돌릴 수 없습니다\n계정: 계정 1',
      confirmLabel: '사용'
    })
    expect(calls('refill:use')).toHaveLength(0)
    answer(false)
    expect(await done).toBe('cancel')
    expect(calls('refill:use')).toHaveLength(0)
    expect(useRefillStore.getState().busy).toBe(false)
  })

  it('「확인 창 끄기」를 켜 두어도 묻는다', async () => {
    setConfirmsDisabled(true)
    route({ use: () => ({ ok: true, amount: 100, label: '계정 1' }) })
    const done = useRefillStore
      .getState()
      .confirmAndUse({ accountId: 'a1', label: '계정 1', amount: 100 })
    await flush()
    expect(confirmOpen()).toBe(true)
    expect(calls('refill:use')).toHaveLength(0)
    answer(true)
    expect(await done).toBe('ok')
    expect(calls('refill:use')).toEqual([['refill:use', { accountId: 'a1' }]])
    expect(toasts()).toEqual([
      { message: '충전 아이템을 썼습니다 — Opus 한도 +100%', type: 'success', action: undefined }
    ])
  })

  it('처리 중에는 한 번에 한 건 — 두 번째 요청은 확인 창도 띄우지 않는다', async () => {
    let finish!: (r: RefillUseResult) => void
    route({ use: () => new Promise<RefillUseResult>((r) => (finish = r)) })
    const store = useRefillStore.getState()
    const first = store.confirmAndUse({ accountId: 'a1', label: '계정 1', amount: 100 })
    await flush()
    const firstConfirm = useDialogStore.getState().confirm
    expect(await store.confirmAndUse({ accountId: 'a2', label: '계정 2', amount: 100 })).toBe(
      'cancel'
    )
    expect(useDialogStore.getState().confirm).toBe(firstConfirm)
    answer(true)
    await flush()
    expect(useRefillStore.getState().busy).toBe(true)
    // 요청이 끝나기 전 또 눌러도 나가지 않는다
    expect(await store.confirmAndUse({ accountId: 'a1', label: '계정 1', amount: 100 })).toBe(
      'cancel'
    )
    finish({ ok: true, amount: 100, label: '계정 1' })
    expect(await first).toBe('ok')
    expect(calls('refill:use')).toHaveLength(1)
    expect(useRefillStore.getState().busy).toBe(false)
  })

  it('실패하면 오류 토스트만 — 다시 보내지 않는다', async () => {
    route({ use: () => ({ ok: false, error: '사용 실패 500' }) })
    const done = useRefillStore
      .getState()
      .confirmAndUse({ accountId: null, label: '', amount: 100 })
    await flush()
    // 계정 목록 없이 쓰는 경우 — 계정 줄 없이 묻고, id 없이 보낸다
    expect(useDialogStore.getState().confirm?.message).toBe(
      'Opus 한도에 100%가 더해지고 되돌릴 수 없습니다'
    )
    answer(true)
    expect(await done).toBe('fail')
    expect(calls('refill:use')).toEqual([['refill:use', {}]])
    expect(toasts()).toEqual([
      { message: '충전 아이템을 쓰지 못했습니다 — 사용 실패 500', type: 'error', action: undefined }
    ])
  })
})

describe('소진 알림 버튼', () => {
  it('쓸 수 있는 충전 아이템이 있으면 「충전 아이템 쓰기」 — 누르기 전엔 조회만 한다', async () => {
    route({
      statusAll: () => [
        status({ accountId: 'a1' }),
        usable({ accountId: 'a2', label: '계정 2', active: false })
      ],
      use: () => ({ ok: true, amount: 100, label: '계정 2' })
    })
    const id = useToastStore.getState().push('모두 소진', 'error')
    await offerRefill(id)
    expect(toasts()).toEqual([{ message: '모두 소진', type: 'error', action: '충전 아이템 쓰기' }])
    expect(calls('refill:statusAll')).toHaveLength(1)
    expect(calls('refill:use')).toHaveLength(0)
    expect(confirmOpen()).toBe(false)
    // 누르면 같은 확인 창 → 그 계정으로
    useToastStore.getState().toasts[0].action?.run()
    await flush()
    expect(useDialogStore.getState().confirm?.message).toContain('계정: 계정 2')
    expect(calls('refill:use')).toHaveLength(0)
    answer(true)
    await flush()
    expect(calls('refill:use')).toEqual([['refill:use', { accountId: 'a2' }]])
  })

  it('보유가 없으면 「구매」 — 누르면 브라우저로 이미지 화면을 열고 안내한다', async () => {
    route({ status: () => status({ accountId: 'a2', label: '계정 2', active: false }) })
    const id = useToastStore.getState().push('"계정 2" 무료분 소진', 'info')
    await offerRefill(id, 'a2')
    expect(calls('refill:status')).toEqual([['refill:status', { accountId: 'a2' }]])
    expect(toasts()[0].action).toBe('구매')
    expect(env.open).not.toHaveBeenCalled()
    useToastStore.getState().toasts[0].action?.run()
    expect(env.open).toHaveBeenCalledWith(REFILL_SHOP_URL)
    expect(REFILL_SHOP_URL).toBe('https://novelai.net/image')
    expect(toasts().map((t) => t.message)).toContain(refillShopGuide('계정 2'))
    expect(refillShopGuide('계정 2')).toBe(
      '열린 화면에서 메뉴 → Inventory → Buy 로 살 수 있습니다. 브라우저에 "계정 2" 계정으로 로그인돼 있어야 합니다'
    )
    expect(calls('refill:use')).toHaveLength(0)
  })

  it('조회에 실패하면 버튼 없이 알림만', async () => {
    route({ statusAll: () => Promise.reject(new Error('끊김')) })
    const id = useToastStore.getState().push('모두 소진', 'error')
    await offerRefill(id)
    expect(toasts()).toEqual([{ message: '모두 소진', type: 'error', action: undefined }])

    route({ statusAll: () => [status({ ok: false, blocked: null })] })
    await offerRefill(id)
    expect(toasts()[0].action).toBeUndefined()
  })

  it('Opus 구독이 아니면 버튼 없음', async () => {
    route({ status: () => status({ blocked: 'notOpus' }) })
    const id = useToastStore.getState().push('빠짐', 'info')
    await offerRefill(id, 'a1')
    expect(toasts()[0].action).toBeUndefined()
  })

  it('알림이 연달아 떠도 조회 중이면 한 번만 읽는다', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    route({
      statusAll: async () => {
        await gate
        return [usable()]
      }
    })
    const a = useToastStore.getState().push('소진 1', 'error')
    const b = useToastStore.getState().push('소진 2', 'error')
    const both = Promise.all([offerRefill(a), offerRefill(b)])
    release()
    await both
    expect(calls('refill:statusAll')).toHaveLength(1)
    expect(toasts().map((t) => t.action)).toEqual(['충전 아이템 쓰기', '충전 아이템 쓰기'])
  })

  it('이미 사라진 알림에는 달지 않는다', async () => {
    route({ statusAll: () => [usable()] })
    const id = useToastStore.getState().push('소진', 'error')
    useToastStore.getState().dismiss(id)
    await offerRefill(id)
    expect(toasts()).toEqual([])
  })
})

describe('이벤트 연결 — 어떤 알림이 어떤 계정을 조회하나', () => {
  let unbind: (() => void) | undefined
  beforeEach(() => {
    unbind?.()
    env.handlers.clear()
    unbind = bindGenerationEvents()
  })
  const emit = (channel: string, payload: unknown): void => env.handlers.get(channel)?.(payload)

  it('고속 모드에서 한 계정이 빠지면 그 계정만, 알림은 바로 뜨고 버튼은 조회 뒤에 붙는다', async () => {
    route({ status: (req) => usable({ accountId: req.accountId ?? null }) })
    emit('turbo:notice', {
      kind: 'dropped',
      id: 'a2',
      label: '계정 2',
      reason: 'exhausted',
      active: 1
    })
    expect(toasts()).toEqual([
      {
        message: '"계정 2" 무료분 소진 — 고속 모드에서 뺐습니다 (×1)',
        type: 'info',
        action: undefined
      }
    ])
    await flush()
    expect(calls('refill:status')).toEqual([['refill:status', { accountId: 'a2' }]])
    expect(toasts()[0].action).toBe('충전 아이템 쓰기')
    expect(calls('refill:use')).toHaveLength(0)
  })

  it('모두 빠짐·자동 전환의 모두 소진은 등록 계정 전부를 조회한다', async () => {
    route({ statusAll: () => [status({})] })
    emit('turbo:notice', { kind: 'allDropped' })
    emit('accounts:allExhausted', undefined)
    await flush()
    expect(calls('refill:statusAll').length).toBeGreaterThanOrEqual(1)
    expect(toasts().map((t) => t.action)).toEqual(['구매', '구매'])
    expect(calls('refill:use')).toHaveLength(0)
  })
})
