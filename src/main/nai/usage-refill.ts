import { createHash } from 'crypto'
import { accountToken, activeAccountId, listAccounts } from '../db/accounts'
import { getNaiToken } from '../db/settings'
import {
  availableRefills,
  refillAmount,
  refillBlock,
  refillBlockText,
  type InventoryItem,
  type RefillStatus,
  type RefillUseResult
} from '../../shared/usage-refill'
import type { OpusUsage } from '../../shared/opus-usage'
import { forgetProbe } from './account-switch'
import { consumeItem, fetchAnlasBalance, fetchInventory } from './client'

/**
 * 충전 아이템(Opus Usage Boost) 조회·사용 (커스텀).
 *
 * 렌더러는 계정 id 만 넘기고 토큰은 이 모듈 밖으로 나가지 않는다.
 * 저절로 쓰는 일은 없다 — 사용은 렌더러가 확인 창을 받은 뒤 부르는 consumeRefill 하나뿐이다.
 */

interface Target {
  id: string | null
  label: string
  token: string
  /** 지금 쓰는(활성) 계정인가 — 잔액 기록·게이지는 이 계정 것만 */
  active: boolean
}

/** accountId 가 없으면 지금 쓰는 토큰의 계정. 계정 목록 없이 토큰만 넣어 쓰면 id 가 null */
function resolveTarget(accountId?: string): Target | null {
  const current = getNaiToken()?.trim() || null
  const labelOf = (id: string): string => listAccounts().find((a) => a.id === id)?.label ?? ''
  if (accountId) {
    const token = accountToken(accountId)?.trim()
    if (!token) return null
    return { id: accountId, label: labelOf(accountId), token, active: token === current }
  }
  if (!current) return null
  const id = activeAccountId()
  const own = id && accountToken(id)?.trim() === current ? id : null
  return { id: own, label: own ? labelOf(own) : '', token: current, active: true }
}

/** 같은 토큰을 쓰는 등록 계정 id 전부 — 한 NAI 계정을 두 항목으로 넣어 두었을 수 있다 */
function sameAccountIds(token: string): string[] {
  return listAccounts()
    .map((a) => a.id)
    .filter((id) => accountToken(id)?.trim() === token)
}

function tokenKey(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16)
}

interface ReadState {
  usage: OpusUsage | null
  opusActive: boolean
  items: InventoryItem[]
}

/** 한도와 인벤토리를 함께 읽는다. 하나라도 실패하면 null */
async function readState(token: string): Promise<ReadState | null> {
  const [balance, items] = await Promise.all([fetchAnlasBalance(token), fetchInventory(token)])
  if (balance.anlas === null || items === null) return null
  return { usage: balance.opusUsage, opusActive: balance.opusActive, items }
}

async function statusOf(target: Target): Promise<RefillStatus> {
  const base = { accountId: target.id, label: target.label, active: target.active }
  const state = await readState(target.token)
  if (!state) return { ...base, ok: false, count: 0, nearestExpiry: null, amount: 0, blocked: null }
  const now = Date.now()
  const available = availableRefills(state.items, now)
  return {
    ...base,
    ok: true,
    count: available.length,
    nearestExpiry: available[0]?.expiryDate ?? null,
    amount: available[0] ? refillAmount(available[0]) : 0,
    blocked: refillBlock({ ...state, now })
  }
}

const NO_ACCOUNT: RefillStatus = {
  ok: false,
  accountId: null,
  label: '',
  active: false,
  count: 0,
  nearestExpiry: null,
  amount: 0,
  blocked: null
}

/** 계정 하나의 충전 아이템 상태 — accountId 가 없으면 지금 쓰는 계정 */
export async function refillStatus(accountId?: string): Promise<RefillStatus> {
  const target = resolveTarget(accountId)
  return target ? statusOf(target) : { ...NO_ACCOUNT, accountId: accountId ?? null }
}

/** 등록 계정마다 한 번씩 (같은 토큰은 한 번) — 모든 계정이 소진됐다는 알림의 버튼을 고를 때 */
export async function refillStatusAll(): Promise<RefillStatus[]> {
  const seen = new Set<string>()
  const targets: Target[] = []
  for (const a of listAccounts()) {
    const target = resolveTarget(a.id)
    if (!target || seen.has(target.token)) continue
    seen.add(target.token)
    targets.push(target)
  }
  // 계정 목록 없이 토큰만 넣어 쓰는 경우
  if (!targets.length) {
    const current = resolveTarget()
    if (current) targets.push(current)
  }
  return Promise.all(targets.map(statusOf))
}

export interface RefillHooks {
  /**
   * 사용 요청을 보낸 뒤(성공·실패 모두) — 이 계정의 한도 기록은 이미 버렸다.
   * 활성 계정이면 잔액을 다시 읽어 알리고, 고속 모드에서 빠진 계정을 다시 판정받게 한다.
   */
  changed(info: { accountIds: string[]; active: boolean }): Promise<void> | void
}

/** 지금 사용 요청을 처리 중인 NAI 계정 (토큰 해시) — 겹친 요청은 하나만 보낸다 */
const using = new Set<string>()

/**
 * 충전 아이템 하나를 쓴다. 쓰기 직전에 인벤토리·한도를 다시 읽어 조건을 확인하고
 * 만료가 가장 가까운 쓸 수 있는 것 하나만 보낸다. 실패해도 다시 보내지 않는다.
 */
export async function consumeRefill(
  accountId: string | undefined,
  hooks: RefillHooks
): Promise<RefillUseResult> {
  const target = resolveTarget(accountId)
  if (!target) return { ok: false, error: '계정 토큰이 없습니다' }
  // 확인과 등록 사이에 await 가 없어야 겹친 요청이 둘 다 통과하지 않는다
  const key = tokenKey(target.token)
  if (using.has(key)) return { ok: false, error: '이미 처리 중입니다' }
  using.add(key)
  try {
    const state = await readState(target.token)
    if (!state) return { ok: false, error: '인벤토리를 읽지 못했습니다' }
    const now = Date.now()
    const item = availableRefills(state.items, now)[0]
    const blocked = refillBlock({ ...state, now })
    if (blocked || !item) {
      return {
        ok: false,
        error: refillBlockText(blocked ?? 'none', item ? refillAmount(item) : 100)
      }
    }

    let error: string | null = null
    try {
      await consumeItem(target.token, item.id)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    // 요청이 서버에 닿았을 수 있다 — 성공·실패 모두 이 계정의 한도 기록을 믿지 않는다
    const accountIds = sameAccountIds(target.token)
    for (const id of accountIds) forgetProbe(id)
    try {
      await hooks.changed({ accountIds, active: target.active })
    } catch {
      // 잔액 방송·재판정이 실패해도 사용 결과는 그대로 알린다
    }
    return error
      ? { ok: false, error }
      : { ok: true, amount: refillAmount(item), label: target.label }
  } finally {
    using.delete(key)
  }
}
