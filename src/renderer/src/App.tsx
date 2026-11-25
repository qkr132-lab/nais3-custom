import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import {
  CalendarPlus,
  FileText,
  Minus,
  Plus,
  Square,
  UsersRound,
  X
} from 'lucide-react'
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
import { CompositionMode } from './components/composition-mode'
import { LibraryMode } from './components/library-mode'
import { UploadMode } from './components/upload-mode'
import { WebMode } from './components/web-mode'
import { Titlebar } from './components/titlebar'
import { PageNav } from './components/page-nav'
import { TurboButton } from './components/turbo-button'
import { Button } from './components/ui/button'
import { SettingsDialog } from './components/token-dialog'
import { TextPromptHost } from './components/text-prompt-host'
import { TooltipProvider } from './components/ui/tooltip'
import { useCharactersStore } from './stores/characters-store'
import { useOutfitsStore } from './stores/outfits-store'
import { useCardFitStore } from './stores/card-fit-store'
import { anyNudeStrip } from './stores/scene-extras-store'
import { OutfitMode } from './components/outfit-mode'
import { useFragmentsStore } from './stores/fragments-store'
import { useCharRefsStore, useVibesStore } from './stores/refs-store'
import { bindGenerationEvents, useGenerationStore } from './stores/generation-store'
import { bindExternalDbEvents, bindSceneEvents, totalReserved, useScenesStore } from './stores/scenes-store'
import { bindShortcuts, useShortcutsStore } from './stores/shortcuts-store'
import { bindUndoShortcut } from './stores/undo-store'
import { bindUpdateEvents } from './stores/update-store'
import { bindNavMouse } from './lib/nav-history'
import { startCloudBridge } from './lib/cloud-bridge'
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

/**
 * 세로(휴대폰/원격) 모드 전용 하단 고정 퀵 액션 바.
 * 프롬프트 서랍을 닫아 둔 상태에서도 엄지손가락 한 번으로
 * [프롬프트] · [캐릭터 선택] · [배치 수량] · [전체 예약] · [고속] · [생성/취소]를 즉시 조작할 수 있다.
 */
