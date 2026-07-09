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
import {
  FileText,
  FolderOpen,
  ImagePlus,
  ImageUp,
  MoreVertical,
  Palette,
  Pencil,
  Trash2
} from 'lucide-react'
import { memo, useEffect, useState, type CSSProperties } from 'react'
import type { LibraryImage } from '@shared/types'
import { imageUrl } from '../lib/constants'
import { cn } from '../lib/utils'
import { askConfirm, askText } from '../stores/dialog-store'
import { setI2iSource } from '../stores/generation-store'
import { useLayoutStore } from '../stores/layout-store'
import { useLibraryStore } from '../stores/library-store'
import { useMetadataStore } from '../stores/metadata-store'
import { toast } from '../stores/toast-store'
import { StyleAnalysisDialog } from './style-analysis-dialog'
import { Button } from './ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from './ui/context-menu'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

/**
 * 라이브러리 모드 (NAIS2 Library 이식) — 참고 이미지 모음.
 * 추가(다이얼로그/드래그 앤 드롭), 드래그 정렬, 메타데이터 보기, i2i 소스, 스타일 태그 분석.
 */
export function LibraryMode(): React.JSX.Element {
  const items = useLibraryStore((s) => s.items)
  const loaded = useLibraryStore((s) => s.loaded)
  const load = useLibraryStore((s) => s.load)
  const add = useLibraryStore((s) => s.add)
  const addFromPaths = useLibraryStore((s) => s.addFromPaths)
  const reorder = useLibraryStore((s) => s.reorder)
  const columns = useLibraryStore((s) => s.columns)
  const setColumns = useLibraryStore((s) => s.setColumns)
  const editMode = useLibraryStore((s) => s.editMode)
  const setEditMode = useLibraryStore((s) => s.setEditMode)
  const selection = useLibraryStore((s) => s.selection)
  const selectAll = useLibraryStore((s) => s.selectAll)
  const clearSelection = useLibraryStore((s) => s.clearSelection)
  const remove = useLibraryStore((s) => s.remove)

  const [analysisPath, setAnalysisPath] = useState<string | null>(null)
  const [dragItem, setDragItem] = useState<LibraryImage | null>(null)
  const [dropHover, setDropHover] = useState(false)

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const onDragStart = (e: DragStartEvent): void => {
    setDragItem(items.find((i) => `lib-${i.id}` === e.active.id) ?? null)
  }
  const onDragEnd = (e: DragEndEvent): void => {
    setDragItem(null)
    const { active, over } = e
    if (!over || active.id === over.id) return
    const ids = items.map((i) => `lib-${i.id}`)
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from < 0 || to < 0) return
    void reorder(arrayMove(items, from, to).map((i) => i.id))
  }

  // 파일 드래그 앤 드롭 추가
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setDropHover(false)
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.nais.pathForFile(f))
      .filter(Boolean)
    if (paths.length > 0) void addFromPaths(paths)
  }

  return (
    <div
      className={cn(
        'flex min-h-0 flex-1 flex-col rounded-xl border bg-surface transition-colors',
        dropHover ? 'border-accent' : 'border-line'
      )}
      onDragOver={(e) => {
        e.preventDefault()
        setDropHover(true)
      }}
      onDragLeave={() => setDropHover(false)}
      onDrop={onDrop}
    >
      {/* 툴바 */}
      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        <Button size="sm" onClick={() => void add()}>
          <ImagePlus size={13} /> 이미지 추가
        </Button>
        <span className="ml-1 text-[12px] text-faint">{items.length}개 · 드래그로 추가 가능</span>
        <div className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setEditMode(!editMode)}
              className={cn(
                'grid size-8 place-items-center rounded-md transition-colors',
                editMode ? 'bg-accent text-white' : 'text-muted hover:bg-surface-2 hover:text-fg'
              )}
            >
              <Pencil size={16} />
            </button>
          </TooltipTrigger>
          <TooltipContent>편집 모드</TooltipContent>
        </Tooltip>
        <div className="flex items-center gap-0.5 rounded-md bg-surface-2 p-0.5">
          {[3, 4, 5, 6].map((n) => (
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

      {/* 편집 모드 바 */}
      {editMode && (
        <div className="flex items-center gap-1.5 border-b border-line bg-surface-2 px-3 py-2 text-[13px]">
          <span className="font-medium">{selection.size}개 선택</span>
          <Button size="sm" variant="ghost" onClick={selectAll}>
            전체 선택
          </Button>
          <Button size="sm" variant="ghost" onClick={clearSelection} disabled={selection.size === 0}>
            해제
          </Button>
          <div className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            className="text-danger"
            disabled={selection.size === 0}
            onClick={async () => {
              if (
                await askConfirm('이미지 삭제', {
                  message: `선택한 ${selection.size}개 이미지를 라이브러리에서 삭제합니다.`,
                  confirmLabel: '삭제',
                  danger: true
                })
              )
                void remove([...selection])
            }}
          >
            <Trash2 size={13} /> 삭제
          </Button>
        </div>
      )}

      {/* 그리드 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3 no-scrollbar">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={onDragStart}
          onDragCancel={() => setDragItem(null)}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={items.map((i) => `lib-${i.id}`)} strategy={rectSortingStrategy}>
            <div
              className="grid gap-3"
              style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
            >
              {items.map((item) => (
                <LibraryCard key={item.id} item={item} onAnalyze={setAnalysisPath} />
              ))}
              <button
                onClick={() => void add()}
                className="flex aspect-square flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-line text-faint transition hover:text-accent"
              >
                <ImagePlus size={22} />
                <span className="text-[12px]">이미지 추가</span>
              </button>
            </div>
          </SortableContext>
          <DragOverlay dropAnimation={null}>
            {dragItem && (
              <div className="aspect-square overflow-hidden rounded-lg border border-accent bg-surface-2 shadow-2xl">
                {dragItem.thumbnail && (
                  <img
                    src={`data:image/webp;base64,${dragItem.thumbnail}`}
                    className="h-full w-full object-cover"
                    draggable={false}
                    alt=""
                  />
                )}
              </div>
            )}
          </DragOverlay>
        </DndContext>
        {items.length === 0 && loaded && (
          <p className="mt-6 text-center text-[13px] text-faint">
            참고 이미지를 모아두는 라이브러리입니다. 추가한 이미지는 메타데이터 보기 · i2i 소스 ·
            스타일 태그 분석에 쓸 수 있어요. 파일을 끌어다 놓아도 추가됩니다.
          </p>
        )}
      </div>

      <StyleAnalysisDialog filePath={analysisPath} onClose={() => setAnalysisPath(null)} />
    </div>
  )
}

function dndStyle(sortable: ReturnType<typeof useSortable>): CSSProperties {
  const t = sortable.transform
  return {
    transform: t ? `translate3d(${Math.round(t.x)}px, ${Math.round(t.y)}px, 0)` : undefined,
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0 : undefined
  }
}

const LibraryCard = memo(function LibraryCard({
  item,
  onAnalyze
}: {
  item: LibraryImage
  onAnalyze: (filePath: string) => void
}): React.JSX.Element {
  const editMode = useLibraryStore((s) => s.editMode)
  const checked = useLibraryStore((s) => s.selection.has(item.id))
  const toggleSelected = useLibraryStore((s) => s.toggleSelected)
  const selectRangeTo = useLibraryStore((s) => s.selectRangeTo)
  const rename = useLibraryStore((s) => s.rename)
  const remove = useLibraryStore((s) => s.remove)
  const sortable = useSortable({ id: `lib-${item.id}` })

  const src = item.thumbnail ? `data:image/webp;base64,${item.thumbnail}` : imageUrl(item.filePath)

  const showMetadata = (): void => {
    void useMetadataStore.getState().show({ filePath: item.filePath })
  }
  const useAsSource = async (): Promise<void> => {
    await setI2iSource(item.filePath)
    useLayoutStore.getState().setCenterMode('main')
    toast('i2i 소스로 설정됨', 'success')
  }
  const renameItem = async (): Promise<void> => {
    const name = await askText('이미지 이름', item.name)
    if (name) void rename(item.id, name)
  }
  const removeItem = async (): Promise<void> => {
    if (
      await askConfirm('이미지 삭제', {
        message: `"${item.name}"을(를) 라이브러리에서 삭제합니다.`,
        confirmLabel: '삭제',
        danger: true
      })
    )
      void remove([item.id])
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={sortable.setNodeRef}
          {...sortable.attributes}
          {...sortable.listeners}
          className={cn(
            'group relative aspect-square touch-none overflow-hidden rounded-lg border bg-surface-2 transition',
            editMode && checked ? 'border-accent ring-2 ring-accent/40' : 'border-line',
            sortable.isDragging && 'shadow-xl'
          )}
          style={dndStyle(sortable)}
          onClick={(e) =>
            editMode
              ? e.shiftKey
                ? selectRangeTo(item.id)
                : toggleSelected(item.id)
              : showMetadata()
          }
        >
          <img
            src={src}
            className="h-full w-full cursor-pointer object-cover"
            draggable={false}
            alt=""
          />

          {/* 편집 모드 체크 / 3점 메뉴 */}
          {editMode ? (
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
              <PopoverContent align="end" className="w-44 p-1" onClick={(e) => e.stopPropagation()}>
                <LibMenuItem icon={<FileText size={13} />} label="메타데이터 보기" onClick={showMetadata} />
                <LibMenuItem icon={<ImageUp size={13} />} label="i2i 소스로" onClick={() => void useAsSource()} />
                <LibMenuItem icon={<Palette size={13} />} label="스타일 태그 분석" onClick={() => onAnalyze(item.filePath)} />
                <LibMenuItem
                  icon={<FolderOpen size={13} />}
                  label="파일 위치 열기"
                  onClick={() => void window.nais.invoke('images:showInFolder', { filePath: item.filePath })}
                />
                <LibMenuItem icon={<Pencil size={13} />} label="이름 변경" onClick={() => void renameItem()} />
                <LibMenuItem icon={<Trash2 size={13} />} label="삭제" danger onClick={() => void removeItem()} />
              </PopoverContent>
            </Popover>
          )}

          {/* 이름 */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-2 pb-1.5 pt-6">
            <div className="truncate text-[12px] font-medium text-white drop-shadow">{item.name}</div>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={showMetadata}>
          <FileText size={13} /> 메타데이터 보기
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void useAsSource()}>
          <ImageUp size={13} /> i2i 소스로
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onAnalyze(item.filePath)}>
          <Palette size={13} /> 스타일 태그 분석
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => void window.nais.invoke('images:showInFolder', { filePath: item.filePath })}
        >
          <FolderOpen size={13} /> 파일 위치 열기
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void renameItem()}>
          <Pencil size={13} /> 이름 변경
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem danger onSelect={() => void removeItem()}>
          <Trash2 size={13} /> 삭제
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
})

function LibMenuItem({
  icon,
  label,
  onClick,
  danger
}: {
  icon: React.ReactNode
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
