/**
 * PC 켜짐 표시 — poll 이 알려 주는 lastSeen·acceptsJobs·queue·appVersion.
 * 메모리(memory.ts)에 두고 디스크에는 60초에 한 번 또는 값이 바뀔 때만 쓴다 (queue 비교는 updatedAt 제외).
 */
import { CLOUD_PC_ONLINE_MS, type CloudQueueSummary } from '../../../src/shared/cloud-contract'
import type { HubDeps, SqlLike } from './deps'
import { memoryOf, queueKey, type PcPresence } from './memory'
import { kvGet, kvGetJson, kvSet, kvSetJson } from './store'

/** 값이 그대로여도 디스크의 lastSeen 은 이 간격으로 갱신한다 (인스턴스가 내려갔다 올라올 때 쓰는 값) */
export const PRESENCE_PERSIST_MS = 60 * 1000

/** poll 한 번을 기록한다 */
export function recordPoll(
  deps: HubDeps,
  input: { acceptsJobs: boolean; appVersion: string | null; queue: CloudQueueSummary | null }
): void {
  const { sql } = deps
  const memory = memoryOf(sql)
  const now = deps.now()
  const queue = input.queue ?? memory.pc?.queue ?? null
  const appVersion = input.appVersion ?? memory.pc?.appVersion ?? null
  memory.pc = { lastSeen: now, acceptsJobs: input.acceptsJobs, queue, appVersion }

  const saved = memory.persisted
  const key = queueKey(queue)
  const acceptsChanged = saved.acceptsJobs !== input.acceptsJobs
  const queueChanged = queue != null && saved.queueKey !== key
  const versionChanged = input.appVersion != null && saved.appVersion !== input.appVersion
  const due = now - saved.at >= PRESENCE_PERSIST_MS
  if (!due && !acceptsChanged && !queueChanged && !versionChanged) return

  kvSet(sql, 'pc:lastSeen', String(now))
  if (acceptsChanged) kvSet(sql, 'pc:acceptsJobs', input.acceptsJobs ? '1' : '0')
  if (queueChanged) kvSetJson(sql, 'pc:queue', queue)
  if (versionChanged) kvSet(sql, 'pc:appVersion', input.appVersion as string)
  memory.persisted = {
    at: now,
    acceptsJobs: input.acceptsJobs,
    queueKey: queueChanged ? key : saved.queueKey,
    appVersion: versionChanged ? input.appVersion : saved.appVersion
  }
}

/** 가장 최근 PC 상태 — 메모리에 없으면(인스턴스가 새로 떴으면) 디스크 값. 한 번도 poll 한 적 없으면 null */
export function readPresence(sql: SqlLike): PcPresence | null {
  const memory = memoryOf(sql).pc
  if (memory) return memory
  const lastSeen = Number(kvGet(sql, 'pc:lastSeen'))
  if (!Number.isFinite(lastSeen) || lastSeen <= 0) return null
  return {
    lastSeen,
    acceptsJobs: kvGet(sql, 'pc:acceptsJobs') === '1',
    queue: kvGetJson<CloudQueueSummary>(sql, 'pc:queue'),
    appVersion: kvGet(sql, 'pc:appVersion')
  }
}

/** PC 가 폰 작업을 받을 수 있는 상태인가 — 최근에 poll 했고 렌더러가 준비됨 */
export function isPcOnline(deps: HubDeps): boolean {
  const presence = readPresence(deps.sql)
  if (!presence) return false
  return deps.now() - presence.lastSeen < CLOUD_PC_ONLINE_MS && presence.acceptsJobs
}

export function getQueueSummary(sql: SqlLike): CloudQueueSummary | null {
  return readPresence(sql)?.queue ?? null
}

export function getLastSeen(sql: SqlLike): number | null {
  return readPresence(sql)?.lastSeen ?? null
}
