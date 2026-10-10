import { create } from 'zustand'
import { useLayoutStore } from './layout-store'

/**
 * 웹 탭 열기 요청 (커스텀) — 다른 화면에서 웹 탭으로 주소를 넘긴다.
 * 태그 추천의 「예시 그림」이 쓴다: 웹 탭으로 바꾸고 그 주소를 연다.
 */
interface WebNavState {
  /** 아직 웹 탭이 열지 않은 주소 */
  pending: string | null
  open: (url: string) => void
  take: () => string | null
}

export const useWebNavStore = create<WebNavState>((set, get) => ({
  pending: null,
  open: (url) => {
    set({ pending: url })
    useLayoutStore.getState().setCenterMode('web')
  },
  take: () => {
    const url = get().pending
    if (url) set({ pending: null })
    return url
  }
}))

/** 태그로 검색한 Danbooru 그림 목록 (shima 미러 — 우회 없이 열림). 수위 필터 없음 */
export function tagExampleUrl(tag: string): string {
  return `https://shima.donmai.us/posts?tags=${encodeURIComponent(tag.trim().replace(/\s+/g, '_'))}`
}

/** 이 태그의 예시 그림을 웹 탭에서 연다 */
export function openTagExamples(tag: string): void {
  useWebNavStore.getState().open(tagExampleUrl(tag))
}
