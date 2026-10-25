import { SceneBackgroundDialog } from './scene-background-dialog'
import { BackgroundUseDialog } from './background-use-dialog'
import { normalizeCensors } from '@shared/censor-tags'
import { CensorStatus, SceneCensorDialog } from './scene-censor-dialog'
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpToLine,
  CalendarPlus,
  CalendarX,
  ChevronDown,
  ChevronUp,
  ClipboardPaste,
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
  Layers,
  LayoutGrid,
  List,
  Loader2,
  Minus,
  MoreVertical,
  Pencil,
  Plus,
  RectangleHorizontal,
  RectangleVertical,
  RefreshCw,
  RotateCcw,
  Scissors,
  Search,
  SlidersHorizontal,
  ShieldCheck,
  Shirt,
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
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent
} from '@dnd-kit/core'
import {
  rectSortingStrategy,
  SortableContext,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { dropBlock, sameOrder } from '@shared/scene-order'
import { nudeStripLabel, type NudeStripSetting } from '@shared/nude-strip'
import { AnimatePresence, motion } from 'motion/react'
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from 'react'
import type { CharRole, CharRoles, R2SyncConfig, Scene, ScenePreset } from '@shared/types'
import { modelCaps } from '@shared/nai-models'
import { RESOLUTIONS, imageUrl } from '../lib/constants'
import {
  anchoredScrollTop,
  findSceneMatches,
  gridKeyAllowed,
  isRestoreEcho,
  parseSavedScrolls,
  resolveFindCurrent,
  sceneLabel,
  sceneScrollKey,
  scrollTopForThumb,
  serializeSavedScrolls,
  stepMatch,
  thumbMetrics,
  topSceneIndex,
  topSceneIndexBy,
  type KeyZone,
  type ScrollAnchor,
  type ThumbMetrics
} from '../lib/scene-nav'
import { useGenerationStore } from '../stores/generation-store'
import { useScenesStore } from '../stores/scenes-store'
import { formatCombo, useShortcutsStore } from '../stores/shortcuts-store'
import { useSceneExtrasStore, hasAddition } from '../stores/scene-extras-store'
import { useCharactersStore } from '../stores/characters-store'
import { useOutfitsStore } from '../stores/outfits-store'
import { useResolutionsStore } from '../stores/resolutions-store'
import { askConfirm, askText } from '../stores/dialog-store'
import { toast } from '../stores/toast-store'
import { cn } from '../lib/utils'
import { ResolutionPicker } from './resolution-picker'
import { R2SyncDialog } from './r2-sync-dialog'
import { NudeStripMenu } from './nude-strip-menu'
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

export function SceneMode({
  kind = 'scene'
}: {
  kind?: 'scene' | 'background'
}): React.JSX.Element {
  const scenes = useScenesStore((s) => s.scenes)
  const selectedId = useScenesStore((s) => s.selectedId)
  const activateLibrary = useScenesStore((s) => s.activateLibrary)
  const libraryKind = useScenesStore((s) => s.libraryKind)
  const loading = useScenesStore((s) => s.libraryLoading)
  const [error, setError] = useState('')
  const loadExtras = useSceneExtrasStore((s) => s.load)

  useEffect(() => {
    void activateLibrary(kind).catch((e) => setError(String(e)))
    void loadExtras()
  }, [activateLibrary, kind, loadExtras])

  if (error)
    return (
      <div role="alert" className="p-4 text-danger">
        {error}
      </div>
    )
  if (loading || libraryKind !== kind)
    return <div className="p-4 text-muted">목록을 불러오는 중…</div>

  const selected = scenes.find((s) => s.id === selectedId) ?? null
  if (selected) return <SceneDetail scene={selected} />
  return <SceneGrid />
}

/** 파일에서 온 역할 맵의 빈 값(null)을 걷어 씬별 설정 모양으로 */
function stripNullRoles(roles?: Record<number, CharRole | null>): CharRoles | undefined {
  if (!roles) return undefined
  const out: CharRoles = {}
  for (const [id, role] of Object.entries(roles)) if (role) out[Number(id)] = role
  return out
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
                {active.kind === 'background' ? '배경' : '씬'} {active.sceneCount ?? 0}
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
                              {p.kind === 'background' ? '배경' : '씬'} {p.sceneCount ?? 0}
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
                                    message: `"${p.name}" 프리셋과 그 안의 씬을 휴지통으로 옮깁니다.`,
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
  disabled,
  onClick
}: {
  icon: React.ReactNode
  tip: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          aria-label={tip}
          disabled={disabled}
          className={cn(
            'grid size-8 shrink-0 place-items-center rounded-md transition-colors disabled:opacity-30',
            active ? 'bg-accent text-white' : 'text-muted hover:bg-surface-2 hover:text-fg',
            disabled && 'pointer-events-none'
          )}
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  )
}

// 씬 격자 스크롤 위치 — 「라이브러리 종류:프리셋 id」별로 기억한다. 다른 페이지·씬 상세를 다녀와도,
// 프리셋을 바꿨다 돌아와도, 앱을 다시 켜도 그 프리셋에서 보던 자리로 돌아온다
// (언마운트돼도 남게 모듈 변수에 두고 localStorage에 디바운스로 저장).
// px 만 적으면 보기(카드 ↔ 이름 목록)·열 수·카드 비율·창 폭이 바뀐 뒤 다른 씬을 가리키므로
// 「화면 맨 위 씬 id + 그 카드 위쪽과의 오프셋」을 적고 scrollTop 은 보조로만 둔다
const SCROLL_STORAGE_KEY = 'scene_grid_scroll'
const SCROLL_SAVE_DELAY = 400
const savedScrolls: Record<string, ScrollAnchor> = readSavedScrolls()
let scrollSaveTimer: number | undefined

function readSavedScrolls(): Record<string, ScrollAnchor> {
  try {
    return parseSavedScrolls(localStorage.getItem(SCROLL_STORAGE_KEY))
  } catch {
    return {}
  }
}

function flushSavedScrolls(): void {
  window.clearTimeout(scrollSaveTimer)
  scrollSaveTimer = undefined
  try {
    localStorage.setItem(SCROLL_STORAGE_KEY, serializeSavedScrolls(savedScrolls))
  } catch {
    /* 저장소를 못 쓰면 이번 실행 동안만 기억한다 */
  }
}

// top 이 0 이하(맨 위)면 기본값이라 기억값을 지운다
function rememberScroll(key: string, anchor: ScrollAnchor): void {
  if (anchor.top > 0) savedScrolls[key] = anchor
  else delete savedScrolls[key]
  window.clearTimeout(scrollSaveTimer)
  scrollSaveTimer = window.setTimeout(flushSavedScrolls, SCROLL_SAVE_DELAY)
}

// 격자 바깥 여백(p-3). 화면 맨 위 씬을 가를 때, 이 간격 이하로만 걸친 카드는 지나간 것으로 본다
const GRID_PAD = 12

/** 격자 안 카드들의 씬 id와 아래 끝(스크롤 내용 좌표) — 화면 순서 */
function measureCards(scroller: HTMLElement): { ids: number[]; bottoms: number[] } {
  const base = scroller.getBoundingClientRect().top - scroller.scrollTop
  const ids: number[] = []
  const bottoms: number[] = []
  scroller.querySelectorAll<HTMLElement>('[data-scene-id]').forEach((el) => {
    ids.push(Number(el.dataset.sceneId))
    bottoms.push(el.getBoundingClientRect().bottom - base)
  })
  return { ids, bottoms }
}

