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
  // Existing fragments and role-qualified tag bodies are edited as one token.
  if (/<[^<>|]*$/.test(prefix)) return null
  let start = before.start
  let end = before.start
  while (start > 0 && !SEPARATOR.test(before.text[start - 1])) start--
  while (end < before.text.length && !SEPARATOR.test(before.text[end])) end++
  while (start < end && /\s/.test(before.text[start])) start++
  while (end > start && /\s/.test(before.text[end - 1])) end--
  if (before.start > start && before.start < end) return null
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
