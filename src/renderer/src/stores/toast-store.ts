import { create } from 'zustand'

export type ToastType = 'error' | 'info' | 'success'

export interface Toast {
  id: number
  message: string
  type: ToastType
  /** 실행취소 버튼 (커스텀) — 있으면 토스트에 "실행취소" 액션 표시 */
  action?: { label: string; run: () => void }
}

interface ToastState {
  toasts: Toast[]
  /** 띄운 토스트의 id 를 돌려준다. ms 를 주면 그만큼 떠 있는다 */
  push: (message: string, type?: ToastType, action?: Toast['action'], ms?: number) => number
  /** 이미 뜬 토스트에 버튼을 단다 (커스텀 — 조회가 끝난 뒤). 떠 있는 시간은 버튼 기준으로 다시 잰다 */
  setAction: (id: number, action: Toast['action']) => void
  dismiss: (id: number) => void
}

let seq = 0
/** 토스트별 자동 사라짐 타이머 — 버튼을 나중에 달면 다시 잰다 */
const timers = new Map<number, ReturnType<typeof setTimeout>>()

// 자동 사라짐 (에러·실행취소 토스트는 조금 더 오래 — 누를 시간 확보)
const lifetime = (type: ToastType, action?: Toast['action']): number =>
  type === 'error' || action ? 6000 : 3000

function schedule(id: number, ms: number): void {
  clearTimeout(timers.get(id))
  timers.set(
    id,
    setTimeout(() => useToastStore.getState().dismiss(id), ms)
  )
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (message, type = 'info', action, ms) => {
    const id = ++seq
    set({ toasts: [...get().toasts, { id, message, type, action }] })
    schedule(id, ms ?? lifetime(type, action))
    return id
  },
  setAction: (id, action) => {
    const target = get().toasts.find((t) => t.id === id)
    if (!target) return // 이미 사라졌다
    set({ toasts: get().toasts.map((t) => (t.id === id ? { ...t, action } : t)) })
    schedule(id, lifetime(target.type, action))
  },
  dismiss: (id) => {
    clearTimeout(timers.get(id))
    timers.delete(id)
    set({ toasts: get().toasts.filter((t) => t.id !== id) })
  }
}))

/** 어디서든 호출 가능한 단축 헬퍼 — 띄운 토스트의 id 를 돌려준다 */
export function toast(message: string, type?: ToastType): number {
  return useToastStore.getState().push(message, type)
}

/** 실행취소 버튼이 달린 토스트 (삭제 등) */
export function toastUndo(message: string, undo: () => void): void {
  useToastStore.getState().push(message, 'info', { label: '실행취소', run: undo })
}
