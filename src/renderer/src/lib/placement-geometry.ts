export interface PlacementPoint {
  x: number
  y: number
}

export const PLACEMENT_GRID = [0.1, 0.3, 0.5, 0.7, 0.9] as const

export function round3(value: number): number {
  const finite = Number.isFinite(value) ? value : 0.5
  return Math.round(Math.min(1, Math.max(0, finite)) * 1000) / 1000
}

export function snapToGrid(value: number): number {
  const clamped = round3(value)
  return PLACEMENT_GRID.reduce<number>(
    (best, point) => (Math.abs(point - clamped) < Math.abs(best - clamped) - 1e-9 ? point : best),
    PLACEMENT_GRID[0]
  )
}

export function normalizedCoordinate(value: number, freeform: boolean): number {
  return freeform ? round3(value) : snapToGrid(value)
}

export function normalizePosition(center: PlacementPoint, freeform: boolean): PlacementPoint {
  return {
    x: normalizedCoordinate(center.x, freeform),
    y: normalizedCoordinate(center.y, freeform)
  }
}

/** Uniform distribution also supports V4.5's five positions. */
export function distributed(
  count: number,
  index: number,
  axis: 'x' | 'y',
  freeform = true
): PlacementPoint {
  const position = count > 0 ? (index + 0.5) / count : 0.5
  return normalizePosition(
    axis === 'y' ? { x: 0.5, y: position } : { x: position, y: 0.5 },
    freeform
  )
}

/** Fit both dimensions, so wide outputs cannot enlarge dialogs or distort the image plane. */
export function fitPlacementCanvas(
  availableWidth: number,
  availableHeight: number,
  imageWidth: number,
  imageHeight: number
): { width: number; height: number } {
  if (availableWidth <= 0 || availableHeight <= 0) return { width: 0, height: 0 }
  const ratio = imageWidth > 0 && imageHeight > 0 ? imageWidth / imageHeight : 1
  const width = Math.min(availableWidth, availableHeight * ratio)
  return { width, height: width / ratio }
}

export function positionFromPointer(
  clientX: number,
  clientY: number,
  box: { left: number; top: number; width: number; height: number },
  freeform: boolean,
  offset: PlacementPoint = { x: 0, y: 0 }
): PlacementPoint | null {
  if (box.width <= 0 || box.height <= 0) return null
  return normalizePosition(
    {
      x: (clientX - offset.x - box.left) / box.width,
      y: (clientY - offset.y - box.top) / box.height
    },
    freeform
  )
}

export function nudgePosition(
  center: PlacementPoint,
  axis: 'x' | 'y',
  direction: -1 | 1,
  freeform: boolean,
  step = 0.01
): PlacementPoint {
  const next = normalizePosition(center, freeform)
  if (freeform) return { ...next, [axis]: round3(next[axis] + direction * step) }
  const index = PLACEMENT_GRID.findIndex((point) => point === next[axis])
  return {
    ...next,
    [axis]: PLACEMENT_GRID[Math.min(PLACEMENT_GRID.length - 1, Math.max(0, index + direction))]
  }
}
