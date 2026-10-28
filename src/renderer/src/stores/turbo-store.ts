import { create } from 'zustand'
import type { TurboStatus } from '@shared/types'

/**
 * 고속 모드(번개 버튼) 상태 (커스텀) — 메인 탭 생성 버튼 옆과 씬 화면 위쪽 막대가 같은 상태를 본다.
 * 진실은 메인 프로세스(큐)에 있고, 여기는 'turbo:status' 이벤트를 받아 비추기만 한다. persist 금지.
 */

interface TurboState {
  status: TurboStatus | null
  load: () => Promise<void>
  apply: (status: TurboStatus) => void
  setEnabled: (enabled: boolean) => Promise<void>
}

export const useTurboStore = create<TurboState>((set, get) => ({
  status: null,
  load: async () => {
    try {
      set({ status: await window.nais.invoke('turbo:status', undefined) })
    } catch {
      // 상태를 못 읽으면 버튼은 꺼진 채로 둔다 (생성에는 영향 없음)
    }
  },
  apply: (status) => set({ status }),
  setEnabled: async (enabled) => {
    // 응답을 기다리지 않고 먼저 비춘다 — 두 버튼이 동시에 바뀌어 보이게
    const prev = get().status
    if (prev) set({ status: { ...prev, enabled } })
    try {
      set({ status: await window.nais.invoke('turbo:set', { enabled }) })
    } catch {
      await get().load() // 실패하면 실제 저장값으로 되돌린다
    }
  }
}))

/** 계정이 둘 이상이어야 쓸 수 있다 */
export function turboUsable(status: TurboStatus | null): boolean {
  return (status?.accounts.length ?? 0) >= 2
}

/** 지금 실제로 켜진 상태 (저장값이 켜져 있고 계정이 둘 이상) */
export function turboOn(status: TurboStatus | null): boolean {
  return !!status?.enabled && turboUsable(status)
}

/** 지금 참여 중인 계정 수 (×N) — 무료분이 없어 뺀 계정은 세지 않는다 */
export function turboActiveCount(status: TurboStatus | null): number {
  return status?.accounts.filter((a) => !a.excluded).length ?? 0
}
