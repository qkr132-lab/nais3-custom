/**
 * 씬 화면 이동 보조 — 찾기 일치, 순번, 빠른 이동 막대, 프리셋별 스크롤 기억의 계산.
 * 화면·스토어·DOM을 전혀 모르는 순수 함수만 둔다 (vitest에서 그대로 돌린다).
 */

/** 찾기·순번 계산에 필요한 씬의 최소 모양 */
export interface NavScene {
  id: number
  name: string
  exportNo?: number | null
}

/** 대소문자·공백을 없앤 비교용 글자 (macOS가 만든 자모 분리 이름도 한 모양으로) */
export function normalizeQuery(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/g, '')
}

/**
 * 찾기 일치 — 목록 순서대로 씬 id를 돌려준다.
 * 이름에 검색어(대소문자·공백 무시)가 들어 있으면 일치. 검색어가 숫자만이면
 * 순번(목록 순서, 1부터)이나 내보내기 번호가 그 숫자인 씬도 일치로 본다.
 */
export function findSceneMatches(scenes: readonly NavScene[], query: string): number[] {
  const q = normalizeQuery(query)
  if (!q) return []
  const asNumber = /^\d+$/.test(q) ? Number(q) : null
  const number = asNumber != null && Number.isSafeInteger(asNumber) ? asNumber : null
  const ids: number[] = []
  scenes.forEach((scene, index) => {
    const byName = normalizeQuery(scene.name).includes(q)
    const byNumber = number != null && (index + 1 === number || scene.exportNo === number)
    if (byName || byNumber) ids.push(scene.id)
  })
  return ids
}

/** 일치 목록에서 다음(+1)·이전(−1) 자리 — 끝에서 처음으로 돌아온다 */
export function stepMatch(total: number, current: number, step: 1 | -1): number {
  if (total <= 0) return 0
  const from = Math.min(Math.max(current, 0), total - 1)
  return (((from + step) % total) + total) % total
}

/** 목록에서 씬의 순번(1부터). 없으면 0 */
export function sceneOrdinal(ids: readonly number[], id: number): number {
  const index = ids.indexOf(id)
  return index < 0 ? 0 : index + 1
}

/** 빠른 이동 말풍선 글자 — 「{순번} · {씬 이름}」 */
export function sceneLabel(index: number, name: string): string {
  return `${index + 1} · ${name.trim() === '' ? '이름 없음' : name}`
}

/**
 * 화면 맨 위에 오는 씬의 자리 — 아래 끝(bottoms)이 offset보다 처음 커지는 씬.
 * bottoms는 카드 아래 끝의 내용 좌표이고 앞에서 뒤로 줄어들지 않는다 (같은 줄 카드는 같은 값).
 * 한 줄에 여러 장이면 그 줄 맨 왼쪽 카드. 다 지나갔으면 마지막. 목록이 비면 −1.
 */
export function topSceneIndex(bottoms: readonly number[], offset: number): number {
  return topSceneIndexBy(bottoms.length, (index) => bottoms[index], offset)
}

/**
 * topSceneIndex 와 같되 아래 끝을 미리 다 재지 않고 필요한 칸만 잰다 (이분 탐색 → 카드 수와 무관하게 몇 번).
 * 스크롤 이벤트마다 부르는 곳(프리셋별 위치 기억)에서 카드 수백 장을 매번 재지 않으려고 쓴다.
 */
export function topSceneIndexBy(
  count: number,
  bottomAt: (index: number) => number,
  offset: number
): number {
  if (count <= 0) return -1
  let lo = 0
  let hi = count - 1
  if (bottomAt(hi) <= offset) return hi
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (bottomAt(mid) > offset) hi = mid
    else lo = mid + 1
  }
  return lo
}

/** 빠른 이동 막대 손잡이의 최소 높이(px) */
export const THUMB_MIN = 28

export interface ThumbMetrics {
  /** 내용이 넘쳐 막대를 보여야 하는가 */
  visible: boolean
  /** 손잡이 높이(px) — 보이는 비율, 최소 THUMB_MIN */
  size: number
  /** 손잡이 위쪽 끝(px, 길 맨 위 기준) */
  top: number
}

function thumbSize(
  scrollHeight: number,
  clientHeight: number,
  trackHeight: number,
  minSize: number
): number {
  return Math.min(trackHeight, Math.max(minSize, trackHeight * (clientHeight / scrollHeight)))
}

