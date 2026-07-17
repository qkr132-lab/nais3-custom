import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { HistoryPanel } from './components/history-panel'
import { LoadingScreen } from './components/loading-screen'
import { Toaster } from './components/toaster'
import { PreviewPane } from './components/preview-pane'
import { DirectorMode } from './components/director-mode'
import { InpaintHost } from './components/inpaint-host'
import { FolderMovedNotice } from './components/folder-moved-notice'
import { MetadataDialog } from './components/metadata-dialog'
import { R2SyncHost } from './components/r2-sync-dialog'
import { PromptPanel } from './components/prompt-panel'
import { SceneMode } from './components/scene-mode'
import { LibraryMode } from './components/library-mode'
import { UploadMode } from './components/upload-mode'
import { WebMode } from './components/web-mode'
import { Titlebar } from './components/titlebar'
import { SettingsDialog } from './components/token-dialog'
import { TextPromptHost } from './components/text-prompt-host'
import { TooltipProvider } from './components/ui/tooltip'
import { useCharactersStore } from './stores/characters-store'
import { useFragmentsStore } from './stores/fragments-store'
import { useCharRefsStore, useVibesStore } from './stores/refs-store'
import { bindGenerationEvents, useGenerationStore } from './stores/generation-store'
import { bindSceneEvents } from './stores/scenes-store'
import { bindShortcuts, useShortcutsStore } from './stores/shortcuts-store'
import { bindUndoShortcut } from './stores/undo-store'
import { bindUpdateEvents } from './stores/update-store'
import { bindNavMouse } from './lib/nav-history'
import { cn } from './lib/utils'
import { useLayoutStore } from './stores/layout-store'
import { useThemeStore } from './stores/theme-store'

function useViewportSize(): { width: number; height: number } {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  useEffect(() => {
    let frame = 0
    const onResize = (): void => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() =>
        setSize({ width: window.innerWidth, height: window.innerHeight })
      )
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', onResize)
    }
  }, [])
  return size
}

/** 웹 모드 keep-alive 래퍼 — 처음 방문 후엔 hidden으로 유지해 webview 세션 보존 */
function WebModeKeepAlive({ active }: { active: boolean }): React.JSX.Element | null {
  const [visited, setVisited] = useState(false)
  useEffect(() => {
    if (active) setVisited(true)
  }, [active])
  if (!active && !visited) return null
  return <div className={active ? 'flex min-h-0 min-w-0 flex-1' : 'hidden'}>{<WebMode />}</div>
}

