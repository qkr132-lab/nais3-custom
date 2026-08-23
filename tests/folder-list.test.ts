import { describe, expect, it } from 'vitest'
import {
  buildDisplayRows,
  canonicalize,
  moveRow,
  rowKey,
  toOrderEntries
} from '../src/renderer/src/lib/folder-list'
import type { ListFolder } from '../src/shared/types'

const folders: ListFolder[] = [
  { id: 1, name: 'A', collapsed: false },
  { id: 2, name: 'B', collapsed: false }
]
const items = [
  { id: 10, folderId: null },
  { id: 11, folderId: 1 },
  { id: 12, folderId: 1 },
  { id: 13, folderId: 2 }
]

function keys(f: ListFolder[], i: { id: number; folderId: number | null }[]): string[] {
  return buildDisplayRows(f, i).map(rowKey)
}

describe('폴더 리스트 이동 로직 (폴더 섹션 상단 + 미분류 구분선)', () => {
  it('정규 순서: 폴더1(아이템) → 폴더2(아이템) → 구분선 → 미분류', () => {
    expect(keys(folders, items)).toEqual([
      'f-1', 'i-11', 'i-12', 'f-2', 'i-13', 'divider', 'i-10'
    ])
  })

  it('폴더가 없으면 구분선도 없다', () => {
    expect(keys([], [{ id: 10, folderId: null }])).toEqual(['i-10'])
  })

  it('아이템을 다른 폴더로 이동하면 소속이 바뀐다', () => {
    const r = moveRow(folders, items, 'i-11', 'i-13')
    expect(r.items.find((i) => i.id === 11)?.folderId).toBe(2)
    expect(keys(r.folders, canonicalize(r.folders, r.items))).toEqual([
      'f-1', 'i-12', 'f-2', 'i-13', 'i-11', 'divider', 'i-10'
    ])
  })

  it('아이템을 구분선 위치로 내리면 미분류가 된다', () => {
    const r = moveRow(folders, items, 'i-12', 'divider')
    expect(r.items.find((i) => i.id === 12)?.folderId).toBeNull()
  })

  it('아이템을 첫 폴더 위(맨 위)로 올리면 미분류가 된다', () => {
    const r = moveRow(folders, items, 'i-12', 'f-1')
    expect(r.items.find((i) => i.id === 12)?.folderId).toBeNull()
  })

  it('폴더 이동 시 소속 아이템이 블록째 따라간다', () => {
    const r = moveRow(folders, items, 'f-1', 'f-2')
    expect(keys(r.folders, r.items)).toEqual([
      'f-2', 'i-13', 'f-1', 'i-11', 'i-12', 'divider', 'i-10'
    ])
  })

  it('폴더를 미분류 아이템 위로 끌면 폴더 섹션 끝으로 스냅된다 (미분류 아래로 못 감)', () => {
    const r = moveRow(folders, items, 'f-1', 'i-10')
    expect(r.folders.map((f) => f.id)).toEqual([2, 1])
    expect(keys(r.folders, r.items)).toEqual([
      'f-2', 'i-13', 'f-1', 'i-11', 'i-12', 'divider', 'i-10'
    ])
  })

  it('toOrderEntries: 미분류가 반드시 먼저 — repo가 직전 폴더로 소속을 파생하기 때문 (v1.0.2 오염 버그 회귀 방지)', () => {
    const order = toOrderEntries(folders, items)
    expect(order).toEqual([
      { type: 'char', id: 10 }, // 미분류 먼저!
      { type: 'folder', id: 1 },
      { type: 'char', id: 11 },
      { type: 'char', id: 12 },
      { type: 'folder', id: 2 },
      { type: 'char', id: 13 }
    ])
    // repo의 소속 파생 로직 시뮬레이션 — 미분류 아이템이 폴더에 배정되면 안 됨
    let current: number | null = null
    const derived = new Map<number, number | null>()
    for (const e of order) {
      if (e.type === 'folder') current = e.id
      else derived.set(e.id, current)
    }
    expect(derived.get(10)).toBeNull()
    expect(derived.get(11)).toBe(1)
    expect(derived.get(13)).toBe(2)
  })
})