/**
 * 지금 화면 맨 위에 오는 씬과 그 카드 위쪽의 오프셋, 보조 scrollTop.
 * scroll 이벤트마다 부르므로 카드를 전부 재지 않고 이분 탐색으로 몇 장만 잰다.
 */
function captureScroll(scroller: HTMLElement): ScrollAnchor {
  const top = scroller.scrollTop
  const cards = scroller.querySelectorAll<HTMLElement>('[data-scene-id]')
  if (cards.length === 0) return { id: null, offset: 0, top }
  const scrollerTop = scroller.getBoundingClientRect().top
  const base = scrollerTop - top
  const index = topSceneIndexBy(
    cards.length,
    (i) => cards[i].getBoundingClientRect().bottom - base,
    top + GRID_PAD
  )
  const card = cards[index]
  return {
    id: Number(card.dataset.sceneId),
    offset: card.getBoundingClientRect().top - scrollerTop,
    top
  }
}

/** 지금 화면 맨 위에 오는 씬의 id (없으면 null) */
function topSceneId(scroller: HTMLElement): number | null {
  return captureScroll(scroller).id
}

/**
 * 기억해 둔 자리로 되돌린다 — 그 씬 카드가 있으면 카드 위쪽을 저장한 오프셋에 맞추고(보기·열 수·창 폭이
 * 달라도 같은 씬), 없으면(지워졌거나 옛 형식) 보조 scrollTop 으로. 기억값이 없으면 맨 위.
 */
function restoreScroll(scroller: HTMLElement, saved: ScrollAnchor | undefined): void {
  const card =
    saved?.id != null ? scroller.querySelector<HTMLElement>(`[data-scene-id="${saved.id}"]`) : null
  if (saved && card) {
    const rect = card.getBoundingClientRect()
    scroller.scrollTop = anchoredScrollTop(
      scroller.scrollTop,
      rect.top,
      scroller.getBoundingClientRect().top,
      rect.height,
      saved.offset,
      GRID_PAD
    )
  } else scroller.scrollTop = saved?.top ?? 0
}

/** 글자를 치는 칸에 있는가 */
function isTextEntry(target: EventTarget | null): boolean {
  const el = target instanceof HTMLElement ? target : null
  if (!el) return false
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
}

/** 대화상자·메뉴·목록 상자가 열려 있는가 — 격자 키 이동과 찾기 Esc 를 접어 둘 때 */
function overlayOpen(): boolean {
  return (
    document.querySelector(
      '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'
    ) != null
  )
}

