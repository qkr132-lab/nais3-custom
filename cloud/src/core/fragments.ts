/**
 * 조각(와일드카드) 소스 — PC 가 올린 R2 `meta/fragments.json`(경로 → 줄 배열)을 FragmentSource 로.
 * PC 가 줄 규칙(주석·빈 줄 제거, src/main/fragments/repo.ts 의 contentToLines)을 이미 적용해 보내므로
 * 받은 줄을 그대로 쓴다. 조회 키는 processWildcards 와 같게 `trim().toLowerCase()`.
 */
import type { FragmentSource } from '../../../src/main/fragments/processor'
import type { HubDeps, SqlLike } from './deps'
import { kvGet, kvSet } from './store'

export const FRAGMENTS_KEY = 'meta/fragments.json'

type Cache = { hash: string; lines: Map<string, string[]> }
/** DO 인스턴스(=sql 객체)마다 한 벌 — 해시가 바뀔 때만 R2 에서 다시 읽는다 */
const caches = new WeakMap<object, Cache>()

/** R2 에 올릴 본문을 정리한다 — 문자열 줄만, 키는 그대로 두고 읽을 때 정규화 */
export function sanitizeFragments(byPath: unknown): Record<string, string[]> | null {
  if (!byPath || typeof byPath !== 'object' || Array.isArray(byPath)) return null
  const out: Record<string, string[]> = {}
  for (const [path, lines] of Object.entries(byPath as Record<string, unknown>)) {
    if (!Array.isArray(lines)) return null
    out[path] = lines.filter((l): l is string => typeof l === 'string')
  }
  return out
}

export async function loadFragmentSource(deps: HubDeps): Promise<FragmentSource> {
  const hash = kvGet(deps.sql, 'hash:fragments') ?? ''
  let cache = caches.get(deps.sql)
  if (!cache || cache.hash !== hash) {
    const lines = new Map<string, string[]>()
    const object = await deps.bucket.get(FRAGMENTS_KEY)
    if (object) {
      try {
        const parsed = JSON.parse(await object.text()) as Record<string, unknown>
        for (const [path, value] of Object.entries(parsed)) {
          if (Array.isArray(value)) {
            lines.set(
              path.trim().toLowerCase(),
              value.filter((l): l is string => typeof l === 'string')
            )
          }
        }
      } catch {
        // 깨진 조각 파일은 없는 것으로 본다 — 조각 토큰이 원문 그대로 남는다 (PC 도 없는 조각은 그대로 둔다)
      }
    }
    cache = { hash, lines }
    caches.set(deps.sql, cache)
  }
  const map = cache.lines
  return { getLines: (path) => map.get(path) ?? null }
}

const SEQ_PREFIX = 'seq:'

/** 순차 조각(<*이름>) 카운터 — kv `seq:<경로>` 에서 모두 읽어 Map 으로 */
export function loadSequentialCounters(sql: SqlLike): Map<string, number> {
  const counters = new Map<string, number>()
  const rows = sql
    .exec<{ k: string; v: string }>(`SELECT k, v FROM kv WHERE k LIKE 'seq:%'`)
    .toArray()
  for (const row of rows) {
    const n = Number(row.v)
    if (Number.isFinite(n)) counters.set(row.k.slice(SEQ_PREFIX.length), n)
  }
  return counters
}

/** 처리 뒤 바뀐 카운터만 저장 */
export function saveSequentialCounters(
  sql: SqlLike,
  before: Map<string, number>,
  after: Map<string, number>
): void {
  for (const [path, n] of after) {
    if (before.get(path) !== n) kvSet(sql, SEQ_PREFIX + path, String(n))
  }
}
