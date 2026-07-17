import {
  ChevronDown,
  ChevronRight,
  Crosshair,
  Eye,
  EyeOff,
  ImageOff,
  Link2,
  Plus,
  RotateCcw,
  Split,
  Trash2,
  User,
  Users,
  Waves
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { CharRefItem, CharacterCard, ListFolder, VibeItem } from '@shared/types'
import { useCharactersStore } from '../stores/characters-store'
import { useCharRefsStore, useVibesStore } from '../stores/refs-store'
import {
  hasAddition,
  useSceneExtrasStore,
  type CharPositions,
  type CharRoles,
  type SceneAddition,
  type SequenceEntry
} from '../stores/scene-extras-store'
import type { CharRole } from '@shared/types'
import { askConfirm } from '../stores/dialog-store'
import { toast } from '../stores/toast-store'
import { useScenesStore } from '../stores/scenes-store'
import { cn } from '../lib/utils'
import { PositionPicker } from './position-picker'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Switch } from './ui/switch'

/**
 * 씬 모드 커스텀 확장 다이얼로그 (NAIS2 Custom 이식):
 * - SequenceDialog: 큐 반복 항목(캐릭터/캐릭레퍼/바이브 조합) 편집
 * - AdditionDialog: 특정 씬에만 추가 적용할 캐릭터/레퍼런스 선택
 */

/** 다이얼로그가 참조하는 라이브러리 로드 보장 */
function useLibraries(open: boolean): void {
  useEffect(() => {
    if (!open) return
    const chars = useCharactersStore.getState()
    const vibes = useVibesStore.getState()
    const crefs = useCharRefsStore.getState()
    if (!chars.loaded) void chars.load()
    if (!vibes.loaded) void vibes.load()
    if (!crefs.loaded) void crefs.load()
  }, [open])
}

function toggleId(ids: number[], id: number): number[] {
  return ids.includes(id) ? ids.filter((v) => v !== id) : [...ids, id]
}

/**
 * 선택창 폴더 접기 상태 (커스텀) — 기본은 "접힘". 펼친 폴더만 localStorage에 저장해
 * 앱을 껐다 켜도 마지막 접기/펼치기 상태가 유지된다.
 */
function usePickerCollapse(storageKey: string): {
  isCollapsed: (key: string) => boolean
  toggle: (key: string) => void
} {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(storageKey) ?? '[]') as string[])
    } catch {
      return new Set()
    }
  })
  const toggle = (key: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      localStorage.setItem(storageKey, JSON.stringify([...next]))
      return next
    })
  return { isCollapsed: (key) => !expanded.has(key), toggle }
}

function charLabel(c: CharacterCard, index: number): string {
  return c.name || c.prompt.split(',')[0]?.trim() || `캐릭터 ${index + 1}`
}

/** 섹션 제목 + 선택 수 */
function SectionTitle({
  icon,
  title,
  count
}: {
  icon: React.ReactNode
  title: string
  count: number
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5 text-[12px] font-medium text-muted">
      {icon}
      <span>{title}</span>
      <span
        className={cn(
          'ml-auto rounded-full px-1.5 py-px text-[11px]',
          count > 0 ? 'bg-accent/15 text-accent' : 'bg-surface-2 text-faint'
        )}
      >
        {count}
      </span>
    </div>
  )
}

