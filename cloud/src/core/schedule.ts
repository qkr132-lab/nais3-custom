/**
 * 알람 예약. DO 는 알람을 하나만 건다(setAlarm 이 이전 것을 덮어쓴다) — 이미 더 이른 알람이
 * 걸려 있으면 건드리지 않고, 더 이르게 필요하면 앞당긴다. 덮여 사라진 뒤쪽 용무는
 * 알람이 울릴 때(handleAlarm) 상태를 보고 다시 건다.
 */
import type { HubDeps } from './deps'
import { memoryOf } from './memory'
import { kvGet, kvSet } from './store'

export const ALARM_KEY = 'alarm:at'

/** 알람이 울려야 할 시각이 이만큼 지났는데도 걸려 있지 않으면 끊긴 것으로 본다 */
const ALARM_STALE_MS = 60 * 1000
/** 끊김 점검은 이 간격으로만 한다 (점검 자체가 읽기 두 번) */
const ALARM_CHECK_MS = 60 * 1000

export async function ensureAlarm(deps: HubDeps, at: number): Promise<void> {
  const pending = Number(kvGet(deps.sql, ALARM_KEY))
  if (Number.isFinite(pending) && pending > deps.now() && pending <= at) return
  kvSet(deps.sql, ALARM_KEY, String(at))
  await deps.setAlarm(at)
}

/**
 * 클라우드 작업이 남았는데 알람이 끊겨 있으면 다시 건다 (저장소 오류가 길게 이어져 알람 처리가 포기했을 때 등).
 * PC 의 poll 과 폰의 상태 요청이 부른다 — 1분에 한 번만 살피고, 알람이 처리 중이면 건드리지 않는다
 */
export async function ensureAlarmAlive(deps: HubDeps): Promise<void> {
  const memory = memoryOf(deps.sql)
  const now = deps.now()
  if (memory.alarmRunning || now - memory.alarmCheckedAt < ALARM_CHECK_MS) return
  memory.alarmCheckedAt = now
  const waiting =
    deps.sql.exec(`SELECT 1 AS x FROM jobs WHERE state = 'cloud' LIMIT 1`).toArray().length > 0
  if (!waiting) return
  const pending = Number(kvGet(deps.sql, ALARM_KEY))
  if (Number.isFinite(pending) && pending > now - ALARM_STALE_MS) return
  await ensureAlarm(deps, now + 1000)
}