export default function App(): React.JSX.Element {
  const leftOpen = useLayoutStore((s) => s.leftOpen)
  const rightOpen = useLayoutStore((s) => s.rightOpen)
  const settingsOpen = useLayoutStore((s) => s.settingsOpen)
  const setSettingsOpen = useLayoutStore((s) => s.setSettingsOpen)
  const centerMode = useLayoutStore((s) => s.centerMode)
  const sidebarWidth = useLayoutStore((s) => s.sidebarWidth)
  const [ready, setReady] = useState(false)
  const [resizing, setResizing] = useState(false)
  const viewport = useViewportSize()
  const stacked = viewport.width < 860
  const overlayHistory = viewport.width < 1240
  const responsiveSidebarWidth = Math.min(
    sidebarWidth,
    Math.max(320, Math.floor(viewport.width * 0.38))
  )
  const stackedSidebarHeight = Math.max(
    210,
    Math.min(360, Math.round((viewport.height - (viewport.width <= 760 ? 48 : 56)) * 0.44))
  )
  const historyWidth = overlayHistory ? Math.min(280, viewport.width - 32) : 240

  // 사이드바 폭 드래그 조절
  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    setResizing(true)
    const startX = e.clientX
    const startW = useLayoutStore.getState().sidebarWidth
    const onMove = (ev: MouseEvent): void =>
      useLayoutStore.getState().setSidebarWidth(startW + (ev.clientX - startX))
    const onUp = (): void => {
      setResizing(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  useEffect(() => {
    // 초기 하이드레이션 — 완료되면 로딩 스플래시 해제
    void (async () => {
      await Promise.allSettled([
        useThemeStore.getState().hydrate(),
        useLayoutStore.getState().hydrate(),
        useGenerationStore.getState().hydrate(),
        useCharactersStore.getState().load(),
        useFragmentsStore.getState().load(),
        useVibesStore.getState().load(),
        useCharRefsStore.getState().load(),
        useShortcutsStore.getState().hydrate()
      ])
      // 스플래시가 너무 순식간에 사라지지 않게 최소 표시 시간 확보
      setTimeout(() => setReady(true), 350)
    })()
    const unbindGen = bindGenerationEvents()
    const unbindScene = bindSceneEvents()
    const unbindKeys = bindShortcuts()
    const unbindUpdate = bindUpdateEvents()
    const unbindNav = bindNavMouse() // 마우스 4/5번 버튼 뒤로/앞으로
    const unbindUndo = bindUndoShortcut() // Ctrl+Z 실행취소 스택 (커스텀)
    // F5 새로고침 (프로덕션에서도)
    const onF5 = (e: KeyboardEvent): void => {
      if (e.key === 'F5') {
        e.preventDefault()
        window.location.reload()
      }
    }
    window.addEventListener('keydown', onF5)
    return () => {
      unbindGen()
      unbindScene()
      unbindKeys()
      unbindUpdate()
      unbindNav()
      unbindUndo()
      window.removeEventListener('keydown', onF5)
    }
  }, [])

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col bg-paper">
        <Titlebar />
        <div
          className={cn(
            'relative flex min-h-0 flex-1',
            stacked ? 'flex-col gap-2 px-2 pb-2' : 'gap-3 px-3 pb-3'
          )}
        >
          <AnimatePresence initial={false}>
            {leftOpen && (
              <motion.div
                key="left"
                className={cn('relative shrink-0 overflow-hidden', stacked ? 'w-full' : 'h-full')}
                initial={stacked ? { height: 0, opacity: 0 } : { width: 0, opacity: 0 }}
                animate={
                  stacked
                    ? { width: '100%', height: stackedSidebarHeight, opacity: 1 }
                    : { width: responsiveSidebarWidth, height: '100%', opacity: 1 }
                }
                exit={stacked ? { height: 0, opacity: 0 } : { width: 0, opacity: 0 }}
                // 드래그 중엔 즉시 반영 (애니메이션이 따라오면 답답함)
                transition={
                  resizing ? { duration: 0 } : { duration: 0.22, ease: [0.22, 1, 0.36, 1] }
                }
              >
                <div
                  style={{ width: stacked ? '100%' : responsiveSidebarWidth }}
                  className="h-full"
                >
                  <PromptPanel />
                </div>
                {/* 폭 조절 핸들 */}
                {!stacked && (
                  <div
                    className="absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize transition-colors hover:bg-accent/30"
                    onMouseDown={startResize}
                  />
                )}
              </motion.div>
            )}
          </AnimatePresence>
          {centerMode === 'scene' ? (
            <SceneMode />
          ) : centerMode === 'director' ? (
            <DirectorMode />
          ) : centerMode === 'library' ? (
            <LibraryMode />
          ) : centerMode === 'upload' ? (
            <UploadMode />
          ) : centerMode === 'main' ? (
            <PreviewPane />
          ) : null}
          {/* 웹 모드는 hidden 유지 렌더 — 모드를 오가도 페이지/로그인이 유지된다 */}
          <WebModeKeepAlive active={centerMode === 'web'} />
          <AnimatePresence initial={false}>
            {rightOpen && (
              <motion.div
                key="right"
                className={cn(
                  'h-full shrink-0 overflow-hidden',
                  overlayHistory &&
                    'absolute bottom-0 right-0 top-0 z-40 rounded-xl bg-paper/95 shadow-2xl backdrop-blur'
                )}
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: historyWidth, opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              >
                <HistoryPanel />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
        <TextPromptHost />
        <InpaintHost />
        <MetadataDialog />
        <FolderMovedNotice />
        <R2SyncHost />
        <Toaster />
        <AnimatePresence>{!ready && <LoadingScreen key="loading" />}</AnimatePresence>
      </div>
    </TooltipProvider>
  )
}
