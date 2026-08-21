import { useCallback, useRef } from 'react'
import { cn } from '../lib/utils'
import { modelCaps } from '@shared/nai-models'
import { useGenerationStore } from '../stores/generation-store'

/** NAI 캐릭터 배치 좌표 격자 값 (5x5). V4.5까지의 캐릭터 center 값. */
export const POSITION_GRID = [0.1, 0.3, 0.5, 0.7, 0.9]

/** 소수 3자리로 (웹 V5 실측 좌표가 0.776 같은 3자리) */
function round3(v: number): number {
  return Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000
}

/**
 * 캐릭터 위치(중심 좌표) 선택기 — 캐릭터 오버레이·씬 큐/추가에서 공용.
 *
 * V4.5까지는 5×5 격자(0.1~0.9)만 허용하지만, V5는 캔버스 자유 배치다
 * (웹 기능표 freeformCharacterPosition=true, 실측 좌표 0.776/0.141 등 연속값).
 * 모델에 따라 두 모드를 자동으로 바꾼다.
 */
export function PositionPicker({
  center,
  onPick
}: {
  center: { x: number; y: number }
  onPick: (center: { x: number; y: number }) => void
}): React.JSX.Element {
  const freeform = modelCaps(useGenerationStore((s) => s.request.model)).freeformCharacterPosition
  return freeform ? (
    <FreeformPicker center={center} onPick={onPick} />
  ) : (
    <GridPicker center={center} onPick={onPick} />
  )
}

function GridPicker({
  center,
  onPick
}: {
  center: { x: number; y: number }
  onPick: (center: { x: number; y: number }) => void
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-5 gap-0.5">
      {POSITION_GRID.map((y) =>
        POSITION_GRID.map((x) => (
          <button
            key={`${x}-${y}`}
            className={cn(
              'size-6 rounded-[4px] border border-line transition-colors',
              center.x === x && center.y === y ? 'bg-accent' : 'bg-paper hover:bg-surface-2'
            )}
            title={`(${x}, ${y})`}
            onClick={() => onPick({ x, y })}
          />
        ))
      )}
    </div>
  )
}

/** V5 자유 배치 — 캔버스를 클릭하거나 점을 끌어 옮긴다 */
function FreeformPicker({
  center,
  onPick
}: {
  center: { x: number; y: number }
  onPick: (center: { x: number; y: number }) => void
}): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  const pickFromEvent = useCallback(
    (clientX: number, clientY: number) => {
      const box = boxRef.current?.getBoundingClientRect()
      if (!box || !box.width || !box.height) return
      onPick({
        x: round3((clientX - box.left) / box.width),
        y: round3((clientY - box.top) / box.height)
      })
    },
    [onPick]
  )

  return (
    <div className="flex flex-col items-end gap-1">
      <div
        ref={boxRef}
        className="relative size-[132px] cursor-crosshair rounded-[6px] border border-line bg-paper"
        onPointerDown={(e) => {
          dragging.current = true
          e.currentTarget.setPointerCapture(e.pointerId)
          pickFromEvent(e.clientX, e.clientY)
        }}
        onPointerMove={(e) => {
          if (dragging.current) pickFromEvent(e.clientX, e.clientY)
        }}
        onPointerUp={(e) => {
          dragging.current = false
          e.currentTarget.releasePointerCapture(e.pointerId)
        }}
      >
        {/* 삼분할 안내선 */}
        {[1 / 3, 2 / 3].map((f) => (
          <div
            key={`v${f}`}
            className="pointer-events-none absolute inset-y-0 w-px bg-line/60"
            style={{ left: `${f * 100}%` }}
          />
        ))}
        {[1 / 3, 2 / 3].map((f) => (
          <div
            key={`h${f}`}
            className="pointer-events-none absolute inset-x-0 h-px bg-line/60"
            style={{ top: `${f * 100}%` }}
          />
        ))}
        <div
          className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-2 ring-paper"
          style={{ left: `${center.x * 100}%`, top: `${center.y * 100}%` }}
        />
      </div>
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[10.5px] text-faint">
          {center.x.toFixed(3)}, {center.y.toFixed(3)}
        </span>
        <button
          className="rounded-[4px] border border-line px-1.5 py-0.5 text-[10.5px] text-muted hover:bg-surface-2"
          title="가운데로"
          onClick={() => onPick({ x: 0.5, y: 0.5 })}
        >
          가운데
        </button>
      </div>
    </div>
  )
}
