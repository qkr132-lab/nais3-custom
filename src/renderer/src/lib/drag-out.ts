/**
 * 이미지를 앱 밖(탐색기 등)으로 끌어 저장하는 드래그 시작 핸들러 (커스텀).
 * HTML5 draggable은 몇 px만 움직여도 발동해 너무 민감하므로, 포인터가 임계값(16px)
 * 이상 이동했을 때만 OS 네이티브 드래그(images:startDrag)를 시작한다.
 * click(제자리 클릭)은 그대로 동작 — 실수 드래그를 크게 줄인다.
 */

import { useLayoutStore } from '../stores/layout-store'

const THRESHOLD = 16 // px — 이 거리 이상 움직여야 드래그 시작

let state: { path: string; x: number; y: number } | null = null

export function imageDragOutProps(filePath: string): {
  draggable: false
  onPointerDown: (e: React.PointerEvent) => void
  onPointerMove: (e: React.PointerEvent) => void
  onPointerUp: () => void
  onPointerLeave: () => void
} {
  return {
    draggable: false,
    onPointerDown: (e) => {
      if (e.button !== 0) return // 좌클릭만
      state = { path: filePath, x: e.clientX, y: e.clientY }
    },
    onPointerMove: (e) => {
      if (!state || state.path !== filePath) return
      const dx = e.clientX - state.x
      const dy = e.clientY - state.y
      if (dx * dx + dy * dy >= THRESHOLD * THRESHOLD) {
        const path = state.path
        state = null // 중복 시작 방지
        // 웹 모드(내장 브라우저)일 땐 창 통과를 끄고 드래그 → webview 업로드 칸에 바로 드롭
        const toWeb = useLayoutStore.getState().centerMode === 'web'
        void window.nais.invoke('images:startDrag', { filePath: path, toWeb })
      }
    },
    onPointerUp: () => {
      state = null
    },
    onPointerLeave: () => {
      state = null
    }
  }
}
