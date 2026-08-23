import type { CharacterOrderEntry, ListFolder } from '@shared/types'

/**
 * 캐릭터/조각 공용 "폴더 리스트" 모델의 순수 로직.
 * - 정규 순서: [폴더1, 폴더1 아이템..., 폴더2, ..., (미분류 구분선), 미분류 아이템...]
 *   폴더 섹션이 맨 위 — 미분류 카드가 수백 개여도 폴더 접근이 쉬움.
 * - 아이템의 폴더 소속은 "직전 폴더 행"에서 파생. 미분류 구분선이 소속을 리셋하므로
 *   구분선 아래 = 미분류로 모호함이 없다.
 * - 폴더 이동 시 소속 아이템이 블록으로 함께 이동한다
 * - 하위 폴더 (커스텀, 캐릭터 전용): parentId가 있으면 부모 바로 뒤에 붙어 한 칸 들여쓴다.
 *   깊이는 2단계까지. 부모를 접으면 하위 폴더와 그 카드까지 함께 감춘다.
 *   ⚠️ 부모-자식 관계는 드래그로 바뀌지 않는다 — 순서 저장 규약(toOrderEntries)이
 *   "직전 폴더로 카드 소속 파생"이라 중첩을 섞으면 소속이 오염된다 (v1.0.2 버그와 같은 함정).
 *   부모 지정은 chars:folderSetParent 경로로만.
 */

export interface FolderListItem {
  id: number
  folderId: number | null
}

export type DisplayRow<T extends FolderListItem> =
  | { type: 'folder'; folder: ListFolder; depth: number; hidden: boolean }
  | { type: 'item'; item: T; hidden: boolean }
  | { type: 'divider' } // 폴더 섹션과 미분류 섹션의 경계 (폴더가 있을 때만)

export const DIVIDER_KEY = 'divider'

export function rowKey<T extends FolderListItem>(row: DisplayRow<T>): string {
  if (row.type === 'divider') return DIVIDER_KEY
  return row.type === 'folder' ? `f-${row.folder.id}` : `i-${row.item.id}`
}

/** 부모 바로 뒤에 그 하위 폴더들이 오도록 정렬 (원래 순서는 각 층 안에서 유지) */
export function orderedFolders(folders: ListFolder[]): { folder: ListFolder; depth: number }[] {
  const parents = folders.filter((f) => f.parentId == null)
  const out: { folder: ListFolder; depth: number }[] = []
  for (const parent of parents) {
    out.push({ folder: parent, depth: 0 })
    for (const child of folders.filter((f) => f.parentId === parent.id)) {
      out.push({ folder: child, depth: 1 })
    }
  }
  // 부모가 사라진 고아 폴더는 최상위로 취급 (데이터 꼬임 방지)
  for (const f of folders) {
    if (
      f.parentId != null &&
      !parents.some((p) => p.id === f.parentId) &&
      !out.some((o) => o.folder.id === f.id)
    ) {
      out.push({ folder: f, depth: 0 })
    }
  }
  return out
}

export function canonicalize<T extends FolderListItem>(folders: ListFolder[], items: T[]): T[] {
  const roots = items.filter((c) => c.folderId == null)
  return [
    ...orderedFolders(folders).flatMap(({ folder }) =>
      items.filter((c) => c.folderId === folder.id)
    ),
    ...roots
  ]
}

export function buildDisplayRows<T extends FolderListItem>(
  folders: ListFolder[],
  items: T[]
): DisplayRow<T>[] {
  const rows: DisplayRow<T>[] = []
  const collapsedIds = new Set(folders.filter((f) => f.collapsed).map((f) => f.id))
  for (const { folder, depth } of orderedFolders(folders)) {
    // 부모가 접혀 있으면 하위 폴더 줄도 감춘다
    const parentCollapsed = folder.parentId != null && collapsedIds.has(folder.parentId)
    rows.push({ type: 'folder', folder, depth, hidden: parentCollapsed })
    for (const item of items.filter((c) => c.folderId === folder.id)) {
      rows.push({ type: 'item', item, hidden: folder.collapsed || parentCollapsed })
    }
  }
  // 폴더가 있으면 미분류 경계 표시 (여기로 드롭 = 폴더에서 빼기)
  if (folders.length > 0) rows.push({ type: 'divider' })
  for (const item of items.filter((c) => c.folderId == null)) {
    rows.push({ type: 'item', item, hidden: false })
  }
  return rows
}

