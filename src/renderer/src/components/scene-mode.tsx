import {
  ArrowRight,
  CalendarPlus,
  CalendarX,
  ChevronDown,
  Cloud,
  CloudOff,
  Copy,
  FileDown,
  FileUp,
  FolderArchive,
  FolderDown,
  FolderOpen,
  Hash,
  ImageOff,
  Images as ImageIcon,
  Loader2,
  Minus,
  MoreVertical,
  Pencil,
  Plus,
  RectangleHorizontal,
  RectangleVertical,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Star,
  Trash2,
  UserPlus,
  Users,
  X
} from 'lucide-react'
import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent
} from '@dnd-kit/core'
import { arrayMove, rectSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable'
import { AnimatePresence, motion } from 'motion/react'
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties
} from 'react'
import type { R2SyncConfig, Scene, ScenePreset } from '@shared/types'
import { RESOLUTIONS, imageUrl } from '../lib/constants'
import { useGenerationStore } from '../stores/generation-store'
import { useScenesStore } from '../stores/scenes-store'
import { useSceneExtrasStore, hasAddition } from '../stores/scene-extras-store'
import { useResolutionsStore } from '../stores/resolutions-store'
import { askConfirm, askText } from '../stores/dialog-store'
import { toast } from '../stores/toast-store'
import { cn } from '../lib/utils'
import { ResolutionPicker } from './resolution-picker'
import { R2SyncDialog } from './r2-sync-dialog'
import { SceneDetail } from './scene-detail'
import { AdditionDialog, SequenceDialog } from './scene-extras-dialogs'
import { SortableList, SortableRow } from './sortable-list'
import { Button } from './ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuPortal,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from './ui/context-menu'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Switch } from './ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

export function SceneMode(): React.JSX.Element {
  const scenes = useScenesStore((s) => s.scenes)
  const selectedId = useScenesStore((s) => s.selectedId)
  const loadPresets = useScenesStore((s) => s.loadPresets)
  const loadExtras = useSceneExtrasStore((s) => s.load)

  useEffect(() => {
    void loadPresets()
    void loadExtras()
  }, [loadPresets, loadExtras])

  const selected = scenes.find((s) => s.id === selectedId) ?? null
  if (selected) return <SceneDetail scene={selected} />
  return <SceneGrid />
}

/** NAIS2식 프리셋 드롭다운 — 현재 프리셋 표시 + 전환/추가/이름변경/삭제 */
function syncTargetLabel(config?: R2SyncConfig): string {
  if (!config?.bucket) return ''
  const prefix = config.prefix.replace(/\/$/, '')
  return prefix ? `${config.bucket}/${prefix}` : `${config.bucket}/(루트)`
}

function PresetDropdown(): React.JSX.Element {
  const presets = useScenesStore((s) => s.presets)
  const activePresetId = useScenesStore((s) => s.activePresetId)
  const setActivePreset = useScenesStore((s) => s.setActivePreset)
  const createPreset = useScenesStore((s) => s.createPreset)
  const renamePreset = useScenesStore((s) => s.renamePreset)
  const deletePreset = useScenesStore((s) => s.deletePreset)
  const reorderPresets = useScenesStore((s) => s.reorderPresets)
  const duplicatePreset = useScenesStore((s) => s.duplicatePreset)
  const setPresetDefaultResolution = useScenesStore((s) => s.setPresetDefaultResolution)
  const [open, setOpen] = useState(false)
  const [syncTarget, setSyncTarget] = useState<ScenePreset | null>(null)
  const [syncConfigs, setSyncConfigs] = useState<Record<number, R2SyncConfig>>({})

  const active = presets.find((p) => p.id === activePresetId)
  const activeSyncConfig = active ? syncConfigs[active.id] : undefined

  const refreshSyncConfigs = useCallback(async (): Promise<void> => {
    try {
      const entries = await Promise.all(
        presets.map(async (preset) => {
          const config = await window.nais.invoke('r2sync:getConfig', { presetId: preset.id })
          return [preset.id, config] as const
        })
      )
      setSyncConfigs(Object.fromEntries(entries))
    } catch (error) {
      toast(
        `모듈별 클플 연결 정보를 불러오지 못했습니다: ${error instanceof Error ? error.message : error}`,
        'error'
      )
    }
  }, [presets])

  useEffect(() => {
    void refreshSyncConfigs()
  }, [refreshSyncConfigs])

  const openSyncSettings = (preset: ScenePreset): void => {
    setOpen(false)
    setSyncTarget(preset)
  }

  const setSyncEnabled = async (presetId: number, enabled: boolean): Promise<void> => {
    const current = syncConfigs[presetId]
    if (!current) return
    const next = { ...current, enabled }
    setSyncConfigs((configs) => ({ ...configs, [presetId]: next }))
    try {
      await window.nais.invoke('r2sync:setConfig', { presetId, config: next })
    } catch (error) {
      void refreshSyncConfigs()
      toast(
        `클플 동기화 설정을 바꾸지 못했습니다: ${error instanceof Error ? error.message : error}`,
        'error'
      )
    }
  }

  // 프리셋 선택 + 닫기 — 닫기를 먼저 (선택의 store 재렌더가 끼어들기 전에 확정) (B9)
  const choose = (id: number): void => {
    setOpen(false)
    void setActivePreset(id)
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            className="flex h-8 min-w-52 items-center gap-1.5 rounded-md border border-line bg-paper px-2.5 text-[13px] font-medium hover:bg-surface-2 max-[1000px]:min-w-40"
            title={
              activeSyncConfig?.bucket
                ? `클플 ${activeSyncConfig.enabled ? '연결됨' : '동기화 꺼짐'} · ${syncTargetLabel(activeSyncConfig)}`
                : undefined
            }
          >
            <span className="min-w-0 flex-1 truncate text-left">{active?.name ?? '프리셋'}</span>
            {activeSyncConfig?.bucket && (
              <Cloud
                size={12}
                className={cn('shrink-0', activeSyncConfig.enabled ? 'text-accent' : 'text-faint')}
              />
            )}
            {active && (
              <span className="shrink-0 rounded-full bg-accent/12 px-2 py-0.5 text-[12px] font-medium text-accent">
                씬 {active.sceneCount ?? 0}
              </span>
            )}
            <ChevronDown size={14} className="shrink-0 text-muted" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-1">
          <div className="max-h-64 overflow-y-auto overflow-x-hidden no-scrollbar">
            {/* 드래그로 순서 변경 */}
            <SortableList
              ids={presets.map((p) => p.id)}
              onReorder={(ids) => void reorderPresets(ids)}
            >
              {presets.map((p) => {
                const syncConfig = syncConfigs[p.id]
                const targetLabel = syncTargetLabel(syncConfig)
                return (
                  <SortableRow
                    key={p.id}
                    id={p.id}
                    className="group gap-1"
                    onTap={() => choose(p.id)}
                  >
                    <ContextMenu>
                      <ContextMenuTrigger asChild>
                        <div className="flex min-w-0 flex-1 items-center gap-1">
                          <div
                            onClick={() => choose(p.id)}
                            className={cn(
                              'flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]',
                              p.id === activePresetId && 'font-semibold text-accent'
                            )}
                          >
                            <div className="min-w-0 flex-1">
                              <span className="block truncate">{p.name}</span>
                              {targetLabel && (
                                <span
                                  className={cn(
                                    'mt-0.5 flex min-w-0 items-center gap-1 truncate text-[10.5px] font-normal',
                                    syncConfig.enabled ? 'text-accent' : 'text-faint'
                                  )}
                                  title={targetLabel}
                                >
                                  <Cloud size={10} className="shrink-0" />
                                  <span className="truncate">{targetLabel}</span>
                                </span>
                              )}
                            </div>
                            {/* 프리셋별 씬 개수 (커스텀) */}
                            <span
                              className={cn(
                                'shrink-0 rounded-full px-2 py-0.5 text-[12px] font-medium',
                                p.id === activePresetId
                                  ? 'bg-accent/15 text-accent'
                                  : 'bg-surface-2 text-muted'
                              )}
                            >
                              씬 {p.sceneCount ?? 0}
                            </span>
                          </div>
                          <button
                            className="shrink-0 rounded p-1 text-faint opacity-0 hover:text-fg group-hover:opacity-100"
                            onClick={async () => {
                              const name = await askText('프리셋 이름', p.name)
                              if (name) void renamePreset(p.id, name)
                            }}
                            title="이름 변경"
                          >
                            <Pencil size={12} />
                          </button>
                          {/* 모듈 복제 — 씬 전부 포함, 클플 연결은 안전상 복제하지 않음 */}
                          <button
                            className="shrink-0 rounded p-1 text-faint opacity-0 hover:text-fg group-hover:opacity-100"
                            onClick={() => {
                              setOpen(false)
                              void duplicatePreset(p.id)
                            }}
                            title="모듈 복제 (씬 전부 포함, 클플 연결 제외)"
                          >
                            <Copy size={12} />
                          </button>
                          {presets.length > 1 && (
                            <button
                              className="shrink-0 rounded p-1 text-faint opacity-0 hover:text-danger group-hover:opacity-100"
                              onClick={async () => {
                                if (
                                  await askConfirm('프리셋 삭제', {
                                    message: `"${p.name}" 프리셋과 그 안의 씬을 모두 삭제합니다.`,
                                    confirmLabel: '삭제',
                                    danger: true
                                  })
                                )
                                  void deletePreset(p.id)
                              }}
                              title="삭제"
                            >
                              <Trash2 size={12} />
                            </button>
                          )}
                        </div>
                      </ContextMenuTrigger>
                      <ContextMenuContent className="w-64">
                        {targetLabel && (
                          <>
                            <div
                              className="truncate px-3 py-1 font-mono text-[10.5px] text-faint"
                              title={targetLabel}
                            >
                              {targetLabel}
                            </div>
                            <ContextMenuSeparator />
                          </>
                        )}
                        <ContextMenuItem onSelect={() => openSyncSettings(p)}>
                          <Cloud size={13} />
                          {targetLabel ? '클플 폴더 변경…' : '클플 폴더 연결…'}
                        </ContextMenuItem>
                        <ContextMenuItem
                          disabled={!syncConfig?.enabled || !syncConfig.bucket}
                          onSelect={() => void window.nais.invoke('r2sync:run', { presetId: p.id })}
                        >
                          <RefreshCw size={13} /> 지금 동기화
                        </ContextMenuItem>
                        {targetLabel && (
                          <>
                            <ContextMenuSeparator />
                            <ContextMenuItem
                              onSelect={() => void setSyncEnabled(p.id, !syncConfig.enabled)}
                            >
                              {syncConfig.enabled ? <CloudOff size={13} /> : <Cloud size={13} />}
                              자동 동기화 {syncConfig.enabled ? '끄기' : '켜기'}
                            </ContextMenuItem>
                          </>
                        )}
                      </ContextMenuContent>
                    </ContextMenu>
                  </SortableRow>
                )
              })}
            </SortableList>
          </div>
          <div className="my-1 h-px bg-line" />
          {/* 활성 프리셋의 새 씬 기본 해상도 (N3) */}
          {active && (
            <div className="flex items-center gap-2 px-2 py-1.5 text-[12px] text-muted">
              <span className="shrink-0">새 씬 기본 해상도</span>
              <div className="flex-1" />
              <ResolutionPicker
                className="w-40"
                width={active.defaultWidth ?? 832}
                height={active.defaultHeight ?? 1216}
                onPick={(w, h) => void setPresetDefaultResolution(active.id, w, h)}
              />
            </div>
          )}
          {active && (
            <button
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-muted hover:bg-surface-2 hover:text-ink"
              onClick={() => {
                if (active) openSyncSettings(active)
              }}
            >
              <Cloud size={14} /> 클플 즐겨찾기 동기화…
            </button>
          )}
          <div className="my-1 h-px bg-line" />
          <button
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-accent hover:bg-surface-2"
            onClick={async () => {
              const name = await askText('새 프리셋 이름', '새 프리셋')
              if (name) void createPreset(name)
            }}
          >
            <Plus size={14} /> 새 프리셋
          </button>
        </PopoverContent>
      </Popover>
      {syncTarget && (
        <R2SyncDialog
          presetId={syncTarget.id}
          presetName={syncTarget.name}
          open
          onOpenChange={(nextOpen) => {
            if (nextOpen) return
            setSyncTarget(null)
            void refreshSyncConfigs()
          }}
        />
      )}
    </>
  )
}

