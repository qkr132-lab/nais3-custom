import type { TagSuggestion } from '../../src/shared/tag-search'
import { mergeTagRecommendations } from '../../src/shared/tag-search'

const base: TagSuggestion[] = [
  {
    tag: 'smile',
    ko: '미소 / 웃는 표정',
    count: 80000,
    type: 'general',
    match: 'related',
    desc: 'A smile with the corners of the mouth raised. This description stays in the footer, so recommendation rows never move under the pointer.'
  },
  { tag: 'smirk', ko: '씨익 웃는 표정', count: 12000, type: 'general', match: 'contains' },
  { tag: 'blue eyes', ko: '파란 눈 / 푸른 홍채', count: 20000, type: 'general', match: 'exact' },
  { tag: 'blue hair', ko: '파란 머리카락', count: 16000, type: 'general', match: 'related' },
  { tag: 'pink eyes', ko: '분홍 눈', count: 4000, type: 'general', match: 'related' },
  { tag: 'pink hair', ko: '분홍 머리', count: 7000, type: 'general', match: 'related' },
  { tag: 'green eyes', ko: '초록 눈', count: 4000, type: 'general', match: 'related' },
  { tag: 'green hair', ko: '초록 머리', count: 4000, type: 'general', match: 'related' },
  { tag: 'long hair', ko: '긴 머리', count: 4000, type: 'general', match: 'contains' },
  { tag: 'short hair', ko: '짧은 머리', count: 4000, type: 'general', match: 'contains' }
]
const history = new Map<string, { count: number; lastUsed: number }>()
const stats = { requests: [] as string[], delay: 0, accepted: [] as string[] }
Object.assign(window, { tagFixture: stats })

export async function tagFixtureInvoke(channel: string, req: unknown): Promise<unknown> {
  const bridge = (
    window as unknown as { realTagInvoke?: (channel: string, req: unknown) => Promise<unknown> }
  ).realTagInvoke
  if (bridge) return bridge(channel, req)
  const args = req as { query?: string; tag?: string; mode?: string; ko?: string }
  if (channel === 'tags:recordUse') {
    const tag = args.tag!
    history.set(tag, { count: (history.get(tag)?.count ?? 0) + 1, lastUsed: Date.now() })
    stats.accepted.push(tag)
    return undefined
  }
  if (channel === 'tags:setKo') {
    const row = base.find((r) => r.tag === args.tag)
    if (row) {
      row.ko = args.ko
      row.userKo = true
    }
    return undefined
  }
  if (channel === 'tags:history') {
    return {
      items: [...history]
        .sort((a, b) =>
          args.mode === 'frequent' ? b[1].count - a[1].count : b[1].lastUsed - a[1].lastUsed
        )
        .map(([tag, h]) => ({
          ...base.find((r) => r.tag === tag),
          usageCount: h.count,
          match: 'history'
        }))
    }
  }
  if (channel === 'tags:search') {
    const query = args.query ?? ''
    stats.requests.push(query)
    await new Promise((resolve) => setTimeout(resolve, query === 'slow' ? 600 : stats.delay))
    if (query === 'error') throw new Error('fixture error')
    const used = (mode: string): TagSuggestion[] =>
      [...history]
        .sort((a, b) =>
          mode === 'recent' ? b[1].lastUsed - a[1].lastUsed : b[1].count - a[1].count
        )
        .map(([tag, h]) => ({
          ...base.find((r) => r.tag === tag)!,
          usageCount: h.count,
          lastUsed: h.lastUsed
        }))
    const matches =
      !query || query === 'zzzz'
        ? []
        : (query.startsWith('blue') ? base.slice(2, 4) : base).map((r) => ({
            ...r,
            usageCount: history.get(r.tag)?.count
          }))
    return {
      items:
        query === 'zzzz' ? [] : mergeTagRecommendations(matches, used('recent'), used('frequent'))
    }
  }
  throw new Error(`Unexpected tag fixture IPC: ${channel}`)
}
