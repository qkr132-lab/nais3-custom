import { Eye, EyeOff, ImageOff, Link2, Plus, Trash2, User, Users, Waves } from 'lucide-react'
import { useEffect } from 'react'
import type { CharRefItem, CharacterCard, VibeItem } from '@shared/types'
import { useCharactersStore } from '../stores/characters-store'
import { useCharRefsStore, useVibesStore } from '../stores/refs-store'
import {
  hasAddition,
  useSceneExtrasStore,
  type SceneAddition,
  type SequenceEntry
} from '../stores/scene-extras-store'
import { askConfirm } from '../stores/dialog-store'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'

/**
 * 씬 모드 커스텀 확장 다이얼로그 (NAIS2 Custom 이식):
 * - SequenceDialog: 큐 반복 항목(캐릭터/캐릭레퍼/바이브 조합) 편집
 * - AdditionDialog: 특정 씬에만 추가 적용할 캐릭터/레퍼런스 선택
 */

const MAX_CHARS = 6 // NAI 동시 캐릭터 한도

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

/** 캐릭터 체크 리스트 (썸네일 + 이름 + 프롬프트 미리보기) */
function CharacterPicker({
  selected,
  onChange
}: {
  selected: number[]
  onChange: (ids: number[]) => void
}): React.JSX.Element {
  const items = useCharactersStore((s) => s.items)
  return (
    <div className="max-h-64 space-y-0.5 overflow-y-auto rounded-md border border-line bg-paper p-1">
      {items.length === 0 && (
        <p className="py-6 text-center text-[12px] text-faint">캐릭터 라이브러리가 비어 있습니다</p>
      )}
      {items.map((c, i) => {
        const checked = selected.includes(c.id)
        const full = !checked && selected.length >= MAX_CHARS
        return (
          <button
            key={c.id}
            disabled={full}
            onClick={() => onChange(toggleId(selected, c.id))}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors',
              checked ? 'bg-accent/10' : 'hover:bg-surface-2',
              full && 'opacity-40'
            )}
          >
            <span
              className={cn(
                'grid size-4 shrink-0 place-items-center rounded border text-[10px] leading-none',
                checked ? 'border-accent bg-accent text-white' : 'border-line bg-surface'
              )}
            >
              {checked && '✓'}
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
            {/* 연결된 캐릭레퍼가 있으면 표시 — 이 캐릭터 선택 시 레퍼런스도 자동 적용 */}
            {c.charRefId != null && (
              <Link2 size={11} className="shrink-0 text-accent" aria-label="레퍼런스 연결됨" />
            )}
          </button>
        )
      })}
    </div>
  )
}

/** 바이브/캐릭레퍼 이미지 그리드 멀티 선택 */
function RefPicker({
  items,
  selected,
  onChange,
  emptyLabel
}: {
  items: (VibeItem | CharRefItem)[]
  selected: number[]
  onChange: (ids: number[]) => void
  emptyLabel: string
}): React.JSX.Element {
  return (
    <div className="max-h-64 overflow-y-auto rounded-md border border-line bg-paper p-1.5">
      {items.length === 0 ? (
        <p className="py-6 text-center text-[12px] text-faint">{emptyLabel}</p>
      ) : (
        <div className="grid grid-cols-3 gap-1.5">
          {items.map((item) => {
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
          })}
        </div>
      )}
    </div>
  )
}

/** 캐릭터+캐릭레퍼+바이브 3열 선택 패널 (두 다이얼로그 공용) */
function SelectionPanel({
  characterIds,
  charRefIds,
  vibeIds,
  onPatch
}: {
  characterIds: number[]
  charRefIds: number[]
  vibeIds: number[]
  onPatch: (patch: { characterIds?: number[]; charRefIds?: number[]; vibeIds?: number[] }) => void
}): React.JSX.Element {
  const vibes = useVibesStore((s) => s.items)
  const crefs = useCharRefsStore((s) => s.items)
  return (
    <div className="grid grid-cols-3 gap-3">
      <div className="space-y-1.5">
        <SectionTitle icon={<User size={13} />} title="캐릭터" count={characterIds.length} />
        <CharacterPicker selected={characterIds} onChange={(ids) => onPatch({ characterIds: ids })} />
      </div>
      <div className="space-y-1.5">
        <SectionTitle icon={<Users size={13} />} title="캐릭터 레퍼런스" count={charRefIds.length} />
        <RefPicker
          items={crefs}
          selected={charRefIds}
          onChange={(ids) => onPatch({ charRefIds: ids })}
          emptyLabel="캐릭레퍼가 없습니다"
        />
      </div>
      <div className="space-y-1.5">
        <SectionTitle icon={<Waves size={13} />} title="바이브" count={vibeIds.length} />
        <RefPicker
          items={vibes}
          selected={vibeIds}
          onChange={(ids) => onPatch({ vibeIds: ids })}
          emptyLabel="바이브가 없습니다"
        />
      </div>
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
            항목의 캐릭터·레퍼런스를 바꿔가며 예약 전체를 반복 생성합니다. 반복 중에는 메인
            설정의 캐릭터/레퍼런스가 적용되지 않습니다.
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
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <SelectionPanel
            characterIds={current.characterIds}
            charRefIds={current.charRefIds}
            vibeIds={current.vibeIds}
            onPatch={patch}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
