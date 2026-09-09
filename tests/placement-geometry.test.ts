import { describe, expect, it } from 'vitest'
import {
  PLACEMENT_GRID,
  distributed,
  fitPlacementCanvas,
  normalizePosition,
  nudgePosition,
  positionFromPointer,
  snapToGrid
} from '../src/renderer/src/lib/placement-geometry'

describe('placement canvas geometry', () => {
  it('fits wide images within the available width without altering aspect ratio', () => {
    expect(fitPlacementCanvas(400, 500, 2048, 512)).toEqual({ width: 400, height: 100 })
  })
  it('fits tall images within the available height', () => {
    expect(fitPlacementCanvas(600, 400, 512, 2048)).toEqual({ width: 100, height: 400 })
  })
  it('handles temporarily hidden viewports and invalid image dimensions', () => {
    expect(fitPlacementCanvas(0, 400, 1024, 1024)).toEqual({ width: 0, height: 0 })
    expect(fitPlacementCanvas(400, 300, 0, 0)).toEqual({ width: 300, height: 300 })
  })
  it('preserves the grab offset, so dragging a marker edge does not jump', () => {
    const rect = { left: 100, top: 50, width: 400, height: 200 }
    expect(positionFromPointer(310, 155, rect, true, { x: 10, y: 5 })).toEqual({ x: 0.5, y: 0.5 })
    expect(positionFromPointer(390, 175, rect, true, { x: 10, y: 5 })).toEqual({ x: 0.7, y: 0.6 })
  })
  it('clamps dragging outside the image and rejects zero-size surfaces', () => {
    expect(
      positionFromPointer(-10, 400, { left: 0, top: 0, width: 100, height: 200 }, true)
    ).toEqual({ x: 0, y: 1 })
    expect(positionFromPointer(10, 20, { left: 0, top: 0, width: 0, height: 200 }, true)).toBeNull()
  })
  it('normalizes edited values and recovers non-finite saved centers', () => {
    expect(normalizePosition({ x: 1.3, y: -0.2 }, true)).toEqual({ x: 1, y: 0 })
    expect(normalizePosition({ x: NaN, y: Infinity }, true)).toEqual({ x: 0.5, y: 0.5 })
    expect(normalizePosition({ x: 0.23456, y: 0.87654 }, true)).toEqual({ x: 0.235, y: 0.877 })
  })
  it('keeps V4.5 editing and distribution on supported grid coordinates', () => {
    expect(normalizePosition({ x: 0.23, y: 0.66 }, false)).toEqual({ x: 0.3, y: 0.7 })
    for (let count = 1; count <= 8; count++) {
      for (let index = 0; index < count; index++) {
        for (const axis of ['x', 'y'] as const) {
          const point = distributed(count, index, axis, false)
          expect(PLACEMENT_GRID).toContain(point.x)
          expect(PLACEMENT_GRID).toContain(point.y)
        }
      }
    }
  })
  it('resolves grid midpoint ties consistently towards the smaller coordinate', () => {
    expect(snapToGrid(0.2)).toBe(0.1)
    expect(snapToGrid(0.4)).toBe(0.3)
    expect(snapToGrid(0.6)).toBe(0.5)
    expect(snapToGrid(0.8)).toBe(0.7)
  })
  it('nudges by one grid cell and clamps at each edge', () => {
    expect(nudgePosition({ x: 0.5, y: 0.3 }, 'x', 1, false)).toEqual({ x: 0.7, y: 0.3 })
    expect(nudgePosition({ x: 0.9, y: 0.1 }, 'x', 1, false)).toEqual({ x: 0.9, y: 0.1 })
    expect(nudgePosition({ x: 0.9, y: 0.1 }, 'y', -1, false)).toEqual({ x: 0.9, y: 0.1 })
  })
  it('supports fine and coarse nudges for freeform coordinates', () => {
    expect(nudgePosition({ x: 0.5, y: 0.5 }, 'x', -1, true)).toEqual({ x: 0.49, y: 0.5 })
    expect(nudgePosition({ x: 0.5, y: 0.5 }, 'y', 1, true, 0.001)).toEqual({ x: 0.5, y: 0.501 })
    expect(nudgePosition({ x: 0.95, y: 0.5 }, 'x', 1, true, 0.1)).toEqual({ x: 1, y: 0.5 })
  })
})
