import { create } from 'zustand'
import { recordNav } from '../lib/nav-history'

export type CenterMode =
  | 'main'
  | 'scene'
  | 'background'
  | 'outfit'
  | 'composition'
  | 'director'
  | 'library'
  | 'web'
  | 'upload'

export type MobileModeOverride = 'auto' | 'portrait' | 'desktop'

interface LayoutState {
  leftOpen: boolean
  rightOpen: boolean
  settingsOpen: boolean
  centerMode: CenterMode
  /** 좌측 사이드바 폭 (드래그로 조절, 영속) */
  sidebarWidth: number
  /** 세로/모바일 UI 전환 모드: auto(폭·비율 자동 감지) / portrait(항상 세로 UI) / desktop(항상 데스크톱 UI) */
  mobileModeOverride: MobileModeOverride
  toggleLeft: () => void
  setLeftOpen: (open: boolean) => void
  toggleRight: () => void
  setSettingsOpen: (open: boolean) => void
  setCenterMode: (mode: CenterMode) => void
  setSidebarWidth: (w: number) => void
  cycleMobileMode: () => void
  hydrate: () => Promise<void>
}

export const SIDEBAR_MIN = 340
export const SIDEBAR_MAX = 640

function persist(key: string, value: boolean): void {
  void window.nais.invoke('settings:set', { key, value: value ? '1' : '0' })
}

function readInitialMobileMode(): MobileModeOverride {
  const raw = localStorage.getItem('ui_mobile_mode')
  if (raw === 'portrait' || raw === 'desktop' || raw === 'auto') return raw
  return 'auto'
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  leftOpen: true,
  rightOpen: true,
  settingsOpen: false,
  centerMode: 'main',
  sidebarWidth: Math.min(
    SIDEBAR_MAX,
    Math.max(SIDEBAR_MIN, Number(localStorage.getItem('sidebar_width')) || 400)
  ),
  mobileModeOverride: readInitialMobileMode(),
  setSidebarWidth: (w) => {
    const clamped = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(w)))
    set({ sidebarWidth: clamped })
    localStorage.setItem('sidebar_width', String(clamped))
  },
  setCenterMode: (centerMode) => {
    if (centerMode !== get().centerMode) recordNav() // 마우스 뒤로/앞으로용 히스토리
    set({ centerMode })
  },
  toggleLeft: () => {
    const leftOpen = !get().leftOpen
    set({ leftOpen })
    persist('ui_left_open', leftOpen)
  },
  setLeftOpen: (leftOpen) => {
    set({ leftOpen })
    persist('ui_left_open', leftOpen)
  },
  toggleRight: () => {
    const rightOpen = !get().rightOpen
    set({ rightOpen })
    persist('ui_right_open', rightOpen)
  },
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  cycleMobileMode: () => {
    const cur = get().mobileModeOverride
    const next: MobileModeOverride =
      cur === 'auto' ? 'portrait' : cur === 'portrait' ? 'desktop' : 'auto'
    set({ mobileModeOverride: next })
    localStorage.setItem('ui_mobile_mode', next)
  },
  hydrate: async () => {
    const [left, right] = await Promise.all([
      window.nais.invoke('settings:get', { key: 'ui_left_open' }),
      window.nais.invoke('settings:get', { key: 'ui_right_open' })
    ])
    set({ leftOpen: left.value !== '0', rightOpen: right.value !== '0' })
  }
}))
