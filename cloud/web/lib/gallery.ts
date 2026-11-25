/** 갤러리 목록 합치기 — DOM 없이 쓰는 순수 함수 */
import type { CloudImageItem } from '@shared/cloud-contract'

export interface ImagePage {
  items: CloudImageItem[]
  next: string | null
}

/** 다음 페이지를 이어 붙인다 (이미 있는 id 는 건너뜀) */
export function appendUnique(
  items: readonly CloudImageItem[],
  more: readonly CloudImageItem[]
): CloudImageItem[] {
  const seen = new Set(items.map((i) => i.id))
  return [...items, ...more.filter((i) => !seen.has(i.id))]
}

/**
 * 목록에서 a 가 b 보다 뒤(더 오래됨)인가. 서버의 정렬(만든 시각 내림차순, 같으면 id 내림차순)과 같은 기준이다.
 * PC 그림은 시각이 초 단위라 같은 시각이 흔하므로 id 까지 봐야 한다
 */
export function comesAfter(
  a: Pick<CloudImageItem, 'createdAt' | 'id'>,
  b: Pick<CloudImageItem, 'createdAt' | 'id'>
): boolean {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt
  return a.id < b.id
}

/**
 * 첫 페이지를 다시 받았을 때 현재 목록에 합친다.
 * - 첫 페이지만 보고 있었으면 통째로 바꾼다.
 * - 더 내려가 있었으면 새 첫 페이지 + 그보다 뒤에 오는 기존 항목을 이어 붙이고, 다음 페이지 표식은 기존 것을 유지한다.
 */
export function mergeHead(current: ImagePage, head: ImagePage): ImagePage {
  if (current.items.length <= head.items.length) return { items: head.items, next: head.next }
  const oldest = head.items[head.items.length - 1]
  if (!oldest) return { items: [], next: head.next }
  const ids = new Set(head.items.map((i) => i.id))
  const tail = current.items.filter((i) => !ids.has(i.id) && comesAfter(i, oldest))
  return { items: [...head.items, ...tail], next: current.next }
}

/**
 * 전체 화면 보기가 가리키는 위치. 보던 그림의 id 로 찾고, 목록에서 사라졌으면(삭제 등)
 * 마지막으로 알던 위치(hint)에서 가장 가까운 항목. 목록이 비면 -1
 */
export function resolveViewerIndex(
  items: readonly Pick<CloudImageItem, 'id'>[],
  id: string | null,
  hint: number
): number {
  if (items.length === 0) return -1
  if (id != null) {
    const at = items.findIndex((i) => i.id === id)
    if (at >= 0) return at
  }
  return Math.min(Math.max(0, hint), items.length - 1)
}

/** 다음 페이지 불러오기가 연달아 실패했을 때 다음 시도까지의 대기 (ms) — 3초부터 두 배씩, 60초 상한 */
export function loadMoreBackoffMs(failures: number): number {
  if (failures <= 0) return 0
  return Math.min(60_000, 3_000 * 2 ** (failures - 1))
}
