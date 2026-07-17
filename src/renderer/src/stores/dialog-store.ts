import { create } from 'zustand'

/**
 * 텍스트 입력 다이얼로그 (Electron은 window.prompt를 지원하지 않음).
 * askText(...)가 Promise를 반환하고, <TextPromptHost/>가 실제 UI를 렌더한다.
 */
interface TextPromptReq {
  title: string
  value: string
  placeholder?: string
  resolve: (value: string | null) => void
}

interface ConfirmReq {
  title: string
  message?: string
  confirmLabel: string
  danger: boolean
  resolve: (ok: boolean) => void
}

interface DialogState {
  textPrompt: TextPromptReq | null
  confirm: ConfirmReq | null
  askText: (title: string, defaultValue?: string, placeholder?: string) => Promise<string | null>
  askConfirm: (
    title: string,
    opts?: { message?: string; confirmLabel?: string; danger?: boolean; important?: boolean }
  ) => Promise<boolean>
  _resolve: (value: string | null) => void
  _resolveConfirm: (ok: boolean) => void
}

// 확인 다이얼로그 전역 끄기 (커스텀 설정) — 켜져 있으면 askConfirm이 즉시 true
let confirmsDisabled = localStorage.getItem('confirms_disabled') === '1'
export function setConfirmsDisabled(v: boolean): void {
  confirmsDisabled = v
  localStorage.setItem('confirms_disabled', v ? '1' : '0')
}
export function getConfirmsDisabled(): boolean {
  return confirmsDisabled
}

export const useDialogStore = create<DialogState>((set, get) => ({
  textPrompt: null,
  confirm: null,
  askText: (title, defaultValue = '', placeholder) =>
    new Promise((resolve) => {
      set({ textPrompt: { title, value: defaultValue, placeholder, resolve } })
    }),
  askConfirm: (title, opts) => {
    // important: 계정 정보 포함 여부 같은 중대한 질문 — "확인 창 끄기"를 무시하고 반드시 묻는다 (커스텀)
    if (confirmsDisabled && !opts?.important) return Promise.resolve(true)
    return new Promise((resolve) => {
      set({
        confirm: {
          title,
          message: opts?.message,
          confirmLabel: opts?.confirmLabel ?? '확인',
          danger: opts?.danger ?? false,
          resolve
        }
      })
    })
  },
  _resolve: (value) => {
    get().textPrompt?.resolve(value)
    set({ textPrompt: null })
  },
  _resolveConfirm: (ok) => {
    get().confirm?.resolve(ok)
    set({ confirm: null })
  }
}))

/** 어디서든 호출 가능한 텍스트 프롬프트 헬퍼 */
export function askText(
  title: string,
  defaultValue?: string,
  placeholder?: string
): Promise<string | null> {
  return useDialogStore.getState().askText(title, defaultValue, placeholder)
}

/** 어디서든 호출 가능한 확인(예/아니오) 헬퍼 — 네이티브 confirm 대체.
 *  important=true면 "확인 창 끄기" 설정을 무시하고 반드시 묻는다 (계정 정보 등 중대 결정) */
export function askConfirm(
  title: string,
  opts?: { message?: string; confirmLabel?: string; danger?: boolean; important?: boolean }
): Promise<boolean> {
  return useDialogStore.getState().askConfirm(title, opts)
}
