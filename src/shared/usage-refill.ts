import { MAX_PURCHASED_PERCENT, usagePurchasedPercent, type OpusUsage } from './opus-usage'

/**
 * 충전 아이템(Opus Usage Boost) — 인벤토리 판정 (커스텀).
 *
 * 확정 소스: NAI 웹 번들 실측 (2026-10-29, CommitHash 6fb7f79). 사면 인벤토리에 들어가고,
 * 쓰면 Opus 한도 추가분이 perk 만큼(usage_limit_add:100 = +100%) 늘어난다. 산 날부터 1년이 지나면
 * 만료되고, 여러 개면 만료가 가장 가까운 것부터 쓴다. 추가분은 400% 를 넘을 수 없어
 * 지금 추가분 + 양이 400 을 넘으면 쓰지 않는다 (웹 itemFitsInAllowance).
 */

export const REFILL_ITEM_ID = 'refill_usage_limits'
const PERK_USAGE_ADD = 'usage_limit_add'

/** /user/inventory 응답의 항목 하나 */
export interface InventoryItem {
  id: string
  /** 상품 종류 — 충전 아이템은 'refill_usage_limits' */
  itemId: string
  /** 효과 — 'usage_limit_add:100' 처럼 마지막 ':' 뒤가 양 */
  perk: string
  isUsable: boolean
  isUsed: boolean
  /** 만료 시각 (ISO) */
  expiryDate: string
  createdAt: string
}

/** 응답 본문 → 항목 목록. items 가 없으면 빈 목록, 모양이 어긋난 항목은 버린다 */
export function parseInventory(value: unknown): InventoryItem[] {
  const items = (value as { items?: unknown } | null)?.items
  if (!Array.isArray(items)) return []
  const out: InventoryItem[] = []
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    if (typeof r.id !== 'string' || !r.id) continue
    out.push({
      id: r.id,
      itemId: typeof r.itemId === 'string' ? r.itemId : '',
      perk: typeof r.perk === 'string' ? r.perk : '',
      isUsable: r.isUsable === true,
      isUsed: r.isUsed === true,
      expiryDate: typeof r.expiryDate === 'string' ? r.expiryDate : '',
      createdAt: typeof r.createdAt === 'string' ? r.createdAt : ''
    })
  }
  return out
}

/** 'usage_limit_add:100' → { kind: 'usage_limit_add', amount: 100 }. 못 읽으면 null */
export function parsePerk(perk: string): { kind: string; amount: number } | null {
  const at = perk.lastIndexOf(':')
  if (at === -1) return null
  const kind = perk.slice(0, at)
  const amount = Number.parseInt(perk.slice(at + 1))
  if (!kind || Number.isNaN(amount)) return null
  return { kind, amount }
}

/** 이 아이템이 더하는 추가분(%) — 한도를 더하는 아이템이 아니면 0 */
export function refillAmount(item: InventoryItem): number {
  const perk = parsePerk(item.perk)
  return perk?.kind === PERK_USAGE_ADD ? Math.max(0, perk.amount) : 0
}

/** 만료 시각(ms). 못 읽으면 만료 없음으로 본다 (웹과 같다) */
export function itemExpiry(item: InventoryItem): number {
  const at = Date.parse(item.expiryDate)
  return Number.isNaN(at) ? Infinity : at
}

/** 지금 쓸 수 있는 충전 아이템 — 만료가 가까운 것부터. 효과를 못 읽는 아이템은 쓰지 않는다 */
export function availableRefills(items: InventoryItem[], now = Date.now()): InventoryItem[] {
  return items
    .filter(
      (i) =>
        i.itemId === REFILL_ITEM_ID &&
        i.isUsable &&
        !i.isUsed &&
        itemExpiry(i) > now &&
        refillAmount(i) > 0
    )
    .sort((a, b) => itemExpiry(a) - itemExpiry(b))
}

/** 이 아이템을 써도 추가분이 상한(400%)을 넘지 않는가. 한도 정보가 없으면 막지 않는다 (웹과 같다) */
export function itemFitsInAllowance(usage: OpusUsage | null, item: InventoryItem): boolean {
  return !usage || usagePurchasedPercent(usage) + refillAmount(item) <= MAX_PURCHASED_PERCENT
}

/** 지금 쓸 수 없는 이유 — 보유 없음 / 추가분 자리 없음 / Opus 구독 아님 */
export type RefillBlock = 'none' | 'full' | 'notOpus'

export function refillBlock(input: {
  usage: OpusUsage | null
  /** Opus(tier 3) 구독이 살아 있는가 */
  opusActive: boolean
  items: InventoryItem[]
  now?: number
}): RefillBlock | null {
  if (!input.opusActive) return 'notOpus'
  const next = availableRefills(input.items, input.now)[0]
  if (!next) return 'none'
  if (!itemFitsInAllowance(input.usage, next)) return 'full'
  return null
}

/** 쓸 수 없는 이유 한 줄 */
export function refillBlockText(block: RefillBlock, amount = 100): string {
  if (block === 'none') return '보유 없음'
  if (block === 'notOpus') return 'Opus 구독 아님'
  return `추가분이 ${MAX_PURCHASED_PERCENT - amount}% 넘음 (${amount}% 들어갈 자리 없음)`
}

/** 계정 하나의 충전 아이템 상태 — 렌더러로 보낸다 (토큰은 담지 않는다) */
export interface RefillStatus {
  /** 인벤토리와 한도를 둘 다 읽었는가. false 면 아래 값은 비어 있다 */
  ok: boolean
  /** 등록 계정 id. 계정 목록 없이 토큰만 넣어 쓰면 null */
  accountId: string | null
  label: string
  /** 지금 쓰는(활성) 계정인가 */
  active: boolean
  /** 쓸 수 있는 충전 아이템 수 */
  count: number
  /** 그중 만료가 가장 가까운 것의 만료 시각 (ISO). 없으면 null */
  nearestExpiry: string | null
  /** 다음에 쓸 아이템이 더하는 양(%). 없으면 0 */
  amount: number
  /** 지금 쓸 수 없는 이유. null 이면 쓸 수 있다 */
  blocked: RefillBlock | null
}

/** 사용 결과. 실패해도 다시 보내지 않는다 */
export type RefillUseResult =
  { ok: true; amount: number; label: string } | { ok: false; error: string }

/** 소진 알림에 달 버튼 — 쓸 수 있는 계정이 있으면 사용, 없고 살 수 있으면 구매, 둘 다 아니면 없음 */
export type RefillNoticeAction =
  | { kind: 'use'; accountId: string | null; label: string; amount: number }
  | { kind: 'buy'; label: string }

/**
 * 알림이 말하는 계정들의 상태로 버튼을 고른다. 활성 계정을 먼저 본다.
 * 조회에 실패한 계정은 빼고, 다 실패했으면 버튼 없이 알림만 둔다.
 */
export function refillNoticeAction(statuses: RefillStatus[]): RefillNoticeAction | null {
  const read = statuses.filter((s) => s.ok)
  const ordered = [...read.filter((s) => s.active), ...read.filter((s) => !s.active)]
  const usable = ordered.find((s) => s.blocked === null)
  if (usable) {
    return { kind: 'use', accountId: usable.accountId, label: usable.label, amount: usable.amount }
  }
  const buyer = ordered.find((s) => s.blocked === 'none')
  return buyer ? { kind: 'buy', label: buyer.label } : null
}