/** 캐릭터 체크 리스트 (폴더별 그룹 + 썸네일 + 이름 + 프롬프트 미리보기) */
function CharacterPicker({
  selected,
  onChange
}: {
  selected: number[]
  onChange: (ids: number[]) => void
}): React.JSX.Element {
  const items = useCharactersStore((s) => s.items)
  const folders = useCharactersStore((s) => s.folders)

  // 폴더 순서대로 그룹핑 + 미분류는 맨 끝. 빈 폴더는 표시 안 함
  const groups: {
    key: string
    name: string | null
    color: string | null
    chars: CharacterCard[]
  }[] = [
    ...folders.map((f) => ({
      key: `f-${f.id}`,
      name: f.name,
      color: f.color,
      chars: items.filter((c) => c.folderId === f.id)
    })),
    {
      key: 'ungrouped',
      name: null,
      color: null,
      chars: items.filter((c) => c.folderId == null || !folders.some((f) => f.id === c.folderId))
    }
  ].filter((g) => g.chars.length > 0)

  const renderChar = (c: CharacterCard, i: number): React.JSX.Element => {
    const checked = selected.includes(c.id)
    const selectionOrder = selected.indexOf(c.id) + 1
    return (
      <button
        key={c.id}
        onClick={() => onChange(toggleId(selected, c.id))}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors',
          checked ? 'bg-accent/10' : 'hover:bg-surface-2'
        )}
      >
        <span
          className={cn(
            'grid size-4 shrink-0 place-items-center rounded border text-[10px] leading-none',
            checked ? 'border-accent bg-accent text-white' : 'border-line bg-surface'
          )}
        >
          {checked && selectionOrder}
        </span>
        {c.thumbnail ? (
          <img
            src={`data:image/webp;base64,${c.thumbnail}`}
            className="size-7 shrink-0 rounded object-cover"
            alt=""
          />
        ) : (
          <span className="grid size-7 shrink-0 place-items-center rounded bg-surface-2 text-faint">
            <User size={13} />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-medium">{charLabel(c, i)}</span>
          <span className="block truncate text-[11px] text-faint">{c.prompt}</span>
        </span>
        {c.charRefId != null && (
          <Link2 size={11} className="shrink-0 text-accent" aria-label="레퍼런스 연결됨" />
        )}
      </button>
    )
  }

  // 기본 접힘 + 상태 영속 (커스텀)
  const { isCollapsed, toggle } = usePickerCollapse('picker_open_chars')

  const showFolders = folders.length > 0

  // 폴더 단위 전체 선택/해제 (커스텀).
  // 하나라도 선택돼 있으면 다시 누를 때 "전체 해제" — 재클릭이 항상 취소가 되게 한다.
  const groupCheck = (chars: CharacterCard[]): 'none' | 'some' | 'all' => {
    const n = chars.filter((c) => selected.includes(c.id)).length
    return n === 0 ? 'none' : n === chars.length ? 'all' : 'some'
  }
  const toggleGroup = (chars: CharacterCard[]): void => {
    const ids = chars.map((c) => c.id)
    onChange(
      ids.some((id) => selected.includes(id))
        ? selected.filter((id) => !ids.includes(id))
        : [...selected, ...ids]
    )
  }

  return (
    <div className="max-h-64 space-y-0.5 overflow-y-auto rounded-md border border-line bg-paper p-1">
      {items.length === 0 && (
        <p className="py-6 text-center text-[12px] text-faint">캐릭터 라이브러리가 비어 있습니다</p>
      )}
      {groups.map((g) => (
        <div key={g.key} className="space-y-0.5">
          {/* 폴더 헤더 — 클릭하면 접기/펴기, 체크로 폴더 통째 선택 (폴더가 있을 때만) */}
          {showFolders && (
            <FolderHeader
              name={g.name ?? '미분류'}
              color={g.color}
              count={g.chars.length}
              collapsed={isCollapsed(g.key)}
              onToggle={() => toggle(g.key)}
              checkState={groupCheck(g.chars)}
              onCheck={() => toggleGroup(g.chars)}
            />
          )}
          {(!showFolders || !isCollapsed(g.key)) &&
            g.chars.map((c) => renderChar(c, items.indexOf(c)))}
        </div>
      ))}
    </div>
  )
}

/** 접기/펴기 폴더 헤더 (커스텀 — 선택 다이얼로그 공용).
 *  checkState/onCheck를 주면 폴더 안 전체를 한 번에 선택/해제하는 체크박스가 붙는다. */
