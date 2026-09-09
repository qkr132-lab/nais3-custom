export type TagMatch =
  'exact' | 'prefix' | 'contains' | 'related' | 'typo' | 'phonetic' | 'initials' | 'history'
export interface TagSuggestion {
  tag: string
  count: number
  type: string
  ko?: string
  desc?: string
  matchedAlias?: string
  legacy?: boolean
  userKo?: boolean
  match?: TagMatch
  usageCount?: number
  lastUsed?: number
}
export interface TagUse {
  count: number
  lastUsed: number
}
export type TagUsage = Record<string, TagUse>

/** One ordered list: relevant matches, then a blend of recent/frequent choices. */
export function mergeTagRecommendations(
  matches: TagSuggestion[],
  recent: TagSuggestion[],
  frequent: TagSuggestion[],
  limit = 10
): TagSuggestion[] {
  const n = Math.max(1, Math.min(30, limit))
  const history: TagSuggestion[] = []
  const seen = new Set(matches.map((t) => t.tag))
  for (let i = 0; i < Math.max(recent.length, frequent.length); i++) {
    for (const item of [recent[i], frequent[i]]) {
      if (!item || seen.has(item.tag)) continue
      seen.add(item.tag)
      history.push({ ...item, match: 'history' })
    }
  }
  const historySlots = Math.min(
    history.length,
    matches.length ? Math.max(1, Math.floor(n * 0.4)) : n
  )
  return [...matches.slice(0, n - historySlots), ...history.slice(0, historySlots)]
}
export const TAG_MATCH_LABEL: Record<TagMatch, string> = {
  exact: '일치',
  prefix: '앞부분 일치',
  contains: '포함',
  related: '연관',
  typo: '비슷한 입력',
  phonetic: '발음 유사',
  initials: '초성',
  history: '사용 기록'
}
