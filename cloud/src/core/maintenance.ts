/**
 * 하루 한 번 하는 정리 — 끝난 작업 기록(7일), 반영 끝난 편집 줄(하루), 만료된 연결 코드·시도 기록,
 * 그림 수 카운터 바로잡기. 알람이나 poll 이 부르고, 마지막으로 돌린 시각은 kv `cleanup:at` 에 남는다
 * (하루에 쓰기 한 줄). 정리는 표를 훑으므로 poll 마다 하지 않는다.
 */
import type { HubDeps } from './deps'
import { memoryOf } from './memory'
import { kvGet, kvSet, rebuildPreparedHashes, recountImages } from './store'
import { errorText } from './util'

export const DAY_MS = 24 * 60 * 60 * 1000
/** 끝난 작업 기록을 남기는 기간 */
export const JOB_KEEP_MS = 7 * DAY_MS
/** 반영(ack) 끝난 편집 줄을 남기는 기간 */
export const ACKED_OP_KEEP_MS = DAY_MS

/** 마지막 정리가 하루 넘게 지났으면 돌린다. 정리가 실패해도 요청·알람을 막지 않는다 */
export function maybeDailyCleanup(deps: HubDeps): boolean {
  const { sql } = deps
  const memory = memoryOf(sql)
  const now = deps.now()
  if (memory.lastCleanup == null) {
    const saved = Number(kvGet(sql, 'cleanup:at'))
    memory.lastCleanup = Number.isFinite(saved) ? saved : 0
  }
  if (now - memory.lastCleanup < DAY_MS) return false
  // 실패해도 곧바로 다시 시도하지 않게 먼저 표시한다 (다음 시도는 한 시간 뒤)
  memory.lastCleanup = now - DAY_MS + 60 * 60 * 1000
  try {
    runDailyCleanup(deps)
    memory.lastCleanup = now
    kvSet(sql, 'cleanup:at', String(now))
    return true
  } catch (error) {
    console.error('[nais3-cloud] 정리 실패', errorText(error))
    return false
  }
}

/** 정리 본체 — 시험이 직접 부를 수 있게 내보낸다 */
export function runDailyCleanup(deps: HubDeps): void {
  const { sql } = deps
  const now = deps.now()
  // jobs_updated 인덱스의 updated_at 범위만 훑는다
  sql.exec(
    `DELETE FROM jobs WHERE updated_at < ? AND state IN ('done', 'failed', 'cancelled')`,
    now - JOB_KEEP_MS
  )
  sql.exec(`DELETE FROM ops WHERE acked = 1 AND at < ?`, now - ACKED_OP_KEEP_MS)
  sql.exec(`DELETE FROM ratelimit WHERE reset_at <= ?`, now)
  sql.exec(`DELETE FROM pairing WHERE expires_at <= ?`, now)
  // 카운터·해시 캐시가 어긋났어도 하루 안에 바로잡힌다
  recountImages(sql)
  rebuildPreparedHashes(sql)
}
