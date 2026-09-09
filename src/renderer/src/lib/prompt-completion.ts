import { commentStart } from '@shared/nai-presets'

export interface CompletionRange {
  text: string
  cursor: number
  start: number
  end: number
  query: string
  kind: 'tag' | 'frag'
}
const SEPARATOR = /[,\n{}[\]|<>:/]/

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
  while (end < text.length && !SEPARATOR.test(text[end])) end++
  while (end > cursor && /\s/.test(text[end - 1])) end--
  return { text, cursor, start, end, query: text.slice(start, cursor), kind: 'tag' }
}

export function completionEdit(
  range: CompletionRange,
  text: string
): { insert: string; next: string; cursor: number } {
  let insert = text + (range.kind === 'frag' ? '>' : '')
  const tail = range.text.slice(range.end)
  if (!/^[\s]*[,\n}\]:>]/.test(tail)) insert += ', '
  return {
    insert,
    next: range.text.slice(0, range.start) + insert + tail,
    cursor: range.start + insert.length
  }
}