function FolderHeader({
  name,
  color,
  count,
  collapsed,
  onToggle,
  checkState,
  onCheck
}: {
  name: string
  color: string | null
  count: number
  collapsed: boolean
  onToggle: () => void
  checkState?: 'none' | 'some' | 'all'
  onCheck?: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onToggle}
      className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[11.5px] font-semibold text-muted transition-colors hover:bg-surface-2"
    >
      {collapsed ? (
        <ChevronRight size={13} className="shrink-0" />
      ) : (
        <ChevronDown size={13} className="shrink-0" />
      )}
      {onCheck && (
        <span
          role="checkbox"
          aria-checked={checkState === 'all'}
          title="폴더 전체 선택/해제"
          onClick={(e) => {
            e.stopPropagation()
            onCheck()
          }}
          className={cn(
            'grid size-4 shrink-0 place-items-center rounded border text-[10px] leading-none transition-colors',
            checkState === 'all'
              ? 'border-accent bg-accent text-white'
              : checkState === 'some'
                ? 'border-accent bg-accent/25 text-accent'
                : 'border-line bg-surface hover:border-accent'
          )}
        >
          {checkState !== 'none' && '✓'}
        </span>
      )}
      <span
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: color ?? 'var(--faint)' }}
      />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span className="shrink-0 text-faint">({count})</span>
    </button>
  )
}

/** 바이브/캐릭레퍼 이미지 그리드 멀티 선택 (폴더별 그룹 + 접기/펴기) */
function RefPicker({
  items,
  folders,
  selected,
  onChange,
  emptyLabel,
  collapseKey
}: {
  items: (VibeItem | CharRefItem)[]
  folders: ListFolder[]
  selected: number[]
  onChange: (ids: number[]) => void
  emptyLabel: string
  /** 접기 상태 저장 키 (바이브/캐릭레퍼 각각 독립) */
  collapseKey: string
}): React.JSX.Element {
  // 기본 접힘 + 상태 영속 (커스텀)
  const { isCollapsed, toggle } = usePickerCollapse(collapseKey)

  const groups = [
    ...folders.map((f) => ({
      key: `f-${f.id}`,
      name: f.name,
      color: f.color,
      list: items.filter((it) => it.folderId === f.id)
    })),
    {
      key: 'ungrouped',
      name: '미분류',
      color: null as string | null,
      list: items.filter((it) => it.folderId == null || !folders.some((f) => f.id === it.folderId))
    }
  ].filter((g) => g.list.length > 0)
  const showFolders = folders.length > 0

  const tile = (item: VibeItem | CharRefItem): React.JSX.Element => {
    const checked = selected.includes(item.id)
    return (
      <button
        key={item.id}
        onClick={() => onChange(toggleId(selected, item.id))}
        className={cn(
          'relative aspect-square overflow-hidden rounded-md border transition',
          checked
            ? 'border-accent ring-2 ring-accent/40'
            : 'border-line opacity-55 grayscale hover:opacity-90 hover:grayscale-0'
        )}
        title={item.name}
      >
        {item.thumbnail ? (
          <img
            src={`data:image/webp;base64,${item.thumbnail}`}
            className="h-full w-full object-cover"
            alt=""
          />
        ) : (
          <span className="grid h-full w-full place-items-center bg-surface-2 text-faint">
            <ImageOff size={16} />
          </span>
        )}
        {checked && (
          <span className="absolute right-1 top-1 grid size-4 place-items-center rounded-full bg-accent text-[10px] leading-none text-white">
            ✓
          </span>
        )}
      </button>
    )
  }

  // 폴더 단위 전체 선택/해제 (커스텀) — 하나라도 선택돼 있으면 재클릭 시 전체 해제 (항상 취소 가능)
  const groupCheck = (list: (VibeItem | CharRefItem)[]): 'none' | 'some' | 'all' => {
    const n = list.filter((it) => selected.includes(it.id)).length
    return n === 0 ? 'none' : n === list.length ? 'all' : 'some'
  }
  const toggleGroup = (list: (VibeItem | CharRefItem)[]): void => {
    const ids = list.map((it) => it.id)
    onChange(
      ids.some((id) => selected.includes(id))
        ? selected.filter((id) => !ids.includes(id))
        : [...selected, ...ids]
    )
  }

  return (
    <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-line bg-paper p-1.5">
      {items.length === 0 ? (
        <p className="py-6 text-center text-[12px] text-faint">{emptyLabel}</p>
      ) : (
        groups.map((g) => (
          <div key={g.key} className="space-y-1">
            {showFolders && (
              <FolderHeader
                name={g.name}
                color={g.color}
                count={g.list.length}
                collapsed={isCollapsed(g.key)}
                onToggle={() => toggle(g.key)}
                checkState={groupCheck(g.list)}
                onCheck={() => toggleGroup(g.list)}
              />
            )}
            {(!showFolders || !isCollapsed(g.key)) && (
              <div className="grid grid-cols-3 gap-1.5">{g.list.map(tile)}</div>
            )}
          </div>
        ))
      )}
    </div>
  )
}