interface Block<T extends FolderListItem> {
  folder: ListFolder | null // null = 미분류 단일 아이템 블록
  /** 이 폴더의 하위 폴더들 (부모를 끌면 함께 움직인다) */
  children: ListFolder[]
  items: T[]
}

/**
 * 폴더 이동용 블록. 부모 블록은 자기 하위 폴더까지 통째로 품어서, 부모를 끌면
 * 하위 폴더와 그 카드가 함께 따라간다. 하위 폴더는 자기 블록으로도 존재하지 않는다
 * (하위끼리의 순서 변경은 부모 블록 안에서 처리).
 */
function toBlocks<T extends FolderListItem>(folders: ListFolder[], items: T[]): Block<T>[] {
  const ordered = orderedFolders(folders)
  const blocks: Block<T>[] = []
  for (const { folder, depth } of ordered) {
    if (depth > 0) continue // 하위 폴더는 부모 블록에 포함된다
    const children = ordered.filter((o) => o.folder.parentId === folder.id).map((o) => o.folder)
    blocks.push({
      folder,
      children,
      items: items.filter(
        (c) => c.folderId === folder.id || children.some((ch) => ch.id === c.folderId)
      )
    })
  }
  for (const item of items.filter((c) => c.folderId == null)) {
    blocks.push({ folder: null, children: [], items: [item] })
  }
  return blocks
}

function fromBlocks<T extends FolderListItem>(
  blocks: Block<T>[]
): { folders: ListFolder[]; items: T[] } {
  const folders: ListFolder[] = []
  const items: T[] = []
  for (const block of blocks) {
    if (block.folder) {
      folders.push(block.folder, ...block.children)
      // 카드 소속은 그대로 둔다 — 부모 블록이 움직여도 하위 폴더 소속이 바뀌면 안 된다
      for (const item of block.items) items.push(item)
    } else {
      for (const item of block.items) items.push({ ...item, folderId: null })
    }
  }
  return { folders, items }
}

/**
 * 드래그 결과 반영. activeKey/overKey는 rowKey 형식 ("f-1" | "i-3" | "divider").
 * - 아이템 이동: 도착 위치의 폴더 문맥으로 소속 변경 (구분선 아래 = 미분류)
 * - 폴더 이동: 소속 아이템이 블록째 함께 이동, 미분류 섹션 아래로는 스냅
 */
export function moveRow<T extends FolderListItem>(
  folders: ListFolder[],
  items: T[],
  activeKey: string,
  overKey: string
): { folders: ListFolder[]; items: T[] } {
  if (activeKey === overKey || activeKey === DIVIDER_KEY) return { folders, items }
  const [activeKind, activeIdStr] = activeKey.split('-')
  const activeId = Number(activeIdStr)

  if (activeKind === 'f') {
    // 폴더 블록 이동 — 폴더 블록들 사이로만
    const blocks = toBlocks(folders, items)
    const fromIdx = blocks.findIndex(
      (b) => b.folder?.id === activeId || b.children.some((c) => c.id === activeId)
    )
    if (fromIdx < 0) return { folders, items }
    const [block] = blocks.splice(fromIdx, 1)

    let toIdx: number
    if (overKey === DIVIDER_KEY) {
      toIdx = blocks.filter((b) => b.folder).length // 폴더 섹션 끝
    } else {
      const [overKind, overIdStr] = overKey.split('-')
      const overId = Number(overIdStr)
      toIdx = blocks.findIndex((b) =>
        overKind === 'f'
          ? b.folder?.id === overId || b.children.some((c) => c.id === overId)
          : b.items.some((i) => i.id === overId)
      )
      if (toIdx < 0) toIdx = blocks.length
      else if (toIdx >= fromIdx) toIdx += 1 // 아래로 이동 시 대상 블록 뒤에
    }
    // 미분류 블록들 아래로 내려가지 않게 폴더 섹션 범위로 스냅
    toIdx = Math.min(toIdx, blocks.filter((b) => b.folder).length)
    blocks.splice(toIdx, 0, block)
    return fromBlocks(blocks)
  }

  // 아이템 이동 — 전체 행 기준으로 위치 재계산
  const rows = buildDisplayRows(folders, items)
  const fromIdx = rows.findIndex((r) => rowKey(r) === activeKey)
  if (fromIdx < 0) return { folders, items }
  const [row] = rows.splice(fromIdx, 1)
  if (row.type !== 'item') return { folders, items }

  let toIdx = rows.findIndex((r) => rowKey(r) === overKey)
  if (toIdx < 0) return { folders, items }
  if (toIdx >= fromIdx) toIdx += 1
  rows.splice(Math.min(toIdx, rows.length), 0, row)

  // 행 순서에서 folders/items 재구성 (소속은 직전 폴더에서 파생, 구분선이 리셋)
  const nextFolders: ListFolder[] = []
  const nextItems: T[] = []
  let currentFolder: number | null = null
  for (const r of rows) {
    if (r.type === 'folder') {
      nextFolders.push(r.folder)
      currentFolder = r.folder.id
    } else if (r.type === 'divider') {
      currentFolder = null
    } else {
      nextItems.push({ ...r.item, folderId: currentFolder })
    }
  }
  return { folders: nextFolders, items: nextItems }
}

