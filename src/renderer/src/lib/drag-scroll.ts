import { useEffect, useState, type RefObject } from 'react'
import { useLayoutStore } from '../stores/layout-store'

/**
 * 현재 화면이 '폰화면모드(세로·모바일 레이아웃)'인지 판별하는 훅.
 * - 상단 스마트폰 아이콘으로 'portrait(항상 세로)'를 강제했거나
 * - 'auto(자동)' 상태에서 창 폭이 960px 미만이거나 세로가 가로보다 긴 경우 true.
 * - 'desktop(항상 PC)'이거나 일반 PC 가로 화면에서는 false.
 */
export function useIsPortraitMode(): boolean {
  const mobileModeOverride = useLayoutStore((s) => s.mobileModeOverride)
  const [narrowOrTall, setNarrowOrTall] = useState(
    () => window.innerWidth < 960 || window.innerHeight > window.innerWidth * 1.05
  )

  useEffect(() => {
    if (mobileModeOverride !== 'auto') return
    const onResize = (): void => {
      setNarrowOrTall(window.innerWidth < 960 || window.innerHeight > window.innerWidth * 1.05)
    }
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [mobileModeOverride])

  return mobileModeOverride === 'portrait' || (mobileModeOverride === 'auto' && narrowOrTall)
}

/**
 * 폰화면모드(세로·모바일 레이아웃) 전용 터치/드래그 스크롤 훅.
 * - PC 화면 모드(isPortrait === false)에서는 전혀 작동하지 않는다.
 * - 폰화면모드에서 스크롤 영역 위를 1손가락/좌클릭으로 위아래로 끌면 부드럽게 스크롤된다.
 * - 6px 이상 움직이면 스크롤로 판정하고, 손가락을 뗄 때 발생하는 오작동 click(씬 열기 등)을 차단한다.
 * - 마우스/원격 드래그에서 손을 뗀 뒤 관성(모멘텀) 감속 스크롤을 제공한다.
 */
export function useDragScroll(
  ref: RefObject<HTMLElement | null>,
  enabled = true
): void {
  const isPortrait = useIsPortraitMode()

  useEffect(() => {
    const el = ref.current
    if (!el || !enabled || !isPortrait) return

    let active = false
    let pointerId = -1
    let startY = 0
    let startX = 0
    let startScrollTop = 0
    let moved = false
    let lastY = 0
    let lastTime = 0
    let velocityY = 0
    let momentumRaf = 0

    const stopMomentum = (): void => {
      if (momentumRaf) {
        window.cancelAnimationFrame(momentumRaf)
        momentumRaf = 0
      }
    }

    const onPointerDown = (e: PointerEvent): void => {
      if (e.button !== 0 || e.ctrlKey || e.shiftKey || e.metaKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (!target) return
      if (
        target.closest(
          'input, textarea, select, [contenteditable="true"], [role="slider"], [data-no-drag-scroll]'
        )
      ) {
        return
      }
      stopMomentum()
      active = true
      pointerId = e.pointerId
      startY = e.clientY
      startX = e.clientX
      startScrollTop = el.scrollTop
      moved = false
      lastY = e.clientY
      lastTime = performance.now()
      velocityY = 0
    }

    const onPointerMove = (e: PointerEvent): void => {
      if (!active || e.pointerId !== pointerId) return
      if (e.pointerType === 'mouse' && (e.buttons & 1) === 0) {
        active = false
        return
      }
      const dy = e.clientY - startY
      const dx = e.clientX - startX
      if (!moved) {
        if (Math.abs(dy) < 6 && Math.abs(dx) < 6) return
        moved = true
      }
      const now = performance.now()
      const dt = now - lastTime
      if (dt > 0) {
        const instantV = (lastY - e.clientY) / dt
        velocityY = velocityY * 0.6 + instantV * 0.4
      }
      lastY = e.clientY
      lastTime = now
      el.scrollTop = startScrollTop - dy
    }

    const suppressClickOnce = (ev: MouseEvent): void => {
      ev.stopPropagation()
      ev.preventDefault()
    }

    const onPointerUp = (e: PointerEvent): void => {
      if (!active || e.pointerId !== pointerId) return
      active = false
      if (!moved) return

      window.addEventListener('click', suppressClickOnce, { capture: true, once: true })
      window.setTimeout(() => {
        window.removeEventListener('click', suppressClickOnce, { capture: true })
      }, 90)

      // 원격 마우스 드래그 모드일 때 관성(모멘텀) 스크롤 적용
      const now = performance.now()
      if (e.pointerType !== 'touch' && now - lastTime < 90 && Math.abs(velocityY) > 0.12) {
        let v = velocityY * 16
        const step = (): void => {
          if (Math.abs(v) < 0.4) {
            momentumRaf = 0
            return
          }
          const prev = el.scrollTop
          el.scrollTop += v
          if (el.scrollTop === prev) {
            momentumRaf = 0
            return
          }
          v *= 0.92
          momentumRaf = window.requestAnimationFrame(step)
        }
        momentumRaf = window.requestAnimationFrame(step)
      }
    }

    const onPointerCancel = (e: PointerEvent): void => {
      if (!active || e.pointerId !== pointerId) return
      active = false
    }

    el.addEventListener('pointerdown', onPointerDown, { passive: true })
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('pointerup', onPointerUp, { passive: true })
    window.addEventListener('pointercancel', onPointerCancel, { passive: true })

    return () => {
      stopMomentum()
      el.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerCancel)
    }
  }, [ref, enabled, isPortrait])
}