type SelectionPatch = {
  characterIds?: number[]
  charRefIds?: number[]
  vibeIds?: number[]
  useCoords?: boolean
  positions?: CharPositions
  roles?: CharRoles
}

/** 캐릭터+캐릭레퍼+바이브 3열 선택 패널 + 캐릭터 위치/역할 지정 (두 다이얼로그 공용) */
function SelectionPanel({
  characterIds,
  charRefIds,
  vibeIds,
  useCoords,
  positions,
  roles,
  onPatch
}: {
  characterIds: number[]
  charRefIds: number[]
  vibeIds: number[]
  useCoords?: boolean
  positions?: CharPositions
  roles?: CharRoles
  onPatch: (patch: SelectionPatch) => void
}): React.JSX.Element {
  const vibes = useVibesStore((s) => s.items)
  const vibeFolders = useVibesStore((s) => s.folders)
  const crefs = useCharRefsStore((s) => s.items)
  const crefFolders = useCharRefsStore((s) => s.folders)
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <SectionTitle icon={<User size={13} />} title="캐릭터" count={characterIds.length} />
          <CharacterPicker
            selected={characterIds}
            onChange={(ids) => onPatch({ characterIds: ids })}
          />
        </div>
        <div className="space-y-1.5">
          <SectionTitle
            icon={<Users size={13} />}
            title="캐릭터 레퍼런스"
            count={charRefIds.length}
          />
          <RefPicker
            items={crefs}
            folders={crefFolders}
            selected={charRefIds}
            onChange={(ids) => onPatch({ charRefIds: ids })}
            emptyLabel="캐릭레퍼가 없습니다"
            collapseKey="picker_open_crefs"
          />
        </div>
        <div className="space-y-1.5">
          <SectionTitle icon={<Waves size={13} />} title="바이브" count={vibeIds.length} />
          <RefPicker
            items={vibes}
            folders={vibeFolders}
            selected={vibeIds}
            onChange={(ids) => onPatch({ vibeIds: ids })}
            emptyLabel="바이브가 없습니다"
            collapseKey="picker_open_vibes"
          />
        </div>
      </div>
      <RolePanel characterIds={characterIds} roles={roles} onPatch={onPatch} />
      <PositionPanel
        characterIds={characterIds}
        useCoords={useCoords}
        positions={positions}
        onPatch={onPatch}
      />
    </div>
  )
}

/** 행위 역할 지정 (커스텀) — 역할을 주면 생성 시 씬의 하는쪽/당하는쪽 태그가
 *  그 캐릭터 프롬프트 뒤에 자동으로 합쳐진다. 카드에는 외형만 있으면 됨 */
