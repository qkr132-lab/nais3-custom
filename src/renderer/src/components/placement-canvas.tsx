import { useCallback, useRef, useState } from 'react'
import { AlignHorizontalJustifyCenter, AlignVerticalJustifyCenter } from 'lucide-react'
import { cn } from '../lib/utils'
import { POSITION_GRID } from './position-picker'
import { Button } from './ui/button'

/**
 * 캐릭터 배치 캔버스 (커스텀) — 메인 '배치' 탭과 씬 위치 지정 창이 함께 쓴다.
 *
 * 실제 생성 비율대로 그린 판 위에 인물 표식을 올려놓고 끌어서 옮긴다.
 * V5는 연속 좌표, V4.5는 5×5 격자만 허용하므로 스냅 여부가 갈린다.
 */

export interface PlacementChar {
  id: number
  label: string
  center: { x: number; y: number }
  thumbnail?: string
  /** 이 씬에서만 쓰는 좌표가 아니라 카드 기본 좌표를 그대로 쓰는 중 */
  isDefault?: boolean
  /** 커서를 올렸을 때 보여줄 태그 (커스텀) — 이 표식이 어떤 캐릭터인지 판에서 바로 확인 */
  tags?: string
  /** 자리 추가 태그처럼 이 자리에서만 덧붙는 태그 (커스텀) */
  extraTags?: string
}

export function round3(v: number): number {
  return Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000
}

function snapToGrid(v: number): number {
  return POSITION_GRID.reduce((best, g) => (Math.abs(g - v) < Math.abs(best - v) ? g : best))
}

/** 균등 배치 좌표 — n명을 한 축으로 고르게 (만화 컷처럼 줄 세울 때) */
export function distributed(
  count: number,
  index: number,
  axis: 'x' | 'y'
): { x: number; y: number } {
  const p = round3((index + 0.5) / count)
  return axis === 'y' ? { x: 0.5, y: p } : { x: p, y: 0.5 }
}