function MobileQuickBar(): React.JSX.Element {
  const leftOpen = useLayoutStore((s) => s.leftOpen)
  const setLeftOpen = useLayoutStore((s) => s.setLeftOpen)
  const centerMode = useLayoutStore((s) => s.centerMode)
  const charOverlayOpen = useCharactersStore((s) => s.overlayOpen)
  const toggleCharOverlay = useCharactersStore((s) => s.toggleOverlay)
  const activeChars = useCharactersStore(
    (s) => s.items.filter((c) => c.enabled && c.prompt.trim()).length
  )
  const setFragOverlayOpen = useFragmentsStore((s) => s.setOverlayOpen)
  const setVibeOverlayOpen = useVibesStore((s) => s.setOverlayOpen)
  const setCrefOpen = useCharRefsStore((s) => s.setOverlayOpen)

  const queue = useGenerationStore((s) => s.queue)
  const batchCount = useGenerationStore((s) => s.batchCount)
  const setBatchCount = useGenerationStore((s) => s.setBatchCount)
  const generate = useGenerationStore((s) => s.generate)
  const cancelAll = useGenerationStore((s) => s.cancelAll)

  const sceneReserved = useScenesStore((s) => totalReserved(s.scenes))
  const sceneCount = useScenesStore((s) => s.scenes.length)
  const adjustReserveAll = useScenesStore((s) => s.adjustReserveAll)
  const generateReserved = useScenesStore((s) => s.generateReserved)
  const isScene = centerMode === 'scene' || centerMode === 'background'
  const scopeReady = useScenesStore((s) => !s.libraryLoading && s.libraryKind === centerMode)

  const queueCount =
    queue?.items.filter((i) => i.state === 'pending' || i.state === 'generating').length ?? 0
  const generating = queueCount > 0

  const togglePromptSheet = (): void => {
    if (leftOpen && !charOverlayOpen) {
      setLeftOpen(false)
      return
    }
    if (charOverlayOpen) toggleCharOverlay()
    setFragOverlayOpen(false)
    setVibeOverlayOpen(false)
    setCrefOpen(false)
    setLeftOpen(true)
  }

  const toggleCharacterSheet = (): void => {
    if (leftOpen && charOverlayOpen) {
      setLeftOpen(false)
      return
    }
    setFragOverlayOpen(false)
    setVibeOverlayOpen(false)
    setCrefOpen(false)
    if (!charOverlayOpen) toggleCharOverlay()
    setLeftOpen(true)
  }

  return (
    <div className="no-drag flex h-12 shrink-0 items-center gap-1.5 border-t border-line bg-surface px-2">
      <Button
        variant={leftOpen && !charOverlayOpen ? 'accent' : 'default'}
        size="sm"
        className="h-9 shrink-0 gap-1 px-2.5 text-[12.5px]"
        onClick={togglePromptSheet}
        title="프롬프트·파라미터 서랍 열기/닫기"
      >
        {leftOpen && !charOverlayOpen ? <X size={14} /> : <FileText size={14} />}
        <span>프롬프트</span>
      </Button>

      <div className="relative shrink-0">
        <Button
          variant={leftOpen && charOverlayOpen ? 'accent' : 'default'}
          size="sm"
          className="h-9 gap-1 px-2.5 text-[12.5px]"
          onClick={toggleCharacterSheet}
          title="캐릭터 카드 선택 서랍 열기/닫기"
        >
          <UsersRound size={14} />
          <span>캐릭터</span>
        </Button>
        {activeChars > 0 && (
          <span className="pointer-events-none absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 font-mono text-[10px] font-bold text-white shadow">
            {activeChars}
          </span>
        )}
      </div>

      {/* 배치 수량 스테퍼 */}
      <div className="flex h-9 shrink-0 items-center rounded-md border border-line bg-paper">
        <button
          type="button"
          className="grid h-full w-7 place-items-center text-muted hover:bg-surface-2 hover:text-ink"
          onClick={() => setBatchCount(batchCount - 1)}
          title="배치 수량 -1"
        >
          <Minus size={13} />
        </button>
        <input
          className="w-7 bg-transparent text-center font-mono text-[12.5px] font-semibold text-ink outline-none"
          value={batchCount}
          inputMode="numeric"
          onChange={(e) => {
            const n = parseInt(e.target.value.replace(/[^0-9]/g, ''), 10)
            if (!Number.isNaN(n)) setBatchCount(n)
          }}
          onFocus={(e) => e.target.select()}
        />
        <button
          type="button"
          className="grid h-full w-7 place-items-center text-muted hover:bg-surface-2 hover:text-ink"
          onClick={() => setBatchCount(batchCount + 1)}
          title="배치 수량 +1"
        >
          <Plus size={13} />
        </button>
      </div>

      {!generating && isScene && (
        <Button
          variant="default"
          size="sm"
          className="h-9 shrink-0 gap-1 px-2.5 text-[12px]"
          disabled={!scopeReady || sceneCount === 0}
          title="현재 프리셋의 모든 씬에 예약 +1"
          onClick={() => void adjustReserveAll(1)}
        >
          <CalendarPlus size={14} />
          <span className="max-[420px]:hidden">전체예약</span>
        </Button>
      )}

      <TurboButton size="panel" />

      {generating ? (
        <Button
          variant="danger"
          size="sm"
          className="h-9 min-w-0 flex-1 gap-1.5 text-[13px] font-semibold"
          onClick={() => void cancelAll()}
        >
          <Square size={13} />
          <span className="truncate">취소 ({queueCount})</span>
        </Button>
      ) : isScene ? (
        <Button
          variant="accent"
          size="sm"
          className="h-9 min-w-0 flex-1 gap-1.5 text-[13px] font-semibold"
          disabled={!scopeReady || sceneReserved === 0}
          onClick={() => {
            setLeftOpen(false)
            void generateReserved()
          }}
          title={sceneReserved === 0 ? '씬 카드에서 +로 예약한 뒤 눌러주세요' : `예약된 ${sceneReserved}장 생성`}
        >
          <span className="truncate">
            {centerMode === 'background' ? '배경 생성' : '씬 생성'}
            {sceneReserved > 0 ? ` (${sceneReserved}장)` : ''}
          </span>
        </Button>
      ) : (
        <Button
          variant="accent"
          size="sm"
          className="h-9 min-w-0 flex-1 gap-1.5 text-[13px] font-semibold"
          onClick={() => {
            setLeftOpen(false)
            void generate()
          }}
        >
          <span className="truncate">생성</span>
        </Button>
      )}
    </div>
  )
}

