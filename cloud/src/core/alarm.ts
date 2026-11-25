/**
 * DO 알람 처리 — 대기 작업 재배정 검사 + 클라우드 생성 한 장, 그리고 다음 알람 예약.
 * 예외는 밖으로 던지지 않는다 (던지면 DO 가 알람을 자동으로 거듭 재시도하다가 포기한다).
 * 작업과 무관한 예외(저장소 오류 등)가 연속으로 나도 알람을 끊지 않는다 — 간격만 늘려(최대 10분) 계속 건다.
 * 클라우드 작업이 남아 있으면 항상 다음 알람이 있어야 하기 때문이다.
 */
import type { HubDeps } from './deps'
import { runCloudStep, STEP_DELAY_MS } from './cloudgen'
import { reassignStaleJobs } from './jobs'
import { maybeDailyCleanup } from './maintenance'
import { memoryOf } from './memory'
import { ensureAlarm, ALARM_KEY } from './schedule'
import { kvDel, kvGet, kvSet } from './store'
import { errorText, scrub } from './util'

/** 연속 실패 뒤 다시 시도하는 간격: 10초부터 두 배씩, 최대 10분 */
export const FAILURE_RETRY_MS = 10_000
export const MAX_FAILURE_RETRY_MS = 10 * 60 * 1000

export function failureDelay(failures: number): number {
  return Math.min(MAX_FAILURE_RETRY_MS, FAILURE_RETRY_MS * 2 ** Math.max(0, failures - 1))
}

export async function handleAlarm(deps: HubDeps): Promise<void> {
  const memory = memoryOf(deps.sql)
  memory.alarmRunning = true
  let nextAt: number | null = null
  const wantAt = (at: number): void => {
    nextAt = nextAt == null ? at : Math.min(nextAt, at)
  }
  try {
    kvDel(deps.sql, ALARM_KEY) // 울린 알람은 더 이상 걸려 있지 않다
    maybeDailyCleanup(deps)
    const reassign = reassignStaleJobs(deps)
    if (reassign.nextCheckAt != null) wantAt(reassign.nextCheckAt)
    const step = await runCloudStep(deps)
    if (step.again) wantAt(deps.now() + step.delayMs)
    else if (hasCloudJobs(deps)) wantAt(deps.now() + STEP_DELAY_MS) // 그래도 남았으면 놓치지 않는다
    kvDel(deps.sql, 'alarm:fail')
  } catch (error) {
    let failures = 1
    try {
      failures = Number(kvGet(deps.sql, 'alarm:fail') ?? 0) + 1
      kvSet(deps.sql, 'alarm:fail', String(failures))
      const token = kvGet(deps.sql, 'secret:nai')
      kvSet(deps.sql, 'alarm:lastError', scrub(errorText(error), token).slice(0, 300))
      console.error('[nais3-cloud] 알람 처리 실패', scrub(errorText(error), token))
    } catch {
      // 기록조차 못 하는 상태(저장소 오류) — 그래도 알람은 계속 건다
    }
    wantAt(deps.now() + failureDelay(failures))
  } finally {
    memory.alarmRunning = false
  }
  if (nextAt != null) await ensureAlarm(deps, nextAt)
}

function hasCloudJobs(deps: HubDeps): boolean {
  return deps.sql.exec(`SELECT 1 AS x FROM jobs WHERE state = 'cloud' LIMIT 1`).toArray().length > 0
}