export function PlacementCanvas({
  chars,
  width,
  height,
  freeform,
  selectedId,
  onSelect,
  onMove,
  onDistribute,
  maxHeight = 'min(58vh, 520px)'
}: {
  chars: PlacementChar[]
  width: number
  height: number
  freeform: boolean
  selectedId?: number | null
  onSelect?: (id: number) => void
  onMove: (id: number, center: { x: number; y: number }) => void
  /** 균등 배치 버튼 — 없으면 버튼을 숨긴다 */
  onDistribute?: (axis: 'x' | 'y') => void
  maxHeight?: string
}): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)
  const draggingId = useRef<number | null>(null)
  // 커서를 올린 표식 — 끌기 시작하면 지운다 (툴팁이 손을 가리지 않게)
  const [hoverId, setHoverId] = useState<number | null>(null)
  const hovered = chars.find((c) => c.id === hoverId)

  const moveTo = useCallback(
    (id: number, clientX: number, clientY: number) => {
      const box = boxRef.current?.getBoundingClientRect()
      if (!box?.width || !box.height) return
      const x = (clientX - box.left) / box.width
      const y = (clientY - box.top) / box.height
      onMove(id, freeform ? { x: round3(x), y: round3(y) } : { x: snapToGrid(x), y: snapToGrid(y) })
    },
    [freeform, onMove]
  )

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={boxRef}
        className="relative overflow-hidden rounded-lg border border-line bg-paper"
        style={{ height: maxHeight, aspectRatio: String(width / height) }}
        onPointerMove={(e) => {
          if (draggingId.current !== null) moveTo(draggingId.current, e.clientX, e.clientY)
        }}
        onPointerUp={() => {
          draggingId.current = null
        }}
      >
        {/* 삼분할 안내선 — 만화 컷 경계 가늠용 */}
        {[1 / 3, 2 / 3].map((f) => (
          <div
            key={`v${f}`}
            className="pointer-events-none absolute inset-y-0 w-px bg-line"
            style={{ left: `${f * 100}%` }}
          />
        ))}
        {[1 / 3, 2 / 3].map((f) => (
          <div
            key={`h${f}`}
            className="pointer-events-none absolute inset-x-0 h-px bg-line"
            style={{ top: `${f * 100}%` }}
          />
        ))}

        {chars.map((char, i) => {
          const isSel = selectedId === char.id
          return (
            <button
              key={char.id}
              className={cn(
                'absolute flex -translate-x-1/2 -translate-y-1/2 cursor-grab items-center gap-1 rounded-full border py-0.5 pl-0.5 pr-2 text-[11px] shadow-sm transition-colors active:cursor-grabbing',
                isSel
                  ? 'z-10 border-accent bg-accent text-white'
                  : 'border-line bg-surface-2 text-ink hover:border-accent'
              )}
              style={{ left: `${char.center.x * 100}%`, top: `${char.center.y * 100}%` }}
              onPointerEnter={() => draggingId.current === null && setHoverId(char.id)}
              onPointerLeave={() => setHoverId((id) => (id === char.id ? null : id))}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId)
                draggingId.current = char.id
                setHoverId(null)
                onSelect?.(char.id)
              }}
              onPointerMove={(e) => {
                if (draggingId.current === char.id) moveTo(char.id, e.clientX, e.clientY)
              }}
              onPointerUp={(e) => {
                e.currentTarget.releasePointerCapture(e.pointerId)
                draggingId.current = null
              }}
            >
              {char.thumbnail ? (
                <img
                  src={`data:image/webp;base64,${char.thumbnail}`}
                  className="size-5 shrink-0 rounded-full object-cover"
                  alt=""
                />
              ) : (
                <span
                  className={cn(
                    'grid size-5 shrink-0 place-items-center rounded-full font-mono text-[10px]',
                    isSel ? 'bg-white/25' : 'bg-paper text-muted'
                  )}
                >
                  {i + 1}
                </span>
              )}
              {char.label}
              {char.isDefault && <span className="opacity-60">(기본)</span>}
            </button>
          )
        })}

        {/* 표식에 커서를 올리면 그 자리에 무슨 태그가 걸려 있는지 (커스텀) */}
        {hovered && (hovered.tags?.trim() || hovered.extraTags?.trim()) && (
          <div
            className="pointer-events-none absolute z-20 w-[min(300px,86%)] rounded-md border border-line bg-surface-2 px-2 py-1.5 shadow-lg"
            style={{
              // 판 밖으로 새지 않게 가장자리에서는 안쪽으로 당기고, 위/아래로 자리를 피한다
              left: `${Math.min(0.8, Math.max(0.2, hovered.center.x)) * 100}%`,
              top: `${hovered.center.y * 100}%`,
              transform:
                hovered.center.y < 0.5
                  ? 'translate(-50%, 18px)'
                  : 'translate(-50%, calc(-100% - 18px))'
            }}
          >
            <p className="truncate text-[11px] font-medium text-ink">{hovered.label}</p>
            <p className="mt-0.5 max-h-24 overflow-hidden break-words text-[11px] leading-relaxed text-muted">
              {hovered.tags?.trim() || '태그 없음'}
            </p>
            {hovered.extraTags?.trim() && (
              <p className="mt-1 break-words text-[11px] leading-relaxed text-emerald-500">
                + {hovered.extraTags.trim()}
              </p>
            )}
          </div>
        )}

        {!chars.length && (
          <div className="grid h-full place-items-center text-[12.5px] text-faint">
            배치할 캐릭터가 없습니다
          </div>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        {onDistribute && chars.length > 1 && (
          <>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 px-2 text-[11.5px]"
              title="세로로 균등 배치 (세로 만화 컷용)"
              onClick={() => onDistribute('y')}
            >
              <AlignVerticalJustifyCenter size={14} /> 세로 균등
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 px-2 text-[11.5px]"
              title="가로로 균등 배치"
              onClick={() => onDistribute('x')}
            >
              <AlignHorizontalJustifyCenter size={14} /> 가로 균등
            </Button>
          </>
        )}
        <div className="flex-1" />
        <span className="font-mono text-[11px] text-faint">
          {width}×{height}
        </span>
      </div>
    </div>
  )
}
