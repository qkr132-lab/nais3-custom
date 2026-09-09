import Database from 'better-sqlite3'
import { compact, koreanInitials, koreanTypingKey, oneTypo, relatedKey } from './tags-related'
import { mergeTagRecommendations } from '../shared/tag-search'
import type { TagMatch, TagSuggestion, TagUsage } from '../shared/tag-search'

interface Row {
  id: number
  tag: string
  key: string
  count: number
  type: string
  ko: string | null
  description: string | null
  aliases: string
  legacy: number
}
interface Aliases {
  ko: string[]
  en: string[]
}
interface Personal {
  ko: Record<string, string>
  usage: TagUsage
}
interface Ranked {
  row: Row
  rank: number
  match: TagMatch
  alias?: string
}
export const normalizeTagQuery = (s: string): string =>
  s.normalize('NFC').trim().toLowerCase().replace(/_/g, ' ').slice(0, 120)
const clampLimit = (n: number): number => Math.max(1, Math.min(30, Math.floor(n) || 10))
const splitAliases = (s: string): string[] =>
  s
    .split(/[(),/;|]/)
    .map((s) => s.trim())
    .filter(Boolean)

/** Immutable disk indexes, a 16 MiB page cache, and bounded candidate sets.
 * This class runs ONLY in the search worker in production. Opening it never
 * parses the full dictionary, builds an index, or touches the user's database. */
