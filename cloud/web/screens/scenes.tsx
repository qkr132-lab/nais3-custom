/** 씬 탭 — 프리셋 폴더 분류·1~4장 전체 보기·폴더 내보내기·씬 시트 열기 */
import type { CloudPhoneScene, CloudPresetLite } from '@shared/cloud-contract'
import { useEffect, useMemo, useState } from 'preact/hooks'
import {
  loadDriveIndex,
  loadScenes,
  refreshState,
  sendControl,
  setPreset
} from '../actions'
import { thumbLoader } from '../client'
import { pcControl } from '../lib/control'
import { buildDriveTree, driveSubFolders, searchDriveFolders } from '../lib/drive'
import {
  PRESET_FOLDER_CATEGORIES,
  classifyPresetFolder,
  type PresetFolderCategory
} from '../lib/format'
import { readPref, writePref } from '../lib/storage'
import { useStore } from '../lib/store'
import { app, drive, scenes, sheets } from '../stores'
import { Icon } from '../ui/icons'
import { Sheet } from '../ui/overlays'
import { AuthImage, EmptyState, ErrorState, Loading } from '../ui/primitives'

function PresetSelect({
  presets,
  value,
  onChange
}: {
  presets: CloudPresetLite[]
  value: number
  onChange: (id: number) => void
}) {
  const sorted = [...presets].sort((a, b) => a.sortOrder - b.sortOrder)
  const sceneKind = sorted.filter((p) => p.kind === 'scene')
  const bgKind = sorted.filter((p) => p.kind === 'background')
  const options = (list: CloudPresetLite[]) =>
    list.map((p) => (
      <option key={p.id} value={p.id}>
        {p.name} ({p.sceneCount})
      </option>
    ))
  return (
    <div class="select-wrap">
      <select
        class="input select"
        aria-label="프리셋"
        value={value}
        onChange={(e) => onChange(Number((e.currentTarget as HTMLSelectElement).value))}
      >
        {sceneKind.length > 0 && bgKind.length > 0 ? (
          <>
            <optgroup label="씬">{options(sceneKind)}</optgroup>
            <optgroup label="배경">{options(bgKind)}</optgroup>
          </>
        ) : (
          options(sorted)
        )}
      </select>
      <Icon name="chevronDown" size={18} class="select-wrap__arrow" />
    </div>
  )
}

function SceneCard({
  scene,
  contain,
  cols
}: {
  scene: CloudPhoneScene
  contain: boolean
  cols: 1 | 2 | 3 | 4
}) {
  const ratio =
    scene.width > 0 && scene.height > 0 ? `${scene.width} / ${scene.height}` : '4 / 5'
  return (
    <li>
      <button
        type="button"
        class={cols === 1 ? 'scene-card scene-card--1col' : 'scene-card'}
        aria-label={`${scene.name} 열기`}
        onClick={() => sheets.set({ sceneId: scene.id })}
      >
        <span
          class={contain ? 'thumb thumb--card is-contain' : 'thumb thumb--card'}
          style={contain ? { aspectRatio: ratio } : undefined}
        >
          {scene.latestImageId ? (
            <AuthImage
              cacheKey={`t:${scene.latestImageId}`}
              load={thumbLoader(scene.latestImageId)}
            />
          ) : (
            <span class="thumb__empty">
              <Icon name="image" size={26} />
            </span>
          )}
          {scene.pendingEdit && <span class="badge">편집 대기</span>}
        </span>
        <span class="scene-card__meta">
          <span class="scene-card__name">{scene.name}</span>
          <span class="scene-card__sub">
            그림 {scene.imageCount}장 · {scene.width}×{scene.height}
          </span>
        </span>
      </button>
    </li>
  )
}