export default function App(): React.JSX.Element {
  const leftOpen = useLayoutStore((s) => s.leftOpen)
  const setLeftOpen = useLayoutStore((s) => s.setLeftOpen)
  const rightOpen = useLayoutStore((s) => s.rightOpen)
  const settingsOpen = useLayoutStore((s) => s.settingsOpen)
  const setSettingsOpen = useLayoutStore((s) => s.setSettingsOpen)
  const centerMode = useLayoutStore((s) => s.centerMode)
  const sidebarWidth = useLayoutStore((s) => s.sidebarWidth)
  const mobileModeOverride = useLayoutStore((s) => s.mobileModeOverride)
  const [ready, setReady] = useState(false)
  const [resizing, setResizing] = useState(false)
  const viewport = useViewportSize()
  const stacked =
    mobileModeOverride === 'portrait' ||
    (mobileModeOverride === 'auto' &&
      (viewport.width < 960 || viewport.height > viewport.width * 1.05))
  const overlayHistory = stacked || viewport.width < 1240
  const responsiveSidebarWidth = Math.min(
    sidebarWidth,
    Math.max(320, Math.floor(viewport.width * 0.38))
  )
  const stackedDrawerHeight = Math.max(
    360,
    Math.min(Math.round(viewport.height * 0.76), viewport.height - 108)
  )
  const historyWidth = overlayHistory ? Math.min(300, viewport.width - 24) : 240

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
        useOutfitsStore.getState().load(),
        useCardFitStore.getState().load(),
        useFragmentsStore.getState().load(),
        useVibesStore.getState().load(),
        useCharRefsStore.getState().load(),
        useShortcutsStore.getState().hydrate()
      ])
      // 누드면 옷 벗기기 — 전체나 어느 씬에서든 켜져 있으면 카드 태그의 옷 분류를 미리 받아둔다 (씬 미리보기용)
      if (anyNudeStrip()) {
        void useOutfitsStore
          .getState()
          .ensureKinds(useCharactersStore.getState().items.map((c) => c.prompt))
          .catch(() => undefined)
      }
      // 스플래시가 너무 순식간에 사라지지 않게 최소 표시 시간 확보
      setTimeout(() => setReady(true), 350)
    })()
    const unbindGen = bindGenerationEvents()
    const unbindScene = bindSceneEvents()
    const unbindExternalDb = bindExternalDbEvents()
    const unbindKeys = bindShortcuts()
    const unbindUpdate = bindUpdateEvents()
    const unbindNav = bindNavMouse() // 마우스 4/5번 버튼 뒤로/앞으로
    const unbindUndo = bindUndoShortcut() // Ctrl+Z 실행취소 스택 (커스텀)
    const unbindCloud = startCloudBridge() // 모바일 클라우드 — 폰 편집·생성 작업 받기 (커스텀)
    // 카드 태그 씬 맞춤 규칙표 (커스텀) — 메모장에서 고치고 앱 창으로 돌아오면 다시 읽는다 (바뀐 게 없으면 아무 일도 없다)
    const onWindowFocus = (): void => {
      if (useCardFitStore.getState().loaded) void useCardFitStore.getState().reloadRules()
    }
    window.addEventListener('focus', onWindowFocus)
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
      unbindExternalDb()
      unbindKeys()
      unbindUpdate()
      unbindNav()
      unbindUndo()
      unbindCloud()
      window.removeEventListener('keydown', onF5)
      window.removeEventListener('focus', onWindowFocus)
    }
  }, [])

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col bg-paper">
        <Titlebar portrait={stacked} />
        {stacked && <PageNav compact />}
        <div
          className={cn(
            'relative flex min-h-0 flex-1',
            stacked ? 'flex-col gap-1.5 px-1.5 py-1.5' : 'gap-3 px-3 pb-3'
          )}
        >
          {/* 세로(모바일) 모드: 프롬프트 패널이 열리면 배경 딤(클릭 시 닫힘) + 넉넉한 높이의 오버레이 시트로 표시 */}
          <AnimatePresence initial={false}>
            {stacked && leftOpen && (
              <motion.div
                key="left-backdrop"
                className="absolute inset-0 z-20 bg-black/45 backdrop-blur-[1px]"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                onClick={() => setLeftOpen(false)}
              />
            )}
            {leftOpen && (
              <motion.div
                key="left"
                className={cn(
                  'shrink-0 overflow-hidden',
                  stacked
                    ? 'absolute inset-x-1.5 top-1.5 z-30 rounded-xl shadow-2xl'
                    : 'relative h-full'
                )}
                initial={stacked ? { height: 0, opacity: 0 } : { width: 0, opacity: 0 }}
                animate={
                  stacked
                    ? { width: 'auto', height: stackedDrawerHeight, opacity: 1 }
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
          {/* 가운데 칸은 남는 폭까지만 — min-w-0 이 없으면 넓은 툴바·격자가 줄지 않아 오른쪽 히스토리를 창 밖으로 민다
              (1920 창에서 왼쪽 패널을 넓히면 히스토리 「전체 비우기」 휴지통이 안 보이던 문제) */}
          {centerMode !== 'web' && (
            <div className="flex min-h-0 min-w-0 flex-1">
              {centerMode === 'scene' || centerMode === 'background' ? (
                <SceneMode key={centerMode} kind={centerMode} />
              ) : centerMode === 'outfit' ? (
                <OutfitMode />
              ) : centerMode === 'composition' ? (
                <CompositionMode />
              ) : centerMode === 'director' ? (
                <DirectorMode />
              ) : centerMode === 'library' ? (
                <LibraryMode />
              ) : centerMode === 'upload' ? (
                <UploadMode />
              ) : centerMode === 'main' ? (
                <PreviewPane />
              ) : null}
            </div>
          )}
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
        {stacked && <MobileQuickBar />}
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
