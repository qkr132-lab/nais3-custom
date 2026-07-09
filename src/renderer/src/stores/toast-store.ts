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
  push: (message: string, type?: ToastType, action?: Toast['action']) => void
  dismiss: (id: number) => void
}

let seq = 0

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (message, type = 'info', action) => {
    const id = ++seq
    set({ toasts: [...get().toasts, { id, message, type, action }] })
    // 자동 사라짐 (에러·실행취소 토스트는 조금 더 오래 — 누를 시간 확보)
    setTimeout(() => get().dismiss(id), type === 'error' || action ? 6000 : 3000)
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) })
}))

/** 어디서든 호출 가능한 단축 헬퍼 */
export function toast(message: string, type?: ToastType): void {
  useToastStore.getState().push(message, type)
}

/** 실행취소 버튼이 달린 토스트 (삭제 등) */
export function toastUndo(message: string, undo: () => void): void {
  useToastStore.getState().push(message, 'info', { label: '실행취소', run: undo })
}