/** 스크롤 상태 → 손잡이 모양. 넘치지 않거나 길이 없으면 visible=false */
export function thumbMetrics(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  trackHeight: number,
  minSize: number = THUMB_MIN
): ThumbMetrics {
  if (!(trackHeight > 0) || !(clientHeight > 0) || scrollHeight <= clientHeight + 1)
    return { visible: false, size: 0, top: 0 }
  const size = thumbSize(scrollHeight, clientHeight, trackHeight, minSize)
  const maxScroll = scrollHeight - clientHeight
  const ratio = Math.min(1, Math.max(0, scrollTop / maxScroll))
  return { visible: true, size, top: (trackHeight - size) * ratio }
}

/** 손잡이 위쪽 끝 자리(px) → 그 비율의 scrollTop (부드러운 스크롤 없이 바로 가는 값) */
export function scrollTopForThumb(
  thumbTop: number,
  scrollHeight: number,
  clientHeight: number,
  trackHeight: number,
  minSize: number = THUMB_MIN
): number {
  if (!(trackHeight > 0) || !(clientHeight > 0) || scrollHeight <= clientHeight) return 0
  const travel = trackHeight - thumbSize(scrollHeight, clientHeight, trackHeight, minSize)
  if (travel <= 0) return 0
  const ratio = Math.min(1, Math.max(0, thumbTop / travel))
  return ratio * (scrollHeight - clientHeight)
}

/** 스크롤 위치 기억 열쇠 — 「라이브러리 종류:프리셋 id」 */
export function sceneScrollKey(kind: string, presetId: number): string {
  return `${kind}:${presetId}`
}

/**
 * 한 열쇠(프리셋)의 기억된 위치. px 하나만 적으면 보기·열 수·카드 비율·창 폭이 바뀐 뒤에는 다른 씬을
 * 가리키므로, 「화면 맨 위 씬 + 그 카드 위쪽과의 거리」로 적고 scrollTop 은 보조로만 둔다.
 */
export interface ScrollAnchor {
  /** 화면 맨 위 씬 id. 옛 형식(숫자 하나)에서 읽은 값은 null */
  id: number | null
  /** 그 카드 위쪽 끝이 스크롤 영역 위쪽 끝에서 떨어진 거리(px, 위로 걸쳐 있으면 음수) */
  offset: number
  /** 보조 scrollTop(px) — 그 씬이 목록에 없을 때만 쓴다 */
  top: number
}

/** localStorage 글자 → 열쇠별 위치. 옛 형식(열쇠: 숫자)도 읽고, 깨졌거나 이상한 값은 버린다 */
export function parseSavedScrolls(raw: string | null): Record<string, ScrollAnchor> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, ScrollAnchor> = {}
    for (const [key, value] of Object.entries(parsed)) {
      const anchor = readAnchor(value)
      if (anchor) out[key] = anchor
    }
    return out
  } catch {
    return {}
  }
}

function readAnchor(value: unknown): ScrollAnchor | null {
  // 옛 형식: px 하나
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? { id: null, offset: 0, top: value } : null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { id, offset, top } = value as Record<string, unknown>
  const topPx = typeof top === 'number' && Number.isFinite(top) && top > 0 ? top : 0
  const sceneId = typeof id === 'number' && Number.isSafeInteger(id) ? id : null
  // 씬 id 도 쓸 만한 px 도 없으면 돌아갈 곳이 없다
  if (sceneId == null && topPx <= 0) return null
  const offsetPx = typeof offset === 'number' && Number.isFinite(offset) ? offset : 0
  return { id: sceneId, offset: offsetPx, top: topPx }
}

/** 열쇠별 위치 → 저장 글자. 맨 위(top 0)는 기본값이라 적지 않는다 */
export function serializeSavedScrolls(map: Readonly<Record<string, ScrollAnchor>>): string {
  const out: Record<string, ScrollAnchor> = {}
  for (const [key, value] of Object.entries(map)) {
    if (!(Number.isFinite(value.top) && value.top > 0)) continue
    out[key] = {
      id: value.id,
      offset: Number.isFinite(value.offset) ? Math.round(value.offset) : 0,
      top: Math.round(value.top)
    }
  }
  return JSON.stringify(out)
}

/**
 * 저장한 오프셋을 그 카드의 높이에 맞게 가둔다.
 * 카드가 낮아진 보기(카드 → 이름 목록)에서 옛 오프셋을 그대로 쓰면 카드가 통째로 화면 위로 넘어가 다른 씬이
 * 맨 위에 서므로, 카드 아래 끝이 위쪽 여백(pad)을 조금이라도 넘어 보이는 선까지만 허용한다.
 */