/**
 * DB 반영용 전체 순서 — ⚠️ 반드시 미분류가 먼저.
 * 메인 repo(reorderCharacters/Fragments/Refs)는 이 시퀀스에서 "직전 폴더"로 소속을 파생하므로,
 * 미분류가 폴더들 뒤에 오면 전부 마지막 폴더 소속으로 저장돼 버린다 (v1.0.2~1.0.5 데이터 오염 버그).
 * 화면 표시 순서(buildDisplayRows: 폴더 먼저)와는 독립된 "전송 규약"이다.
 */
export function toOrderEntries<T extends FolderListItem>(
  folders: ListFolder[],
  items: T[]
): CharacterOrderEntry[] {
  const order: CharacterOrderEntry[] = []
  for (const c of items.filter((c) => c.folderId == null)) order.push({ type: 'char', id: c.id })
  for (const { folder } of orderedFolders(folders)) {
    order.push({ type: 'folder', id: folder.id })
    for (const c of items.filter((c) => c.folderId === folder.id)) {
      order.push({ type: 'char', id: c.id })
    }
  }
  return order
}

export type DropIntent = 'reorder' | 'nest'

/**
 * 폴더를 폴더 위로 끌었을 때 "안에 넣기"인지 "순서 바꾸기"인지 판정 (커스텀).
 *
 * 대상 행의 가운데쯤(25~75%)에 놓으면 안에 넣기, 위아래 가장자리면 순서 바꾸기다.
 * 파일 탐색기들이 쓰는 방식이고, 순서 변경을 잃지 않으면서 중첩을 드래그로 열 수 있다.
 *
 * 안에 넣기는 아래를 모두 만족할 때만 (깊이 2단계 제한):
 * - 끄는 것도 받는 것도 폴더
 * - 끄는 폴더에 하위가 없다 (있으면 3단계가 된다)
 * - 받는 폴더가 최상위다 (하위 폴더는 하위를 못 받는다)
 */
export function dropIntent(opts: {
  activeKey: string
  overKey: string
  folders: ListFolder[]
  /** 끄는 행의 세로 중심이 받는 행의 어디쯤인지 (0=위 끝, 1=아래 끝) */
  overlapRatio: number
}): DropIntent {
  const { activeKey, overKey, folders, overlapRatio } = opts
  if (!activeKey.startsWith('f-') || !overKey.startsWith('f-')) return 'reorder'
  if (activeKey === overKey) return 'reorder'
  if (overlapRatio < 0.25 || overlapRatio > 0.75) return 'reorder'

  const activeId = Number(activeKey.slice(2))
  const overId = Number(overKey.slice(2))
  const active = folders.find((f) => f.id === activeId)
  const over = folders.find((f) => f.id === overId)
  if (!active || !over) return 'reorder'
  if (over.parentId != null) return 'reorder' // 하위 폴더는 하위를 못 받는다
  if (active.parentId === overId) return 'reorder' // 이미 그 안에 있다
  if (folders.some((f) => f.parentId === activeId)) return 'reorder' // 하위를 가진 폴더는 못 들어간다
  return 'nest'
}
