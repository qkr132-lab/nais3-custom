import { commentStart } from '@shared/nai-presets'

export interface CompletionRange {
  text: string
  cursor: number
  start: number
  end: number
  query: string
  kind: 'tag' | 'frag'
  /** A new tag was typed beside protected existing text. */
  insertion?: true
  /** Role/fragment opening included in an anchored replacement. */
  insertionPrefix?: string
}
export interface CompletionAnchor {
  prefix: string
  suffix: string
}
const SEPARATOR = /[,\n{}[\]|<>:/]/

function anchoredBounds(
  anchor: CompletionAnchor,
  text: string
): { start: number; end: number } | null {
  if (
    !text.startsWith(anchor.prefix) ||
    !text.endsWith(anchor.suffix) ||
    text.length < anchor.prefix.length + anchor.suffix.length
  )
    return null
  return { start: anchor.prefix.length, end: text.length - anchor.suffix.length }
}

/** Retain only the newly inserted span; existing text on either side is immutable. */
export function completionAnchor(
  previousAnchor: CompletionAnchor | null,
  before: { text: string; start: number; end: number },
  text: string,
  cursor: number
): CompletionAnchor | null {
  if (previousAnchor) {
    const old = anchoredBounds(previousAnchor, before.text)
    const next = anchoredBounds(previousAnchor, text)
    if (
      old &&
      next &&
      before.start >= old.start &&
      before.end <= old.end &&
      cursor >= next.start &&
      cursor <= next.end
    )
      return previousAnchor
  }
  if (before.start !== before.end || before.start < 0 || before.start > before.text.length)
    return null
  const added = text.length - before.text.length
  if (added <= 0 || cursor < before.start || cursor > before.start + added) return null
  const prefix = before.text.slice(0, before.start)
  const suffix = before.text.slice(before.end)
  if (!text.startsWith(prefix) || !text.endsWith(suffix)) return null
  // Existing fragments and tag interiors are edited as one token.
  if (/<[^<>|]*$/.test(prefix)) return null
  let start = before.start
  let end = before.start
  while (start > 0 && !SEPARATOR.test(before.text[start - 1])) start--
  while (end < before.text.length && !SEPARATOR.test(before.text[end])) end++
  while (start < end && /\s/.test(before.text[start])) start++
  while (end > start && /\s/.test(before.text[end - 1])) end--
  const role = /^(?:source|target|mutual)#/.exec(before.text.slice(start, end))
  const atRoleBodyStart = role !== null && before.start === start + role[0].length
  if (!atRoleBodyStart && before.start > start && before.start < end) return null
  // 영어 단어 끝에 붙여 친 영어·숫자는 그 단어를 잇는 것 — 따로 넣으면 a + ndroid가
  // "a, android18"이 된다. (영어 태그 뒤에 붙여 친 한글은 지금처럼 따로 넣는다)
  const typed = text.slice(before.start, before.start + added)
  if (
    !atRoleBodyStart &&
    before.start > start &&
    before.start === end &&
    /[A-Za-z0-9_)]$/.test(before.text.slice(start, end)) &&
    /^[A-Za-z0-9_(]/.test(typed) &&
    !/^(?:source|target|mutual)#/.test(typed)
  )
    return null
  return { prefix, suffix }
}

export function anchoredCompletionRange(
  anchor: CompletionAnchor,
  text: string,
  cursor: number,
  selectionEnd = cursor
): CompletionRange | null {
  const bounds = anchoredBounds(anchor, text)
  if (!bounds || cursor < bounds.start || cursor > bounds.end || cursor !== selectionEnd)
    return null
  const before = text.slice(0, cursor)
  if (commentStart(before.slice(before.lastIndexOf('\n') + 1)) !== -1) return null
  const inserted = text.slice(bounds.start, bounds.end)
  const local = completionRange(inserted, cursor - bounds.start)
  if (!local) return null
  const role = /(?:source|target|mutual)#$/.exec(inserted.slice(0, local.start))
  const insertionPrefix = local.kind === 'frag' ? '<' : (role?.[0] ?? '')
  return {
    ...local,
    text,
    cursor,
    start: bounds.start + local.start - insertionPrefix.length,
    end: bounds.start + local.end,
    insertion: true,
    ...(insertionPrefix ? { insertionPrefix } : {})
  }
}

