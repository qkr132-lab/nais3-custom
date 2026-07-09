import { cn } from '../lib/utils'

/** NAI 캐릭터 배치 좌표 격자 값 (5x5). 캐릭터 카드의 center 도 이 값들을 쓴다. */
export const POSITION_GRID = [0.1, 0.3, 0.5, 0.7, 0.9]

/** 캐릭터 위치(중심 좌표) 5x5 격자 선택기 — 캐릭터 오버레이·씬 큐/추가에서 공용 */
export function PositionPicker({
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