export function clampAnchorOffset(offset: number, cardHeight: number, pad: number): number {
  return Math.max(offset, pad - cardHeight + 1)
}

/**
 * 저장한 자리로 되돌릴 scrollTop — 그 씬 카드의 위쪽 끝(cardTop)이 스크롤 영역 위쪽 끝(scrollerTop)에서
 * offset 만큼 떨어진 자리에 오게 한다. cardTop·scrollerTop 은 같은 좌표계(화면)의 값, current 는 지금 scrollTop.
 */
export function anchoredScrollTop(
  current: number,
  cardTop: number,
  scrollerTop: number,
  cardHeight: number,
  offset: number,
  pad: number
): number {
  return current + (cardTop - scrollerTop) - clampAnchorOffset(offset, cardHeight, pad)
}

/** 위치 복원이 일으킨 scroll 이벤트인가 — 복원한 scrollTop 과 같은 자리의 이벤트는 기억값을 덮어쓰지 않는다 */
export function isRestoreEcho(restoredTop: number | null, top: number): boolean {
  return restoredTop != null && Math.abs(top - restoredTop) <= 1.5
}

/** 키가 난 곳 — 격자 영역 안의 요소 / 포커스가 없는 body / 격자 밖의 다른 요소 */
export type KeyZone = 'inside' | 'neutral' | 'outside'

/**
 * Home/End/PageUp/PageDown 으로 씬 격자를 움직여도 되는가.
 * 포커스가 격자 안이면 허용, 격자 밖 요소에 있으면 거절. 포커스가 body 처럼 비어 있으면 마지막 pointerdown 이
 * 격자 안이었을 때만 허용한다 (오른쪽 히스토리·왼쪽 패널의 빈 곳을 누르고 누른 키는 그 패널 몫).
 */
export function gridKeyAllowed(zone: KeyZone, lastPointerInside: boolean): boolean {
  return zone === 'inside' || (zone === 'neutral' && lastPointerInside)
}

export interface FindCurrentInput {
  /** 지금까지의 현재 일치 씬 id (없으면 null) */
  prevId: number | null
  /** 이전 씬 순서(id) — 현재 일치가 지워졌을 때 그 자리를 알아내는 데 쓴다 */
  prevOrder: readonly number[]
  /** 지금 씬 순서(id) */
  order: readonly number[]
  /** 지금 일치 — 목록 순서 */
  matches: readonly number[]
  /** 프리셋·라이브러리가 바뀌어 처음부터 다시 시작해야 하는가 */
  reset: boolean
}

/**
 * 찾기의 현재 일치를 씬 id 로 보관할 때, 목록이 바뀐 뒤의 현재 일치를 정한다.
 *  - 일치가 없으면 null
 *  - 처음부터(reset)이거나 현재가 없었으면 첫 일치
 *  - 현재 id 가 아직 일치 안에 있으면 그대로 (순번만 새 자리로 따라간다)
 *  - 현재가 사라졌으면(삭제·이름 변경으로 일치에서 빠짐) 그 자리 뒤의 첫 일치, 없으면 첫 일치
 * moved 는 현재가 사라져 강제로 옮긴 경우만 true — 이때만 화면을 그 씬으로 옮긴다.
 */
export function resolveFindCurrent(input: FindCurrentInput): {
  id: number | null
  moved: boolean
} {
  const { prevId, prevOrder, order, matches } = input
  if (matches.length === 0) return { id: null, moved: false }
  if (input.reset || prevId == null) return { id: matches[0], moved: false }
  if (matches.includes(prevId)) return { id: prevId, moved: false }

  const position = new Map<number, number>()
  order.forEach((id, index) => position.set(id, index))
  // 이 자리부터의 일치를 찾는다. 이름이 바뀌어 일치에서만 빠졌다면 그 씬 바로 뒤부터,
  // 씬이 지워졌다면 이전 순서에서 그 뒤에 있던 씬 중 남은 첫 씬 자리부터
  let from = order.length
  const own = position.get(prevId)
  if (own != null) from = own + 1
  else {
    const old = prevOrder.indexOf(prevId)
    for (let i = old + 1; old >= 0 && i < prevOrder.length; i++) {
      const at = position.get(prevOrder[i])
      if (at != null) {
        from = at
        break
      }
    }
  }
  for (const id of matches) {
    const at = position.get(id)
    if (at != null && at >= from) return { id, moved: true }
  }
  return { id: matches[0], moved: true }
}
