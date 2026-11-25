/** 갤러리 탭 — PC·클라우드 생성 갤러리 + 구글 드라이브식 PC 폴더 탐색기 (1~4장 전체 비율 지원) */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import {
  LOAD_MORE_AUTO_RETRIES,
  loadDriveIndex,
  loadGallery,
  loadMoreGallery,
  loadScenes,
  openDriveFolder,
  openViewer,
  sendControl,
  setGalleryFilter
} from '../actions'
import { thumbLoader } from '../client'
import { isNearView, useInView } from '../hooks'
import { pcControl } from '../lib/control'
import {
  buildDriveTree,
  driveFolder,
  driveImageItems,
  driveParentPath,
  driveSubFolders,
  joinDrivePath,
  searchDriveFolders
} from '../lib/drive'
import { readPref, writePref } from '../lib/storage'
import { useStore } from '../lib/store'
import { app, drive, gallery, scenes, sheets } from '../stores'
import { Icon } from '../ui/icons'
import { Sheet } from '../ui/overlays'
import { AuthImage, EmptyState, ErrorState, Loading, Spinner } from '../ui/primitives'

/** 목록 끝이 이만큼(px) 안으로 다가오면 다음 페이지를 미리 받는다 */
const LOAD_AHEAD_PX = 600

export function GalleryTab({ active }: { active: boolean }) {
  const [mode, setMode] = useState<'generated' | 'drive'>(() =>
    readPref('galleryMode') === 'drive' ? 'drive' : 'generated'
  )
  const [cols, setCols] = useState<1 | 2 | 3 | 4>(() => {
    const saved = Number(readPref('galleryCols'))
    return saved === 1 || saved === 2 || saved === 3 || saved === 4 ? saved : 3
  })
  const [contain, setContain] = useState<boolean>(() => readPref('galleryFit') !== 'cover')

  const switchMode = (next: 'generated' | 'drive'): void => {
    setMode(next)
    writePref('galleryMode', next)
    if (next === 'drive') void loadDriveIndex({ silent: true })
  }
  const changeCols = (n: 1 | 2 | 3 | 4): void => {
    setCols(n)
    writePref('galleryCols', String(n))
  }
  const toggleContain = (): void => {
    setContain((prev) => {
      const next = !prev
      writePref('galleryFit', next ? 'contain' : 'cover')
      return next
    })
  }

  return (
    <div class="gallery stack">
      <div class="segmented" role="tablist" aria-label="갤러리 모드">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'generated'}
          class={mode === 'generated' ? 'segmented__item btn--grow is-on' : 'segmented__item btn--grow'}
          onClick={() => switchMode('generated')}
        >
          🖼 생성 갤러리
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'drive'}
          class={mode === 'drive' ? 'segmented__item btn--grow is-on' : 'segmented__item btn--grow'}
          onClick={() => switchMode('drive')}
        >
          📁 PC 폴더
        </button>
      </div>

      <div class="view-toolbar" role="group" aria-label="보기열 및 비율">
        <div class="view-toolbar__cols">
          {([1, 2, 3, 4] as const).map((n) => (
            <button
              key={n}
              type="button"
              class={cols === n ? 'chip chip--sm is-on' : 'chip chip--sm'}
              aria-pressed={cols === n}
              onClick={() => changeCols(n)}
            >
              {n}장
            </button>
          ))}
          <button
            type="button"
            class={contain ? 'chip chip--sm is-on' : 'chip chip--sm'}
            aria-pressed={contain}
            onClick={toggleContain}
          >
            {contain ? '전체 비율' : '꽉 채움'}
          </button>
        </div>
      </div>

      {mode === 'generated' ? (
        <GeneratedGalleryView active={active} cols={cols} contain={contain} />
      ) : (
        <DriveExplorerView active={active} cols={cols} contain={contain} />
      )}
    </div>
  )
}

