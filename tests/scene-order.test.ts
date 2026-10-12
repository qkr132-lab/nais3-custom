import { describe, expect, it } from 'vitest'
import { arrayMove } from '@dnd-kit/sortable'
import {
  blockNextTo,
  blockToPosition,
  dropBlock,
  insertBlock,
  sameOrder
} from '../src/shared/scene-order'

const ALL = [1, 2, 3, 4, 5, 6]

describe('씬 묶음 이동', () => {
  it('insertBlock: 묶음을 빼낸 나머지의 자리에, 서로의 순서는 유지', () => {
    expect(insertBlock(ALL, [5, 2], 0)).toEqual([2, 5, 1, 3, 4, 6])
    expect(insertBlock(ALL, [2, 5], 4)).toEqual([1, 3, 4, 6, 2, 5])
    expect(insertBlock(ALL, [2, 5], 99)).toEqual([1, 3, 4, 6, 2, 5])
    expect(insertBlock(ALL, [2, 5], -3)).toEqual([2, 5, 1, 3, 4, 6])
    expect(insertBlock(ALL, [], 2)).toBe(ALL)
    expect(insertBlock(ALL, [42], 2)).toBe(ALL)
  })

  it('dropBlock 한 장: dnd-kit arrayMove와 같은 결과', () => {
    for (let from = 0; from < ALL.length; from++)
      for (let to = 0; to < ALL.length; to++) {
        if (from === to) continue
        expect(dropBlock(ALL, [ALL[from]], ALL[from], ALL[to])).toEqual(arrayMove(ALL, from, to))
      }
  })

  it('dropBlock 여러 장: 앞→뒤는 over 뒤에, 뒤→앞은 over 앞에', () => {
    expect(dropBlock(ALL, [1, 3], 1, 6)).toEqual([2, 4, 5, 6, 1, 3])
    expect(dropBlock(ALL, [1, 3], 3, 5)).toEqual([2, 4, 5, 1, 3, 6])
    expect(dropBlock(ALL, [4, 6], 6, 1)).toEqual([4, 6, 1, 2, 3, 5])
    expect(dropBlock(ALL, [4, 6], 4, 2)).toEqual([1, 4, 6, 2, 3, 5])
    // over가 묶음 안이거나 active가 묶음 밖이면 그대로
    expect(dropBlock(ALL, [1, 3], 1, 3)).toBe(ALL)
    expect(dropBlock(ALL, [1, 3], 2, 5)).toBe(ALL)
  })

  it('blockNextTo: 기준 앞/뒤, 기준이 묶음 안이면 그대로', () => {
    expect(blockNextTo(ALL, [5, 6], 2, 'before')).toEqual([1, 5, 6, 2, 3, 4])
    expect(blockNextTo(ALL, [5, 6], 2, 'after')).toEqual([1, 2, 5, 6, 3, 4])
    expect(blockNextTo(ALL, [1, 2], 6, 'after')).toEqual([3, 4, 5, 6, 1, 2])
    expect(blockNextTo(ALL, [1, 2], 2, 'after')).toBe(ALL)
    expect(blockNextTo(ALL, [1, 2], 99, 'after')).toBe(ALL)
  })

  it('blockToPosition: 첫 장이 N번째(1부터)가 되게, 범위를 넘으면 끝/처음', () => {
    expect(blockToPosition(ALL, [5, 6], 1)).toEqual([5, 6, 1, 2, 3, 4])
    expect(blockToPosition(ALL, [1, 2], 3)).toEqual([3, 4, 1, 2, 5, 6])
    expect(blockToPosition(ALL, [1, 2], 100)).toEqual([3, 4, 5, 6, 1, 2])
    expect(blockToPosition(ALL, [1, 2], 0)).toEqual([1, 2, 3, 4, 5, 6])
    expect(sameOrder(ALL, blockToPosition(ALL, [1, 2], 1))).toBe(true)
  })
})