/** 글자를 치는 칸에 있거나, 대화상자·메뉴·목록 상자가 열려 있는가 — 격자 키 이동을 접어 둘 때 */
function keysBelongElsewhere(target: EventTarget | null): boolean {
  return isTextEntry(target) || overlayOpen()
}

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
  const isBackground = useScenesStore((s) => s.libraryKind === 'background')
  const [useBackground, setUseBackground] = useState<Scene | null>(null)
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
  const gridView = useScenesStore((s) => s.gridView)
  const setGridView = useScenesStore((s) => s.setGridView)
  const libraryKind = useScenesStore((s) => s.libraryKind)
  const findBinding = useShortcutsStore((s) => s.bindings.findScene)
  const adjustReserveAll = useScenesStore((s) => s.adjustReserveAll)
  const clearReserveAll = useScenesStore((s) => s.clearReserveAll)
  const gridClipboard = useScenesStore((s) => s.sceneClipboard)
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
  const [backgroundSceneIds, setBackgroundSceneIds] = useState<number[] | null>(null)
  const [censorSceneIds, setCensorSceneIds] = useState<number[] | null>(null)
  const [additionSceneIds, setAdditionSceneIds] = useState<number[] | null>(null)
  const [hideBulkBarForPainting, setHideBulkBarForPainting] = useState(false)

  // 스크롤 위치 복원 — 마운트 직후, 프리셋을 바꾼 뒤, 씬 목록이 늦게 로드된 경우에 한 번씩
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [gridWidth, setGridWidth] = useState(0)
  useLayoutEffect(() => {
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
  // 프리셋을 바꾸면 activePresetId가 먼저 바뀌고 새 씬 목록은 조금 뒤에 온다. 그 사이의 옛 목록과
  // 클램프로 생기는 scroll 이벤트가 새 열쇠 자리를 덮어쓰지 않게, 목록이 활성 프리셋 것일 때만
  // 복원하고 기록한다 (shownScrollKeyRef = 지금 화면에 자리를 맞춰 둔 열쇠)
  const scrollKey = sceneScrollKey(libraryKind, activePresetId)
  const scenesReady = scenes.length > 0 && scenes[0].presetId === activePresetId
  const shownScrollKeyRef = useRef<string | null>(null)
  // 복원해 둔 scrollTop — 복원이 일으킨 scroll 이벤트(요청과 다르게 잘린 값 포함)가 기억값을 덮어쓰지 못하게,
  // 이 자리와 같은 이벤트는 건너뛰고 사용자가 움직여 다른 자리가 되면 풀린다
  const restoredTopRef = useRef<number | null>(null)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (!scenesReady || gridWidth === 0) {
      shownScrollKeyRef.current = null
      restoredTopRef.current = null
      return
    }
    if (shownScrollKeyRef.current === scrollKey) return
    shownScrollKeyRef.current = scrollKey
    restoreScroll(el, savedScrolls[scrollKey])
    restoredTopRef.current = el.scrollTop
  }, [scrollKey, scenesReady, gridWidth])
  useEffect(() => {
    window.addEventListener('beforeunload', flushSavedScrolls)
    return () => {
      window.removeEventListener('beforeunload', flushSavedScrolls)
      flushSavedScrolls()
    }
  }, [])

  // 보기(카드 ↔ 이름 목록)를 바꿔도 보던 씬이 화면 맨 위에 남게 — 바꾸기 직전의 맨 위 씬을 적어 둔다
  const viewAnchorRef = useRef<number | null>(null)
  const toggleGridView = (): void => {
    const el = scrollRef.current
    viewAnchorRef.current = el ? topSceneId(el) : null
    setGridView(gridView === 'card' ? 'row' : 'card')
  }
  useLayoutEffect(() => {
    const id = viewAnchorRef.current
    viewAnchorRef.current = null
    const el = scrollRef.current
    const card = id == null ? null : el?.querySelector<HTMLElement>(`[data-scene-id="${id}"]`)
    if (!el || !card) return
    el.scrollTop += card.getBoundingClientRect().top - el.getBoundingClientRect().top - GRID_PAD
  }, [gridView])

  // 씬 찾기 — 목록은 거르지 않고(순서 맥락 유지) 일치 카드로 가서 강조한다
  // 현재 일치는 순번이 아니라 씬 id 로 들고 있다 — 씬이 지워지거나 끌려 가거나 이름이 바뀌어
  // 일치 목록이 달라져도, 보던 카드가 조작 없이 다른 씬으로 옮겨 가지 않게
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findId, setFindId] = useState<number | null>(null)
  const [findFocusTick, setFindFocusTick] = useState(0)
  const findInputRef = useRef<HTMLInputElement>(null)
  const matches = useMemo(
    () => (findOpen ? findSceneMatches(scenes, findQuery) : []),
    [findOpen, scenes, findQuery]
  )
  // 새 목록에서의 현재 순번(0부터). 목록 맞춤 효과가 돌기 전의 한 번(그려지지 않음)은 0으로 둔다
  const matchPos = Math.max(0, findId == null ? 0 : matches.indexOf(findId))
  const foundId = findId != null && matches.includes(findId) ? findId : null
  const revealScene = useCallback((id: number): void => {
    scrollRef.current
      ?.querySelector<HTMLElement>(`[data-scene-id="${id}"]`)
      ?.scrollIntoView({ block: 'center' })
  }, [])
  const openFind = useCallback((): void => {
    setFindOpen(true)
    setFindFocusTick((tick) => tick + 1)
  }, [])
  const closeFind = useCallback((): void => {
    setFindOpen(false)
    setFindQuery('')
    setFindId(null)
  }, [])
  const changeFindQuery = (value: string): void => {
    setFindQuery(value)
    const first = findSceneMatches(scenes, value)[0] ?? null
    setFindId(first)
    if (first != null) revealScene(first)
  }
  const stepFind = (step: 1 | -1): void => {
    if (matches.length === 0) return
    const next = matches[stepMatch(matches.length, matchPos, step)]
    setFindId(next)
    revealScene(next)
  }
  // 씬 목록이 바뀌어 일치가 달라지면 현재 일치를 맞춘다: 그 id 가 아직 일치면 그대로(순번만 따라감),
  // 없어졌으면 그 자리 뒤의 일치(없으면 첫 일치)로 옮기고 그때만 화면을 옮긴다.
  // 프리셋·라이브러리가 바뀌면 새 목록이 올 때 처음부터(첫 일치, 화면은 기억해 둔 자리 그대로).
  // 레이아웃 효과라 어긋난 한 번은 화면에 그려지지 않는다
  const findOrderRef = useRef<number[]>([])
  const findScopeRef = useRef(scrollKey)
  useLayoutEffect(() => {
    // 프리셋을 바꾸는 중 — 옛 목록이 남아 있는 동안은 기다린다 (빈 목록은 그대로 빈 일치로 본다)
    if (scenes.length > 0 && !scenesReady) return
    const order = scenes.map((s) => s.id)
    const prevOrder = findOrderRef.current
    findOrderRef.current = order
    const reset = findScopeRef.current !== scrollKey
    findScopeRef.current = scrollKey
    if (!findOpen) return
    const next = resolveFindCurrent({ prevId: findId, prevOrder, order, matches, reset })
    if (next.id !== findId) setFindId(next.id)
    if (next.moved && next.id != null) revealScene(next.id)
  }, [findOpen, findId, scenes, scenesReady, matches, scrollKey, revealScene])
  useEffect(() => {
    window.addEventListener('shortcut:findScene', openFind)
    return () => window.removeEventListener('shortcut:findScene', openFind)
  }, [openFind])
  useEffect(() => {
    if (findFocusTick === 0) return
    findInputRef.current?.focus()
    findInputRef.current?.select()
  }, [findFocusTick])
  // 찾기 칸이 열려 있는 동안은 포커스가 입력칸 밖(툴바·격자 빈 곳)에 있어도 Esc 로 닫는다.
  // 대화상자·메뉴가 열려 있으면 그쪽 Esc 이므로 양보하고, 입력칸 안의 Esc 는 입력칸이 이미 처리해
  // (preventDefault + stopPropagation) 여기까지 오지 않는다
  useEffect(() => {
    if (!findOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return
      if (overlayOpen()) return
      closeFind()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [findOpen, closeFind])

  // Home/End/PageUp/PageDown — 글자 칸이나 대화상자에 포커스가 없고, 씬 화면(툴바·격자)이 키 받을 자리일 때
  // 격자를 한 번에 옮긴다. 포커스가 격자 밖 요소에 있거나, 포커스가 body 인데 마지막 pointerdown 이 격자 밖이면
  // (오른쪽 히스토리·왼쪽 패널·덮개 패널의 빈 곳을 누른 뒤) 그 패널의 기본 키 스크롤에 양보한다.
  // 마운트 직후에는 방금 이 화면으로 들어온 것이라 격자 쪽으로 본다
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // 부드럽게 가는 중에 키를 또 누르면(꾹 누름 포함) 가는 중인 도착점에서 이어 더한다.
    // 안 그러면 누를 때마다 지금 자리에서 다시 출발해 한 화면씩밖에 못 간다
    let pendingTop: number | null = null
    let pendingTimer: number | undefined
    let lastPointerInside = true
    const settle = (): void => {
      pendingTop = null
      window.clearTimeout(pendingTimer)
    }
    const scroller = scrollRef.current
    scroller?.addEventListener('scrollend', settle)
    // 캡처 단계 — 카드·막대가 pointerdown 을 막아도 놓치지 않는다
    const onPointerDown = (e: PointerEvent): void => {
      const root = rootRef.current
      lastPointerInside = root != null && e.target instanceof Node && root.contains(e.target)
    }
    const zoneOf = (target: EventTarget | null): KeyZone => {
      if (
        !(target instanceof Node) ||
        target === document.body ||
        target === document.documentElement
      )
        return 'neutral'
      return rootRef.current?.contains(target) ? 'inside' : 'outside'
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.isComposing) return
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
      if (!['Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) return
      if (keysBelongElsewhere(e.target)) return
      if (!gridKeyAllowed(zoneOf(e.target), lastPointerInside)) return
      const el = scrollRef.current
      if (!el) return
      e.preventDefault()
      const max = Math.max(0, el.scrollHeight - el.clientHeight)
      const page = el.clientHeight * 0.9
      const from = pendingTop ?? el.scrollTop
      const top =
        e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? max
            : Math.min(max, Math.max(0, from + (e.key === 'PageUp' ? -page : page)))
      pendingTop = top
      window.clearTimeout(pendingTimer)
      pendingTimer = window.setTimeout(settle, 700)
      el.scrollTo({ top, behavior: 'smooth' })
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onPointerDown, true)
      scroller?.removeEventListener('scrollend', settle)
      window.clearTimeout(pendingTimer)
    }
  }, [])

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
  // 끌고 있는 묶음 — 고른 카드를 끌면 고른 전부(화면 순서), 아니면 그 한 장 (커스텀)
  const [dragIds, setDragIds] = useState<number[]>([])
  const sceneIdOf = (id: string | number): number => Number(String(id).replace('scene-', ''))
  const onDragStart = (e: DragStartEvent): void => {
    const scene = scenes.find((s) => `scene-${s.id}` === e.active.id) ?? null
    setDragScene(scene)
    const sel = useScenesStore.getState().selection
    setDragIds(
      scene
        ? sel.has(scene.id) && sel.size > 1
          ? scenes.filter((s) => sel.has(s.id)).map((s) => s.id)
          : [scene.id]
        : []
    )
  }
  const onDragCancel = (): void => {
    setDragScene(null)
    setDragIds([])
  }
  // 묶음을 끌 땐 같은 묶음의 (흐려진) 다른 카드는 놓을 자리 후보에서 뺀다 —
  // 안 그러면 그 위에 놓았을 때 dropBlock이 그대로 돌려줘 드래그가 조용히 무시된다
  const collision: CollisionDetection = (args) => {
    if (dragIds.length <= 1) return closestCenter(args)
    const skip = new Set(dragIds.map((id) => `scene-${id}`))
    skip.delete(String(args.active.id))
    return closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter((c) => !skip.has(String(c.id)))
    })
  }
  const onDragEnd = (e: DragEndEvent): void => {
    const moving = dragIds
    onDragCancel()
    const { active, over } = e
    if (!over || active.id === over.id || moving.length === 0) return
    const all = scenes.map((s) => s.id)
    const next = dropBlock(all, moving, sceneIdOf(active.id), sceneIdOf(over.id))
    if (!sameOrder(all, next)) void reorder(next)
  }

  // 스트리밍: 현재 생성 중인 씬과 미리보기 프레임 (해당 씬 카드에만 전달)
  const previewPng = useGenerationStore((s) => s.previewPng)
  const generatingSceneId = useGenerationStore((s) => s.generatingSceneId)

  async function exportJson(): Promise<void> {
    const r = await window.nais.invoke('scenes:exportJson', { presetId: activePresetId })
    if (!r.saved) return
    toast(`씬 ${r.scenes}개 내보냄`, 'success')
  }
  async function importJson(): Promise<void> {
    const { count, additions, dropped, transparent, nudeStrip } = await window.nais.invoke(
      'scenes:importJson',
      { presetId: activePresetId }
    )
    if (count > 0) {
      // 파일이 만든 카드·복장을 바로 쓰게 다시 읽는다 — 안 읽으면 생성 때 복장 태그가 빠진다
      await Promise.all([useCharactersStore.getState().load(), useOutfitsStore.getState().load()])
      if (transparent?.length) {
        await useSceneExtrasStore.getState().load()
        for (const t of transparent) {
          useSceneExtrasStore
            .getState()
            .setSceneTransparentBackground(activePresetId, t.sceneId, t.enabled)
        }
      }
      if (nudeStrip?.length) {
        await useSceneExtrasStore.getState().load()
        for (const t of nudeStrip) {
          useSceneExtrasStore.getState().setSceneNudeStrip(activePresetId, [t.sceneId], t.value)
        }
      }
      // 캐릭터탭 포함 파일 (커스텀): 만들어진 카드를 "씬별 캐릭터 추가"로 연결
      if (additions.length > 0) {
        const extras = useSceneExtrasStore.getState()
        await extras.load()
        // 하이드레이션 전에 쓰면 기존 씬별 설정을 빈 값으로 덮어쓸 수 있다 — 먼저 로드 보장
        await useSceneExtrasStore.getState().load()
        // 씬 구성 전체(씬별 캐릭터·위치·역할·자리·자리 태그·씬 태그)를 그대로 넣는다
        for (const a of additions) {
          useSceneExtrasStore.getState().updateAddition(activePresetId, a.sceneId, {
            ...a.setup,
            roles: stripNullRoles(a.setup.roles),
            charRefIds: a.setup.charRefIds ?? [],
            vibeIds: a.setup.vibeIds ?? []
          })
        }
        useSceneExtrasStore.getState().setAdditionsEnabled(true)
        toast(
          `씬 ${count}개 가져옴 — ${additions.length}개 씬에 캐릭터 구성 연결` +
            (dropped ? ` · 못 찾은 연결 ${dropped}건` : ''),
          'success'
        )
      } else {
        toast(`씬 ${count}개 가져옴`, 'success')
      }
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
    <div
      ref={rootRef}
      className="flex min-h-0 min-w-0 flex-1 flex-col rounded-xl border border-line bg-surface"
    >
      {/* 툴바 — 한 행: 프리셋 드롭다운 + 아이콘(툴팁) */}
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-2 py-1.5">
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
        {/* 휴지통 — 삭제한 프리셋·씬 복원 (커스텀) */}
        <IconBtn
          icon={<Trash2 size={16} />}
          tip="휴지통 — 삭제한 프리셋·씬 복원"
          onClick={() => {
            void useScenesStore.getState().loadTrash()
            setTrashOpen(true)
          }}
        />
        {/* 씬 찾기 — 씬이 많을 때 이름·번호로 바로 가기 */}
        <IconBtn
          icon={<Search size={16} />}
          tip={`씬 찾기 (${formatCombo(findBinding)})`}
          active={findOpen}
          onClick={openFind}
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
        {/* 씬 클립보드 붙여넣기 — 빈 모듈이나 우클릭할 씬이 없을 때도 맨 뒤에 붙일 수 있게 (커스텀) */}
        {gridClipboard && gridClipboard.ids.length > 0 && (
          <IconBtn
            icon={<ClipboardPaste size={16} />}
            tip={`씬 ${gridClipboard.ids.length}개 맨 뒤에 붙여넣기 (${gridClipboard.mode === 'cut' ? '잘라냄' : '복사됨'})`}
            onClick={() => void useScenesStore.getState().pasteSceneClipboard(null)}
          />
        )}
        <div className="mx-1 h-5 w-px bg-line" />
        {/* 보기: 카드 ↔ 이름 목록 (씬이 많을 때 촘촘히) */}
        <IconBtn
          icon={gridView === 'card' ? <LayoutGrid size={16} /> : <List size={16} />}
          tip={gridView === 'card' ? '카드 보기 (클릭: 이름 목록)' : '이름 목록 (클릭: 카드)'}
          onClick={toggleGridView}
        />
        {/* 카드 비율: 세로/가로 (해상도와 무관하게 고정). 이름 목록에서는 쓰지 않는다 */}
        <IconBtn
          icon={
            cardOrientation === 'portrait' ? (
              <RectangleVertical size={16} />
            ) : (
              <RectangleHorizontal size={16} />
            )
          }
          tip={cardOrientation === 'portrait' ? '세로 카드 (클릭: 가로)' : '가로 카드 (클릭: 세로)'}
          disabled={gridView === 'row'}
          onClick={() =>
            setCardOrientation(cardOrientation === 'portrait' ? 'landscape' : 'portrait')
          }
        />
        {/* 열 수 (2~5) */}
        <div
          className={cn(
            'flex items-center gap-0.5 rounded-md bg-surface-2 p-0.5',
            gridView === 'row' && 'opacity-40'
          )}
        >
          {[2, 3, 4, 5].map((n) => (
            <button
              key={n}
              onClick={() => setColumns(n)}
              disabled={gridView === 'row'}
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

      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-[12px]">
        {isBackground ? (
          <>
            <span className="font-medium">배경 태그</span>
            <span className="text-muted">
              카드에 태그를 적고 예약·생성해서 비교한 뒤 씬에 사용하세요.
            </span>
            <Button
              size="sm"
              disabled={selection.size !== 1}
              onClick={() => setUseBackground(scenes.find((s) => selection.has(s.id)) ?? null)}
            >
              선택한 배경을 씬에 사용
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              onClick={() => {
                if (selection.size) setCensorSceneIds([...selection])
                else setEditMode(true)
              }}
              disabled={scenes.length === 0}
            >
              <ShieldCheck size={14} />{' '}
              {selection.size ? `선택 ${selection.size}개 검열 설정` : '검열할 씬 선택'}
            </Button>
            <span className="text-muted">
              검열 태그 적용{' '}
              {scenes.filter((s) => normalizeCensors(s.censorKinds).length > 0).length}/
              {scenes.length}개
            </span>
            <Button
              size="sm"
              disabled={!scenes.length}
              onClick={() => {
                if (selection.size) setBackgroundSceneIds([...selection])
                else setEditMode(true)
              }}
            >
              {selection.size ? `선택 ${selection.size}개 배경 설정` : '배경 설정할 씬 선택'}
            </Button>
            <span className="text-muted">
              배경 적용 {scenes.filter((s) => s.background?.prompt.trim()).length}/{scenes.length}개
            </span>
            {selectionActive && <span className="text-muted">Shift로 범위 선택</span>}
          </>
        )}
      </div>
      {useBackground && (
        <BackgroundUseDialog
          backgroundScene={useBackground}
          onClose={() => setUseBackground(null)}
        />
      )}
      {backgroundSceneIds && (
        <SceneBackgroundDialog
          scenes={scenes.filter((s) => backgroundSceneIds.includes(s.id))}
          onClose={() => setBackgroundSceneIds(null)}
        />
      )}
      {censorSceneIds && (
        <SceneCensorDialog
          scenes={scenes.filter((s) => censorSceneIds.includes(s.id))}
          onClose={() => setCensorSceneIds(null)}
        />
      )}
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
            <BulkBar onOpenAddition={setAdditionSceneIds} onOpenCensors={setCensorSceneIds} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* 카드 그리드 (열 수만큼 폭에 꽉 차게). scrollbar-gutter로 스크롤바 등장 시 밀림 방지.
          빠른 이동 막대·찾기 칸은 이 영역 위에 겹쳐 둔다 */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          onScroll={(e) => {
            if (shownScrollKeyRef.current !== scrollKey) return
            // 위치 복원이 일으킨 이벤트(요청과 다르게 잘린 값 포함)는 기억값을 덮어쓰지 않는다
            if (isRestoreEcho(restoredTopRef.current, e.currentTarget.scrollTop)) return
            restoredTopRef.current = null
            rememberScroll(scrollKey, captureScroll(e.currentTarget))
          }}
          className="min-h-0 flex-1 overflow-y-auto p-3 no-scrollbar"
        >
          <div ref={contentRef}>
            <DndContext
              sensors={sensors}
              collisionDetection={collision}
              onDragStart={onDragStart}
              onDragCancel={onDragCancel}
              onDragEnd={onDragEnd}
              // 긴 목록: 가장자리 자동 스크롤을 조금 빠르게 (기본 10)
              autoScroll={{ acceleration: 16 }}
            >
              <SortableContext
                items={scenes.map((s) => `scene-${s.id}`)}
                strategy={gridView === 'row' ? verticalListSortingStrategy : rectSortingStrategy}
              >
                <div
                  className={cn('grid', gridView === 'row' ? 'gap-1' : 'gap-3')}
                  style={{
                    gridTemplateColumns: `repeat(${gridView === 'row' ? 1 : effectiveColumns}, minmax(0, 1fr))`
                  }}
                >
                  {scenes.map((scene, index) => (
                    <SceneCard
                      key={scene.id}
                      scene={scene}
                      variant={gridView}
                      order={gridView === 'row' ? index + 1 : undefined}
                      found={scene.id === foundId}
                      live={scene.id === generatingSceneId ? previewPng : null}
                      generating={scene.id === generatingSceneId}
                      onOpenAddition={setAdditionSceneIds}
                      onOpenCensors={setCensorSceneIds}
                      onUseBackground={setUseBackground}
                      onExportFavorites={onExportSceneFavorites}
                      onClearImages={onClearSceneImages}
                      onBeginShiftSelection={beginShiftSelection}
                      dragged={dragIds.length > 1 && dragIds.includes(scene.id)}
                    />
                  ))}
                  {gridView === 'row' ? (
                    <button
                      onClick={() => void create(isBackground ? '새 배경' : '새 씬')}
                      className="flex h-10 items-center justify-center gap-1.5 rounded-md border border-dashed border-line text-faint transition hover:text-accent"
                    >
                      <Plus size={16} />
                      <span className="text-[12px]">{isBackground ? '배경 추가' : '씬 추가'}</span>
                    </button>
                  ) : (
                    <button
                      onClick={() => void create(isBackground ? '새 배경' : '새 씬')}
                      className="flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-line text-faint transition hover:text-accent"
                      style={{ aspectRatio: CARD_ASPECT[cardOrientation] }}
                    >
                      <Plus size={22} />
                      <span className="text-[12px]">{isBackground ? '배경 추가' : '씬 추가'}</span>
                    </button>
                  )}
                </div>
              </SortableContext>
              {/* 드래그 중 커서를 따라가는 가벼운 클론 (원본은 숨김) */}
              <DragOverlay dropAnimation={null}>
                {dragScene && gridView === 'row' && (
                  <div className="flex h-full items-center gap-2 rounded-md border border-accent bg-surface-2 px-3 shadow-2xl">
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
                      {dragScene.name}
                    </span>
                    {dragIds.length > 1 && (
                      <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-[12px] font-bold text-white shadow">
                        {dragIds.length}개 함께 이동
                      </span>
                    )}
                  </div>
                )}
                {dragScene && gridView === 'card' && (
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
                    {dragIds.length > 1 && (
                      <span className="absolute right-1.5 top-1.5 rounded-full bg-accent px-2 py-0.5 text-[12px] font-bold text-white shadow">
                        {dragIds.length}개 함께 이동
                      </span>
                    )}
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
        </div>
        <SceneScrollBar
          scrollRef={scrollRef}
          contentRef={contentRef}
          scenes={scenes}
          layoutKey={`${scenes.length}|${gridView}|${effectiveColumns}|${cardOrientation}`}
        />
        {findOpen && (
          <div
            role="search"
            className="absolute right-5 top-2 z-20 flex h-8 items-center gap-1.5 rounded-lg border border-line bg-paper pl-2 pr-1 shadow-lg"
          >
            <Search size={14} className="shrink-0 text-faint" />
            <input
              ref={findInputRef}
              value={findQuery}
              aria-label="씬 찾기"
              placeholder="씬 이름 또는 번호"
              className="w-40 bg-transparent text-[13px] text-ink outline-none placeholder:text-faint"
              onChange={(e) => changeFindQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return
                if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  closeFind()
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  stepFind(e.shiftKey ? -1 : 1)
                }
              }}
            />
            {findQuery.trim() !== '' && (
              <span
                className={cn(
                  'shrink-0 text-[12px] tabular-nums',
                  matches.length > 0 ? 'text-muted' : 'text-danger'
                )}
              >
                {matches.length > 0 ? `${matchPos + 1}/${matches.length}` : '없음'}
              </span>
            )}
            <button
              onClick={closeFind}
              aria-label="찾기 닫기"
              className="grid size-6 shrink-0 place-items-center rounded text-muted transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <X size={13} />
            </button>
          </div>
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

// 빠른 이동 막대의 길 위·아래 여백(px)
const SCROLL_TRACK_PAD = 4

/**
 * 빠른 이동 막대 — 씬 격자 스크롤 영역 오른쪽 가장자리(격자 바깥 여백 안)에 겹쳐 둔 얇은 세로 막대.
 * 내용이 넘칠 때만 보이고, 손잡이나 막대 아무 곳을 누르고 끌면 그 비율 위치로 바로 간다.
 * 끄는 동안 막대 왼쪽에 「{순번} · {씬 이름}」 말풍선이 포인터 높이를 따라온다.
 * 카드(dnd-kit 끌기 대상) 바깥이라 카드 끌기와 겹치지 않고, 포인터 캡처로 창 밖에서도 끌기가 이어진다.
 */
function SceneScrollBar({
  scrollRef,
  contentRef,
  scenes,
  layoutKey
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>
  contentRef: React.RefObject<HTMLDivElement | null>
  scenes: Scene[]
  /** 바뀌면 손잡이를 다시 잰다 (씬 수·보기·열 수 등 내용 높이를 바꾸는 값) */
  layoutKey: string
}): React.JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)
  const [metrics, setMetrics] = useState<ThumbMetrics>({ visible: false, size: 0, top: 0 })
  const [bubble, setBubble] = useState<{ y: number; label: string } | null>(null)
  // 끄는 중이면 손잡이를 잡은 높이(손잡이 위에서 눌렀으면 그 자리, 아니면 손잡이 가운데)
  const dragRef = useRef<{ pointerId: number; grab: number; userSelect: string } | null>(null)

  const measure = useCallback((): void => {
    const scroller = scrollRef.current
    const track = trackRef.current
    if (!scroller || !track) return
    const next = thumbMetrics(
      scroller.scrollTop,
      scroller.scrollHeight,
      scroller.clientHeight,
      track.clientHeight
    )
    setMetrics((prev) =>
      prev.visible === next.visible &&
      Math.abs(prev.size - next.size) < 0.5 &&
      Math.abs(prev.top - next.top) < 0.5
        ? prev
        : next
    )
  }, [scrollRef])

  useLayoutEffect(() => {
    measure()
  }, [measure, layoutKey])
  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    scroller.addEventListener('scroll', measure, { passive: true })
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    if (contentRef.current) observer.observe(contentRef.current)
    return () => {
      scroller.removeEventListener('scroll', measure)
      observer.disconnect()
    }
  }, [scrollRef, contentRef, measure])
  // 끄다가 격자가 사라지면(씬 상세로 이동 등) 막아 둔 글자 선택을 되돌린다
  useEffect(
    () => () => {
      if (dragRef.current) document.body.style.userSelect = dragRef.current.userSelect
    },
    []
  )

  /** 포인터 높이 → 그 비율의 위치로 바로 이동하고 말풍선을 갱신 */
  const jumpTo = (clientY: number): void => {
    const scroller = scrollRef.current
    const track = trackRef.current
    const drag = dragRef.current
    if (!scroller || !track || !drag) return
    const trackTop = track.getBoundingClientRect().top
    const y = clientY - trackTop
    scroller.scrollTop = scrollTopForThumb(
      y - drag.grab,
      scroller.scrollHeight,
      scroller.clientHeight,
      track.clientHeight
    )
    const { ids, bottoms } = measureCards(scroller)
    const at = topSceneIndex(bottoms, scroller.scrollTop + GRID_PAD)
    const index = at < 0 ? -1 : scenes.findIndex((s) => s.id === ids[at])
    setBubble(
      index < 0
        ? null
        : {
            y: Math.min(Math.max(y, 0), track.clientHeight) + SCROLL_TRACK_PAD,
            label: sceneLabel(index, scenes[index].name)
          }
    )
    measure()
  }

  const endDrag = (): void => {
    const drag = dragRef.current
    if (!drag) return
    document.body.style.userSelect = drag.userSelect
    dragRef.current = null
    setBubble(null)
  }

  return (
    <div
      aria-hidden="true"
      className={cn(
        'group absolute inset-y-0 right-0 z-10 w-3 touch-none select-none',
        !metrics.visible && 'invisible pointer-events-none'
      )}
      onMouseDown={(e) => e.preventDefault()}
      onWheel={(e) => scrollRef.current?.scrollBy({ top: e.deltaY })}
      onPointerDown={(e) => {
        if (e.button !== 0 || dragRef.current || !trackRef.current) return
        const y = e.clientY - trackRef.current.getBoundingClientRect().top
        const onThumb = y >= metrics.top && y <= metrics.top + metrics.size
        dragRef.current = {
          pointerId: e.pointerId,
          grab: onThumb ? y - metrics.top : metrics.size / 2,
          userSelect: document.body.style.userSelect
        }
        document.body.style.userSelect = 'none'
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          /* 캡처를 못 잡아도 막대 위에서는 끌기가 이어진다 */
        }
        jumpTo(e.clientY)
      }}
      onPointerMove={(e) => {
        if (dragRef.current?.pointerId === e.pointerId) jumpTo(e.clientY)
      }}
      onPointerUp={(e) => {
        if (dragRef.current?.pointerId === e.pointerId) endDrag()
      }}
      onPointerCancel={(e) => {
        if (dragRef.current?.pointerId === e.pointerId) endDrag()
      }}
      onLostPointerCapture={(e) => {
        if (dragRef.current?.pointerId === e.pointerId) endDrag()
      }}
    >
      <div
        ref={trackRef}
        className="absolute inset-x-0"
        style={{ top: SCROLL_TRACK_PAD, bottom: SCROLL_TRACK_PAD }}
      >
        {metrics.visible && (
          <div
            className={cn(
              'absolute right-0.5 w-1 rounded-full transition-[width,background-color] duration-100',
              bubble ? 'w-2 bg-accent/70' : 'bg-muted/40 group-hover:w-2 group-hover:bg-muted/60'
            )}
            style={{ top: metrics.top, height: metrics.size }}
          />
        )}
      </div>
      {bubble && (
        <div
          className="pointer-events-none absolute right-full mr-2 max-w-64 -translate-y-1/2 truncate whitespace-nowrap rounded-md border border-line bg-surface px-2.5 py-1 text-[12px] font-medium text-ink shadow-lg"
          style={{ top: bubble.y }}
        >
          {bubble.label}
        </div>
      )}
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
  onOpenAddition,
  onOpenCensors
}: {
  onOpenCensors: (sceneIds: number[]) => void
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
  const setSceneNudeStrip = useSceneExtrasStore((s) => s.setSceneNudeStrip)
  const globalStripOnNude = useOutfitsStore((s) => s.stripOnNude)
  const moveScenesToEdge = useScenesStore((s) => s.moveScenesToEdge)
  const moveScenesToPosition = useScenesStore((s) => s.moveScenesToPosition)
  const total = useScenesStore((s) => s.scenes.length)

  const n = selection.size

  // 고른 씬들을 N번째로 (커스텀) — 첫 장이 그 번호가 되게, 옮긴 뒤 그 자리로 스크롤
  const moveToPosition = async (): Promise<void> => {
    const max = Math.max(1, total - n + 1)
    const raw = await askText(
      `이동할 위치 (1~${max}) — 고른 ${n}개의 첫 장이 이 번째가 됩니다`,
      '1'
    )
    if (raw == null) return
    const pos = Number(raw.trim())
    if (!Number.isInteger(pos) || pos < 1 || pos > max) {
      toast(`1~${max} 사이의 정수를 입력하세요`, 'info')
      return
    }
    await moveScenesToPosition([...selection], pos)
  }

  // 옷 벗기기 (커스텀) — 선택한 씬에만 적용. 전체 설정 따름 = 씬에서 정한 값을 지움
  const bulkNudeStrip = (value: NudeStripSetting | undefined): void => {
    if (activePresetId == null) return
    setSceneNudeStrip(activePresetId, [...selection], value)
    toast(`선택한 ${n}개 씬: 옷 벗기기 · ${nudeStripLabel(value)}`, 'success')
  }
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
      <span className="font-medium text-ink">{n}개 선택</span>
      <Button size="sm" disabled={disabled} onClick={() => onOpenCensors([...selection])}>
        <ShieldCheck size={14} /> 검열 태그
      </Button>
      <Button size="sm" variant="ghost" onClick={selectAll}>
        전체 선택
      </Button>
      <Button size="sm" variant="ghost" onClick={clearSelection} disabled={disabled}>
        해제
      </Button>
      <div className="mx-1 h-4 w-px bg-line" />

      {/* 고른 씬 묶음 이동 (커스텀) — 맨 앞·맨 뒤·N번째로. 카드 우클릭엔 「이 씬 앞/뒤에」 */}
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={() => void moveScenesToEdge([...selection], 'front')}
      >
        <ArrowUpToLine size={13} /> 맨 앞
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={() => void moveScenesToEdge([...selection], 'back')}
      >
        <ArrowDownToLine size={13} /> 맨 뒤
      </Button>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void moveToPosition()}>
        <ArrowRight size={13} /> N번째로
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
      {/* 옷 벗기기 일괄 (커스텀) — 누르면 메뉴: 전체 설정 따름 / 안 벗김 / 둘 다 / 남캐만 / 여캐만 */}
      <NudeStripMenu current={null} globalOn={globalStripOnNude} onPick={bulkNudeStrip}>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          title="선택한 씬의 옷 벗기기를 정함 — 전체 설정 따름 · 안 벗김 · 둘 다 · 남캐만 · 여캐만"
        >
          <Shirt size={13} /> 옷 벗기기
        </Button>
      </NudeStripMenu>
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
  onBeginShiftSelection,
  onOpenCensors,
  onUseBackground,
  variant = 'card',
  order,
  found = false,
  dragged = false
}: {
  scene: Scene
  live: string | null
  generating: boolean
  /** card = 썸네일 카드, row = 한 줄짜리 이름 목록 (같은 컴포넌트·같은 제스처) */
  variant?: 'card' | 'row'
  /** row에서 보이는 순번(목록 순서, 1부터) */
  order?: number
  /** 씬 찾기의 현재 일치 — 강조 테두리 */
  found?: boolean
  /** 다른 카드를 끄는 중, 이 카드도 같은 묶음으로 따라감 (흐리게) */
  dragged?: boolean
  onOpenAddition: (sceneIds: number[]) => void
  onExportFavorites: (id: number) => void
  onClearImages: (id: number, name: string) => void
  onOpenCensors: (sceneIds: number[]) => void
  onUseBackground: (scene: Scene) => void
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
  const sceneClipboard = useScenesStore((s) => s.sceneClipboard)
  const selectionActive = editMode || selection.size > 0
  // Shift/Ctrl 제스처는 아래 pointerdown에서 따로 가로채고, 일반 드래그는 편집 중에도 재정렬에 쓴다.
  // 고른 카드를 끌면 고른 전부가 함께 간다 (2026-10-12 유저 「멀티 선택 드래그」)
  const sortable = useSortable({ id: `scene-${scene.id}` })

  // 씬별 캐릭터 추가 (NAIS2 Custom) — 선택 합계 배지
  const additionsEnabled = useSceneExtrasStore((s) => s.additionsEnabled)
  const addition = useSceneExtrasStore((s) => s.additions[scene.presetId]?.[scene.id])
  const transparentBackground = useGenerationStore((s) => s.transparentBackground)
  const model = useGenerationStore((s) => s.request.model)
  const transparentOverride = useSceneExtrasStore(
    (s) => s.transparentBackgrounds[scene.presetId]?.[scene.id]
  )
  const setSceneTransparentBackground = useSceneExtrasStore((s) => s.setSceneTransparentBackground)
  const transparentEnabled = transparentOverride ?? transparentBackground
  const canUseTransparentBackground = modelCaps(model).transparency
  const additionCount = hasAddition(addition)
    ? addition.characterIds.length + addition.charRefIds.length + addition.vibeIds.length
    : 0

  // 생성 중 이 씬의 남은 개수 (메인 큐 pending+generating) — NAIS2처럼 배지가 줄어들며 표시.
  // 큐 반복 사용 시 항목×예약 전체가 반영된다. 수천 장 큐에서도 카드당 O(1) (커스텀 — 성능)
  const queueRemaining = useGenerationStore(
    (s) => (s.pendingBySceneId[scene.id] ?? 0) + (s.generatingSceneId === scene.id ? 1 : 0)
  )
  const badgeCount = scene.reserveCount + queueRemaining

  const toggleSceneTransparentBackground = (): void => {
    setSceneTransparentBackground(scene.presetId, scene.id, !transparentEnabled)
  }
  const inheritTransparentBackground = (): void => {
    setSceneTransparentBackground(scene.presetId, scene.id, undefined)
  }

  const checked = selection.has(scene.id)
  const isRow = variant === 'row'
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

  // 우클릭 복사/잘라내기/붙여넣기 (커스텀) — 다중 선택이면 선택 전체, 아니면 이 카드 한 장
  const contextTargetIds = (): number[] => {
    const st = useScenesStore.getState()
    return st.selection.has(scene.id) ? [...st.selection] : [scene.id]
  }
  const clipboardScenes = (mode: 'copy' | 'cut'): void => {
    useScenesStore.getState().setSceneClipboard(contextTargetIds(), mode)
  }
  const moveToEdge = (edge: 'front' | 'back'): void => {
    void useScenesStore.getState().moveScenesToEdge(contextTargetIds(), edge)
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

  // 이름 목록(row) 한 줄 — 순번 · 이름 · 그림 수 · 내보내기 번호 · V+ · 생성 중 · 예약.
  // 클릭 열기·선택·Shift 칠하기·드래그·우클릭 메뉴는 바깥 요소가 카드와 똑같이 맡는다
  const rowBody = (
    <>
      {selectionActive && (
        <span
          className={cn(
            'grid size-5 shrink-0 place-items-center rounded border-2 transition',
            checked ? 'border-accent bg-accent text-white' : 'border-faint bg-black/10'
          )}
        >
          {checked && <span className="text-[11px] leading-none">✓</span>}
        </span>
      )}
      <span className="w-8 shrink-0 text-right font-mono text-[12px] tabular-nums text-faint">
        {order}
      </span>
      <div className="min-w-0 flex-1">
        {editMode ? (
          <input
            className="h-7 w-full truncate rounded bg-paper px-2 text-[13px] font-medium text-ink outline-none ring-1 ring-line focus:ring-accent"
            value={scene.name}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => void update(scene.id, { name: e.target.value })}
          />
        ) : (
          <div className="truncate text-[13px] font-medium text-ink">{scene.name}</div>
        )}
      </div>
      <span className="w-14 shrink-0 text-right text-[12px] tabular-nums text-muted">
        {scene.imageCount > 0 && `${scene.imageCount}장`}
      </span>
      <span className="grid w-9 shrink-0 place-items-center">
        {scene.exportNo != null && (
          <button
            className="inline-flex items-center rounded-full bg-accent/85 px-2 py-0.5 font-mono text-[12px] font-bold text-white transition hover:bg-accent"
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
      </span>
      <span className="grid w-9 shrink-0 place-items-center">
        {scene.varietyPlus && (
          <span
            className="flex h-5 items-center gap-0.5 rounded-full bg-violet-500/85 px-1.5 text-[10px] font-bold text-white"
            title="이 씬은 Variety+가 적용됩니다"
          >
            <Sparkles size={10} /> V+
          </span>
        )}
      </span>
      <span className="grid w-4 shrink-0 place-items-center">
        {generating && (
          <Loader2 size={14} className="animate-spin text-accent" aria-label="생성 중" />
        )}
      </span>
      <span className="grid w-7 shrink-0 place-items-center">
        {badgeCount > 0 && (
          <span
            className="grid h-5 min-w-5 place-items-center rounded-full bg-danger px-1 text-[12px] font-bold text-white"
            title="예약 + 생성 대기"
          >
            {badgeCount}
          </span>
        )}
      </span>
      <div
        className="flex shrink-0 items-center gap-0.5 rounded-full bg-paper p-0.5"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button
          className="grid size-5 place-items-center rounded-full text-ink hover:bg-surface-2 disabled:opacity-30"
          // 생성 중엔 큐 대기분 취소가 가능해야 하므로 합산 기준 (카드와 같다)
          disabled={scene.reserveCount + queueRemaining === 0}
          onClick={() => void adjustReserve(scene.id, -1)}
        >
          <Minus size={13} />
        </button>
        <span className="min-w-4 text-center text-[12px] font-medium text-ink">
          {scene.reserveCount}
        </span>
        <button
          className="grid size-5 place-items-center rounded-full text-ink hover:bg-surface-2"
          onClick={() => void adjustReserve(scene.id, 1)}
        >
          <Plus size={13} />
        </button>
      </div>
    </>
  )

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={sortable.setNodeRef}
          {...sortable.attributes}
          {...sortable.listeners}
          data-scene-id={scene.id}
          title={
            checked && selection.size > 1
              ? `드래그하면 선택한 ${selection.size}개가 함께 이동`
              : '클릭해서 열기 · 드래그해서 순서 변경'
          }
          className={cn(
            isRow
              ? 'group relative flex h-10 touch-none items-center gap-2 overflow-hidden rounded-md border bg-surface-2 px-2 transition'
              : 'group relative touch-none overflow-hidden rounded-lg border bg-surface-2 transition',
            selectionActive && checked ? 'border-accent ring-2 ring-accent/40' : 'border-line',
            found && 'border-accent ring-[3px] ring-accent ring-offset-2 ring-offset-surface',
            sortable.isDragging && 'shadow-xl',
            dragged && 'opacity-30'
          )}
          style={dndStyle(sortable)}
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
            // 편집 모드에서 고른 게 있으면 다른 카드 우클릭도 선택을 지우지 않는다 — 메뉴 「이 씬 앞/뒤에」용
            if (editMode && selection.size > 0 && !e.shiftKey && !e.ctrlKey && !e.metaKey) return
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
          {isRow ? (
            rowBody
          ) : (
            <>
              <div className="relative" style={{ aspectRatio: CARD_ASPECT[cardOrientation] }}>
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
                {canUseTransparentBackground && !editMode && (
                  <button
                    type="button"
                    data-testid={`scene-transparent-bg-${scene.id}`}
                    aria-pressed={transparentEnabled}
                    className={cn(
                      'absolute right-1.5 top-9 z-10 grid size-7 place-items-center rounded-full text-white shadow transition',
                      transparentEnabled
                        ? 'bg-accent hover:bg-accent/85'
                        : 'bg-black/60 text-white/80 hover:bg-black/80'
                    )}
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleSceneTransparentBackground()
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      inheritTransparentBackground()
                    }}
                    title={
                      transparentOverride === undefined
                        ? `Scene Transparent BG: ${transparentEnabled ? 'on' : 'off'} (click to override)`
                        : `Scene Transparent BG: ${transparentEnabled ? 'on' : 'off'} (double-click to use global)`
                    }
                  >
                    <ImageOff size={14} />
                  </button>
                )}

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
                    <PopoverContent
                      align="end"
                      className="w-40 p-1"
                      onClick={(e) => e.stopPropagation()}
                    >
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
              {scene.kind === 'background' ? (
                <button
                  type="button"
                  className="h-8 w-full border-t border-line bg-accent-soft text-xs text-accent"
                  disabled={!scene.prompt.trim()}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation()
                    onUseBackground(scene)
                  }}
                >
                  이 배경을 씬에 사용
                </button>
              ) : (
                <CensorStatus scene={scene} onEdit={() => onOpenCensors([scene.id])} />
              )}
            </>
          )}
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
        <ContextMenuSeparator />
        {/* 복사/잘라내기 → 원하는 씬에 우클릭해 "이 씬 뒤에 붙여넣기" — 위치 맞추기용 (커스텀) */}
        <ContextMenuItem onSelect={() => clipboardScenes('copy')}>
          <Copy size={13} className="text-teal-400" /> 복사{multi ? ` (${multiN}개)` : ''}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => clipboardScenes('cut')}>
          <Scissors size={13} className="text-orange-400" /> 잘라내기
          {multi ? ` (${multiN}개)` : ''}
        </ContextMenuItem>
        {sceneClipboard && sceneClipboard.ids.length > 0 && (
          <ContextMenuItem
            onSelect={() => void useScenesStore.getState().pasteSceneClipboard(scene.id)}
          >
            <ClipboardPaste size={13} className="text-emerald-400" /> 이 씬 뒤에 붙여넣기 (
            {sceneClipboard.ids.length}개)
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={() => moveToEdge('front')}>
          <ArrowUpToLine size={13} /> 맨 앞으로{multi ? ` (${multiN}개)` : ''}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => moveToEdge('back')}>
          <ArrowDownToLine size={13} /> 맨 뒤로{multi ? ` (${multiN}개)` : ''}
        </ContextMenuItem>
        {/* 고른 씬들을 이 카드 자리로 — 잘라내기 없이 바로 (커스텀) */}
        {selection.size > 0 && !checked && (
          <>
            <ContextMenuItem
              onSelect={() =>
                void useScenesStore.getState().moveScenesNextTo([...selection], scene.id, 'before')
              }
            >
              <ChevronUp size={13} className="text-sky-400" /> 선택한 {selection.size}개를 이 씬
              앞에
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() =>
                void useScenesStore.getState().moveScenesNextTo([...selection], scene.id, 'after')
              }
            >
              <ChevronDown size={13} className="text-sky-400" /> 선택한 {selection.size}개를 이 씬
              뒤에
            </ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
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

/** 'YYYY-MM-DD HH:MM:SS[.SSS]'(UTC) → 로컬 표시 */
function formatDeletedAt(utc: string): string {
  const date = new Date(utc.replace(' ', 'T') + 'Z')
  if (Number.isNaN(date.getTime())) return utc
  return date.toLocaleString('ko-KR', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** 씬 휴지통 — 삭제한 프리셋·씬을 되살리거나 영구 삭제 (커스텀). 보관 기간은 설정 가능 */
function SceneTrashDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const trashed = useScenesStore((s) => s.trashed)
  const trashedPresets = useScenesStore((s) => s.trashedPresets)
  const libraryKind = useScenesStore((s) => s.libraryKind)
  const restoreScenes = useScenesStore((s) => s.restoreScenes)
  const purgeScenes = useScenesStore((s) => s.purgeScenes)
  const restorePreset = useScenesStore((s) => s.restorePreset)
  const purgePreset = useScenesStore((s) => s.purgePreset)
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
            삭제한 프리셋과 씬을 되살릴 수 있습니다.
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
          {trashed.length === 0 && trashedPresets.length === 0 ? (
            <p className="py-10 text-center text-[13px] text-faint">휴지통이 비어 있습니다</p>
          ) : (
            <div className="space-y-1.5">
              {/* 삭제한 프리셋 — 안의 씬은 프리셋째로 되살리거나 지운다 */}
              {trashedPresets.length > 0 && (
                <div className="px-1 text-[11px] font-medium text-muted">프리셋</div>
              )}
              {trashedPresets.map((p) => (
                <div
                  key={`preset-${p.id}`}
                  className="flex items-center gap-3 rounded-lg border border-line bg-surface-2 p-2"
                >
                  <div className="grid size-12 shrink-0 place-items-center rounded-md bg-paper text-faint">
                    <Layers size={16} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-ink">{p.name}</div>
                    <div className="truncate text-[11px] text-faint">
                      {p.kind === 'background' ? '배경' : '씬'} {p.sceneCount ?? 0}개 ·{' '}
                      {formatDeletedAt(p.deletedAt)}
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => void restorePreset(p.id)}>
                    <RotateCcw size={13} /> 복원
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-danger"
                    title="영구 삭제"
                    onClick={async () => {
                      if (
                        await askConfirm('영구 삭제', {
                          message: `"${p.name}" 프리셋과 그 안의 씬을 영구 삭제합니다. 생성한 이미지는 기록에 남습니다. 먼저 따로 지운 씬은 이미지 파일까지 OS 휴지통으로 이동합니다.`,
                          confirmLabel: '영구 삭제',
                          danger: true
                        })
                      )
                        void purgePreset(p.id)
                    }}
                  >
                    <Trash2 size={13} />
                  </Button>
                </div>
              ))}
              {trashedPresets.length > 0 && trashed.length > 0 && (
                <div className="px-1 pt-2 text-[11px] font-medium text-muted">
                  {libraryKind === 'background' ? '배경' : '씬'}
                </div>
              )}
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
