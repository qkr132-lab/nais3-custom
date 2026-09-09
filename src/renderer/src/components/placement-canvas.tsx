import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react'
import { AlignHorizontalJustifyCenter, AlignVerticalJustifyCenter, Crosshair } from 'lucide-react'
import { cn } from '../lib/utils'
import {
  PLACEMENT_GRID,
  fitPlacementCanvas,
  normalizePosition,
  normalizedCoordinate,
  nudgePosition,
  positionFromPointer,
  type PlacementPoint
} from '../lib/placement-geometry'
import { Button } from './ui/button'
import { Input } from './ui/input'

export interface PlacementChar {
  id: number
  label: string
  center: PlacementPoint
  thumbnail?: string
  isDefault?: boolean
  tags?: string
  extraTags?: string
}

function CoordinateInput({
  axis,
  value,
  freeform,
  disabled,
  onCommit
}: {
  axis: 'x' | 'y'
  value: number
  freeform: boolean
  disabled: boolean
  onCommit: (value: number) => void
}): React.JSX.Element {
  // Preserve partial input instead of rounding while the user is still typing.
  const [draft, setDraft] = useState<string | null>(null)
  const cancel = useRef(false)
  return (
    <label className="flex min-w-0 items-center gap-1 font-mono text-[11px] text-muted">
      {axis.toUpperCase()}
      <Input
        type="number"
        inputMode="decimal"
        aria-label={axis.toUpperCase() + ' 좌표'}
        className="h-7 min-w-0 px-1.5 font-mono text-[11.5px] tabular-nums disabled:opacity-50"
        min={freeform ? 0 : 0.1}
        max={freeform ? 1 : 0.9}
        step={freeform ? 0.01 : 0.2}
        disabled={disabled}
        value={draft ?? value.toFixed(3)}
        onFocus={() => setDraft(value.toFixed(3))}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={(event) => {
          const text = event.currentTarget.value.trim()
          const next = Number(text)
          if (!cancel.current && text && Number.isFinite(next)) {
            const normalized = normalizedCoordinate(next, freeform)
            if (normalized !== value) onCommit(normalized)
          }
          cancel.current = false
          setDraft(null)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            cancel.current = true
            event.currentTarget.blur()
          } else if (event.key === 'Enter') {
            event.preventDefault()
            event.currentTarget.blur()
          }
        }}
      />
    </label>
  )
}

interface DragSession {
  id: number
  pointerId: number
  offset: PlacementPoint
  center: PlacementPoint
  origin: PlacementPoint
}