export class TagSearchEngine {
  private db: Database.Database
  private personal: Personal = { ko: {}, usage: {} }
  private cache = new Map<string, TagSuggestion[]>()
  private rowCache = new Map<number, Row>()
  private statements = new Map<string, Database.Statement>()
  constructor(path: string) {
    this.db = new Database(path, { readonly: true, fileMustExist: true })
    this.db.pragma('query_only = ON')
    this.db.pragma('cache_size = -16384')
    const manifest = this.get('SELECT value FROM metadata WHERE key = ?', 'manifest') as
      { value: string } | undefined
    if (!manifest || JSON.parse(manifest.value).schema !== 1)
      throw new Error('Unsupported tag search database')
  }
  close(): void {
    this.db.close()
  }
  private statement(sql: string): Database.Statement {
    let st = this.statements.get(sql)
    if (!st) {
      st = this.db.prepare(sql)
      this.statements.set(sql, st)
    }
    return st
  }
  private get(sql: string, ...args: (string | number)[]): unknown {
    return this.statement(sql).get(...args)
  }
  private all(sql: string, ...args: (string | number)[]): Row[] {
    return this.statement(sql).all(...args) as Row[]
  }
  setPersonal(value: Personal): void {
    this.personal = value
    this.cache.clear()
  }
  private row(id: number): Row | undefined {
    let row = this.rowCache.get(id)
    if (!row) {
      row = this.get('SELECT * FROM tags WHERE id = ?', id) as Row | undefined
      if (row) {
        if (this.rowCache.size >= 2048) this.rowCache.delete(this.rowCache.keys().next().value!)
        this.rowCache.set(id, row)
      }
    }
    return row
  }
  private named(name: string): Row | undefined {
    return this.get('SELECT * FROM tags WHERE tag = ?', normalizeTagQuery(name)) as Row | undefined
  }
  private enrich(row: Row, match?: TagMatch, alias?: string): TagSuggestion {
    const ko = this.personal.ko[row.tag] || row.ko
    const used = this.personal.usage[row.tag]
    return {
      tag: row.tag,
      count: row.count,
      type: row.type,
      ...(row.legacy ? { legacy: true } : {}),
      ...(ko ? { ko: splitAliases(ko)[0] } : {}),
      ...(this.personal.ko[row.tag] ? { userKo: true } : {}),
      ...(row.description ? { desc: row.description } : {}),
      ...(alias && compact(alias) !== compact(ko ?? '') ? { matchedAlias: alias } : {}),
      ...(match ? { match } : {}),
      ...(used ? { usageCount: used.count, lastUsed: used.lastUsed } : {})
    }
  }
  lookup(names: string[]): TagSuggestion[] {
    return names.slice(0, 1000).flatMap((name) => {
      const row = this.named(name)
      return row ? [this.enrich(row)] : []
    })
  }
  history(mode: 'recent' | 'frequent', limit = 12): TagSuggestion[] {
    return Object.entries(this.personal.usage)
      .sort((a, b) =>
        mode === 'frequent'
          ? b[1].count - a[1].count || b[1].lastUsed - a[1].lastUsed
          : b[1].lastUsed - a[1].lastUsed || b[1].count - a[1].count
      )
      .slice(0, clampLimit(limit))
      .flatMap(([name]) => {
        const row = this.named(name)
        return row ? [this.enrich(row, 'history')] : []
      })
  }
  private ids(key: string, kind: number, exact = false): number[] {
    if (!key) return []
    if (!exact && key.length <= 2) {
      const found = this.get(
        'SELECT ids FROM short_terms WHERE key = ? AND kind = ?',
        key,
        kind
      ) as { ids: string } | undefined
      return found ? JSON.parse(found.ids) : []
    }
    if (kind === 4) {
      return this.all(
        'SELECT id FROM tags WHERE key >= ? AND key < ? LIMIT 512',
        key,
        key + '\uffff'
      ).map((r) => r.id)
    }
    const sql = exact
      ? 'SELECT tag_id AS id FROM terms WHERE key = ? AND kind = ? LIMIT 512'
      : 'SELECT tag_id AS id FROM terms WHERE key >= ? AND key < ? AND kind = ? LIMIT 512'
    return this.all(sql, ...(exact ? [key, kind] : [key, key + '\uffff', kind])).map((r) => r.id)
  }
  search(query: string, limit = 10): TagSuggestion[] {
    const q = normalizeTagQuery(query),
      n = clampLimit(limit)
    const korean = /[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(q)
    if (!q || (!korean && q.length < 2)) return []
    const cacheKey = `${n}:${q}`
    const cached = this.cache.get(cacheKey)
    if (cached) return cached.map((r) => ({ ...r }))
    const cq = compact(q),
      words = q.split(/\s+/).map(compact).filter(Boolean)
    const initial = /^[ㄱ-ㅎ]+$/.test(cq)
    const typing = koreanTypingKey(q)
    const candidates = new Map<number, Row>()
    const relatedIds = new Set<number>()
    const addIds = (ids: number[]): void => {
      for (const id of ids) {
        if (!candidates.has(id)) {
          const r = this.row(id)
          if (r) candidates.set(id, r)
        }
      }
    }
    addIds(this.ids(cq, 0, true))
    if (initial) {
      addIds(this.ids(cq, 2))
    } else if (korean) {
      if (cq.length >= 2) {
        for (const id of this.ids(cq, 5, true)) relatedIds.add(id)
        addIds([...relatedIds])
      }
      addIds(this.ids(cq, 0))
      addIds(this.ids(typing, 3))
      if (cq.length >= 2) addIds(this.ids(cq, 1))
      // Multiword Korean queries retain all constraints; begin with the longest
      // term to avoid broad single-character lists drowning out precise phrases.
      if (words.length > 1) {
        for (const w of [...words].sort((a, b) => b.length - a.length).slice(0, 3)) {
          addIds(this.ids(w, 0))
          if (w.length >= 2) addIds(this.ids(w, 1))
        }
      }
      const folded = compact(relatedKey(q))
      if (folded !== cq && !/[가-힣]/.test(folded)) {
        addIds(this.ids(folded, 4))
        addIds(this.ids(folded, 0))
      }
      // Typo candidates share all but the final syllable or their initials.
      if (cq.length >= 3 && cq.length <= 32) {
        addIds(this.ids(cq.slice(0, -1), 0))
        addIds(this.ids(koreanInitials(cq), 2))
      }
    } else {
      addIds(this.ids(cq, 4))
      addIds(this.ids(cq, 0))
      // Trigram FTS stores only canonical names and active English aliases.
      // LIMIT streams popular rowids, with no unbounded relevance sort.
      const terms = words.filter((w) => w.length >= 3)
      if (terms.length) {
        const grams = [
          ...new Set(
            terms.flatMap((w) => Array.from({ length: w.length - 2 }, (_, i) => w.slice(i, i + 3)))
          )
        ]
        const match = grams.map((w) => `"${w.replace(/"/g, '""')}"`).join(' AND ')
        addIds(
          this.all(
            'SELECT rowid AS id FROM substrings WHERE substrings MATCH ? LIMIT 512',
            match
          ).map((r) => r.id)
        )
      }
    }
    // Personal vocabulary is small and changes independently of the disk index.
    for (const tag of Object.keys(this.personal.ko)) {
      const r = this.named(tag)
      if (r) candidates.set(r.id, r)
    }
    const ranked: Ranked[] = []
    for (const row of candidates.values()) {
      const saved = JSON.parse(row.aliases) as Aliases
      const names = [
        ...splitAliases(this.personal.ko[row.tag] ?? ''),
        ...saved.ko,
        row.tag,
        ...saved.en
      ]
      let best: Ranked | undefined = relatedIds.has(row.id)
        ? { row, rank: 6, match: 'related' }
        : undefined
      for (const name of names) {
        const key = compact(name)
        let rank = Infinity,
          match: TagMatch = 'contains'
        if (
          key === cq &&
          (korean || normalizeTagQuery(name).replace(/\s/g, '') === q.replace(/\s/g, ''))
        ) {
          rank = 0
          match = 'exact'
        } else if (initial && koreanInitials(key).startsWith(cq)) {
          rank =
            cq.length >= 2 && koreanInitials(key) === cq
              ? 0.5
              : compact(row.ko ?? '') === key
                ? 1
                : 2
          match = 'initials'
        } else if (!initial && key.startsWith(cq)) {
          rank = 1
          match = 'prefix'
        } else if (korean && !initial && koreanTypingKey(key).startsWith(typing)) {
          rank = 2
          match = 'prefix'
        } else if (!initial && words.every((w) => key.includes(w))) {
          rank = 3
        } else if (
          !initial &&
          korean &&
          row.type === 'general' &&
          compact(relatedKey(key)).includes(compact(relatedKey(q)))
        ) {
          rank = 4
          match = 'related'
        } else if (!initial && cq.length >= 3 && oneTypo(cq, key)) {
          rank = 5
          match = 'typo'
        }
        if (Number.isFinite(rank) && (!best || rank < best.rank))
          best = { row, rank, match, alias: name }
      }
      if (best) ranked.push(best)
    }
    ranked.sort(
      (a, b) =>
        a.rank - b.rank ||
        (korean && a.rank > 0
          ? Number(a.row.type !== 'general') - Number(b.row.type !== 'general')
          : 0) ||
        Math.log2(1 + (this.personal.usage[b.row.tag]?.count ?? 0)) -
          Math.log2(1 + (this.personal.usage[a.row.tag]?.count ?? 0)) ||
        b.row.count - a.row.count ||
        a.row.tag.localeCompare(b.row.tag)
    )
    const result = ranked.slice(0, n).map((r) => this.enrich(r.row, r.match, r.alias))
    if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!)
    this.cache.set(cacheKey, result)
    return result.map((r) => ({ ...r }))
  }
  recommend(query: string, limit = 10): TagSuggestion[] {
    const n = clampLimit(limit)
    return mergeTagRecommendations(
      this.search(query, n),
      this.history('recent', n),
      this.history('frequent', n),
      n
    )
  }
}