export function ScenesTab({ active }: { active: boolean }) {
  const phone = useStore(app, (s) => s.phone)
  const presetId = useStore(app, (s) => s.presetId)
  const jobsVersion = useStore(app, (s) => s.jobsVersion)
  const entry = useStore(scenes, (s) => (presetId != null ? s.byPreset[presetId] : undefined))
  const exportPresetId = useStore(sheets, (s) => s.exportPresetId)
  const anyPending = !!entry?.items.some((s) => s.pendingEdit)

  const [folderCat, setFolderCat] = useState<PresetFolderCategory>('전체')
  const [cols, setCols] = useState<1 | 2 | 3 | 4>(() => {
    const saved = Number(readPref('sceneCols'))
    return saved === 1 || saved === 2 || saved === 3 || saved === 4 ? saved : 2
  })
  const [contain, setContain] = useState<boolean>(() => readPref('sceneFit') !== 'cover')

  const changeCols = (n: 1 | 2 | 3 | 4): void => {
    setCols(n)
    writePref('sceneCols', String(n))
  }
  const toggleContain = (): void => {
    setContain((prev) => {
      const next = !prev
      writePref('sceneFit', next ? 'contain' : 'cover')
      return next
    })
  }

  // 탭이 보일 때·프리셋이 바뀔 때·작업이 진행될 때 (그림 수·최신 그림이 바뀜) 다시 받는다
  useEffect(() => {
    if (active && presetId != null) void loadScenes(presetId, { silent: true })
  }, [active, presetId, jobsVersion])

  // PC 가 편집을 반영하면 「편집 대기」 표시가 사라진다 — 대기 중에만 가끔 확인
  useEffect(() => {
    if (!active || !anyPending || presetId == null) return
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void loadScenes(presetId, { silent: true })
    }, 6000)
    return () => clearInterval(t)
  }, [active, anyPending, presetId])

  const allPresets = phone?.library?.presets ?? []
  const filteredPresets = useMemo(() => {
    if (folderCat === '전체') return allPresets
    return allPresets.filter((p) => classifyPresetFolder(p.name, p.kind) === folderCat)
  }, [allPresets, folderCat])

  const catCounts = useMemo(() => {
    const counts: Record<PresetFolderCategory, number> = {
      전체: allPresets.length,
      단독: 0,
      남캐: 0,
      여캐: 0,
      '후타×후타': 0,
      '배경·기타': 0
    }
    for (const p of allPresets) {
      counts[classifyPresetFolder(p.name, p.kind)]++
    }
    return counts
  }, [allPresets])

  if (!phone) return null
  const library = phone.library
  if (!library || library.presets.length === 0) {
    return (
      <EmptyState
        title="PC가 아직 데이터를 올리지 않았습니다"
        body="PC에서 NAIS3를 켜 두면 씬 목록이 여기에 나타납니다."
      >
        <button type="button" class="btn" onClick={() => void refreshState()}>
          <Icon name="refresh" size={18} />
          다시 확인
        </button>
      </EmptyState>
    )
  }
  if (presetId == null) return <Loading />

  const selectCategory = (cat: PresetFolderCategory): void => {
    setFolderCat(cat)
    const list =
      cat === '전체'
        ? library.presets
        : library.presets.filter((p) => classifyPresetFolder(p.name, p.kind) === cat)
    if (list.length > 0 && !list.some((p) => p.id === presetId)) {
      const sorted = [...list].sort((a, b) => a.sortOrder - b.sortOrder)
      setPreset(sorted[0].id)
    }
  }

  return (
    <div class="stack">
      <div class="chips chips--scroll" role="group" aria-label="프리셋 폴더 분류">
        {PRESET_FOLDER_CATEGORIES.map((cat) => {
          const count = catCounts[cat]
          if (cat !== '전체' && count === 0) return null
          const on = folderCat === cat
          return (
            <button
              key={cat}
              type="button"
              class={on ? 'chip is-on' : 'chip'}
              aria-pressed={on}
              onClick={() => selectCategory(cat)}
            >
              📁 {cat} ({count})
            </button>
          )
        })}
      </div>

      <PresetSelect
        presets={filteredPresets.length > 0 ? filteredPresets : library.presets}
        value={presetId}
        onChange={setPreset}
      />

      <div class="view-toolbar" role="group" aria-label="보기 방식 및 폴더 저장">
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
            title="잘림 없이 전체 비율로 보기"
          >
            {contain ? '전체 비율' : '꽉 채움'}
          </button>
        </div>
        <button
          type="button"
          class="chip chip--sm"
          onClick={() => {
            void loadDriveIndex({ silent: true })
            sheets.set({ exportPresetId: presetId })
          }}
        >
          <Icon name="folder" size={14} />
          폴더 저장
        </button>
      </div>

      {!entry || (!entry.loaded && !entry.error) ? (
        <Loading />
      ) : entry.error && !entry.loaded ? (
        <ErrorState message={entry.error} onRetry={() => void loadScenes(presetId)} />
      ) : entry.items.length === 0 ? (
        <EmptyState title="표시할 씬이 없습니다" body="이 프리셋에는 씬이 없습니다." />
      ) : (
        <ul class={`scene-grid scene-grid--cols-${cols}`}>
          {entry.items.map((scene) => (
            <SceneCard key={scene.id} scene={scene} contain={contain} cols={cols} />
          ))}
        </ul>
      )}

      {exportPresetId != null && (
        <ExportPresetToDriveSheet
          presetId={exportPresetId}
          presetName={
            library.presets.find((p) => p.id === exportPresetId)?.name ?? `프리셋 #${exportPresetId}`
          }
          onClose={() => sheets.set({ exportPresetId: null })}
        />
      )}
    </div>
  )
}

