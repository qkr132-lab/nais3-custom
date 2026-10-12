/**
 * 씬 묶음 이동 (커스텀) — 고른 씬 여러 장을 서로의 순서를 지킨 채 한 덩어리로 옮긴다.
 * 드래그·우클릭 「이 씬 앞/뒤에」·편집 바 「N번째로」가 전부 이 계산을 쓴다.
 */

/** moving을 all에서 빼낸 나머지의 at 자리에 끼운다 (at은 나머지 기준 0~length) */
export function insertBlock(all: number[], moving: number[], at: number): number[] {
  const set = new Set(moving)
  const ordered = all.filter((id) => set.has(id))
  if (ordered.length === 0) return all
  const rest = all.filter((id) => !set.has(id))
  const i = Math.max(0, Math.min(Math.floor(at), rest.length))
  return [...rest.slice(0, i), ...ordered, ...rest.slice(i)]
}

/**
 * 드래그로 놓기 — 묶음을 over 자리로. 앞에서 뒤로 끌면 over 뒤에, 뒤에서 앞으로 끌면 over 앞에
 * (한 장일 때 dnd-kit arrayMove와 같은 결과). over가 묶음 안이면 그대로.
 */
export function dropBlock(
  all: number[],
  moving: number[],
  activeId: number,
  overId: number
): number[] {
  const set = new Set(moving)
  if (set.has(overId) || !set.has(activeId)) return all
  const from = all.indexOf(activeId)
  const to = all.indexOf(overId)
  if (from < 0 || to < 0) return all
  const rest = all.filter((id) => !set.has(id))
  return insertBlock(all, moving, rest.indexOf(overId) + (from < to ? 1 : 0))
}

/** 묶음을 기준 씬 바로 앞/뒤에. 기준이 묶음 안이면 그대로 */
export function blockNextTo(
  all: number[],
  moving: number[],
  targetId: number,
  side: 'before' | 'after'
): number[] {
  const set = new Set(moving)
  if (set.has(targetId)) return all
  const rest = all.filter((id) => !set.has(id))
  const i = rest.indexOf(targetId)
  if (i < 0) return all
  return insertBlock(all, moving, i + (side === 'after' ? 1 : 0))
}

/** 묶음의 첫 장이 전체에서 position번째(1부터)가 되게 */
export function blockToPosition(all: number[], moving: number[], position: number): number[] {
  return insertBlock(all, moving, position - 1)
}

/** 순서가 실제로 바뀌었는지 */
export function sameOrder(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}