function RolePanel({
  characterIds,
  roles,
  onPatch
}: {
  characterIds: number[]
  roles?: CharRoles
  onPatch: (patch: SelectionPatch) => void
}): React.JSX.Element | null {
  const items = useCharactersStore((s) => s.items)
  const chars = characterIds
    .map((id) => items.find((c) => c.id === id))
    .filter((c): c is CharacterCard => !!c)
  if (chars.length === 0) return null

  const setRole = (id: number, role: CharRole | null): void => {
    const next: CharRoles = { ...(roles ?? {}) }
    if (role) next[id] = role
    else delete next[id]
    onPatch({ roles: next })
  }

  const OPTIONS: { value: CharRole | null; label: string; title: string }[] = [
    { value: null, label: '없음', title: '카드 프롬프트 그대로 사용' },
    { value: 'source', label: '하는쪽', title: '씬의 하는쪽 태그를 프롬프트 뒤에 합침' },
    { value: 'target', label: '당하는쪽', title: '씬의 당하는쪽 태그를 프롬프트 뒤에 합침' }
  ]

  return (
    <div className="rounded-md border border-line bg-paper p-2">
      <div className="flex items-center gap-2">
        <Users size={13} className="text-muted" />
        <span className="text-[12px] font-medium text-muted">행위 역할</span>
        <span className="text-[11px] text-faint">
          역할을 주면 씬의 하는쪽/당하는쪽 태그가 그 캐릭터에 자동으로 합쳐져요
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {chars.map((c, i) => {
          const current = roles?.[c.id] ?? null
          return (
            <div
              key={c.id}
              className="flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-1.5 py-1"
            >
              {c.thumbnail ? (
                <img
                  src={`data:image/webp;base64,${c.thumbnail}`}
                  className="size-6 shrink-0 rounded object-cover"
                  alt=""
                />
              ) : (
                <span className="grid size-6 shrink-0 place-items-center rounded bg-paper text-faint">
                  <User size={12} />
                </span>
              )}
              <span className="max-w-24 truncate text-[11.5px]">{charLabel(c, i)}</span>
              <div className="flex overflow-hidden rounded border border-line">
                {OPTIONS.map((o) => (
                  <button
                    key={o.label}
                    title={o.title}
                    className={cn(
                      'px-1.5 py-0.5 text-[10.5px] transition-colors',
                      current === o.value
                        ? o.value === null
                          ? 'bg-surface text-fg'
                          : 'bg-accent text-white'
                        : 'text-faint hover:bg-paper'
                    )}
                    onClick={() => setRole(c.id, o.value)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 캐릭터 위치 지정 (커스텀) — 위치 적용 on/off + 선택 캐릭터별 5x5 격자 오버라이드 */
function PositionPanel({
  characterIds,
  useCoords,
  positions,
  onPatch
}: {
  characterIds: number[]
  useCoords?: boolean
  positions?: CharPositions
  onPatch: (patch: SelectionPatch) => void
}): React.JSX.Element {
  const items = useCharactersStore((s) => s.items)
  const chars = characterIds
    .map((id) => items.find((c) => c.id === id))
    .filter((c): c is CharacterCard => !!c)

  const setPos = (id: number, c: { x: number; y: number }): void =>
    onPatch({ positions: { ...(positions ?? {}), [id]: c } })
  const resetPos = (id: number): void => {
    const next = { ...(positions ?? {}) }
    delete next[id]
    onPatch({ positions: next })
  }

  return (
    <div className="rounded-md border border-line bg-paper p-2">
      <div className="flex items-center gap-2">
        <Crosshair size={13} className="text-muted" />
        <span className="text-[12px] font-medium text-muted">위치 적용</span>
        <span className="text-[11px] text-faint">캐릭터 배치 좌표 (NAI 다중 캐릭터)</span>
        <div className="flex-1" />
        <Switch checked={!!useCoords} onCheckedChange={(v) => onPatch({ useCoords: v })} />
      </div>
      {useCoords &&
        (chars.length === 0 ? (
          <p className="mt-2 text-[11.5px] text-faint">
            캐릭터를 먼저 선택하면 위치를 지정할 수 있어요.
          </p>
        ) : (
          <div className="mt-2 flex flex-wrap gap-2">
            {chars.map((c, i) => {
              const pos = positions?.[c.id]
              const center = pos ?? c.center ?? { x: 0.5, y: 0.5 }
              return (
                <div
                  key={c.id}
                  className="flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-1.5 py-1"
                >
                  {c.thumbnail ? (
                    <img
                      src={`data:image/webp;base64,${c.thumbnail}`}
                      className="size-6 shrink-0 rounded object-cover"
                      alt=""
                    />
                  ) : (
                    <span className="grid size-6 shrink-0 place-items-center rounded bg-paper text-faint">
                      <User size={12} />
                    </span>
                  )}
                  <span className="max-w-24 truncate text-[11.5px]">{charLabel(c, i)}</span>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 gap-1 px-1.5 font-mono text-[10.5px]"
                        title="위치 지정"
                      >
                        <Crosshair size={11} />
                        {center.x},{center.y}
                        {!pos && <span className="text-faint">(기본)</span>}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto">
                      <PositionPicker center={center} onPick={(nc) => setPos(c.id, nc)} />
                    </PopoverContent>
                  </Popover>
                  {pos && (
                    <button
                      className="grid size-5 place-items-center rounded text-faint hover:text-fg"
                      title="카드 기본 위치로"
                      onClick={() => resetPos(c.id)}
                    >
                      <RotateCcw size={11} />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        ))}
    </div>
  )
}

/** 큐 반복 항목 편집 다이얼로그 */
export function SequenceDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  useLibraries(open)
  const entries = useSceneExtrasStore((s) => s.entries)
  const addEntry = useSceneExtrasStore((s) => s.addEntry)
  const updateEntry = useSceneExtrasStore((s) => s.updateEntry)
  const removeEntry = useSceneExtrasStore((s) => s.removeEntry)
  const clearEntries = useSceneExtrasStore((s) => s.clearEntries)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[86vh] max-w-[860px] flex-col">
        <div className="border-b border-line px-4 py-3">
          <DialogTitle>캐릭터 / 레퍼런스 큐 반복</DialogTitle>
          <DialogDescription className="mt-0.5">
            항목의 캐릭터·레퍼런스를 바꿔가며 예약 전체를 반복 생성합니다. 반복 중에는 메인 설정의
            캐릭터/레퍼런스가 적용되지 않습니다.
          </DialogDescription>
        </div>

        <div className="flex items-center gap-2 px-4 pt-3">
          <span className="text-[12px] text-muted">{entries.length}개 항목</span>
          <div className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            disabled={entries.length === 0}
            onClick={async () => {
              if (
                await askConfirm('전체 지우기', {
                  message: '큐 반복 항목을 모두 삭제합니다.',
                  confirmLabel: '지우기',
                  danger: true
                })
              )
                clearEntries()
            }}
          >
            <Trash2 size={13} /> 전체 지우기
          </Button>
          <Button size="sm" onClick={addEntry}>
            <Plus size={13} /> 항목 추가
          </Button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {entries.length === 0 && (
            <div className="rounded-lg border border-dashed border-line py-10 text-center text-[13px] text-faint">
              <Users size={22} className="mx-auto mb-2 opacity-50" />
              항목을 추가해 시작하세요
            </div>
          )}
          {entries.map((entry, index) => (
            <EntryEditor
              key={entry.id}
              entry={entry}
              index={index}
              onPatch={(patch) => updateEntry(entry.id, patch)}
              onRemove={() => removeEntry(entry.id)}
            />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function EntryEditor({
  entry,
  index,
  onPatch,
  onRemove
}: {
  entry: SequenceEntry
  index: number
  onPatch: (patch: Partial<SequenceEntry>) => void
  onRemove: () => void
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border border-line bg-surface-2',
        !entry.enabled && 'opacity-55'
      )}
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-accent/15 text-[12px] font-semibold text-accent">
          {index + 1}
        </span>
        <input
          className="h-7 w-48 rounded-md border border-line bg-paper px-2 text-[13px] outline-none focus:border-accent"
          value={entry.name}
          placeholder="항목 이름"
          onChange={(e) => onPatch({ name: e.target.value })}
        />
        <div className="flex-1" />
        {/* 캐릭터 2명 이상이면 "1명씩" 선택지 — 누르면 캐릭터마다 항목 1개로 쪼개져 한 명씩 돌아간다.
            안 누르면 지금처럼 한 항목에서 여러 명이 같이 그려진다 (커스텀) */}
        {entry.characterIds.length >= 2 && (
          <button
            className="flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-accent transition-colors hover:bg-surface"
            title="이 항목의 캐릭터를 1명씩 항목으로 나눠 한 명씩 차례로 그리게 합니다"
            onClick={() => {
              const chars = useCharactersStore.getState().items
              const replacements = entry.characterIds.map((cid, i) => ({
                ...entry,
                id: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
                name: chars.find((c) => c.id === cid)?.name?.trim() || `${entry.name} ${i + 1}`,
                characterIds: [cid],
                positions:
                  entry.positions?.[cid] != null ? { [cid]: entry.positions[cid] } : undefined
              }))
              useSceneExtrasStore.getState().replaceEntry(entry.id, replacements)
              toast(`${replacements.length}개 항목으로 분리 — 한 명씩 차례로 그립니다`, 'success')
            }}
          >
            <Split size={13} /> 1명씩 분리
          </button>
        )}
        <button
          className={cn(
            'grid size-7 place-items-center rounded-md transition-colors',
            entry.enabled ? 'text-accent hover:bg-surface' : 'text-faint hover:bg-surface'
          )}
          title={entry.enabled ? '이 항목 사용 중 (클릭: 제외)' : '제외됨 (클릭: 사용)'}
          onClick={() => onPatch({ enabled: !entry.enabled })}
        >
          {entry.enabled ? <Eye size={15} /> : <EyeOff size={15} />}
        </button>
        <button
          className="grid size-7 place-items-center rounded-md text-faint transition-colors hover:bg-surface hover:text-danger"
          title="항목 삭제"
          onClick={onRemove}
        >
          <Trash2 size={15} />
        </button>
      </div>
      <div className="p-3">
        <SelectionPanel
          characterIds={entry.characterIds}
          charRefIds={entry.charRefIds}
          vibeIds={entry.vibeIds}
          useCoords={entry.useCoords}
          positions={entry.positions}
          roles={entry.roles}
          onPatch={onPatch}
        />
      </div>
    </div>
  )
}

/** 씬별 캐릭터 추가 다이얼로그 — 여러 씬을 한 번에 설정 가능 (편집 모드 일괄) */
export function AdditionDialog({
  presetId,
  sceneIds,
  sceneName,
  onClose
}: {
  presetId: number
  sceneIds: number[] | null
  sceneName: string
  onClose: () => void
}): React.JSX.Element {
  const open = sceneIds != null && sceneIds.length > 0
  const firstId = sceneIds?.[0] ?? null
  useLibraries(open)
  // 대표(첫 씬)의 설정을 보여주고, 수정하면 모든 대상 씬에 동일하게 적용
  const addition = useSceneExtrasStore((s) =>
    firstId != null ? s.additions[presetId]?.[firstId] : undefined
  )
  const updateAddition = useSceneExtrasStore((s) => s.updateAddition)
  const clearAddition = useSceneExtrasStore((s) => s.clearAddition)

  const current: SceneAddition = addition ?? { characterIds: [], charRefIds: [], vibeIds: [] }
  const patch = (p: Partial<SceneAddition>): void => {
    if (!sceneIds) return
    const next = { ...current, ...p }
    for (const id of sceneIds) updateAddition(presetId, id, next)
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="flex max-h-[86vh] max-w-[860px] flex-col">
        <div className="border-b border-line px-4 py-3">
          <DialogTitle>씬별 캐릭터 추가{sceneName ? ` — ${sceneName}` : ''}</DialogTitle>
          <DialogDescription className="mt-0.5">
            {sceneIds && sceneIds.length > 1
              ? `선택한 ${sceneIds.length}개 씬 모두에 동일한 추가 캐릭터/레퍼런스를 설정합니다.`
              : '이 씬을 생성할 때만 추가로 적용할 캐릭터와 레퍼런스를 선택합니다.'}
          </DialogDescription>
        </div>
        <div className="flex items-center gap-2 px-4 pt-3">
          <span className="text-[12px] text-muted">
            캐릭터 {current.characterIds.length} · 캐릭레퍼 {current.charRefIds.length} · 바이브{' '}
            {current.vibeIds.length}
          </span>
          <div className="flex-1" />
          {/* 씬 여러 개 + 캐릭터 여러 명이면 "1명씩" 선택지 — 씬 순서대로 캐릭터를 한 명씩 배분.
              안 누르면 지금처럼 모든 씬에 전원이 함께 들어간다 (커스텀) */}
          {sceneIds != null && sceneIds.length >= 2 && current.characterIds.length >= 2 && (
            <Button
              size="sm"
              variant="ghost"
              className="text-accent"
              title="씬 순서대로 캐릭터를 1명씩 나눠 배정합니다 (씬1←캐릭1, 씬2←캐릭2…)"
              onClick={() => {
                // 씬 목록 순서대로 배분 (선택 순서가 아니라 보이는 순서)
                const order = useScenesStore.getState().scenes.map((s) => s.id)
                const targets = [...sceneIds].sort((a, b) => order.indexOf(a) - order.indexOf(b))
                const chars = current.characterIds
                targets.forEach((sid, i) => {
                  updateAddition(presetId, sid, {
                    ...current,
                    characterIds: [chars[i % chars.length]]
                  })
                })
                toast(`씬 ${targets.length}개에 1명씩 배분됨`, 'success')
              }}
            >
              <Split size={13} /> 씬마다 1명씩
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={!hasAddition(current)}
            onClick={() => {
              for (const id of sceneIds ?? []) clearAddition(presetId, id)
            }}
          >
            <Trash2 size={13} /> 비우기
          </Button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <SelectionPanel
            characterIds={current.characterIds}
            charRefIds={current.charRefIds}
            vibeIds={current.vibeIds}
            useCoords={current.useCoords}
            positions={current.positions}
            roles={current.roles}
            onPatch={patch}
          />
          {firstId != null && sceneIds?.length === 1 && <SceneRoleTagsEditor sceneId={firstId} />}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** 씬 행위 태그 편집 (커스텀) — 역할(하는쪽/당하는쪽)이 지정된 캐릭터에 합쳐질 태그.
 *  단일 씬을 열었을 때만 표시. 입력을 벗어나면 저장 */
function SceneRoleTagsEditor({ sceneId }: { sceneId: number }): React.JSX.Element | null {
  const scene = useScenesStore((s) => s.scenes.find((x) => x.id === sceneId))
  const update = useScenesStore((s) => s.update)
  if (!scene) return null
  return (
    <div className="rounded-md border border-line bg-paper p-2">
      <div className="flex items-center gap-2">
        <Split size={13} className="text-muted" />
        <span className="text-[12px] font-medium text-muted">씬 행위 태그</span>
        <span className="text-[11px] text-faint">
          역할이 지정된 캐릭터 프롬프트 뒤에 자동으로 합쳐짐. sex, fellatio처럼 그냥 쓰면
          source#/target#이 자동으로 붙어요 (포즈·표정 태그는 그대로)
        </span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="space-y-1">
          <span className="text-[11px] font-medium text-muted">하는쪽 태그</span>
          <textarea
            key={`src-${scene.id}`}
            defaultValue={scene.sourceTags}
            rows={3}
            spellCheck={false}
            placeholder="source#sex, source#missionary, on top, smirk …"
            className="w-full resize-y rounded-md border border-line bg-surface px-2 py-1.5 text-[12px] leading-relaxed outline-none focus:border-accent"
            onBlur={(e) => {
              if (e.target.value !== scene.sourceTags)
                void update(scene.id, { sourceTags: e.target.value })
            }}
          />
        </label>
        <label className="space-y-1">
          <span className="text-[11px] font-medium text-muted">당하는쪽 태그</span>
          <textarea
            key={`tgt-${scene.id}`}
            defaultValue={scene.targetTags}
            rows={3}
            spellCheck={false}
            placeholder="target#sex, target#missionary, lying, on back …"
            className="w-full resize-y rounded-md border border-line bg-surface px-2 py-1.5 text-[12px] leading-relaxed outline-none focus:border-accent"
            onBlur={(e) => {
              if (e.target.value !== scene.targetTags)
                void update(scene.id, { targetTags: e.target.value })
            }}
          />
        </label>
      </div>
    </div>
  )
}
