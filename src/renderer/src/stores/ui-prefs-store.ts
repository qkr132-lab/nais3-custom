import { create } from 'zustand'

/**
 * 입력창 표시 설정 (커스텀) — settings KV에 저장.
 * markUnknownTags: 사전에 없는 태그를 빨갛게 (기본 켬)
 */
const MARK_KEY = 'mark_unknown_tags'

interface UiPrefsState {
  loaded: boolean
  markUnknownTags: boolean
  load: () => Promise<void>
  setMarkUnknownTags: (v: boolean) => void
}

export const useUiPrefsStore = create<UiPrefsState>((set, get) => ({
  loaded: false,
  markUnknownTags: true,
  load: async () => {
    if (get().loaded) return
    const { value } = await window.nais.invoke('settings:get', { key: MARK_KEY })
    set({ markUnknownTags: value !== '0', loaded: true })
  },
  setMarkUnknownTags: (markUnknownTags) => {
    set({ markUnknownTags })
    void window.nais.invoke('settings:set', { key: MARK_KEY, value: markUnknownTags ? '1' : '0' })
  }
}))
