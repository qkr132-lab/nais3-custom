/** 화면 조각들이 같이 쓰는 훅 */
import type { RefObject } from 'preact'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type StateUpdater
} from 'preact/hooks'
import { imageCache } from './client'
import { isCancelled } from './lib/image-cache'
import { registerOverlay } from './lib/overlay'
import { app } from './stores'
import { useStore } from './lib/store'

/** 서버 시각 기준의 지금 — 상대 시간 표시용. 주기마다 다시 그린다 */
export function useServerNow(tickMs = 15_000): number {
  const skew = useStore(app, (s) => s.clockSkew)
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), tickMs)
    return () => clearInterval(t)
  }, [tickMs])
  return Date.now() + skew
}

/**
 * 요소를 감싸는 세로 스크롤 틀(탭 패널·시트 본문). 없으면 null(화면 전체).
 * 미리 불러오는 여유(rootMargin)는 관찰 기준 틀에만 적용되므로, 스크롤하는 틀을 기준으로 삼아야 먹는다
 */
export function scrollRootOf(el: Element): HTMLElement | null {
  return el.closest<HTMLElement>('.panel, .sheet__body')
}

/** 요소가 스크롤 틀(없으면 화면)에서 marginPx 이내로 가까운가 — 렌더 직후의 실제 위치로 잰다 */
export function isNearView(el: Element | null, marginPx: number): boolean {
  if (!el) return false
  const root = scrollRootOf(el)
  const rootRect = root
    ? root.getBoundingClientRect()
    : { top: 0, bottom: window.innerHeight, height: window.innerHeight }
  if (rootRect.height === 0) return false // 숨겨진 탭
  const rect = el.getBoundingClientRect()
  return rect.top <= rootRect.bottom + marginPx && rect.bottom >= rootRect.top - marginPx
}

/** 요소가 화면(또는 margin 만큼 가까이)에 들어와 있는가 */
export function useInView(ref: RefObject<Element>, margin = '320px'): boolean {
  const [seen, setSeen] = useState(typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        const last = entries[entries.length - 1] // 한꺼번에 오면 가장 나중 것이 지금 상태
        if (last) setSeen(last.isIntersecting)
      },
      { root: scrollRootOf(el), rootMargin: margin }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [ref, margin])
  return seen
}

/**
 * 키에 해당하는 그림 blob URL. key 가 null 이면 아무것도 안 가져온다.
 * 참조를 쥐고 있다가 키가 바뀌거나 사라지면 놓아서 캐시가 정리할 수 있게 한다.
 */
export function useBlobUrl(
  key: string | null,
  load: () => Promise<Blob>,
  priority = false
): { url: string | null; error: string | null } {
  const loadRef = useRef(load)
  loadRef.current = load
  const [result, setResult] = useState<{ key: string; url: string | null; error: string | null }>({
    key: '',
    url: null,
    error: null
  })
  useEffect(() => {
    if (!key) return
    let alive = true
    imageCache
      .acquire(key, () => loadRef.current(), { priority })
      .then((url) => alive && setResult({ key, url, error: null }))
      .catch((err) => {
        if (!alive || isCancelled(err)) return
        setResult({
          key,
          url: null,
          error: err instanceof Error ? err.message : '불러오지 못했습니다'
        })
      })
    return () => {
      alive = false
      imageCache.release(key)
      setResult({ key: '', url: null, error: null }) // 놓은 URL 을 계속 쓰지 않게
    }
  }, [key, priority])
  if (!key || result.key !== key) return { url: null, error: null }
  return { url: result.url, error: result.error }
}

/**
 * textarea 높이를 글 길이에 맞춘다.
 * 높이를 줄였다 다시 늘리는 사이 스크롤 틀의 전체 길이가 짧아져 스크롤 위치가 끌려 올라가므로 위치를 되돌려 놓는다
 */
export function useAutoHeight(ref: RefObject<HTMLTextAreaElement>, value: string): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const scroller = scrollRootOf(el)
    const top = scroller?.scrollTop ?? 0
    el.style.height = 'auto'
    // 테두리는 scrollHeight 에 들어 있지 않다 (box-sizing: border-box)
    el.style.height = `${el.scrollHeight + (el.offsetHeight - el.clientHeight)}px`
    if (scroller && scroller.scrollTop !== top) scroller.scrollTop = top
  }, [ref, value])
}

/**
 * 서버 값과 편집 중인 값을 같이 들고 있는다.
 * 고치지 않았을 때만 서버 값이 바뀌면 따라가고, 고치는 중이면 건드리지 않는다.
 * 설정 함수는 이전 값을 받는 형태도 된다 (저장 응답을 반영할 때 그 사이 입력을 지키려고)
 */
export function useDraft<T>(server: T): [T, Dispatch<StateUpdater<T>>, boolean] {
  const [draft, setDraft] = useState<T>(server)
  const baseRef = useRef(server)
  useEffect(() => {
    if (Object.is(baseRef.current, server)) return
    if (Object.is(draft, baseRef.current)) setDraft(server)
    baseRef.current = server
  }, [server, draft])
  return [draft, setDraft, !Object.is(draft, server)]
}

/** 겹침 화면이 떠 있는 동안 브라우저 「뒤로」를 이 화면 닫기로 연결 */
export function useOverlayHistory(onClose: () => void): void {
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => registerOverlay(() => closeRef.current()), [])
}

/** 열린 동안 Esc 로 닫고, Tab 이 화면 밖으로 새지 않게 가둔다. 닫으면 열기 전 포커스로 돌아간다 */
export function useDialogFocus(ref: RefObject<HTMLElement>, onEscape: () => void): void {
  const escRef = useRef(onEscape)
  escRef.current = onEscape
  useEffect(() => {
    const root = ref.current
    const before = document.activeElement as HTMLElement | null
    root?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        escRef.current()
        return
      }
      if (e.key !== 'Tab' || !root) return
      const items = [
        ...root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'
        )
      ].filter((el) => el.offsetParent !== null)
      if (items.length === 0) {
        e.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || active === root)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      if (before && document.contains(before)) before.focus({ preventScroll: true })
    }
  }, [ref])
}