/**
 * 하위 폴더 (커스텀, 2단계).
 * 부모-자식 관계는 드래그로 바뀌지 않는다 — 순서 저장 규약이 "직전 폴더로 카드 소속 파생"이라
 * 중첩을 드래그에 섞으면 소속이 오염된다. 여기서 지키는 건 표시 순서·접기·블록 이동·전송 규약이다.
 */
const nested: ListFolder[] = [
  { id: 1, name: '포켓몬', collapsed: false, color: null, parentId: null },
  { id: 3, name: '불속성', collapsed: false, color: null, parentId: 1 },
  { id: 2, name: '디지몬', collapsed: false, color: null, parentId: null }
]
const nestedItems = [
  { id: 10, folderId: null },
  { id: 11, folderId: 1 },
  { id: 12, folderId: 3 },
  { id: 13, folderId: 2 }
]

describe('하위 폴더 (2단계 중첩)', () => {
  it('하위 폴더는 부모 바로 뒤에 붙는다 — 목록 순서와 무관하게', () => {
    expect(keys(nested, nestedItems)).toEqual([
      'f-1', 'i-11', 'f-3', 'i-12', 'f-2', 'i-13', 'divider', 'i-10'
    ])
  })

  it('하위 폴더 줄에 depth 1이 붙는다 (들여쓰기용)', () => {
    const rows = buildDisplayRows(nested, nestedItems)
    const depths = rows
      .filter((r): r is Extract<typeof r, { type: 'folder' }> => r.type === 'folder')
      .map((r) => [r.folder.id, r.depth])
    expect(depths).toEqual([
      [1, 0],
      [3, 1],
      [2, 0]
    ])
  })

  it('부모를 접으면 하위 폴더 줄과 그 카드까지 함께 감춘다', () => {
    const collapsed = nested.map((f) => (f.id === 1 ? { ...f, collapsed: true } : f))
    const rows = buildDisplayRows(collapsed, nestedItems)
    const hidden = rows.filter((r) => r.type !== 'divider' && r.hidden).map(rowKey)
    expect(hidden).toEqual(['i-11', 'f-3', 'i-12'])
  })

  it('부모를 옮기면 하위 폴더와 그 카드가 통째로 따라간다', () => {
    // 포켓몬(+불속성)을 디지몬 뒤로
    const moved = moveRow(nested, nestedItems, 'f-1', 'f-2')
    expect(keys(moved.folders, moved.items)).toEqual([
      'f-2', 'i-13', 'f-1', 'i-11', 'f-3', 'i-12', 'divider', 'i-10'
    ])
    // 카드 소속은 그대로 (하위 카드가 부모로 딸려 올라가면 안 된다)
    expect(moved.items.find((i) => i.id === 12)?.folderId).toBe(3)
  })

  it('하위 폴더를 끌면 부모 블록이 통째로 움직인다 (하위만 떼어내지 않는다)', () => {
    const moved = moveRow(nested, nestedItems, 'f-3', 'f-2')
    expect(moved.folders.find((f) => f.id === 3)?.parentId).toBe(1)
    expect(keys(moved.folders, moved.items)).toEqual([
      'f-2', 'i-13', 'f-1', 'i-11', 'f-3', 'i-12', 'divider', 'i-10'
    ])
  })

  it('toOrderEntries: 미분류가 먼저, 각 폴더는 자기 카드와 함께 (소속 오염 방지)', () => {
    expect(toOrderEntries(nested, nestedItems)).toEqual([
      { type: 'char', id: 10 },
      { type: 'folder', id: 1 },
      { type: 'char', id: 11 },
      { type: 'folder', id: 3 },
      { type: 'char', id: 12 },
      { type: 'folder', id: 2 },
      { type: 'char', id: 13 }
    ])
  })

  it('부모가 사라진 고아 폴더는 최상위로 취급한다', () => {
    const orphaned: ListFolder[] = [{ id: 3, name: '불속성', collapsed: false, color: null, parentId: 99 }]
    expect(keys(orphaned, [{ id: 12, folderId: 3 }])).toEqual(['f-3', 'i-12', 'divider'])
  })

  it('canonicalize도 부모→하위 순서를 따른다', () => {
    expect(canonicalize(nested, nestedItems).map((i) => i.id)).toEqual([11, 12, 13, 10])
  })
})