export function completionRange(
  text: string,
  cursor: number,
  selectionEnd = cursor
): CompletionRange | null {
  if (cursor !== selectionEnd) return null
  const before = text.slice(0, cursor)
  if (commentStart(before.slice(before.lastIndexOf('\n') + 1)) !== -1) return null
  const frag = /<([^<>|]*)$/.exec(before)
  if (frag) {
    let end = cursor
    while (end < text.length && !/[<>|\n]/.test(text[end])) end++
    if (text[end] === '>') end++
    return { text, cursor, start: cursor - frag[1].length, end, query: frag[1], kind: 'frag' }
  }
  let start = cursor
  while (start > 0 && !SEPARATOR.test(text[start - 1])) start--
  const raw = text.slice(start, cursor)
  start += raw.length - raw.trimStart().length
  // Preserve role prefixes; a hash inside a role-qualified tag is not a comment.
  const role = /^(?:source|target|mutual)#/.exec(text.slice(start, cursor))
  if (role) start += role[0].length
  let end = cursor
  // A fresh Korean query immediately before an existing English tag must not
  // consume that tag when no edit-session snapshot is available (e.g. a paste).
  if (
    !role &&
    (!text.slice(start, cursor).trim() ||
      (/[가-힣ㄱ-ㅎㅏ-ㅣ]\s*$/.test(text.slice(start, cursor)) &&
        /[a-zA-Z0-9]/.test(text[cursor] ?? '')))
  )
    return {
      text,
      cursor,
      start,
      end,
      query: text.slice(start, cursor),
      kind: 'tag',
      insertion: true
    }
  while (end < text.length && !SEPARATOR.test(text[end])) end++
  while (end > cursor && /\s/.test(text[end - 1])) end--
  return { text, cursor, start, end, query: text.slice(start, cursor), kind: 'tag' }
}

export function completionEdit(
  range: CompletionRange,
  text: string
): { insert: string; next: string; cursor: number } {
  let insert = (range.insertionPrefix ?? '') + text + (range.kind === 'frag' ? '>' : '')
  const head = range.text.slice(0, range.start)
  if (range.insertion) {
    const trimmed = head.replace(/[^\S\r\n]+$/g, '')
    const rolePrefix = /(?:^|[,\n{}[\]|<>:])\s*(?:source|target|mutual)#$/.test(trimmed)
    const openingWeight = /(?:^|[,\n{}[\]|<>:])\s*-?\d+(?:\.\d+)?::$/.test(trimmed)
    const separated = /[,\r\n{[|</]$/.test(trimmed) || (/:$/.test(trimmed) && !/::$/.test(trimmed))
    if (trimmed && !rolePrefix && !openingWeight && !separated) insert = ', ' + insert
  }
  const tail = range.text.slice(range.end)
  if (!/^[\s]*[,\n}\]:>]/.test(tail)) insert += range.insertion && /^\s/.test(tail) ? ',' : ', '
  return {
    insert,
    next: head + insert + tail,
    cursor: range.start + insert.length
  }
}

/**
 * 여러 단어로 친 영어 검색어의 마지막 단어 ("black mai" → "mai").
 * 두 단어를 다 품은 태그만 찾으면 엉뚱한 것만 나와서, 마지막 단어로도 따로 찾는다.
 */
export function lastWordQuery(query: string): string | null {
  if (/[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(query)) return null
  const words = query.trim().split(/\s+/)
  const last = words.at(-1) ?? ''
  if (words.length < 2 || last.length < 2 || !/^[a-z0-9]/i.test(last)) return null
  return last
}

/** 마지막 단어만 바꾸는 범위 — 앞 단어(black)는 그대로 두고 mai만 maid로 */
export function lastWordRange(range: CompletionRange): CompletionRange {
  const typed = range.text.slice(range.start, range.cursor)
  const m = /\S+$/.exec(typed)
  if (!m) return range
  return {
    text: range.text,
    cursor: range.cursor,
    start: range.start + m.index,
    end: range.end,
    query: m[0],
    kind: range.kind
  }
}

/** 전체 검색어로 찾은 것과 마지막 단어로 찾은 것을 합친다 — 정확·앞부분 일치 → 마지막 단어 → 나머지 */
export function mergeLastWord<T extends { tag: string; match?: string }>(
  full: T[],
  part: T[],
  limit: number
): (T & { lastWord?: true })[] {
  const strong = full.filter((t) => t.match === 'exact' || t.match === 'prefix')
  const rest = full.filter((t) => !strong.includes(t))
  const seen = new Set<string>()
  const out: (T & { lastWord?: true })[] = []
  for (const [list, last] of [
    [strong, false],
    [part, true],
    [rest, false]
  ] as const) {
    for (const t of list) {
      if (seen.has(t.tag)) continue
      seen.add(t.tag)
      out.push(last ? { ...t, lastWord: true } : t)
    }
  }
  return out.slice(0, limit)
}
