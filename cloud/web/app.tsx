/** 앱 틀 — 연결 여부에 따라 연결 화면 또는 탭 화면, 그리고 폴링 */
import type { ComponentChildren } from 'preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { loadDevice, refreshGalleryHead, refreshState } from './actions'
import { Poller, hasActiveJobs } from './lib/poll'
import { useStore } from './lib/store'
import { app, type TabId } from './stores'
import { ConnectScreen } from './screens/connect'
import { StatusBar, TabBar } from './screens/chrome'
import { CreateTab } from './screens/create'
import { GalleryTab, ScenePickerHost } from './screens/gallery'
import { JobsTab } from './screens/jobs'
import { ScenesTab } from './screens/scenes'
import { SceneSheetHost } from './screens/scene-sheet'
import { SettingsTab } from './screens/settings'
import { ViewerHost } from './screens/viewer'
import { ConfirmHost, ToastHost } from './ui/overlays'
import { ErrorState, Loading } from './ui/primitives'

const STATE_POLL_MS = 4000
const ACTIVE_POLL_MS = 8000

const pageVisible = (): boolean => document.visibilityState !== 'hidden'

/** 화면이 보이는 동안만 도는 Poller 를 시작하고, 정리 함수를 돌려준다 */
function runPoller(poller: Poller): () => void {
  const onVisibility = (): void => poller.notifyVisibility()
  const onOnline = (): void => poller.trigger()
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('online', onOnline)
  poller.start()
  return () => {
    poller.stop()
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('online', onOnline)
  }
}

export function App() {
  const auth = useStore(app, (s) => s.auth)
  return (
    <>
      {auth === 'in' ? <Shell /> : <ConnectScreen />}
      <ConfirmHost />
      <ToastHost />
    </>
  )
}

/** 탭 하나의 내용 — 한 번 열린 탭은 숨기기만 하고 그대로 둬서 스크롤 위치와 입력 중인 글을 지킨다 */
function Panel({
  active,
  label,
  children
}: {
  active: boolean
  label: string
  children: ComponentChildren
}) {
  const ref = useRef<HTMLElement>(null)
  const scrollTop = useRef(0)
  useLayoutEffect(() => {
    if (active && ref.current) ref.current.scrollTop = scrollTop.current
  }, [active])
  return (
    <section
      ref={ref}
      class="panel"
      hidden={!active}
      aria-label={label}
      onScroll={() => {
        if (active && ref.current) scrollTop.current = ref.current.scrollTop
      }}
    >
      {children}
    </section>
  )
}

const TAB_LABELS: Record<TabId, string> = {
  scenes: '씬',
  create: '생성',
  gallery: '갤러리',
  jobs: '작업',
  settings: '설정'
}

function Shell() {
  const tab = useStore(app, (s) => s.tab)
  const hasPhone = useStore(app, (s) => s.phone != null)
  const stateError = useStore(app, (s) => s.stateError)
  const active = useStore(app, (s) => hasActiveJobs(s.phone?.jobs))
  const [opened, setOpened] = useState<ReadonlySet<TabId>>(() => new Set([tab]))

  useEffect(() => {
    setOpened((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)))
  }, [tab])

  // 상태 4초 폴링 (화면이 보일 때만)
  useEffect(() => {
    void loadDevice()
    return runPoller(
      new Poller({ run: refreshState, intervalMs: STATE_POLL_MS, isVisible: pageVisible })
    )
  }, [])

  // 작업이 진행 중이면 갤러리 첫 페이지도 8초마다. 끝나면 마지막으로 한 번 더
  useEffect(() => {
    if (!active) return
    const stop = runPoller(
      new Poller({
        run: async () => {
          await refreshGalleryHead()
          return true
        },
        intervalMs: ACTIVE_POLL_MS,
        isVisible: pageVisible
      })
    )
    return () => {
      stop()
      void refreshGalleryHead()
    }
  }, [active])

  const panel = (id: TabId, content: ComponentChildren) =>
    opened.has(id) ? (
      <Panel active={tab === id} label={TAB_LABELS[id]}>
        {content}
      </Panel>
    ) : null

  return (
    <div class="shell">
      <StatusBar />
      <main class="shell__main">
        {!hasPhone ? (
          <section class="panel">
            {stateError ? (
              <ErrorState message={stateError} onRetry={() => void refreshState()} />
            ) : (
              <Loading />
            )}
          </section>
        ) : (
          <>
            {panel('scenes', <ScenesTab active={tab === 'scenes'} />)}
            {panel('create', <CreateTab />)}
            {panel('gallery', <GalleryTab active={tab === 'gallery'} />)}
            {panel('jobs', <JobsTab />)}
            {panel('settings', <SettingsTab />)}
          </>
        )}
      </main>
      <TabBar />
      <SceneSheetHost />
      <ScenePickerHost />
      <ViewerHost />
    </div>
  )
}
