import { create } from 'zustand'
import type { RefillStatus } from '@shared/types'
import { refillNoticeAction } from '@shared/usage-refill'
import { askConfirm } from './dialog-store'
import { toast, useToastStore } from './toast-store'

/**
 * 충전 아이템(Opus Usage Boost) — 렌더러 쪽 (커스텀).
 *
 * 쓰기는 언제나 확인 창을 거친다(「확인 창 끄기」 설정과 무관). 한 번에 한 건만 처리하고,
 * 저절로 쓰거나 사는 일은 없다. 구매는 앱이 하지 않고 기본 브라우저로 NAI 이미지 화면을 연다.
 */

/** 구매 화면 — 웹 구매는 이미지 화면 안의 모달이라 바로 여는 주소가 없다 */
export const REFILL_SHOP_URL = 'https://novelai.net/image'

export interface RefillTarget {
  /** 등록 계정 id. 계정 목록 없이 토큰만 넣어 쓰면 null (지금 쓰는 계정) */
  accountId: string | null
  /** 더해지는 양(%) */
  amount: number
}

interface RefillState {
  /** 쓰는 중 — 확인 창을 띄운 때부터 끝날 때까지. 그동안 사용 버튼을 끈다 */
  busy: boolean
  /** 확인 창 → 사용. 취소면 'cancel', 요청을 보냈으면 결과 */
  confirmAndUse: (target: RefillTarget) => Promise<'cancel' | 'ok' | 'fail'>
}

export const useRefillStore = create<RefillState>((set, get) => ({
  busy: false,
  confirmAndUse: async ({ accountId, amount }) => {
    if (get().busy) {
      toast('충전 아이템을 쓰는 중입니다', 'info')
      return 'cancel'
    }
    set({ busy: true })
    try {
      const ok = await askConfirm('충전 아이템을 쓸까요?', {
        message: `Opus 한도에 ${amount}%가 더해지고 되돌릴 수 없습니다`,
        confirmLabel: '사용',
        important: true
      })
      if (!ok) return 'cancel'
      const result = await window.nais.invoke('refill:use', accountId ? { accountId } : {})
      if (result.ok) {
        toast(`충전 아이템을 썼습니다 — Opus 한도 +${result.amount}%`, 'success')
        return 'ok'
      }
      toast(`충전 아이템을 쓰지 못했습니다 — ${result.error}`, 'error')
      return 'fail'
    } catch (e) {
      toast(
        `충전 아이템을 쓰지 못했습니다 — ${e instanceof Error ? e.message : String(e)}`,
        'error'
      )
      return 'fail'
    } finally {
      set({ busy: false })
    }
  }
}))

/**
 * 게이지 칩 작은 창의 바깥 상호작용 처리기 — 쓰는 중(확인 창이 떠 있는 동안 포함)에는 닫지 않는다.
 * 확인 창으로 포커스가 넘어가도 창이 열린 채로 남아 처리 중 표시·사용 뒤 갱신이 그 자리에서 보인다.
 */
export function keepOpenWhileBusy(e: Event): void {
  if (useRefillStore.getState().busy) e.preventDefault()
}

/** 구매 안내 한 줄 */
export function refillShopGuide(label: string): string {
  const who = label ? `"${label}" 계정으로` : '이 계정으로'
  return `열린 화면에서 메뉴 → Inventory → Buy 로 살 수 있습니다. 브라우저에 ${who} 로그인돼 있어야 합니다`
}

/** 기본 브라우저로 구매 화면을 연다 (창 열기 → 메인의 openExternal) */
export function openRefillShop(): void {
  window.open(REFILL_SHOP_URL)
}

/** 같은 범위의 조회가 진행 중이면 그 결과를 같이 받는다 — 알림이 연달아 떠도 계정마다 조회는 한 번 */
const lookups = new Map<string, Promise<RefillStatus[]>>()

function lookup(accountId?: string): Promise<RefillStatus[]> {
  const key = accountId ?? '*'
  const running = lookups.get(key)
  if (running) return running
  const started = (
    accountId
      ? window.nais.invoke('refill:status', { accountId }).then((s) => [s])
      : window.nais.invoke('refill:statusAll', undefined).then((r) => r.items)
  ).finally(() => lookups.delete(key))
  lookups.set(key, started)
  return started
}

/**
 * 무료분 소진 알림에 버튼을 단다 — 그 알림이 말하는 계정(accountId 가 없으면 등록 계정 전부)에
 * 쓸 수 있는 충전 아이템이 있으면 「충전 아이템 쓰기」, 없으면 「구매」. 조회에 실패하면 알림만 둔다.
 * 조회만 하고, 누르기 전에는 아무것도 하지 않는다.
 */
export async function offerRefill(toastId: number, accountId?: string): Promise<void> {
  let statuses: RefillStatus[]
  try {
    statuses = await lookup(accountId)
  } catch {
    return
  }
  const action = refillNoticeAction(statuses)
  if (!action) return
  const toasts = useToastStore.getState()
  if (action.kind === 'use') {
    toasts.setAction(toastId, {
      label: '충전 아이템 쓰기',
      run: () => void useRefillStore.getState().confirmAndUse(action)
    })
  } else {
    toasts.setAction(toastId, {
      label: '구매',
      run: () => {
        openRefillShop()
        useToastStore.getState().push(refillShopGuide(action.label), 'info', undefined, 8000)
      }
    })
  }
}