function GeneratedGalleryView({
  active,
  cols,
  contain
}: {
  active: boolean
  cols: 1 | 2 | 3 | 4
  contain: boolean
}) {
  const items = useStore(gallery, (s) => s.items)
  const next = useStore(gallery, (s) => s.next)
  const loaded = useStore(gallery, (s) => s.loaded)
  const loading = useStore(gallery, (s) => s.loading)
  const error = useStore(gallery, (s) => s.error)
  const filter = useStore(gallery, (s) => s.filter)
  const moreError = useStore(gallery, (s) => s.moreError)
  const moreFailures = useStore(gallery, (s) => s.moreFailures)
  const retryAt = useStore(gallery, (s) => s.retryAt)
  const [syncing, setSyncing] = useState(false)

  // 처음 열 때 한 번
  useEffect(() => {
    if (active && !loaded && !loading && !error) void loadGallery()
  }, [active, loaded, loading, error])

  const sentinel = useRef<HTMLDivElement>(null)
  const nearEnd = useInView(sentinel, `${LOAD_AHEAD_PX}px`)
  useEffect(() => {
    if (!active || !nearEnd || !next || loading) return
    if (moreError) {
      if (moreFailures > LOAD_MORE_AUTO_RETRIES) return
      const wait = Math.max(0, retryAt - Date.now()) + 50
      const timer = setTimeout(() => void loadMoreGallery(), wait)
      return () => clearTimeout(timer)
    }
    const frame = requestAnimationFrame(() => {
      if (isNearView(sentinel.current, LOAD_AHEAD_PX)) void loadMoreGallery()
    })
    return () => cancelAnimationFrame(frame)
  }, [active, nearEnd, next, loading, items.length, moreError, moreFailures, retryAt])

  async function syncFromPc(): Promise<void> {
    if (syncing) return
    setSyncing(true)
    try {
      await sendControl(
        pcControl.uploadRecentImages(),
        'PC에서 생성된 최근 그림들을 클라우드로 동기화합니다'
      )
    } finally {
      setSyncing(false)
    }
  }

  return (
    <>
      <div class="chips chips--scroll" role="group" aria-label="씬 필터">
        <button
          type="button"
          class={filter ? 'chip' : 'chip is-on'}
          aria-pressed={!filter}
          onClick={() => filter && setGalleryFilter(null)}
        >
          전체
        </button>
        {filter && (
          <button
            type="button"
            class="chip is-on"
            aria-label={`${filter.label} 필터 해제`}
            onClick={() => setGalleryFilter(null)}
          >
            <span class="chip__text">{filter.label}</span>
            <Icon name="x" size={14} />
          </button>
        )}
        <button type="button" class="chip" onClick={() => sheets.set({ picker: true })}>
          <Icon name="filter" size={14} />씬 선택
        </button>
        <button
          type="button"
          class="chip"
          disabled={syncing}
          onClick={() => void syncFromPc()}
          title="PC에서 생성된 그림을 즉시 동기화"
        >
          <Icon name="refresh" size={14} />
          PC 그림 동기화
        </button>
        <button
          type="button"
          class="chip chip--icon"
          aria-label="목록 새로고침"
          disabled={loading}
          onClick={() => void loadGallery()}
        >
          <Icon name="refresh" size={14} />
        </button>
      </div>

      {!loaded && !error ? (
        <Loading />
      ) : error && (!loaded || items.length === 0) ? (
        <ErrorState message={error} onRetry={() => void loadGallery()} />
      ) : items.length === 0 ? (
        <EmptyState
          title="그림이 없습니다"
          body={
            filter
              ? '이 필터에 해당하는 그림이 없습니다.'
              : '생성하거나 「PC 그림 동기화」를 누르면 여기에 모입니다.'
          }
        >
          <button type="button" class="btn" disabled={syncing} onClick={() => void syncFromPc()}>
            <Icon name="refresh" size={18} />
            PC에서 생성된 그림 불러오기
          </button>
        </EmptyState>
      ) : (
        <ul class={`gallery-grid gallery-grid--cols-${cols}`}>
          {items.map((it, i) => {
            const ratio =
              it.width > 0 && it.height > 0 ? `${it.width} / ${it.height}` : '3 / 4'
            return (
              <li key={it.id}>
                <button
                  type="button"
                  class={contain ? 'thumb thumb--cell is-contain' : 'thumb thumb--cell'}
                  style={contain ? { aspectRatio: ratio } : undefined}
                  aria-label={`그림 ${i + 1}번 크게 보기`}
                  onClick={() => openViewer(items, i, 'gallery')}
                >
                  <AuthImage cacheKey={`t:${it.id}`} load={thumbLoader(it.id, it.hasThumb)} />
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <div ref={sentinel} class="gallery__end">
        {loading && loaded ? (
          <Spinner size={20} />
        ) : moreError && next ? (
          <div class="gallery__more-error" role="alert">
            <p class="muted">다음 그림을 불러오지 못했습니다. {moreError}</p>
            <button
              type="button"
              class="btn"
              onClick={() => void loadMoreGallery({ manual: true })}
            >
              <Icon name="refresh" size={18} />
              다시 시도
            </button>
          </div>
        ) : null}
      </div>
    </>
  )
}

/** 구글 드라이브식 PC 폴더 탐색기 — 폴더 이름은 PC가 올린 색인의 rootName 을 보여 준다 */
function DriveExplorerView({
  active,
  cols,
  contain
}: {
  active: boolean
  cols: 1 | 2 | 3 | 4
  contain: boolean
}) {
  const index = useStore(drive, (s) => s.index)
  const cachedFiles = useStore(drive, (s) => s.cachedFiles)
  const currentPath = useStore(drive, (s) => s.currentPath)
  const search = useStore(drive, (s) => s.search)
  const loading = useStore(drive, (s) => s.loading)
  const error = useStore(drive, (s) => s.error)
  const presetId = useStore(app, (s) => s.presetId)
  const [newFolderName, setNewFolderName] = useState('')
  const [showNewFolder, setShowNewFolder] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (active && !index && !loading && !error) void loadDriveIndex()
  }, [active, index, loading, error])

  // PC 색인({ path, dirs, imgs })을 화면이 쓰는 폴더 모양으로 — 계산은 lib/drive.ts
  const tree = useMemo(() => (index ? buildDriveTree(index) : null), [index])
  const currentEntry = tree ? driveFolder(tree, currentPath) : null

  const subFolders = useMemo(() => {
    if (!tree) return []
    return search.trim() ? searchDriveFolders(tree, search, 80) : driveSubFolders(tree, currentPath)
  }, [tree, currentPath, search])

  const files = currentEntry?.files ?? []

  // 현재 폴더의 그림들을 ViewerHost 호환 CloudImageItem[] 으로 변환
  const driveViewerItems = useMemo(() => driveImageItems(currentEntry), [currentEntry])

  const breadcrumbs = currentPath ? currentPath.split('/') : []

  async function requestSyncFolder(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      await sendControl(
        pcControl.syncDriveFolder(currentPath),
        `PC에서 「${currentPath || '최상위'}」 폴더 그림들을 클라우드로 올리는 중입니다`
      )
      setTimeout(() => void loadDriveIndex({ silent: true }), 2500)
      setTimeout(() => void loadDriveIndex({ silent: true }), 5500)
    } finally {
      setBusy(false)
    }
  }

  async function createFolder(): Promise<void> {
    const trimmed = newFolderName.trim()
    if (!trimmed || busy) return
    const targetPath = currentPath ? `${currentPath}/${trimmed}` : trimmed
    setBusy(true)
    try {
      const ok = await sendControl(
        pcControl.makeDriveFolder(targetPath),
        `폴더 생성 완료: ${targetPath}`
      )
      if (ok) {
        setNewFolderName('')
        setShowNewFolder(false)
        openDriveFolder(targetPath)
      }
    } finally {
      setBusy(false)
    }
  }

  if (loading && !index) return <Loading />
  if (error && !index) return <ErrorState message={error} onRetry={() => void loadDriveIndex()} />
  if (!index || !tree) {
    return (
      <EmptyState
        title="PC 폴더 목록을 아직 받지 못했습니다"
        body="PC에서 NAIS3가 켜져 있으면 폴더 목록을 불러올 수 있습니다."
      >
        <button
          type="button"
          class="btn"
          disabled={busy}
          onClick={() =>
            void sendControl(pcControl.refreshDriveIndex(), 'PC에 폴더 목록 전송을 요청했습니다')
          }
        >
          <Icon name="refresh" size={18} />
          PC에서 폴더 목록 불러오기
        </button>
      </EmptyState>
    )
  }

  return (
    <div class="stack">
      <div class="drive-header">
        <div class="drive-header__info">
          <span class="drive-header__title">📁 {index.rootName}</span>
          <span class="muted">
            폴더 {tree.totalFolders}개 · 그림 {tree.totalImages.toLocaleString('ko-KR')}장
          </span>
        </div>
        <div class="drive-header__actions">
          <button
            type="button"
            class="chip chip--sm"
            onClick={() => setShowNewFolder((v) => !v)}
          >
            <Icon name="folderPlus" size={14} />새 폴더
          </button>
          <button
            type="button"
            class="chip chip--sm"
            disabled={busy}
            onClick={() =>
              void sendControl(pcControl.refreshDriveIndex(), 'PC 폴더 트리를 새로고침합니다')
            }
          >
            <Icon name="refresh" size={14} />
          </button>
        </div>
      </div>

      {/* 경로 탐색 브레드크럼 */}
      <div class="chips chips--scroll" role="navigation" aria-label="폴더 경로">
        <button
          type="button"
          class={currentPath === '' ? 'chip is-on' : 'chip'}
          onClick={() => openDriveFolder('')}
        >
          🏠 최상위
        </button>
        {breadcrumbs.map((part, idx) => {
          const sub = breadcrumbs.slice(0, idx + 1).join('/')
          const on = sub === currentPath
          return (
            <button
              key={sub}
              type="button"
              class={on ? 'chip is-on' : 'chip'}
              onClick={() => openDriveFolder(sub)}
            >
              {part}
            </button>
          )
        })}
      </div>

      {showNewFolder && (
        <div class="field-row">
          <input
            class="input"
            type="text"
            placeholder="새 하위 폴더 이름 입력..."
            value={newFolderName}
            onInput={(e) => setNewFolderName((e.currentTarget as HTMLInputElement).value)}
          />
          <button
            type="button"
            class="btn btn--primary"
            disabled={!newFolderName.trim() || busy}
            onClick={() => void createFolder()}
          >
            만들기
          </button>
        </div>
      )}

      {/* 폴더 검색 */}
      <div class="field-row">
        <input
          class="input"
          type="search"
          placeholder="전체 하위 폴더 검색"
          value={search}
          onInput={(e) => drive.set({ search: (e.currentTarget as HTMLInputElement).value })}
        />
        {currentPath !== '' && (
          <button
            type="button"
            class="btn"
            onClick={() => openDriveFolder(driveParentPath(currentPath))}
          >
            위로
          </button>
        )}
      </div>

      {/* 현재 선택된 프리셋을 이 폴더로 바로 분류·저장 */}
      {presetId != null && currentPath !== '' && (
        <button
          type="button"
          class="btn btn--block"
          disabled={busy}
          onClick={() =>
            void sendControl(
              pcControl.exportPresetToDrive(presetId, currentPath),
              `현재 프리셋 그림들을 「${currentPath}」 폴더에 저장했습니다`
            )
          }
        >
          <Icon name="save" size={16} />이 폴더에 현재 프리셋 그림 분류·저장 (001.png~)
        </button>
      )}

      {/* 하위 폴더 목록 */}
      {subFolders.length > 0 && (
        <section class="stack" aria-label="하위 폴더">
          <h3 class="section-title">
            {search.trim() ? `검색된 폴더 (${subFolders.length})` : `하위 폴더 (${subFolders.length})`}
          </h3>
          <ul class="rows">
            {subFolders.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  class="row row--button"
                  onClick={() => openDriveFolder(f.path)}
                >
                  <span class="drive-folder-row">
                    <Icon name="folder" size={18} />
                    <span class="row__main">
                      <span class="row__title">{search.trim() ? f.path : f.name}</span>
                      {f.childDirs.length > 0 && (
                        <span class="row__sub">하위 폴더 {f.childDirs.length}개</span>
                      )}
                    </span>
                  </span>
                  <span class="muted">그림 {f.imageCount}장</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 현재 폴더의 이미지 목록 */}
      {files.length > 0 && (
        <section class="stack" aria-label="폴더 내 그림">
          <div class="section-head">
            <h3 class="section-title">이 폴더의 그림 ({files.length}장)</h3>
            <button
              type="button"
              class="chip chip--sm"
              disabled={busy}
              onClick={() => void requestSyncFolder()}
            >
              <Icon name="refresh" size={14} />
              PC에서 썸네일 불러오기
            </button>
          </div>
          <ul class={`gallery-grid gallery-grid--cols-${cols}`}>
            {files.map((fileName, idx) => {
              const relFile = joinDrivePath(currentPath, fileName)
              const isCached = !!cachedFiles[relFile]
              return (
                <li key={relFile} class="drive-img-card">
                  <button
                    type="button"
                    class={contain ? 'thumb thumb--cell is-contain' : 'thumb thumb--cell'}
                    style={contain ? { aspectRatio: '3 / 4' } : undefined}
                    aria-label={`${fileName} 크게 보기`}
                    onClick={() => {
                      if (!isCached) {
                        void requestSyncFolder()
                      }
                      openViewer(driveViewerItems, idx, 'list')
                    }}
                  >
                    {isCached ? (
                      <AuthImage
                        cacheKey={`t:d:${relFile}`}
                        load={thumbLoader(`d:${relFile}`, true)}
                      />
                    ) : (
                      <span class="thumb__empty drive-img-card__pending">
                        <Icon name="image" size={22} />
                        <span>터치하여 PC에서 로드</span>
                      </span>
                    )}
                  </button>
                  <span class="drive-img-card__name">{fileName}</span>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {subFolders.length === 0 && files.length === 0 && (
        <EmptyState
          title="이 폴더는 비어 있습니다"
          body="상단 「새 폴더」로 하위 폴더를 만들거나 현재 프리셋 그림을 이 폴더로 분류해 저장할 수 있습니다."
        />
      )}
    </div>
  )
}

/** 씬 고르기 시트 — 프리셋을 고르고 씬을 누르면 갤러리가 그 씬 그림만 보여 준다 */
export function ScenePickerHost() {
  const open = useStore(sheets, (s) => s.picker)
  return open ? <ScenePicker /> : null
}

function ScenePicker() {
  const presets = useStore(app, (s) => s.phone?.library?.presets ?? [])
  const appPreset = useStore(app, (s) => s.presetId)
  const sorted = [...presets].sort((a, b) => a.sortOrder - b.sortOrder)
  const [presetId, setPresetId] = useState<number | null>(appPreset ?? sorted[0]?.id ?? null)
  const entry = useStore(scenes, (s) => (presetId != null ? s.byPreset[presetId] : undefined))
  const preset = sorted.find((p) => p.id === presetId)

  useEffect(() => {
    if (presetId != null) void loadScenes(presetId, { silent: true })
  }, [presetId])

  const close = (): void => sheets.set({ picker: false })
  const choose = (filter: {
    sceneId: number | null
    presetId: number | null
    label: string
  }): void => {
    close()
    setGalleryFilter(filter)
  }

  return (
    <Sheet title="씬 선택" onClose={close}>
      <div class="stack">
        {sorted.length === 0 ? (
          <p class="muted">프리셋이 없습니다.</p>
        ) : (
          <>
            <div class="select-wrap">
              <select
                class="input select"
                aria-label="프리셋"
                value={presetId ?? ''}
                onChange={(e) => setPresetId(Number((e.currentTarget as HTMLSelectElement).value))}
              >
                {sorted.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.sceneCount})
                  </option>
                ))}
              </select>
              <Icon name="chevronDown" size={18} class="select-wrap__arrow" />
            </div>
            {preset && (
              <button
                type="button"
                class="btn btn--block"
                onClick={() => choose({ sceneId: null, presetId: preset.id, label: preset.name })}
              >
                이 프리셋 그림 전체
              </button>
            )}
            {!entry || (!entry.loaded && !entry.error) ? (
              <Loading />
            ) : entry.error && !entry.loaded ? (
              <ErrorState
                message={entry.error}
                onRetry={() => presetId != null && void loadScenes(presetId)}
              />
            ) : (
              <ul class="rows">
                {entry.items.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      class="row row--button"
                      onClick={() => choose({ sceneId: s.id, presetId: s.presetId, label: s.name })}
                    >
                      <span class="row__title">{s.name}</span>
                      <span class="muted">{s.imageCount}장</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </Sheet>
  )
}