/** 프리셋 그림들을 PC 폴더의 하위 폴더로 바로 분류·저장하는 시트 */
export function ExportPresetToDriveSheet({
  presetId,
  presetName,
  onClose
}: {
  presetId: number
  presetName: string
  onClose: () => void
}) {
  const index = useStore(drive, (s) => s.index)
  const loading = useStore(drive, (s) => s.loading)
  const [curPath, setCurPath] = useState('')
  const [search, setSearch] = useState('')
  const [newFolderName, setNewFolderName] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!index && !loading) void loadDriveIndex()
  }, [index, loading])

  // PC 색인({ path, dirs, imgs })을 화면이 쓰는 폴더 모양으로 — 계산은 lib/drive.ts
  const tree = useMemo(() => (index ? buildDriveTree(index) : null), [index])
  const subFolders = useMemo(() => {
    if (!tree) return []
    return search.trim() ? searchDriveFolders(tree, search, 60) : driveSubFolders(tree, curPath)
  }, [tree, curPath, search])

  const breadcrumbs = curPath ? curPath.split('/') : []

  async function createSubFolder(): Promise<void> {
    const trimmed = newFolderName.trim()
    if (!trimmed || busy) return
    const targetPath = curPath ? `${curPath}/${trimmed}` : trimmed
    setBusy(true)
    try {
      const ok = await sendControl(
        pcControl.makeDriveFolder(targetPath),
        `새 폴더 생성 요청: ${targetPath}`
      )
      if (ok) {
        setNewFolderName('')
        setCurPath(targetPath)
      }
    } finally {
      setBusy(false)
    }
  }

  async function exportHere(targetPath: string): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      const ok = await sendControl(
        pcControl.exportPresetToDrive(presetId, targetPath),
        `「${presetName}」 그림들을 「${targetPath || '루트 폴더'}」로 번호화 저장했습니다`
      )
      if (ok) onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet title={`폴더 분류·저장 — ${presetName}`} onClose={onClose}>
      <div class="stack">
        <div class="callout">
          <div class="muted">연결된 PC 폴더</div>
          <b>
            📁 {index?.rootName || 'PC 폴더'} {curPath ? `/ ${curPath}` : '(최상위)'}
          </b>
        </div>

        <div class="chips chips--scroll" role="navigation" aria-label="폴더 경로">
          <button
            type="button"
            class={curPath === '' ? 'chip is-on' : 'chip'}
            onClick={() => setCurPath('')}
          >
            🏠 최상위
          </button>
          {breadcrumbs.map((part, idx) => {
            const sub = breadcrumbs.slice(0, idx + 1).join('/')
            const on = sub === curPath
            return (
              <button
                key={sub}
                type="button"
                class={on ? 'chip is-on' : 'chip'}
                onClick={() => setCurPath(sub)}
              >
                {part}
              </button>
            )
          })}
        </div>

        <div class="field-row">
          <input
            class="input"
            type="search"
            placeholder="폴더 이름 검색"
            value={search}
            onInput={(e) => setSearch((e.currentTarget as HTMLInputElement).value)}
          />
        </div>

        <button
          type="button"
          class="btn btn--primary btn--block"
          disabled={busy}
          onClick={() => void exportHere(curPath)}
        >
          <Icon name="save" size={18} />
          현재 폴더({curPath || '최상위'})에 번호화 저장 (001.png~)
        </button>

        <div class="field-row">
          <input
            class="input"
            type="text"
            placeholder="여기에 새 하위 폴더 만들기..."
            value={newFolderName}
            onInput={(e) => setNewFolderName((e.currentTarget as HTMLInputElement).value)}
          />
          <button
            type="button"
            class="btn"
            disabled={!newFolderName.trim() || busy}
            onClick={() => void createSubFolder()}
          >
            <Icon name="folderPlus" size={18} />
            생성
          </button>
        </div>

        {loading && !index ? (
          <Loading />
        ) : subFolders.length === 0 ? (
          <p class="muted">하위 폴더가 없습니다. 바로 위 버튼으로 현재 폴더에 저장하거나 새 폴더를 만드세요.</p>
        ) : (
          <ul class="rows">
            {subFolders.map((f) => (
              <li key={f.path} class="row">
                <button
                  type="button"
                  class="drive-folder-btn"
                  onClick={() => {
                    setCurPath(f.path)
                    setSearch('')
                  }}
                >
                  <Icon name="folder" size={18} />
                  <span class="drive-folder-btn__text">
                    <span class="row__title">{search ? f.path : f.name}</span>
                    <span class="row__sub">
                      하위 폴더 {f.childDirs.length}개 · 그림 {f.imageCount}장
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  class="chip"
                  disabled={busy}
                  onClick={() => void exportHere(f.path)}
                >
                  여기에 저장
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Sheet>
  )
}
