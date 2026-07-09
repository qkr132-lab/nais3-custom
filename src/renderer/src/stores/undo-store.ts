import { create } from 'zustand'
import { toast } from './toast-store'

/**
 * 실행취소 스택 (커스텀) — 삭제 등 파괴적 동작을 Ctrl+Z로 연속 되돌린다.
 * 각 동작이 pushUndo(label, undo)로 등록되고, Ctrl+Z가 최근 것부터 하나씩 실행.
 */

interface UndoEntry {
  label: string
  undo: () => void | Promise<void>
}

const MAX_STACK = 30

interface UndoState {
  stack: UndoEntry[]
  push: (label: string, undo: UndoEntry['undo']) => void
  /** 최근 항목 하나 실행취소. 없으면 false */
  undoLast: () => boolean
}

export const useUndoStore = create<UndoState>((set, get) => ({
  stack: [],
  push: (label, undo) =>
    set({ stack: [...get().stack.slice(-(MAX_STACK - 1)), { label, undo }] }),
  undoLast: () => {
    const { stack } = get()
    const entry = stack[stack.length - 1]
    if (!entry) return false
    set({ stack: stack.slice(0, -1) })
    void entry.undo()
    toast(`실행취소: ${entry.label}`, 'success')
    return true
  }
}))

/** 파괴적 동작 등록 헬퍼 */
export function pushUndo(label: string, undo: () => void | Promise<void>): void {
  useUndoStore.getState().push(label, undo)
}

/** Ctrl+Z 전역 바인딩 — 입력창에 포커스가 있으면 텍스트 편집 undo에 양보 */
export function bindUndoShortcut(): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || e.shiftKey || e.altKey) return
    const el = document.activeElement
    if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      (el instanceof HTMLElement && el.isContentEditable)
    )
      return // 텍스트 undo 우선
    if (useUndoStore.getState().undoLast()) e.preventDefault()
  }
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}
