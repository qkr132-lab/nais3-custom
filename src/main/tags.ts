import { app } from 'electron'
import { readFileSync } from 'fs'
import { join } from 'path'
import { englishKey, hangulKey, keySimilarity } from './tags-fuzzy'

/**
 * 단부루 태그 자동완성 데이터 (resources/tags.json, ~30만 개).
 * NAIS2는 이걸 렌더러 번들에 넣었지만, NAIS3는 메인에서 lazy 로드 + IPC 검색으로 서빙
 * — 렌더러 메모리/번들에 28MB를 싣지 않는다.
 *
 * 한글 검색 (커스텀): resources/tags-ko.json (직접 작성한 한글 사전 + 색상×부위 조합)
 * 으로 한글 질의를 태그에 매칭하고, 결과에 한글 뜻(ko)을 붙여 내려준다.
 */

export interface TagEntry {
  tag: string
  count: number
  type: string
  /** 한글 뜻 (사전에 있을 때만) */
  ko?: string
}

let tags: TagEntry[] | null = null
let koMap: Record<string, string> | null = null
let koEntries: { entry: TagEntry; ko: string }[] | null = null

function load(): TagEntry[] {
  if (tags) return tags
  const raw = JSON.parse(
    readFileSync(join(app.getAppPath(), 'resources', 'tags.json'), 'utf-8')
  ) as { value: string; count: number; type: string }[]
  // count 내림차순 정렬해두면 검색 결과가 자연히 인기순
  tags = raw
    .map((t) => ({ tag: t.value, count: t.count, type: t.type }))
    .sort((a, b) => b.count - a.count)
  return tags
}

function loadKo(): { map: Record<string, string>; entries: { entry: TagEntry; ko: string }[] } {
  if (koMap && koEntries) return { map: koMap, entries: koEntries }
  try {
    koMap = JSON.parse(
      readFileSync(join(app.getAppPath(), 'resources', 'tags-ko.json'), 'utf-8')
    ) as Record<string, string>
  } catch {
    koMap = {} // 사전 없이도 영어 검색은 동작
  }
  // 인기순(전체 태그 정렬 순서)으로 한글 사전 항목 목록 구성
  const map = koMap
  koEntries = load()
    .filter((t) => map[t.tag])
    .map((t) => ({ entry: t, ko: map[t.tag] }))
  return { map: koMap, entries: koEntries }
}

const HANGUL = /[가-힣]/

/** 태그명 목록 → 정보 조회 (태그 탐색기용). 존재하지 않는 태그는 제외 */
export function lookupTags(names: string[]): TagEntry[] {
  const all = load()
  const { map } = loadKo()
  const byTag = new Map(all.map((t) => [t.tag, t]))
  const result: TagEntry[] = []
  for (const name of names) {
    const t = byTag.get(name)
    if (!t) continue
    const ko = map[t.tag]
    result.push(ko ? { ...t, ko } : t)
  }
  return result
}

// 퍼지 매칭 대상 — 인기 상위 태그의 발음 키 (lazy 1회 계산)
const FUZZY_POOL_SIZE = 60000
let fuzzyPool: { entry: TagEntry; key: string }[] | null = null

function loadFuzzyPool(): { entry: TagEntry; key: string }[] {
  if (fuzzyPool) return fuzzyPool
  fuzzyPool = load()
    .slice(0, FUZZY_POOL_SIZE)
    .map((entry) => ({ entry, key: englishKey(entry.tag) }))
    .filter((p) => p.key.length >= 2)
  return fuzzyPool
}

/** 발음 키 퍼지 매칭 — "미드리프트"→midriff, 영어 오타 보완용 */
function fuzzySearch(queryKey: string, limit: number, excludeTags: Set<string>): TagEntry[] {
  if (queryKey.length < 3) return []
  const { map } = loadKo()
  const scored: { entry: TagEntry; score: number }[] = []
  for (const { entry, key } of loadFuzzyPool()) {
    if (excludeTags.has(entry.tag)) continue
    if (Math.abs(key.length - queryKey.length) > 4) continue // 길이 차 크면 스킵 (성능+정확도)
    const score = keySimilarity(queryKey, key)
    if (score >= 0.55) scored.push({ entry, score })
  }
  // 유사도 → 인기순
  scored.sort((a, b) => b.score - a.score || b.entry.count - a.entry.count)
  return scored.slice(0, limit).map(({ entry }) => {
    const ko = map[entry.tag]
    return ko ? { ...entry, ko } : entry
  })
}

export function searchTags(query: string, limit = 8): TagEntry[] {
  const q = query.trim().toLowerCase().replace(/_/g, ' ')
  if (q.length < 1) return []

  // 한글 질의 — 1) 한글 사전 뜻 매칭 (인기순, 띄어쓴 단어는 AND: "핑크 동공")
  //           2) 부족하면 음차 퍼지 매칭으로 채움
  if (HANGUL.test(q)) {
    const { entries } = loadKo()
    const words = q.split(/\s+/).filter(Boolean)
    const hits: TagEntry[] = []
    for (const { entry, ko } of entries) {
      if (words.every((w) => ko.includes(w) || entry.tag.includes(w))) {
        hits.push({ ...entry, ko })
        if (hits.length >= limit) break
      }
    }
    if (hits.length < limit) {
      const seen = new Set(hits.map((h) => h.tag))
      hits.push(...fuzzySearch(hangulKey(q), limit - hits.length, seen))
    }
    return hits
  }

  if (q.length < 2) return []
  const all = load()
  const { map } = loadKo()

  const prefix: TagEntry[] = []
  const substring: TagEntry[] = []
  for (const t of all) {
    if (t.tag.startsWith(q)) {
      prefix.push(t)
      if (prefix.length >= limit) break
    } else if (substring.length < limit && t.tag.includes(q)) {
      substring.push(t)
    }
  }
  // 영어 결과에도 한글 뜻을 붙여준다 (사전에 있으면)
  const results = [...prefix, ...substring].slice(0, limit).map((t) => {
    const ko = map[t.tag]
    return ko ? { ...t, ko } : t
  })
  // 정확 매칭이 부족하면 오타 등을 퍼지로 보완
  if (results.length < Math.min(3, limit)) {
    const seen = new Set(results.map((r) => r.tag))
    results.push(...fuzzySearch(englishKey(q), limit - results.length, seen))
  }
  return results
}
