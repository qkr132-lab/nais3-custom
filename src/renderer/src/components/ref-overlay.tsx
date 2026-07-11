import {
  Check,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  ImagePlus,
  ListChecks,
  Pencil,
  Search,
  Trash2,
  X
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CharRefItem, CharRefType, VibeItem } from '@shared/types'
import { cn } from '../lib/utils'
import { buildDisplayRows } from '../lib/folder-list'
import { CHARREF_TYPES, refsStoreFor } from '../stores/refs-store'
import { askConfirm, askText } from '../stores/dialog-store'
import { toast } from '../stores/toast-store'
import { FolderListView } from './folder-list-view'
import { Button } from './ui/button'
import { ContextMenuItem, ContextMenuSeparator } from './ui/context-menu'
import { Input } from './ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Slider } from './ui/slider'
import { Switch } from './ui/switch'

/**
 * 바이브/캐릭레퍼 라이브러리 — 캐릭터 프롬프트와 동일한 얇은 카드 + 펼치기 방식.
 * 헤더: 토글 / 썸네일(호버 미리보기) / 이름. 펼치면 전체 이미지 + 파라미터.
 */
export function RefOverlay({ kind }: { kind: 'vibe' | 'charref' }): React.JSX.Element {
  const store = refsStoreFor(kind)
  const setOverlayOpen = store((s) => s.setOverlayOpen)
  const folders = store((s) => s.folders)
  const items = store((s) => s.items)
  const add = store((s) => s.add)
  const update = store((s) => s.update)
  const bulkUpdate = store((s) => s.bulkUpdate)
  const remove = store((s) => s.remove)
  const createFolder = store((s) => s.createFolder)
  const renameFolder = store((s) => s.renameFolder)
  const toggleCollapse = store((s) => s.toggleCollapse)
  const setFolderColor = store((s) => s.setFolderColor)
  const removeFolder = store((s) => s.removeFolder)
  const move = store((s) => s.move)

  const [search, setSearch] = useState('')
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [preview, setPreview] = useState<{ src: string; top: number; left: number } | null>(null)

  // ── 다중 선택 + 일괄 적용 ──────────────────────────────────────────
  const [selection, setSelection] = useState<Set<number>>(() => new Set())
  const anchorRef = useRef<number | null>(null)
  // 일괄 바에서 조절하는 값 + 어떤 필드를 적용할지 (건드린 것만 적용)
  const [batchType, setBatchType] = useState<CharRefType>('character')
  const [batchStrength, setBatchStrength] = useState(0.8)
  const [batchFidelity, setBatchFidelity] = useState(0.8)
  const [batchInfo, setBatchInfo] = useState(1)
  const [apply, setApply] = useState({ type: true, strength: true, fidelity: true, info: true })

  const searching = search.trim().length > 0
  const rows = useMemo(() => {
    const all = buildDisplayRows(folders, items as { id: number; folderId: number | null }[])
    if (!searching) return all
    const q = search.trim().toLowerCase()
    return all.filter(
      (r) => r.type === 'item' && (items.find((i) => i.id === r.item.id)?.name ?? '').toLowerCase().includes(q)
    )
  }, [folders, items, searching, search])

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  const enabledCount = items.filter((i) => i.enabled).length

  // 리스트에 실제로 보이는 아이템 순서 (Shift 범위 선택 기준)
  const visibleItemIds = useMemo(
    () => rows.flatMap((r) => (r.type === 'item' ? [r.item.id] : [])),
    [rows]
  )

  // 삭제·폴더이동 등으로 사라진 항목은 선택에서 제거
  useEffect(() => {
    setSelection((prev) => {
      if (prev.size === 0) return prev
      const valid = new Set(items.map((i) => i.id))
      const next = new Set<number>()
      for (const id of prev) if (valid.has(id)) next.add(id)
      return next.size === prev.size ? prev : next
    })
  }, [items])

  const toggleSelect = (id: number, range: boolean): void => {
    setSelection((prev) => {
      const next = new Set(prev)
      if (range && anchorRef.current != null) {
        const a = visibleItemIds.indexOf(anchorRef.current)
        const b = visibleItemIds.indexOf(id)
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a]
          for (let i = lo; i <= hi; i++) next.add(visibleItemIds[i])
          return next
        }
      }
      if (next.has(id)) next.delete(id)
      else next.add(id)
      anchorRef.current = id
      return next
    })
  }
  const selectAll = (): void => setSelection(new Set(visibleItemIds))
  const clearSelection = (): void => setSelection(new Set())

  const removeSelected = async (): Promise<void> => {
    const ids = [...selection]
    if (ids.length === 0) return
    if (ids.length > 1) {
      const ok = await askConfirm(`선택한 ${ids.length}개를 삭제할까요?`)
      if (!ok) return
    }
    for (const id of ids) remove(id)
    setSelection(new Set())
    toast(`${ids.length}개 삭제됨`, 'success')
  }

  // 여러 장 추가하면 방금 넣은 것들을 자동 선택 → 아래 바에서 바로 일괄 설정
  const addAndSelect = async (folderId: number | null): Promise<void> => {
    const before = new Set(store.getState().items.map((i) => i.id))
    await add(folderId)
    const fresh = store
      .getState()
      .items.filter((i) => !before.has(i.id))
      .map((i) => i.id)
    if (fresh.length >= 2) {
      setSelection(new Set(fresh))
      toast(`추가한 ${fresh.length}개 선택됨 — 아래 바에서 한 번에 설정`, 'success')
    }
  }

  const applyBatch = (): void => {
    const ids = [...selection]
    if (ids.length === 0) return
    const patch: Record<string, unknown> = {}
    if (kind === 'charref') {
      if (apply.type) patch.refType = batchType
      if (apply.strength) patch.strength = batchStrength
      if (apply.fidelity) patch.fidelity = batchFidelity
    } else {
      if (apply.strength) patch.strength = batchStrength
      if (apply.info) patch.infoExtracted = batchInfo
    }
    if (Object.keys(patch).length === 0) {
      toast('적용할 항목을 하나 이상 켜주세요', 'error')
      return
    }
    bulkUpdate(ids, patch)
    toast(`${ids.length}개에 적용됨`, 'success')
  }

  const showPreview = (e: React.MouseEvent, thumb: string): void => {
    const card = (e.currentTarget as HTMLElement).closest('[data-ref-card]')
    if (!card) return
    const rect = card.getBoundingClientRect()
    const size = 176
    const top = Math.max(8, Math.min(rect.top + rect.height / 2 - size / 2, window.innerHeight - size - 8))
    setPreview({ src: thumb, top, left: rect.right + 10 })
  }

  const renderHeader = (row: { id: number }): React.ReactNode => {
    const item = byId.get(row.id)
    if (!item) return null
    const selected = selection.has(item.id)
    const expanded = expandedId === item.id
    return (
      <div
        data-ref-card
        className={cn(
          'flex h-10 items-center gap-1.5 px-2',
          !item.enabled && !selected && 'opacity-55',
          selected && 'bg-accent-soft'
        )}
      >
        {/* 다중 선택 체크박스 (Shift+클릭 = 범위) — 히트 영역 넉넉하게 */}
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            toggleSelect(item.id, e.shiftKey)
          }}
          title="선택 (Shift+클릭 = 범위 선택)"
          className="grid size-8 shrink-0 place-items-center"
        >
          <span
            className={cn(
              'grid size-5 place-items-center rounded-md border transition-colors',
              selected
                ? 'border-accent bg-accent text-white'
                : 'border-muted/70 bg-surface-2 text-transparent hover:border-accent'
            )}
          >
            <Check size={14} strokeWidth={3} />
          </span>
        </button>
        {/* 전역 적용 스위치 */}
        <Switch
          checked={item.enabled}
          onCheckedChange={(v) => update(item.id, { enabled: v })}
          onPointerDown={(e) => e.stopPropagation()}
        />
        {/* 썸네일 클릭으로도 선택 토글 (큰 히트 영역) — 호버 미리보기는 유지 */}
        {item.thumbnail ? (
          <img
            src={`data:image/webp;base64,${item.thumbnail}`}
            className={cn(
              'size-7 shrink-0 cursor-pointer rounded object-cover',
              selected && 'ring-2 ring-accent'
            )}
            alt=""
            title="클릭해서 선택"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              toggleSelect(item.id, e.shiftKey)
            }}
            onMouseEnter={(e) => showPreview(e, item.thumbnail)}
            onMouseLeave={() => setPreview(null)}
          />
        ) : (
          <button
            className={cn(
              'grid size-7 shrink-0 place-items-center rounded bg-surface-2 text-faint',
              selected && 'ring-2 ring-accent'
            )}
            title="클릭해서 선택"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              toggleSelect(item.id, e.shiftKey)
            }}
          >
            <ImagePlus size={14} strokeWidth={1.5} />
          </button>
        )}
        {/* 이름 클릭 = 펼치기. chevron으로 "여기 눌러 편집"임을 드러낸다 */}
        <button
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-[13px] text-ink"
          onClick={() => setExpandedId(expanded ? null : item.id)}
          title="클릭하면 세부 설정(강도·충실도 등)이 열립니다"
        >
          {expanded ? (
            <ChevronDown size={13} className="shrink-0 text-faint" />
          ) : (
            <ChevronRight size={13} className="shrink-0 text-faint" />
          )}
          <span className="truncate">
            {item.name || <span className="text-faint">이름 없음</span>}
          </span>
        </button>
        {/* 바이브 인코딩 완료 표시 — 채워진 점=인코딩됨, 빈 점=생성 시 인코딩 예정 */}
        {kind === 'vibe' && (
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              (item as VibeItem).encodedReady ? 'bg-emerald-500' : 'border border-faint'
            )}
            title={(item as VibeItem).encodedReady ? '인코딩됨' : '미인코딩 (생성 시 인코딩, 2 Anlas)'}
          />
        )}
        {/* 타입 빠른 편집 (캐릭레퍼) — 펼치지 않고도 바로 변경 / 바이브는 강도 표시 */}
        {kind === 'charref' ? (
          <Select
            value={(item as CharRefItem).refType}
            onValueChange={(v) => update(item.id, { refType: v as CharRefType })}
          >
            <SelectTrigger
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              className="h-6 w-[96px] shrink-0 gap-1 px-1.5 text-[11px]"
              title="레퍼런스 유형"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CHARREF_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="shrink-0 font-mono text-[10px] text-faint">
            s{(item as VibeItem).strength.toFixed(2)}
          </span>
        )}
      </div>
    )
  }

  const renderExpanded = (row: { id: number }): React.ReactNode => {
    const item = byId.get(row.id)
    if (!item) return null
    return (
      <div className="flex flex-col gap-2 px-2 pb-2">
        {item.thumbnail && (
          <img
            src={`data:image/webp;base64,${item.thumbnail}`}
            className="max-h-48 w-full rounded-md border border-line object-contain"
            alt=""
          />
        )}
        <div className="flex gap-1.5">
          <Input
            className="h-7 flex-1 text-[12px]"
            value={item.name}
            placeholder="이름 (선택)"
            onChange={(e) => update(item.id, { name: e.target.value })}
          />
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 hover:text-danger" title="삭제" onClick={() => remove(item.id)}>
            <Trash2 size={13} />
          </Button>
        </div>
        {kind === 'vibe' ? (
          <VibeParams item={item as VibeItem} update={update} />
        ) : (
          <CharRefParams item={item as CharRefItem} update={update} />
        )}
      </div>
    )
  }

  const someSelected = selection.size > 0
  const allSelected = visibleItemIds.length > 0 && visibleItemIds.every((id) => selection.has(id))

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button size="icon" variant="ghost" className="h-7 w-7" title="닫기" onClick={() => setOverlayOpen(false)}>
          <X size={15} />
        </Button>
        <span className="text-[13px] font-medium">{kind === 'vibe' ? '바이브 트랜스퍼' : '캐릭터 레퍼런스'}</span>
        {enabledCount > 0 && (
          <span className="rounded-full bg-accent-soft px-1.5 font-mono text-[10.5px] text-accent">
            {enabledCount}
          </span>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        <div className="relative flex-1">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-faint" />
          <Input className="pl-7" value={search} placeholder="검색" onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Button size="sm" variant="ghost" title="폴더 추가" onClick={() => void createFolder('새 폴더')}>
          <FolderPlus size={14} />
        </Button>
        <Button size="sm" variant="accent" className="gap-1" onClick={() => void addAndSelect(null)}>
          <ImagePlus size={13} /> 추가
        </Button>
      </div>

      {/* 항상 보이는 선택 줄 — 첫 선택/전체취소를 한 번에 */}
      {items.length > 0 && (
        <div className="flex items-center gap-1 text-[11.5px]">
          <button
            onClick={allSelected ? clearSelection : selectAll}
            className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-muted transition-colors hover:bg-surface-2 hover:text-ink"
            title={allSelected ? '전체 선택 해제' : '전부 선택'}
          >
            <span
              className={cn(
                'grid size-4 place-items-center rounded border',
                allSelected
                  ? 'border-accent bg-accent text-white'
                  : someSelected
                    ? 'border-accent bg-accent/30 text-accent'
                    : 'border-muted/70 text-transparent'
              )}
            >
              <Check size={11} strokeWidth={3} />
            </span>
            {allSelected ? '전체 해제' : '전체 선택'}
          </button>
          {someSelected && (
            <>
              <span className="font-medium text-accent">{selection.size}개 선택됨</span>
              <button
                onClick={clearSelection}
                className="ml-auto rounded-md px-2 py-1 text-muted transition-colors hover:bg-surface-2 hover:text-ink"
              >
                선택 해제
              </button>
            </>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden no-scrollbar">
        <FolderListView
          rows={rows}
          searching={searching}
          expandedId={expandedId}
          folderActions={{
            rename: renameFolder,
            toggleCollapse,
            setColor: setFolderColor,
            remove: removeFolder,
            addItem: (folderId) => void addAndSelect(folderId)
          }}
          onMove={move}
          itemClassName={(row) =>
            cn(
              'transition-colors hover:border-muted/60', // F2
              byId.get(row.id)?.enabled && 'border-accent/60 bg-accent-soft' // F3
            )
          }
          renderHeader={renderHeader}
          renderExpanded={renderExpanded}
          itemContextMenu={(row) => {
            // 선택된 항목 위에서 우클릭 + 2개 이상이면 선택 전체를 대상으로
            const multi = selection.has(row.id) && selection.size > 1
            if (multi) {
              return (
                <>
                  <ContextMenuItem disabled>{selection.size}개 선택됨</ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem danger onSelect={() => void removeSelected()}>
                    <Trash2 size={13} /> 선택한 {selection.size}개 삭제
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={clearSelection}>
                    <X size={13} /> 선택 해제
                  </ContextMenuItem>
                </>
              )
            }
            return (
              <>
                <ContextMenuItem
                  onSelect={async () => {
                    const name = await askText('이름 변경', byId.get(row.id)?.name ?? '')
                    if (name != null) update(row.id, { name })
                  }}
                >
                  <Pencil size={13} /> 이름 변경
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem danger onSelect={() => remove(row.id)}>
                  <Trash2 size={13} /> 삭제
                </ContextMenuItem>
              </>
            )
          }}
          emptyText={items.length === 0 ? '이미지를 추가해보세요' : '검색 결과 없음'}
        />
      </div>

      {/* 다중 선택 일괄 적용 바 — 켠 항목만 선택 전부에 한 번에 적용 */}
      {selection.size > 0 && (
        <div className="shrink-0 rounded-lg border border-accent/40 bg-surface-2 p-2">
          <div className="mb-1.5 flex items-center gap-2 text-[12px]">
            <ListChecks size={14} className="text-accent" />
            <span className="font-medium">선택 {selection.size}개에 일괄 적용</span>
            <div className="flex-1" />
            <button className="text-muted hover:text-ink" title="선택 해제" onClick={clearSelection}>
              <X size={14} />
            </button>
          </div>
          <div className="flex flex-col gap-1.5">
            {kind === 'charref' && (
              <BatchRow
                on={apply.type}
                toggle={() => setApply((a) => ({ ...a, type: !a.type }))}
                label="타입"
              >
                <Select value={batchType} onValueChange={(v) => setBatchType(v as CharRefType)}>
                  <SelectTrigger className="h-7 flex-1 text-[12px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CHARREF_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </BatchRow>
            )}
            <BatchRow
              on={apply.strength}
              toggle={() => setApply((a) => ({ ...a, strength: !a.strength }))}
              label={`강도 ${batchStrength.toFixed(2)}`}
            >
              <Slider
                min={0}
                max={1}
                step={0.05}
                value={[batchStrength]}
                onValueChange={([v]) => setBatchStrength(Math.round(v * 100) / 100)}
              />
            </BatchRow>
            {kind === 'charref' ? (
              <BatchRow
                on={apply.fidelity}
                toggle={() => setApply((a) => ({ ...a, fidelity: !a.fidelity }))}
                label={`충실도 ${batchFidelity.toFixed(2)}`}
              >
                <Slider
                  min={0}
                  max={1}
                  step={0.05}
                  value={[batchFidelity]}
                  onValueChange={([v]) => setBatchFidelity(Math.round(v * 100) / 100)}
                />
              </BatchRow>
            ) : (
              <BatchRow
                on={apply.info}
                toggle={() => setApply((a) => ({ ...a, info: !a.info }))}
                label={`정보 ${batchInfo.toFixed(2)}`}
              >
                <Slider
                  min={0}
                  max={1}
                  step={0.05}
                  value={[batchInfo]}
                  onValueChange={([v]) => setBatchInfo(Math.round(v * 100) / 100)}
                />
              </BatchRow>
            )}
          </div>
          <Button size="sm" variant="accent" className="mt-2 w-full" onClick={applyBatch}>
            선택 {selection.size}개에 적용
          </Button>
        </div>
      )}

      {preview &&
        createPortal(
          <img
            src={`data:image/webp;base64,${preview.src}`}
            className="pointer-events-none fixed z-50 size-44 rounded-lg border border-line object-cover shadow-2xl"
            style={{ top: preview.top, left: preview.left }}
            alt=""
          />,
          document.body
        )}
    </div>
  )
}

function ParamRow({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-[11.5px] text-muted">{label}</span>
      {children}
    </div>
  )
}

/** 일괄 바의 한 줄 — 앞의 체크로 "이 항목을 적용할지"를 켜고 끈다 (꺼두면 기존 값 유지) */
function BatchRow({
  on,
  toggle,
  label,
  children
}: {
  on: boolean
  toggle: () => void
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={cn('flex items-center gap-2', !on && 'opacity-45')}>
      <button
        onClick={toggle}
        title={on ? '적용됨 — 끄면 이 항목은 그대로 유지' : '유지됨 — 켜면 이 값으로 적용'}
        className={cn(
          'grid size-4 shrink-0 place-items-center rounded border transition-colors',
          on ? 'border-accent bg-accent text-white' : 'border-line text-transparent'
        )}
      >
        <Check size={11} strokeWidth={3} />
      </button>
      <span className="w-16 shrink-0 text-[11.5px] text-muted">{label}</span>
      {children}
    </div>
  )
}

function VibeParams({
  item,
  update
}: {
  item: VibeItem
  update: (id: number, patch: Record<string, unknown>) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <ParamRow label={`강도 ${item.strength.toFixed(2)}`}>
        <Slider
          min={0}
          max={1}
          step={0.05}
          value={[item.strength]}
          onValueChange={([v]) => update(item.id, { strength: Math.round(v * 100) / 100 })}
        />
      </ParamRow>
      <ParamRow label={`정보 ${item.infoExtracted.toFixed(2)}`}>
        <Slider
          min={0}
          max={1}
          step={0.05}
          value={[item.infoExtracted]}
          onValueChange={([v]) => update(item.id, { infoExtracted: Math.round(v * 100) / 100 })}
        />
      </ParamRow>
      {!item.encodedReady && (
        <p className="text-[10.5px] text-faint">생성 시 인코딩 (2 Anlas, 이후 캐시)</p>
      )}
    </div>
  )
}

function CharRefParams({
  item,
  update
}: {
  item: CharRefItem
  update: (id: number, patch: Record<string, unknown>) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <ParamRow label="타입">
        <Select value={item.refType} onValueChange={(v) => update(item.id, { refType: v as CharRefType })}>
          <SelectTrigger className="h-7 flex-1 text-[12px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CHARREF_TYPES.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </ParamRow>
      <ParamRow label={`강도 ${item.strength.toFixed(2)}`}>
        <Slider
          min={0}
          max={1}
          step={0.05}
          value={[item.strength]}
          onValueChange={([v]) => update(item.id, { strength: Math.round(v * 100) / 100 })}
        />
      </ParamRow>
      <ParamRow label={`충실도 ${item.fidelity.toFixed(2)}`}>
        <Slider
          min={0}
          max={1}
          step={0.05}
          value={[item.fidelity]}
          onValueChange={([v]) => update(item.id, { fidelity: Math.round(v * 100) / 100 })}
        />
      </ParamRow>
    </div>
  )
}