/** 아이콘 버튼 + 툴팁 */
function IconBtn({
  icon,
  tip,
  active,
  onClick
}: {
  icon: React.ReactNode
  tip: string
  active?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          className={cn(
            'grid size-8 shrink-0 place-items-center rounded-md transition-colors',
            active ? 'bg-accent text-white' : 'text-muted hover:bg-surface-2 hover:text-fg'
          )}
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  )
}

// 씬 그리드 스크롤 위치 — 다른 페이지/씬 상세를 다녀와도 위치 복원 (언마운트돼도 유지)
let savedGridScroll = 0

/** 여러 씬에 연속 번호를 붙일 시작값을 묻는다. 선택/전체 번호 매기기에서 공용. */
async function askStartNumber(count: number): Promise<number | null> {
  const raw = await askText(
    `${count}개 씬 — 몇 번부터 시작할까요?`,
    '1',
    '예: 1 → 01, 02… / 100 → 100, 101…'
  )
  if (raw == null) return null
  const start = Number(raw.trim())
  if (!Number.isInteger(start) || start < 0) {
    toast('0 이상의 숫자를 입력하세요', 'info')
    return null
  }
  return start
}

function SceneGrid(): React.JSX.Element {
  const scenes = useScenesStore((s) => s.scenes)
  const activePresetId = useScenesStore((s) => s.activePresetId)
  const create = useScenesStore((s) => s.create)
  const editMode = useScenesStore((s) => s.editMode)
  const setEditMode = useScenesStore((s) => s.setEditMode)
  const selection = useScenesStore((s) => s.selection)
  const clearSelection = useScenesStore((s) => s.clearSelection)
  const columns = useScenesStore((s) => s.columns)
  const setColumns = useScenesStore((s) => s.setColumns)
  const cardOrientation = useScenesStore((s) => s.cardOrientation)
  const setCardOrientation = useScenesStore((s) => s.setCardOrientation)
  const adjustReserveAll = useScenesStore((s) => s.adjustReserveAll)
  const clearReserveAll = useScenesStore((s) => s.clearReserveAll)
  const reorder = useScenesStore((s) => s.reorder)
  // 새 씬 기본 해상도 (커스텀 — 툴바 노출용)
  const presets = useScenesStore((s) => s.presets)
  const setPresetDefaultResolution = useScenesStore((s) => s.setPresetDefaultResolution)
  const activePreset = presets.find((p) => p.id === activePresetId) ?? null
  const selectionActive = editMode || selection.size > 0

  // 커스텀 확장 (NAIS2 Custom): 큐 반복 / 씬별 캐릭터 추가
  const sequenceEnabled = useSceneExtrasStore((s) => s.sequenceEnabled)
  const setSequenceEnabled = useSceneExtrasStore((s) => s.setSequenceEnabled)
  const activeEntryCount = useSceneExtrasStore((s) => s.entries.filter((e) => e.enabled).length)
  const additionsEnabled = useSceneExtrasStore((s) => s.additionsEnabled)
  const setAdditionsEnabled = useSceneExtrasStore((s) => s.setAdditionsEnabled)
  const [sequenceDialogOpen, setSequenceDialogOpen] = useState(false)
  const [trashOpen, setTrashOpen] = useState(false)
  const [additionSceneIds, setAdditionSceneIds] = useState<number[] | null>(null)
  const [hideBulkBarForPainting, setHideBulkBarForPainting] = useState(false)

  // 스크롤 위치 복원 — 마운트 직후 + 씬 목록이 늦게 로드된 경우 한 번 더
  const scrollRef = useRef<HTMLDivElement>(null)
  const [gridWidth, setGridWidth] = useState(0)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const update = (): void => setGridWidth(el.clientWidth)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const effectiveColumns =
    gridWidth > 0 && gridWidth < 520
      ? 1
      : gridWidth > 0 && gridWidth < 780
        ? Math.min(columns, 2)
        : gridWidth > 0 && gridWidth < 1100
          ? Math.min(columns, 3)
          : columns
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = savedGridScroll
  }, [])
  useEffect(() => {
    const el = scrollRef.current
    if (el && savedGridScroll > 0 && el.scrollTop === 0) el.scrollTop = savedGridScroll
  }, [scenes.length])

  // Shift+왼쪽 드래그: 커서가 지나간 카드까지 목록 순서대로 연속 선택한다.
  // 전역 pointermove를 쓰므로 빠르게 드래그해 중간 카드를 건너뛰어도 selectRangeTo가 사이를 채운다.
  const paintCleanupRef = useRef<(() => void) | null>(null)
  const beginShiftSelection = useCallback((sceneId: number, pointerId: number): void => {
    paintCleanupRef.current?.()
    const initialState = useScenesStore.getState()
    // 처음 선택을 시작할 때만 작업 바 등장을 pointerup까지 미뤄 카드 위치를 고정한다.
    // 이미 작업 바가 보였다면 숨기지 않아 그리드가 위로 튀지 않게 한다.
    setHideBulkBarForPainting(!initialState.editMode && initialState.selection.size === 0)
    initialState.selectRangeTo(sceneId)
    const visited = new Set<number>([sceneId])
    const previousUserSelect = document.body.style.userSelect
    document.body.style.userSelect = 'none'
    let lastX = 0
    let lastY = 0
    let raf = 0

    const selectAt = (x: number, y: number): void => {
      const card = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-scene-id]')
      const id = Number(card?.dataset.sceneId)
      if (!Number.isInteger(id) || visited.has(id)) return
      visited.add(id)
      useScenesStore.getState().selectRangeTo(id)
    }

    const autoScroll = (): void => {
      const scroller = scrollRef.current
      if (scroller && lastY > 0) {
        const rect = scroller.getBoundingClientRect()
        let delta = 0
        if (lastY < rect.top + 44) delta = -20
        else if (lastY > rect.bottom - 44) delta = 20
        if (delta !== 0) {
          scroller.scrollTop += delta
          selectAt(lastX, lastY)
        }
      }
      raf = window.requestAnimationFrame(autoScroll)
    }

    const onMove = (e: PointerEvent): void => {
      if (e.pointerId !== pointerId || (e.buttons & 1) === 0) return
      lastX = e.clientX
      lastY = e.clientY
      selectAt(lastX, lastY)
    }
    const cleanup = (): void => {
      window.cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', cleanup)
      window.removeEventListener('pointercancel', cleanup)
      window.removeEventListener('blur', cleanup)
      document.body.style.userSelect = previousUserSelect
      setHideBulkBarForPainting(false)
      if (paintCleanupRef.current === cleanup) paintCleanupRef.current = null
    }
    paintCleanupRef.current = cleanup
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', cleanup)
    window.addEventListener('pointercancel', cleanup)
    window.addEventListener('blur', cleanup)
    raf = window.requestAnimationFrame(autoScroll)
  }, [])
  useEffect(() => () => paintCleanupRef.current?.(), [])

  // 드래그 재정렬 (5px 이동해야 시작 — 클릭과 구분).
  // DragOverlay 사용: 드래그 중엔 가벼운 클론이 커서를 따라가고 원본은 숨겨 프레임 저하 방지
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const [dragScene, setDragScene] = useState<Scene | null>(null)
  const onDragStart = (e: DragStartEvent): void => {
    setDragScene(scenes.find((s) => `scene-${s.id}` === e.active.id) ?? null)
  }
  const onDragEnd = (e: DragEndEvent): void => {
    setDragScene(null)
    const { active, over } = e
    if (!over || active.id === over.id) return
    const ids = scenes.map((s) => `scene-${s.id}`)
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from < 0 || to < 0) return
    void reorder(arrayMove(scenes, from, to).map((s) => s.id))
  }

  // 스트리밍: 현재 생성 중인 씬과 미리보기 프레임 (해당 씬 카드에만 전달)
  const previewPng = useGenerationStore((s) => s.previewPng)
  const generatingSceneId = useGenerationStore(
    (s) => s.queue?.items.find((i) => i.state === 'generating')?.request.sceneId ?? null
  )

  async function exportJson(): Promise<void> {
    await window.nais.invoke('scenes:exportJson', { presetId: activePresetId })
  }
  async function importJson(): Promise<void> {
    const { count } = await window.nais.invoke('scenes:importJson', { presetId: activePresetId })
    if (count > 0) {
      toast(`씬 ${count}개 가져옴`, 'success')
      void useScenesStore.getState().load()
    } else {
      toast('가져올 씬이 없습니다', 'info')
    }
  }
  async function assignAllSceneNumbers(): Promise<void> {
    if (scenes.length === 0) return
    const start = await askStartNumber(scenes.length)
    if (start == null) return
    await window.nais.invoke('scenes:assignExportNumbers', {
      ids: scenes.map((scene) => scene.id),
      start
    })
    await useScenesStore.getState().load()
    toast(
      `전체 ${scenes.length}개 씬에 화면 순서대로 번호 부여 (${String(start).padStart(2, '0')}부터)`,
      'success'
    )
  }
  async function clearAllSceneNumbers(): Promise<void> {
    if (scenes.length === 0) return
    await window.nais.invoke('scenes:assignExportNumbers', {
      ids: scenes.map((scene) => scene.id),
      start: null
    })
    await useScenesStore.getState().load()
    toast('현재 모듈의 씬 번호를 모두 제거했습니다', 'info')
  }
  async function exportZip(mode: 'favorites' | 'sceneTop'): Promise<void> {
    await window.nais.invoke('scenes:exportZip', { mode })
  }
  // ZIP — 현재 프리셋 전체 이미지 (씬 id 전체를 bulkExportZip으로)
  async function exportPresetZip(): Promise<void> {
    const ids = scenes.map((s) => s.id)
    if (ids.length === 0) {
      toast('내보낼 씬이 없습니다', 'info')
      return
    }
    await window.nais.invoke('scenes:bulkExportZip', { ids })
  }

  // 폴더로 내보내기 (커스텀) — 편집 모드 없이 상단 툴바에서 바로.
  // 현재 프리셋에서 이미지가 있는 씬 전부를 지정 폴더에 원본 그대로 싹 복사한다.
  const folderExport = useFolderExport()
  function exportAllToFolder(): void {
    void folderExport.run({ ids: scenes.filter((s) => (s.imageCount ?? 0) > 0).map((s) => s.id) })
  }

  // 씬 카드 우클릭 메뉴용 안정 콜백 (커스텀) — folderExport.run은 렌더마다 바뀌므로 ref로 감싸
  // SceneCard memo가 깨지지 않게 한다
  const clearSceneImages = useScenesStore((s) => s.clearSceneImages)
  const runExportRef = useRef(folderExport.run)
  useEffect(() => {
    runExportRef.current = folderExport.run
  })
  const onExportSceneFavorites = useCallback((id: number): void => {
    void runExportRef.current({ ids: [id], favoritesOnly: true })
  }, [])
  const onClearSceneImages = useCallback(
    async (id: number, name: string): Promise<void> => {
      if (
        await askConfirm('이미지 모두 삭제', {
          message: `"${name}" 씬의 생성 이미지를 모두 삭제합니다. (파일은 휴지통으로 이동)`,
          confirmLabel: '삭제',
          danger: true
        })
      )
        await clearSceneImages(id)
    },
    [clearSceneImages]
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-line bg-surface">
      {/* 툴바 — 한 행: 프리셋 드롭다운 + 아이콘(툴팁) */}
      <div className="no-scrollbar flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-2 py-1.5">
        <PresetDropdown />
        <div className="mx-1 h-5 w-px bg-line" />
        <IconBtn icon={<FileDown size={16} />} tip="JSON 내보내기" onClick={exportJson} />
        <IconBtn icon={<FileUp size={16} />} tip="JSON 불러오기" onClick={importJson} />
        <Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button
                  disabled={scenes.length === 0}
                  className="grid size-8 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-30"
                >
                  <Hash size={16} />
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>씬 번호 — 내보내기·클플 파일명</TooltipContent>
          </Tooltip>
          <PopoverContent align="start" className="w-64 p-1">
            <MenuItem
              icon={<Hash size={13} />}
              label="전체 씬 — 현재 순서대로 번호 매기기"
              onClick={() => void assignAllSceneNumbers()}
            />
            <MenuItem
              icon={<X size={13} />}
              label="전체 씬 번호 제거"
              onClick={() => void clearAllSceneNumbers()}
            />
          </PopoverContent>
        </Popover>
        <Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button className="grid size-8 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg">
                  <FolderDown size={16} />
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>이미지 내보내기</TooltipContent>
          </Tooltip>
          <PopoverContent align="start" className="w-64 p-1">
            {/* 폴더로 보내기 (커스텀) — ZIP 없이 지정 폴더에 원본 그대로 */}
            <p className="flex items-center gap-1.5 px-2 pb-0.5 pt-1 text-[11px] font-semibold text-muted">
              <FolderOpen size={12} /> 폴더로 보내기
            </p>
            <MenuItem
              icon={<ImageIcon size={13} />}
              label="현재 프리셋 전체 이미지"
              onClick={exportAllToFolder}
            />
            <MenuItem
              icon={<Star size={13} />}
              label="즐겨찾기 이미지"
              onClick={() => void folderExport.run({ mode: 'favorites' })}
            />
            <MenuItem
              icon={<ImageOff size={13} />}
              label="각 씬 최상단 이미지"
              onClick={() => void folderExport.run({ mode: 'sceneTop' })}
            />
            <div className="my-1 h-px bg-line" />
            {/* ZIP으로 보내기 */}
            <p className="flex items-center gap-1.5 px-2 pb-0.5 pt-1 text-[11px] font-semibold text-muted">
              <FolderArchive size={12} /> ZIP으로 보내기
            </p>
            <MenuItem
              icon={<ImageIcon size={13} />}
              label="현재 프리셋 전체 이미지"
              onClick={() => void exportPresetZip()}
            />
            <MenuItem
              icon={<Star size={13} />}
              label="즐겨찾기 이미지"
              onClick={() => void exportZip('favorites')}
            />
            <MenuItem
              icon={<ImageOff size={13} />}
              label="각 씬 최상단 이미지"
              onClick={() => void exportZip('sceneTop')}
            />
          </PopoverContent>
        </Popover>
        <IconBtn
          icon={<Pencil size={16} />}
          tip={selectionActive ? '선택 끝내기' : '편집/다중 선택 모드'}
          active={selectionActive}
          onClick={() => {
            if (selectionActive) {
              setEditMode(false)
              clearSelection()
            } else {
              setEditMode(true)
            }
          }}
        />
        {/* 휴지통 — 삭제한 씬 복원 (커스텀) */}
        <IconBtn
          icon={<Trash2 size={16} />}
          tip="휴지통 — 삭제한 씬 복원"
          onClick={() => {
            void useScenesStore.getState().loadTrash()
            setTrashOpen(true)
          }}
        />
        <div className="mx-1 h-5 w-px bg-line" />

        {/* 큐 반복: 캐릭터/레퍼런스 조합을 바꿔가며 예약 전체 반복 (NAIS2 Custom) */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className={cn(
                'flex h-8 items-center gap-1.5 rounded-md border px-2 transition-colors',
                sequenceEnabled ? 'border-accent/50 bg-accent/10' : 'border-line'
              )}
            >
              <Users size={14} className={sequenceEnabled ? 'text-accent' : 'text-muted'} />
              <Switch checked={sequenceEnabled} onCheckedChange={setSequenceEnabled} />
              <button
                className="grid size-6 place-items-center rounded text-muted transition-colors hover:bg-surface-2 hover:text-fg"
                onClick={() => setSequenceDialogOpen(true)}
              >
                <SlidersHorizontal size={13} />
              </button>
              {activeEntryCount > 0 && (
                <span className="grid h-4 min-w-4 place-items-center rounded-full bg-accent/15 px-1 text-[10px] font-semibold text-accent">
                  {activeEntryCount}
                </span>
              )}
            </div>
          </TooltipTrigger>
          <TooltipContent>캐릭터/레퍼런스 큐 반복</TooltipContent>
        </Tooltip>

        {/* 씬별 캐릭터 추가 (NAIS2 Custom) */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className={cn(
                'flex h-8 items-center gap-1.5 rounded-md border px-2 transition-colors',
                additionsEnabled ? 'border-accent/50 bg-accent/10' : 'border-line'
              )}
            >
              <UserPlus size={14} className={additionsEnabled ? 'text-accent' : 'text-muted'} />
              <Switch checked={additionsEnabled} onCheckedChange={setAdditionsEnabled} />
            </div>
          </TooltipTrigger>
          <TooltipContent>씬별 캐릭터 추가</TooltipContent>
        </Tooltip>

        <div className="min-w-4 flex-1" />

        {/* 새 씬 기본 해상도 (커스텀 — 프리셋 드롭다운에만 있던 걸 툴바로 노출).
            여기서 바꾸면 이후 "+ 씬 추가"로 만드는 씬이 이 해상도로 생성된다 */}
        {activePreset && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div>
                <ResolutionPicker
                  className="h-8 w-36"
                  width={activePreset.defaultWidth ?? 832}
                  height={activePreset.defaultHeight ?? 1216}
                  onPick={(w, h) => void setPresetDefaultResolution(activePreset.id, w, h)}
                />
              </div>
            </TooltipTrigger>
            <TooltipContent>새 씬 기본 해상도 — 씬 추가 시 이 해상도로 생성</TooltipContent>
          </Tooltip>
        )}
        <div className="mx-1 h-5 w-px bg-line" />

        <IconBtn
          icon={<CalendarPlus size={16} />}
          tip="전체 예약 +1"
          onClick={() => void adjustReserveAll(1)}
        />
        <IconBtn
          icon={<CalendarX size={16} />}
          tip="전체 예약 취소"
          onClick={() => void clearReserveAll()}
        />
        <div className="mx-1 h-5 w-px bg-line" />
        {/* 카드 비율: 세로/가로 (해상도와 무관하게 고정) */}
        <IconBtn
          icon={
            cardOrientation === 'portrait' ? (
              <RectangleVertical size={16} />
            ) : (
              <RectangleHorizontal size={16} />
            )
          }
          tip={cardOrientation === 'portrait' ? '세로 카드 (클릭: 가로)' : '가로 카드 (클릭: 세로)'}
          onClick={() =>
            setCardOrientation(cardOrientation === 'portrait' ? 'landscape' : 'portrait')
          }
        />
        {/* 열 수 (2~5) */}
        <div className="flex items-center gap-0.5 rounded-md bg-surface-2 p-0.5">
          {[2, 3, 4, 5].map((n) => (
            <button
              key={n}
              onClick={() => setColumns(n)}
              className={cn(
                'grid h-6 w-6 place-items-center rounded text-[12px] font-medium transition-colors',
                columns === n ? 'bg-paper text-ink shadow-sm' : 'text-muted hover:text-ink'
              )}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      <AnimatePresence initial={false}>
        {selectionActive && !hideBulkBarForPainting && (
          <motion.div
            key="bulkbar"
            className="overflow-hidden"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <BulkBar onOpenAddition={setAdditionSceneIds} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* 카드 그리드 (열 수만큼 폭에 꽉 차게). scrollbar-gutter로 스크롤바 등장 시 밀림 방지 */}
      <div
        ref={scrollRef}
        onScroll={(e) => {
          savedGridScroll = e.currentTarget.scrollTop
        }}
        className="min-h-0 flex-1 overflow-y-auto p-3 no-scrollbar"
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={onDragStart}
          onDragCancel={() => setDragScene(null)}
          onDragEnd={onDragEnd}
        >
          <SortableContext
            items={scenes.map((s) => `scene-${s.id}`)}
            strategy={rectSortingStrategy}
          >
            <div
              className="grid gap-3"
              style={{ gridTemplateColumns: `repeat(${effectiveColumns}, minmax(0, 1fr))` }}
            >
              {scenes.map((scene) => (
                <SceneCard
                  key={scene.id}
                  scene={scene}
                  live={scene.id === generatingSceneId ? previewPng : null}
                  generating={scene.id === generatingSceneId}
                  onOpenAddition={setAdditionSceneIds}
                  onExportFavorites={onExportSceneFavorites}
                  onClearImages={onClearSceneImages}
                  onBeginShiftSelection={beginShiftSelection}
                />
              ))}
              <button
                onClick={() => void create('새 씬')}
                className="flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-line text-faint transition hover:text-accent"
                style={{ aspectRatio: CARD_ASPECT[cardOrientation] }}
              >
                <Plus size={22} />
                <span className="text-[12px]">씬 추가</span>
              </button>
            </div>
          </SortableContext>
          {/* 드래그 중 커서를 따라가는 가벼운 클론 (원본은 숨김) */}
          <DragOverlay dropAnimation={null}>
            {dragScene && (
              <div
                className="relative overflow-hidden rounded-lg border border-accent bg-surface-2 shadow-2xl"
                style={{ aspectRatio: CARD_ASPECT[cardOrientation] }}
              >
                {dragScene.thumbnail ? (
                  <img
                    src={`data:image/webp;base64,${dragScene.thumbnail}`}
                    className="h-full w-full object-cover"
                    draggable={false}
                    alt=""
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-paper text-faint">
                    <ImageOff size={26} strokeWidth={1.3} />
                  </div>
                )}
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-2 pb-1.5 pt-6">
                  <div className="truncate text-[13px] font-semibold text-white drop-shadow">
                    {dragScene.name}
                  </div>
                </div>
              </div>
            )}
          </DragOverlay>
        </DndContext>
        {scenes.length === 0 && (
          <p className="mt-6 text-center text-[13px] text-faint">
            씬을 추가해 프롬프트와 해상도를 저장하고, +로 예약한 뒤 좌측 생성 버튼으로 뽑으세요.
          </p>
        )}
      </div>

      {/* 커스텀 확장 다이얼로그 (NAIS2 Custom) */}
      <SequenceDialog open={sequenceDialogOpen} onOpenChange={setSequenceDialogOpen} />
      <SceneTrashDialog open={trashOpen} onOpenChange={setTrashOpen} />
      <AdditionDialog
        presetId={activePresetId}
        sceneIds={additionSceneIds}
        sceneName={
          additionSceneIds && additionSceneIds.length === 1
            ? (scenes.find((s) => s.id === additionSceneIds[0])?.name ?? '')
            : additionSceneIds
              ? `씬 ${additionSceneIds.length}개`
              : ''
        }
        onClose={() => setAdditionSceneIds(null)}
      />
      {/* 폴더로 내보내기 이름 충돌 다이얼로그 (커스텀, 상단 툴바용) */}
      {folderExport.dialog}
    </div>
  )
}

/** 폴더 내보내기 대상 (커스텀). ids=씬들의 모든 이미지, mode=즐겨찾기/각 씬 최상단(전역) */
type FolderExportScope = {
  ids?: number[]
  mode?: 'favorites' | 'sceneTop'
  favoritesOnly?: boolean
}

/**
 * 폴더로 내보내기 로직 (커스텀) — 상단 툴바와 편집 모드에서 공유.
 * 선택 이미지(씬 ids 또는 즐겨찾기/각 씬 최상단)를 지정 폴더에 원본 그대로 복사한다.
 * 이름 충돌 시 미리보기 다이얼로그로 물어본다.
 */
function useFolderExport(): {
  run: (scope: FolderExportScope) => Promise<void>
  dialog: React.JSX.Element
} {
  type Conflict = { name: string; existingThumb: string; incomingThumb: string }
  const [conflict, setConflict] = useState<{
    scope: FolderExportScope
    dir: string
    items: Conflict[]
    total: number
  } | null>(null)

  const run = async (scope: FolderExportScope): Promise<void> => {
    if (!scope.mode && (scope.ids?.length ?? 0) === 0) {
      toast('내보낼 이미지가 없습니다', 'info')
      return
    }
    const res = await window.nais.invoke('scenes:exportToFolder', scope)
    if (res.canceled) return
    if (res.conflicts && res.conflicts.length > 0 && res.dir) {
      setConflict({ scope, dir: res.dir, items: res.conflicts, total: res.total ?? 0 })
      return
    }
    if ((res.copied ?? 0) === 0) {
      toast('내보낼 이미지가 없습니다', 'info')
      return
    }
    toast(`이미지 ${res.copied ?? 0}개 내보냄`, 'success')
  }

  const resolveConflict = async (policy: 'overwrite' | 'rename' | 'skip'): Promise<void> => {
    if (!conflict) return
    const { scope, dir } = conflict
    setConflict(null)
    const res = await window.nais.invoke('scenes:exportToFolder', { ...scope, dir, policy })
    toast(
      `이미지 ${res.copied ?? 0}개 내보냄${res.skipped ? ` · ${res.skipped}개 건너뜀` : ''}`,
      'success'
    )
  }

  const dialog = (
    <ExportConflictDialog
      data={conflict}
      onResolve={resolveConflict}
      onCancel={() => setConflict(null)}
    />
  )
  return { run, dialog }
}

/** 편집 모드 일괄 작업 바 */
function BulkBar({
  onOpenAddition
}: {
  onOpenAddition: (sceneIds: number[]) => void
}): React.JSX.Element {
  const selection = useScenesStore((s) => s.selection)
  const presets = useScenesStore((s) => s.presets)
  const activePresetId = useScenesStore((s) => s.activePresetId)
  const selectAll = useScenesStore((s) => s.selectAll)
  const clearSelection = useScenesStore((s) => s.clearSelection)
  const bulkMove = useScenesStore((s) => s.bulkMove)
  const bulkCopy = useScenesStore((s) => s.bulkCopy)
  const bulkDelete = useScenesStore((s) => s.bulkDelete)
  const bulkAdjustReserve = useScenesStore((s) => s.bulkAdjustReserve)
  const bulkClearReserve = useScenesStore((s) => s.bulkClearReserve)
  const bulkSetVariety = useScenesStore((s) => s.bulkSetVariety)
  const bulkDuplicate = useScenesStore((s) => s.bulkDuplicate)
  const bulkSetResolution = useScenesStore((s) => s.bulkSetResolution)
  const customResolutions = useResolutionsStore((s) => s.custom)
  const bulkClearFavorites = useScenesStore((s) => s.bulkClearFavorites)
  const bulkClearImages = useScenesStore((s) => s.bulkClearImages)
  const bulkExportZip = useScenesStore((s) => s.bulkExportZip)
  const bulkAssignNumbers = useScenesStore((s) => s.bulkAssignNumbers)

  const n = selection.size
  const disabled = n === 0

  // 내보내기 번호 매기기 (커스텀) — 시작 번호 입력 후 목록 순서대로 순번
  const assignNumbers = async (): Promise<void> => {
    const start = await askStartNumber(n)
    if (start == null) return
    await bulkAssignNumbers(start)
    toast(
      `선택한 ${n}개 씬에 화면 순서대로 번호 부여 (${String(start).padStart(2, '0')}부터)`,
      'success'
    )
  }

  // 폴더로 내보내기 — 충돌 있으면 미리보기 다이얼로그로 물어봄 (커스텀, 상단 툴바와 공유)
  const folderExport = useFolderExport()

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-line bg-surface-2 px-3 py-2 text-[13px]">
      <span className="font-medium text-fg">{n}개 선택</span>
      <Button size="sm" variant="ghost" onClick={selectAll}>
        전체 선택
      </Button>
      <Button size="sm" variant="ghost" onClick={clearSelection} disabled={disabled}>
        해제
      </Button>
      <div className="mx-1 h-4 w-px bg-line" />

      {/* 선택 예약 (커스텀) — 누를 때마다 선택 씬들만 배치 수 단위로 증감 */}
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={() => void bulkAdjustReserve(1)}
      >
        <CalendarPlus size={13} /> 예약 +
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={() => void bulkAdjustReserve(-1)}
      >
        <Minus size={13} /> 예약 −
      </Button>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void bulkClearReserve()}>
        <CalendarX size={13} /> 예약 취소
      </Button>
      {/* 씬별 variety+ 일괄 (커스텀) */}
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={() => void bulkSetVariety(true)}
      >
        <Sparkles size={13} /> V+ 적용
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={() => void bulkSetVariety(false)}
      >
        V+ 해제
      </Button>
      {/* 씬별 캐릭터 일괄 적용 (커스텀) — 선택한 씬 전체에 같은 추가 캐릭터/레퍼런스 설정 */}
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={() => onOpenAddition([...selection])}
      >
        <UserPlus size={13} /> 씬별 캐릭터
      </Button>
      {/* 일괄 복제 (커스텀) */}
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void bulkDuplicate()}>
        <Copy size={13} /> 복제
      </Button>
      <div className="mx-1 h-4 w-px bg-line" />

      {/* 다른 모듈로 — 이동(잘라내기) / 복사 분리 (커스텀) */}
      <Popover>
        <PopoverTrigger asChild>
          <Button size="sm" variant="ghost" disabled={disabled}>
            다른 모듈로
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-56 p-1">
          {presets.filter((p) => p.id !== activePresetId).length === 0 ? (
            <p className="px-2 py-1.5 text-[12px] text-faint">다른 프리셋 없음</p>
          ) : (
            <>
              <p className="flex items-center gap-1.5 px-2 pb-0.5 pt-1 text-[11px] font-semibold text-muted">
                <ArrowRight size={12} /> 이동 (원본에서 사라짐)
              </p>
              {presets
                .filter((p) => p.id !== activePresetId)
                .map((p) => (
                  <MenuItem key={`m-${p.id}`} label={p.name} onClick={() => void bulkMove(p.id)} />
                ))}
              <div className="my-1 h-px bg-line" />
              <p className="flex items-center gap-1.5 px-2 pb-0.5 pt-1 text-[11px] font-semibold text-muted">
                <Copy size={12} /> 복사 (원본 유지)
              </p>
              {presets
                .filter((p) => p.id !== activePresetId)
                .map((p) => (
                  <MenuItem
                    key={`c-${p.id}`}
                    label={p.name}
                    onClick={async () => {
                      const copied = await bulkCopy(p.id)
                      toast(`"${p.name}"에 씬 ${copied}개 복사됨`, 'success')
                    }}
                  />
                ))}
            </>
          )}
        </PopoverContent>
      </Popover>

      {/* 해상도 일괄 (기본 + 커스텀) */}
      <Select
        onValueChange={(v) => {
          const [w, h] = v.split('x').map(Number)
          if (w && h) void bulkSetResolution(w, h)
        }}
      >
        <SelectTrigger className="h-8 w-40" disabled={disabled}>
          <SelectValue placeholder="해상도 변경" />
        </SelectTrigger>
        <SelectContent>
          {[...RESOLUTIONS, ...customResolutions].map((r) => (
            <SelectItem key={r.label} value={`${r.width}x${r.height}`}>
              {r.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* 내보내기 번호 매기기 (커스텀) — 파일명이 01, 02… 번호로 나감 (클라우드 업로드용) */}
      <Popover>
        <PopoverTrigger asChild>
          <Button size="sm" variant="ghost" disabled={disabled}>
            <Hash size={13} /> 번호
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-60 p-1">
          <MenuItem
            icon={<Hash size={13} />}
            label="번호 매기기 — 목록 순서대로"
            onClick={() => void assignNumbers()}
          />
          <MenuItem
            icon={<X size={13} />}
            label="번호 제거 (씬 이름으로 내보냄)"
            onClick={async () => {
              await bulkAssignNumbers(null)
              toast('번호 제거됨', 'info')
            }}
          />
          <p className="px-2 py-1.5 text-[11px] leading-relaxed text-faint">
            번호가 있으면 내보내기 파일명이 01, 02… 번호만으로 나가고, 번호↔씬 이름 표
            (_이미지목록.md)가 함께 저장됩니다.
          </p>
        </PopoverContent>
      </Popover>
      {/* 폴더로 내보내기 (원본 파일 그대로) — 폴더 아이콘 유지 */}
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={() => void folderExport.run({ ids: [...selection] })}
      >
        <FolderOpen size={13} /> 폴더로
      </Button>
      {/* ZIP으로 내보내기 — 압축 아이콘 유지 */}
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void bulkExportZip()}>
        <FolderArchive size={13} /> ZIP
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={() => void bulkClearFavorites()}
      >
        즐겨찾기 해제
      </Button>
      {/* 이미지 비우기 — 전체 / 즐겨찾기 제외 선택 (커스텀) */}
      <Popover>
        <PopoverTrigger asChild>
          <Button size="sm" variant="ghost" disabled={disabled}>
            이미지 비우기
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-52 p-1">
          <MenuItem
            icon={<ImageOff size={13} />}
            label="전체 비우기"
            onClick={async () => {
              if (
                await askConfirm('이미지 비우기', {
                  message: `선택한 ${n}개 씬의 생성 이미지를 모두 삭제합니다. (파일은 휴지통으로)`,
                  confirmLabel: '비우기',
                  danger: true
                })
              )
                void bulkClearImages(false)
            }}
          />
          <MenuItem
            icon={<Star size={13} />}
            label="즐겨찾기 제외 비우기"
            onClick={async () => {
              if (
                await askConfirm('즐겨찾기 제외 비우기', {
                  message: `선택한 ${n}개 씬에서 즐겨찾기를 뺀 이미지만 삭제합니다. (파일은 휴지통으로)`,
                  confirmLabel: '비우기',
                  danger: true
                })
              )
                void bulkClearImages(true)
            }}
          />
        </PopoverContent>
      </Popover>
      <Button
        size="sm"
        variant="ghost"
        className="text-danger"
        disabled={disabled}
        onClick={async () => {
          if (
            await askConfirm('씬 삭제', {
              message: `선택한 ${n}개 씬을 삭제합니다.`,
              confirmLabel: '삭제',
              danger: true
            })
          )
            void bulkDelete()
        }}
      >
        <Trash2 size={13} /> 삭제
      </Button>

      {/* 폴더 내보내기 이름 충돌 다이얼로그 (커스텀) */}
      {folderExport.dialog}
    </div>
  )
}

/** 폴더 내보내기 시 이름이 겹치는 이미지들을 미리보기로 보여주고 처리 방법을 묻는다 (커스텀) */
function ExportConflictDialog({
  data,
  onResolve,
  onCancel
}: {
  data: {
    dir: string
    items: { name: string; existingThumb: string; incomingThumb: string }[]
    total: number
  } | null
  onResolve: (policy: 'overwrite' | 'rename' | 'skip') => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <Dialog open={data != null} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="flex max-h-[84vh] max-w-[720px] flex-col">
        <div className="border-b border-line px-4 py-3">
          <DialogTitle>이름이 겹치는 이미지가 있어요</DialogTitle>
          <DialogDescription className="mt-0.5">
            {data
              ? `${data.items.length}개가 대상 폴더의 기존 파일과 이름이 같습니다. 어떻게 할까요?`
              : ''}
          </DialogDescription>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
          {data?.items.map((c) => (
            <div
              key={c.name}
              className="flex items-center gap-3 rounded-lg border border-line bg-surface-2 p-2"
            >
              <ConflictThumb label="기존" thumb={c.existingThumb} />
              <ArrowRight size={16} className="shrink-0 text-faint" />
              <ConflictThumb label="내보낼 것" thumb={c.incomingThumb} accent />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-medium text-ink">{c.name}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            취소
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onResolve('skip')}>
            건너뛰기
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onResolve('rename')}>
            다른 이름으로 (둘 다 보관)
          </Button>
          <Button size="sm" variant="accent" onClick={() => onResolve('overwrite')}>
            덮어쓰기
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ConflictThumb({
  label,
  thumb,
  accent
}: {
  label: string
  thumb: string
  accent?: boolean
}): React.JSX.Element {
  return (
    <div className="shrink-0 text-center">
      <div
        className={cn(
          'size-16 overflow-hidden rounded-md border bg-paper',
          accent ? 'border-accent' : 'border-line'
        )}
      >
        {thumb ? (
          <img
            src={`data:image/webp;base64,${thumb}`}
            className="h-full w-full object-cover"
            alt=""
          />
        ) : (
          <div className="grid h-full w-full place-items-center text-faint">
            <ImageOff size={16} />
          </div>
        )}
      </div>
      <div className={cn('mt-0.5 text-[10.5px]', accent ? 'text-accent' : 'text-faint')}>
        {label}
      </div>
    </div>
  )
}

// 카드 비율은 해상도와 무관하게 고정 (혼합 해상도에서도 레이아웃 균일)
const CARD_ASPECT = { portrait: '832 / 1216', landscape: '1216 / 832' } as const

function dndStyle(sortable: ReturnType<typeof useSortable>): CSSProperties {
  const t = sortable.transform
  return {
    // 드래그되는 원본은 숨긴다 — 실제 이동은 DragOverlay 클론이 담당 (프레임 저하 방지)
    transform: t ? `translate3d(${Math.round(t.x)}px, ${Math.round(t.y)}px, 0)` : undefined,
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0 : undefined
  }
}

const SceneCard = memo(function SceneCard({
  scene,
  live,
  generating,
  onOpenAddition,
  onExportFavorites,
  onClearImages,
  onBeginShiftSelection
}: {
  scene: Scene
  live: string | null
  generating: boolean
  onOpenAddition: (sceneIds: number[]) => void
  onExportFavorites: (id: number) => void
  onClearImages: (id: number, name: string) => void
  onBeginShiftSelection: (sceneId: number, pointerId: number) => void
}): React.JSX.Element {
  const editMode = useScenesStore((s) => s.editMode)
  const cardOrientation = useScenesStore((s) => s.cardOrientation)
  const selection = useScenesStore((s) => s.selection)
  const toggleSelected = useScenesStore((s) => s.toggleSelected)
  const selectRangeTo = useScenesStore((s) => s.selectRangeTo)
  const select = useScenesStore((s) => s.select)
  const update = useScenesStore((s) => s.update)
  const duplicate = useScenesStore((s) => s.duplicate)
  const remove = useScenesStore((s) => s.remove)
  const adjustReserve = useScenesStore((s) => s.adjustReserve)
  const presets = useScenesStore((s) => s.presets)
  const activePresetId = useScenesStore((s) => s.activePresetId)
  const selectionActive = editMode || selection.size > 0
  // Shift/Ctrl 제스처는 아래 pointerdown에서 따로 가로채고, 일반 드래그는 편집 중에도 재정렬에 쓴다.
  // 여러 씬이 선택된 상태만 잠가 "선택 전체 이동"으로 오해하지 않게 한다.
  const sortable = useSortable({ id: `scene-${scene.id}`, disabled: selection.size > 1 })

  // 씬별 캐릭터 추가 (NAIS2 Custom) — 선택 합계 배지
  const additionsEnabled = useSceneExtrasStore((s) => s.additionsEnabled)
  const addition = useSceneExtrasStore((s) => s.additions[scene.presetId]?.[scene.id])
  const additionCount = hasAddition(addition)
    ? addition.characterIds.length + addition.charRefIds.length + addition.vibeIds.length
    : 0

  // 생성 중 이 씬의 남은 개수 (메인 큐 pending+generating) — NAIS2처럼 배지가 줄어들며 표시.
  // 큐 반복 사용 시 항목×예약 전체가 반영된다.
  const queueRemaining = useGenerationStore(
    (s) =>
      s.queue?.items.filter(
        (i) => (i.state === 'pending' || i.state === 'generating') && i.request.sceneId === scene.id
      ).length ?? 0
  )
  const badgeCount = scene.reserveCount + queueRemaining

  const checked = selection.has(scene.id)
  // 이미지 우선순위: 생성 중 스트리밍 > 저장 썸네일(가벼움, 드래그 렉 방지) > 원본 > 없음.
  // 카드는 작게 표시되므로 640 webp 썸네일이면 충분히 선명하고, 풀해상도 대신 써서 드래그가 부드럽다.
  const src = live
    ? `data:image/png;base64,${live}`
    : scene.thumbnail
      ? `data:image/webp;base64,${scene.thumbnail}`
      : scene.thumbnailPath
        ? imageUrl(scene.thumbnailPath)
        : null

  // 우클릭 메뉴/3-dot 공용 액션
  const renameScene = async (): Promise<void> => {
    const name = await askText('씬 이름', scene.name)
    if (name) void update(scene.id, { name })
  }
  const openFolder = async (): Promise<void> => {
    const { ok } = await window.nais.invoke('scenes:openFolder', { sceneId: scene.id })
    if (!ok) toast('아직 생성된 이미지 폴더가 없습니다', 'info')
  }
  // 선택된 카드를 우클릭하면 편집 모드 여부와 무관하게 선택 전체에 적용 (탐색기 방식).
  const multi = selection.has(scene.id) && selection.size > 1
  const multiN = selection.size
  const otherPresets = presets.filter((p) => p.id !== activePresetId)
  const suppressShiftClickRef = useRef(false)

  const editSingleSceneNumber = async (): Promise<void> => {
    const raw = await askText(
      `"${scene.name}" 번호 수정`,
      scene.exportNo == null ? '' : String(scene.exportNo),
      '0 이상의 숫자 · 비우면 번호 제거'
    )
    if (raw == null) return
    const trimmed = raw.trim()
    const number = trimmed === '' ? null : Number(trimmed)
    if (number !== null && (!Number.isInteger(number) || number < 0)) {
      toast('0 이상의 숫자를 입력하세요', 'info')
      return
    }
    await window.nais.invoke('scenes:assignExportNumbers', {
      ids: [scene.id],
      start: number
    })
    await useScenesStore.getState().load()
    toast(number == null ? '씬 번호 제거됨' : `씬 번호를 ${number}번으로 변경했습니다`, 'success')
  }

  const editContextSceneNumbers = async (): Promise<void> => {
    const state = useScenesStore.getState()
    if (state.selection.has(scene.id) && state.selection.size > 1) {
      const start = await askStartNumber(state.selection.size)
      if (start == null) return
      await state.bulkAssignNumbers(start)
      toast(
        `선택한 ${state.selection.size}개 씬에 화면 순서대로 번호 부여 (${String(start).padStart(2, '0')}부터)`,
        'success'
      )
      return
    }
    await editSingleSceneNumber()
  }

  const duplicateScenes = (): void => {
    const state = useScenesStore.getState()
    if (state.selection.has(scene.id)) void state.bulkDuplicate()
    else void duplicate(scene.id)
  }

  const removeScene = async (): Promise<void> => {
    if (
      await askConfirm('씬 삭제', {
        message: multi ? `선택한 ${multiN}개 씬을 삭제합니다.` : `"${scene.name}" 씬을 삭제합니다.`,
        confirmLabel: '삭제',
        danger: true
      })
    ) {
      const state = useScenesStore.getState()
      if (state.selection.has(scene.id)) void state.bulkDelete()
      else void remove(scene.id)
    }
  }

  const transferScenes = async (presetId: number, mode: 'move' | 'copy'): Promise<void> => {
    const state = useScenesStore.getState()
    // 3점 메뉴 등으로 선택 없이 호출된 경우에도 이 카드 한 장을 대상으로 맞춘다.
    if (!state.selection.has(scene.id)) {
      state.clearSelection()
      state.toggleSelected(scene.id)
    }
    const count = useScenesStore.getState().selection.size
    if (mode === 'move') {
      await useScenesStore.getState().bulkMove(presetId)
      toast(`씬 ${count}개 이동됨`, 'success')
    } else {
      const copied = await useScenesStore.getState().bulkCopy(presetId)
      if (copied > 0) toast(`씬 ${copied}개 복사됨`, 'success')
    }
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={sortable.setNodeRef}
          {...sortable.attributes}
          {...sortable.listeners}
          data-scene-id={scene.id}
          title={
            selection.size > 1
              ? '다중 선택을 끝낸 뒤 드래그하면 순서를 바꿀 수 있습니다'
              : '클릭해서 열기 · 드래그해서 순서 변경'
          }
          className={cn(
            'group relative touch-none overflow-hidden rounded-lg border bg-surface-2 transition',
            selectionActive && checked ? 'border-accent ring-2 ring-accent/40' : 'border-line',
            sortable.isDragging && 'shadow-xl'
          )}
          style={{ aspectRatio: CARD_ASPECT[cardOrientation], ...dndStyle(sortable) }}
          onPointerDown={(e) => {
            if (e.button === 0 && e.shiftKey) {
              suppressShiftClickRef.current = true
              e.preventDefault()
              e.stopPropagation()
              onBeginShiftSelection(scene.id, e.pointerId)
              return
            }
            // Ctrl/Cmd는 개별 선택 제스처다. click에서 토글하되 dnd-kit에는 넘기지 않는다.
            if (e.button === 0 && (e.ctrlKey || e.metaKey)) return
            // 위의 spread를 덮어썼으므로 일반 상태에서는 dnd-kit 리스너를 직접 전달한다.
            sortable.listeners?.onPointerDown?.(e)
          }}
          onContextMenu={(e) => {
            if (checked) return // 선택된 카드 우클릭은 현재 다중 선택을 그대로 유지
            if (e.shiftKey) {
              selectRangeTo(scene.id)
            } else {
              if (!e.ctrlKey && !e.metaKey) useScenesStore.getState().clearSelection()
              useScenesStore.getState().toggleSelected(scene.id)
            }
          }}
          onClick={(e) => {
            if (e.shiftKey && suppressShiftClickRef.current) {
              suppressShiftClickRef.current = false
              return
            }
            suppressShiftClickRef.current = false
            if (e.shiftKey) {
              selectRangeTo(scene.id)
            } else if (e.ctrlKey || e.metaKey || selectionActive) {
              toggleSelected(scene.id)
            } else {
              select(scene.id)
            }
          }}
        >
          {/* 배경 이미지 (생성 중이면 스트리밍 프리뷰) */}
          {src ? (
            <img
              src={src}
              className="h-full w-full cursor-pointer object-cover"
              draggable={false}
              alt=""
            />
          ) : (
            <div className="flex h-full w-full cursor-pointer items-center justify-center bg-paper text-faint">
              <ImageOff size={26} strokeWidth={1.3} />
            </div>
          )}

          {/* 생성 준비 중(프리뷰 뜨기 전) 스피너 */}
          {generating && !live && (
            <div className="absolute inset-0 grid place-items-center bg-black/40">
              <Loader2 size={28} className="animate-spin text-white" strokeWidth={2} />
            </div>
          )}

          {/* 예약 수 + 생성 중 남은 수 — 좌측 상단 붉은 원 (생성이 진행되며 줄어든다) */}
          {badgeCount > 0 && (
            <span className="absolute left-1.5 top-1.5 grid h-6 min-w-6 place-items-center rounded-full bg-danger px-1.5 text-[12px] font-bold text-white shadow">
              {badgeCount}
            </span>
          )}

          {/* 씬별 variety+ 적용 표시 (커스텀) */}
          {scene.varietyPlus && (
            <span
              className={cn(
                'absolute top-1.5 flex h-6 items-center gap-0.5 rounded-full bg-violet-500/85 px-1.5 text-[10px] font-bold text-white shadow',
                badgeCount > 0 ? 'left-9' : 'left-1.5'
              )}
              title="이 씬은 Variety+가 적용됩니다"
            >
              <Sparkles size={10} /> V+
            </span>
          )}

          {/* 씬별 캐릭터 추가 버튼 — 기능이 켜져 있으면 항상 표시. 선택 있음=강조색, 없음=반투명 */}
          {additionsEnabled && !editMode && (
            <button
              className={cn(
                'absolute left-1.5 z-10 flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-semibold shadow transition',
                badgeCount > 0 || scene.varietyPlus ? 'top-9' : 'top-1.5',
                additionCount > 0
                  ? 'bg-accent text-white hover:bg-accent/85'
                  : 'bg-black/60 text-white/90 hover:bg-black/80'
              )}
              onClick={(e) => {
                e.stopPropagation()
                onOpenAddition([scene.id])
              }}
              onPointerDown={(e) => e.stopPropagation()}
              title="이 씬에만 추가 적용할 캐릭터/레퍼런스 선택"
            >
              <UserPlus size={14} />
              {additionCount > 0 ? `캐릭터 ${additionCount}` : '캐릭터+'}
            </button>
          )}

          {/* 우측 상단 — 편집 모드 체크박스 / 일반 3점 메뉴 */}
          {selectionActive ? (
            <span
              className={cn(
                'absolute right-1.5 top-1.5 grid size-5 place-items-center rounded border-2 transition',
                checked ? 'border-accent bg-accent text-white' : 'border-white/80 bg-black/30'
              )}
            >
              {checked && <span className="text-[11px] leading-none">✓</span>}
            </span>
          ) : (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-full bg-black/55 text-white opacity-0 transition hover:bg-black/70 group-hover:opacity-100"
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <MoreVertical size={14} />
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-40 p-1" onClick={(e) => e.stopPropagation()}>
                <MenuItem
                  icon={<Pencil size={13} />}
                  label="이름 변경"
                  onClick={() => void renameScene()}
                />
                <MenuItem
                  icon={<Copy size={13} />}
                  label="복제"
                  onClick={() => void duplicate(scene.id)}
                />
                <MenuItem
                  icon={<FolderOpen size={13} />}
                  label="폴더 열기"
                  onClick={() => void openFolder()}
                />
                <MenuItem
                  icon={<Trash2 size={13} />}
                  label="삭제"
                  danger
                  onClick={() => void removeScene()}
                />
              </PopoverContent>
            </Popover>
          )}

          {/* 하단 그라디언트 + 이름 + 예약 +/- */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-2 pb-1.5 pt-6">
            <div className="pointer-events-auto flex items-end justify-between gap-1">
              <div className="min-w-0">
                {editMode ? (
                  <input
                    className="w-full truncate rounded bg-white/15 px-1 py-0.5 text-[13px] font-medium text-white outline-none placeholder:text-white/50 focus:bg-white/25"
                    value={scene.name}
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onChange={(e) => void update(scene.id, { name: e.target.value })}
                  />
                ) : (
                  <div className="truncate text-[13px] font-semibold text-white drop-shadow">
                    {scene.name}
                  </div>
                )}
                {/* 이미지 장수 + 내보내기 번호 (커스텀) */}
                {(scene.imageCount > 0 || scene.exportNo != null) && (
                  <div className="mt-1 flex items-center gap-1">
                    {scene.exportNo != null && (
                      <button
                        className="inline-flex items-center rounded-full bg-accent/85 px-2 py-0.5 font-mono text-[12px] font-bold text-white drop-shadow transition hover:bg-accent"
                        title="클릭해서 씬 번호 수정"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation()
                          void editSingleSceneNumber()
                        }}
                      >
                        {String(scene.exportNo).padStart(2, '0')}
                      </button>
                    )}
                    {scene.imageCount > 0 && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[12px] font-medium text-white drop-shadow">
                        <ImageIcon size={12} />
                        {scene.imageCount}장
                      </span>
                    )}
                  </div>
                )}
              </div>
              {/* 예약 +/- */}
              <div
                className="flex shrink-0 items-center gap-0.5 rounded-full bg-black/55 p-0.5"
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <button
                  className="grid size-5 place-items-center rounded-full text-white hover:bg-white/20 disabled:opacity-30"
                  // 생성 중엔 큐 대기분 취소가 가능해야 하므로 합산 기준 (커스텀)
                  disabled={scene.reserveCount + queueRemaining === 0}
                  onClick={() => void adjustReserve(scene.id, -1)}
                >
                  <Minus size={13} />
                </button>
                <span className="min-w-4 text-center text-[12px] font-medium text-white">
                  {scene.reserveCount}
                </span>
                <button
                  className="grid size-5 place-items-center rounded-full text-white hover:bg-white/20"
                  onClick={() => void adjustReserve(scene.id, 1)}
                >
                  <Plus size={13} />
                </button>
              </div>
            </div>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => void renameScene()}>
          <Pencil size={13} /> 이름 변경
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void editContextSceneNumbers()}>
          <Hash size={13} />
          {multi ? `선택 순서대로 번호 매기기 (${multiN}개)` : '씬 번호 수정·제거'}
        </ContextMenuItem>
        <ContextMenuItem onSelect={duplicateScenes}>
          <Copy size={13} /> 복제{multi ? ` (${multiN}개)` : ''}
        </ContextMenuItem>
        {otherPresets.length > 0 && (
          <>
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <ArrowRight size={13} /> 이동·잘라내기{multi ? ` (${multiN}개)` : ''}
              </ContextMenuSubTrigger>
              <ContextMenuPortal>
                <ContextMenuSubContent sideOffset={2} alignOffset={-5}>
                  {otherPresets.map((p) => (
                    <ContextMenuItem
                      key={`move-${p.id}`}
                      onSelect={() => void transferScenes(p.id, 'move')}
                    >
                      {p.name}
                    </ContextMenuItem>
                  ))}
                </ContextMenuSubContent>
              </ContextMenuPortal>
            </ContextMenuSub>
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <Copy size={13} /> 다른 모듈로 복사{multi ? ` (${multiN}개)` : ''}
              </ContextMenuSubTrigger>
              <ContextMenuPortal>
                <ContextMenuSubContent sideOffset={2} alignOffset={-5}>
                  {otherPresets.map((p) => (
                    <ContextMenuItem
                      key={`copy-${p.id}`}
                      onSelect={() => void transferScenes(p.id, 'copy')}
                    >
                      {p.name}
                    </ContextMenuItem>
                  ))}
                </ContextMenuSubContent>
              </ContextMenuPortal>
            </ContextMenuSub>
          </>
        )}
        <ContextMenuItem onSelect={() => void openFolder()}>
          <FolderOpen size={13} className="text-amber-400" /> 폴더 열기
        </ContextMenuItem>
        {additionsEnabled && (
          <ContextMenuItem onSelect={() => onOpenAddition([scene.id])}>
            <UserPlus size={13} /> 씬별 캐릭터 추가
          </ContextMenuItem>
        )}
        <ContextMenuItem
          onSelect={() => void update(scene.id, { varietyPlus: !scene.varietyPlus })}
        >
          <Sparkles size={13} className={scene.varietyPlus ? 'text-violet-400' : undefined} />
          Variety+ {scene.varietyPlus ? '끄기' : '켜기'}
        </ContextMenuItem>
        {scene.imageCount > 0 && (
          <>
            <ContextMenuSeparator />
            {/* 이 씬의 즐겨찾기 이미지만 폴더로 내보내기 (커스텀) */}
            <ContextMenuItem onSelect={() => onExportFavorites(scene.id)}>
              <Star size={13} className="text-amber-400" /> 즐겨찾기 이미지 내보내기
            </ContextMenuItem>
            {/* 이 씬의 생성 이미지 모두 삭제 (커스텀) */}
            <ContextMenuItem danger onSelect={() => onClearImages(scene.id, scene.name)}>
              <ImageOff size={13} /> 이미지 모두 삭제
            </ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem danger onSelect={() => void removeScene()}>
          <Trash2 size={13} /> 씬 삭제{multi ? ` (${multiN}개)` : ''}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
})

function MenuItem({
  icon,
  label,
  onClick,
  danger
}: {
  icon?: React.ReactNode
  label: string
  onClick: () => void
  danger?: boolean
}): React.JSX.Element {
  return (
    <button
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-surface-2',
        danger && 'text-danger'
      )}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  )
}

/** 씬 휴지통 — 삭제한 씬을 되살리거나 영구 삭제 (커스텀). 보관 기간은 설정 가능 */
function SceneTrashDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const trashed = useScenesStore((s) => s.trashed)
  const restoreScenes = useScenesStore((s) => s.restoreScenes)
  const purgeScenes = useScenesStore((s) => s.purgeScenes)
  const [retention, setRetention] = useState('30')

  useEffect(() => {
    if (!open) return
    void window.nais.invoke('settings:get', { key: 'trash_retention_days' }).then(({ value }) => {
      if (value) setRetention(value)
    })
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[82vh] max-w-[720px] flex-col">
        <div className="border-b border-line px-4 py-3">
          <DialogTitle className="flex items-center gap-2">
            <Trash2 size={15} /> 휴지통
          </DialogTitle>
          <DialogDescription className="mt-0.5">
            삭제한 씬을 되살릴 수 있습니다.
            {retention === '0'
              ? ' 자동 삭제 없이 계속 보관합니다.'
              : ` ${retention}일이 지나면 자동으로 영구 삭제됩니다.`}
          </DialogDescription>
        </div>
        {/* 보관 기간 설정 (커스텀) */}
        <div className="flex items-center gap-2 border-b border-line px-4 py-2">
          <span className="text-[12px] text-muted">보관 기간</span>
          <Select
            value={retention}
            onValueChange={(v) => {
              setRetention(v)
              void window.nais.invoke('settings:set', { key: 'trash_retention_days', value: v })
            }}
          >
            <SelectTrigger className="h-7 w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">7일</SelectItem>
              <SelectItem value="30">30일</SelectItem>
              <SelectItem value="90">90일</SelectItem>
              <SelectItem value="0">무제한</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {trashed.length === 0 ? (
            <p className="py-10 text-center text-[13px] text-faint">휴지통이 비어 있습니다</p>
          ) : (
            <div className="space-y-1.5">
              {trashed.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center gap-3 rounded-lg border border-line bg-surface-2 p-2"
                >
                  <div className="size-12 shrink-0 overflow-hidden rounded-md bg-paper">
                    {s.thumbnail ? (
                      <img
                        src={`data:image/webp;base64,${s.thumbnail}`}
                        className="h-full w-full object-cover"
                        alt=""
                      />
                    ) : (
                      <div className="grid h-full w-full place-items-center text-faint">
                        <ImageOff size={16} />
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-ink">{s.name}</div>
                    <div className="truncate text-[11px] text-faint">
                      {s.presetName && `${s.presetName} · `}
                      이미지 {s.imageCount}장
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => void restoreScenes([s.id])}>
                    <RotateCcw size={13} /> 복원
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-danger"
                    onClick={async () => {
                      if (
                        await askConfirm('영구 삭제', {
                          message: `"${s.name}"을(를) 영구 삭제합니다. 이미지 파일은 OS 휴지통으로 이동합니다.`,
                          confirmLabel: '영구 삭제',
                          danger: true
                        })
                      )
                        void purgeScenes([s.id])
                    }}
                  >
                    <Trash2 size={13} />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
        {trashed.length > 0 && (
          <div className="flex justify-end gap-2 border-t border-line px-4 py-2.5">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void restoreScenes(trashed.map((s) => s.id))}
            >
              <RotateCcw size={13} /> 전체 복원
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-danger"
              onClick={async () => {
                if (
                  await askConfirm('휴지통 비우기', {
                    message: `휴지통의 씬 ${trashed.length}개를 영구 삭제합니다. 이미지 파일은 OS 휴지통으로 이동합니다.`,
                    confirmLabel: '비우기',
                    danger: true
                  })
                )
                  void purgeScenes(trashed.map((s) => s.id))
              }}
            >
              <Trash2 size={13} /> 휴지통 비우기
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