/** A fixed viewport holds a fitted image plane; markers and editors never resize it. */
export function PlacementCanvas({
  chars,
  width,
  height,
  freeform,
  selectedId,
  onSelect,
  onMove,
  onDistribute,
  maxHeight = 'min(58vh, 520px)',
  fill = false
}: {
  chars: PlacementChar[]
  width: number
  height: number
  freeform: boolean
  selectedId?: number | null
  onSelect?: (id: number) => void
  onMove: (id: number, center: PlacementPoint) => void
  onDistribute?: (axis: 'x' | 'y') => void
  maxHeight?: string
  /** Fit the height supplied by a min-h-0 parent. */
  fill?: boolean
}): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const drag = useRef<DragSession | null>(null)
  const [dragPreview, setDragPreview] = useState<{ id: number; center: PlacementPoint } | null>(
    null
  )
  const [hoverId, setHoverId] = useState<number | null>(null)
  const [showAllLabels, setShowAllLabels] = useState<boolean | null>(null)
  const [localSelectedId, setLocalSelectedId] = useState<number | null>(null)
  const [available, setAvailable] = useState({ width: 0, height: 0 })
  const helpId = useId()
  const activeId = selectedId === undefined ? localSelectedId : selectedId
  const selected = chars.find((char) => char.id === activeId)
  const hovered = chars.find((char) => char.id === hoverId)
  const size = fitPlacementCanvas(available.width, available.height, width, height)
  // Dense or tall layouts need clear marker centers, not dozens of overlapping text boxes.
  const labelsVisible = showAllLabels ?? (chars.length < 8 && size.width >= 240)
  const centerOf = (char: PlacementChar): PlacementPoint =>
    dragPreview?.id === char.id ? dragPreview.center : normalizePosition(char.center, true)
  const selectedCenter = selected ? centerOf(selected) : { x: 0.5, y: 0.5 }

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const measure = (): void => {
      const rect = viewport.getBoundingClientRect()
      setAvailable((previous) =>
        Math.abs(previous.width - rect.width) < 0.25 &&
        Math.abs(previous.height - rect.height) < 0.25
          ? previous
          : { width: rect.width, height: rect.height }
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  const select = (id: number): void => {
    setLocalSelectedId(id)
    onSelect?.(id)
  }

  const movePointer = useCallback(
    (pointerId: number, clientX: number, clientY: number) => {
      const session = drag.current
      const box = boxRef.current?.getBoundingClientRect()
      if (!session || session.pointerId !== pointerId || !box) return
      const center = positionFromPointer(clientX, clientY, box, freeform, session.offset)
      if (!center) return
      session.center = center
      setDragPreview({ id: session.id, center })
    },
    [freeform]
  )

  const finishDrag = (pointerId: number): void => {
    const session = drag.current
    if (!session || session.pointerId !== pointerId) return
    drag.current = null
    if (session.center.x !== session.origin.x || session.center.y !== session.origin.y) {
      onMove(session.id, session.center)
    }
    setDragPreview(null)
  }

  const ticksX = size.width < 220 ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1]
  const ticksY = size.height < 180 ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1]
  const grid = freeform ? [0.25, 0.5, 0.75] : PLACEMENT_GRID

  return (
    <div
      className={cn(
        'flex min-h-0 min-w-0 max-w-full flex-col gap-2',
        fill ? 'h-full w-full' : 'flex-1 basis-[340px]'
      )}
    >
      <div
        className={cn(
          'relative min-h-0 overflow-hidden rounded-lg border border-line bg-surface-2',
          fill ? 'flex-1' : 'shrink-0'
        )}
        style={fill ? undefined : { height: maxHeight }}
      >
        <div
          ref={viewportRef}
          className="absolute bottom-7 left-11 right-6 top-8 grid place-items-center"
        >
          <div
            ref={boxRef}
            role="group"
            aria-label="캐릭터 위치 캔버스"
            aria-describedby={helpId}
            className="relative shrink-0 rounded-sm bg-paper ring-1 ring-line"
            style={{
              width: size.width,
              height: size.height,
              visibility: size.width ? 'visible' : 'hidden'
            }}
          >
            <span className="pointer-events-none absolute -left-9 -top-6 font-mono text-[10px] text-muted">
              Y ↓
            </span>
            {ticksX.map((tick) => (
              <span
                key={'x' + tick}
                className="pointer-events-none absolute -top-6 -translate-x-1/2 font-mono text-[10px] tabular-nums text-muted"
                style={{ left: tick * 100 + '%' }}
              >
                {tick.toFixed(2)}
              </span>
            ))}
            {ticksY.map((tick) => (
              <span
                key={'y' + tick}
                className="pointer-events-none absolute -left-9 -translate-y-1/2 font-mono text-[10px] tabular-nums text-muted"
                style={{ top: tick * 100 + '%' }}
              >
                {tick.toFixed(2)}
              </span>
            ))}
            <span className="pointer-events-none absolute -bottom-5 right-0 font-mono text-[10px] text-muted">
              X →
            </span>
            {grid.map((position) => (
              <div key={position} className="pointer-events-none">
                <div
                  className="absolute inset-y-0 w-px bg-line/70"
                  style={{ left: position * 100 + '%' }}
                />
                <div
                  className="absolute inset-x-0 h-px bg-line/70"
                  style={{ top: position * 100 + '%' }}
                />
              </div>
            ))}
            {selected && (
              <div className="pointer-events-none" aria-hidden="true">
                <div
                  className="absolute inset-y-0 border-l border-dashed border-accent/50"
                  style={{ left: selectedCenter.x * 100 + '%' }}
                />
                <div
                  className="absolute inset-x-0 border-t border-dashed border-accent/50"
                  style={{ top: selectedCenter.y * 100 + '%' }}
                />
              </div>
            )}
            {chars.map((char, index) => {
              const center = centerOf(char)
              const isSelected = activeId === char.id
              return (
                <button
                  key={char.id}
                  type="button"
                  aria-label={
                    char.label + ', X ' + center.x.toFixed(3) + ', Y ' + center.y.toFixed(3)
                  }
                  aria-pressed={isSelected}
                  aria-describedby={helpId}
                  className={cn(
                    'absolute grid size-7 -translate-x-1/2 -translate-y-1/2 touch-none select-none place-items-center rounded-full border-2 font-mono text-[11px] shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 active:cursor-grabbing',
                    isSelected
                      ? 'z-10 cursor-grab border-accent bg-accent text-white'
                      : 'z-[1] cursor-grab border-line bg-surface-2 text-ink hover:z-[5] hover:border-accent'
                  )}
                  style={{ left: center.x * 100 + '%', top: center.y * 100 + '%' }}
                  onFocus={() => select(char.id)}
                  onPointerEnter={() => !drag.current && setHoverId(char.id)}
                  onPointerLeave={() => setHoverId((id) => (id === char.id ? null : id))}
                  onPointerDown={(event) => {
                    if (event.button !== 0 || !event.isPrimary || drag.current) return
                    const box = boxRef.current?.getBoundingClientRect()
                    if (!box?.width || !box.height) return
                    event.preventDefault()
                    event.stopPropagation()
                    event.currentTarget.focus()
                    event.currentTarget.setPointerCapture(event.pointerId)
                    drag.current = {
                      id: char.id,
                      pointerId: event.pointerId,
                      offset: {
                        x: event.clientX - box.left - center.x * box.width,
                        y: event.clientY - box.top - center.y * box.height
                      },
                      center,
                      origin: center
                    }
                    setHoverId(null)
                    select(char.id)
                  }}
                  onPointerMove={(event) =>
                    movePointer(event.pointerId, event.clientX, event.clientY)
                  }
                  onPointerUp={(event) => {
                    movePointer(event.pointerId, event.clientX, event.clientY)
                    finishDrag(event.pointerId)
                    if (event.currentTarget.hasPointerCapture(event.pointerId))
                      event.currentTarget.releasePointerCapture(event.pointerId)
                  }}
                  onPointerCancel={(event) => finishDrag(event.pointerId)}
                  onLostPointerCapture={(event) => finishDrag(event.pointerId)}
                  onKeyDown={(event) => {
                    const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1
                    const axis = event.key === 'ArrowLeft' || event.key === 'ArrowRight' ? 'x' : 'y'
                    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
                      event.preventDefault()
                      event.stopPropagation()
                      const step = event.shiftKey ? 0.1 : event.altKey ? 0.001 : 0.01
                      onMove(char.id, nudgePosition(center, axis, direction, freeform, step))
                    } else if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      select(char.id)
                    }
                  }}
                >
                  {char.thumbnail ? (
                    <img
                      src={'data:image/webp;base64,' + char.thumbnail}
                      draggable={false}
                      className="size-full rounded-full object-cover"
                      alt=""
                    />
                  ) : (
                    index + 1
                  )}
                  {(labelsVisible || isSelected || hoverId === char.id) && (
                    <span
                      className={cn(
                        'pointer-events-none absolute w-max max-w-[126px] rounded border bg-paper/95 px-1.5 py-0.5 text-left font-sans text-[10px] shadow-sm',
                        center.x > 0.5 ? 'right-8' : 'left-8',
                        isSelected ? 'border-accent/50 text-accent' : 'border-line text-muted'
                      )}
                    >
                      <span className="block truncate">
                        {char.label}
                        {char.isDefault ? ' (기본)' : ''}
                      </span>
                      <span className="block font-mono text-[9px] tabular-nums">
                        {center.x.toFixed(3)} / {center.y.toFixed(3)}
                      </span>
                    </span>
                  )}
                </button>
              )
            })}
            {!chars.length && (
              <div className="absolute inset-0 grid place-items-center px-2 text-center text-[12px] text-faint">
                배치할 캐릭터가 없습니다
              </div>
            )}
          </div>
        </div>
        {hovered && (hovered.tags?.trim() || hovered.extraTags?.trim()) && (
          <div className="pointer-events-none absolute bottom-1 left-1 right-1 z-20 max-h-32 overflow-hidden rounded-md border border-line bg-surface-2 px-2 py-1.5 shadow-lg">
            <p className="truncate text-[11px] font-medium text-ink">{hovered.label}</p>
            <p className="mt-0.5 max-h-16 overflow-hidden break-words text-[11px] leading-relaxed text-muted">
              {hovered.tags?.trim() || '태그 없음'}
            </p>
            {hovered.extraTags?.trim() && (
              <p className="mt-1 break-words text-[11px] text-emerald-500">
                + {hovered.extraTags.trim()}
              </p>
            )}
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-col gap-1.5 rounded-lg border border-line bg-paper p-2">
        <div className="flex h-4 min-w-0 items-center gap-1.5 text-[11.5px]">
          <Crosshair size={12} className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1 truncate font-medium">
            {selected?.label ?? '표식을 선택해 위치를 조절하세요'}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-faint">
            {width}×{height}
          </span>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2">
          {(['x', 'y'] as const).map((axis) => (
            <CoordinateInput
              key={String(selected?.id ?? 'empty') + '-' + axis}
              axis={axis}
              value={selectedCenter[axis]}
              freeform={freeform}
              disabled={!selected || !!dragPreview}
              onCommit={(value) =>
                selected &&
                onMove(
                  selected.id,
                  normalizePosition({ ...selectedCenter, [axis]: value }, freeform)
                )
              }
            />
          ))}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11px]"
            disabled={!selected}
            onClick={() => selected && onMove(selected.id, { x: 0.5, y: 0.5 })}
          >
            가운데
          </Button>
        </div>
        <p id={helpId} className="min-h-8 text-[10px] leading-4 text-muted">
          {freeform
            ? 'X 왼쪽 0 → 오른쪽 1 · Y 위 0 → 아래 1'
            : '5×5 격자 · 0.1 / 0.3 / 0.5 / 0.7 / 0.9로 맞춤'}
          <br />
          {freeform
            ? '표식 드래그 · 방향키 0.01 · Shift 0.1 · Alt 0.001 · 입력 후 Enter'
            : '표식 드래그 · 방향키 한 칸 · 숫자 입력 후 Enter'}
        </p>
      </div>
      <div className="flex h-7 shrink-0 items-center gap-1.5">
        {onDistribute && (
          <>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={chars.length < 2}
              className="h-7 gap-1 px-2 text-[11px]"
              title="세로로 균등 배치"
              onClick={() => onDistribute('y')}
            >
              <AlignVerticalJustifyCenter size={14} /> 세로 균등
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={chars.length < 2}
              className="h-7 gap-1 px-2 text-[11px]"
              title="가로로 균등 배치"
              onClick={() => onDistribute('x')}
            >
              <AlignHorizontalJustifyCenter size={14} /> 가로 균등
            </Button>
          </>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={!chars.length}
          aria-label="모든 표식의 이름과 좌표 표시"
          aria-pressed={labelsVisible}
          className={cn(
            'ml-auto h-7 shrink-0 px-2 text-[10px]',
            labelsVisible && 'bg-accent-soft text-accent'
          )}
          title={
            labelsVisible
              ? '선택하거나 마우스를 올린 표식만 이름과 좌표 표시'
              : '모든 표식의 이름과 좌표 표시'
          }
          onClick={() => setShowAllLabels(!labelsVisible)}
        >
          이름·좌표
        </Button>
      </div>
    </div>
  )
}
