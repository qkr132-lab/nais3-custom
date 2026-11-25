/**
 * 허브 인스턴스 메모리 — 디스크(SQLite)에 매번 쓰지 않아도 되는 값을 DO 인스턴스 안에 둔다.
 *
 * DO 무료 요금제는 하루 쓰기 10만 행이라, 5초마다 오는 poll 이 값이 같아도 kv 네 줄을 쓰면
 * 하루 6.9만 행이 poll 만으로 나간다. PC 의 켜짐 표시(lastSeen·acceptsJobs·queue·appVersion)는
 * 여기에 두고 디스크에는 60초에 한 번 또는 값이 바뀔 때만 쓴다.
 * 인스턴스가 내려갔다 올라오면 메모리는 비고, 읽는 쪽이 디스크 값으로 물러난다 (다음 poll 이 다시 채운다).
 *
 * 키는 sql 객체(=DO 인스턴스마다 하나) — 테스트에서는 허브마다 따로, 요청마다 deps 를 복사해도 같은 메모리를 본다.
 */
import type { CloudQueueSummary } from '../../../src/shared/cloud-contract'
import type { SqlLike } from './deps'

export interface PcPresence {
  lastSeen: number
  acceptsJobs: boolean
  queue: CloudQueueSummary | null
  appVersion: string | null
}

/** 마지막으로 디스크에 쓴 PC 상태 — 새 poll 과 비교해 바뀐 것만 쓴다 */
export interface PcPersisted {
  at: number
  acceptsJobs: boolean | null
  /** updatedAt 을 뺀 queue 의 JSON */
  queueKey: string | null
  appVersion: string | null
}

export interface HubMemory {
  /** 가장 최근 poll 의 PC 상태 (인스턴스가 새로 떴으면 null → 디스크 값) */
  pc: PcPresence | null
  persisted: PcPersisted
  /** 씬 id → PC 그림 수 (kv scene:counts 를 처음 읽을 때 채우고 PUT 때 갱신) */
  sceneCounts: Record<string, number> | null
  /** 하루 한 번 정리를 마지막으로 돌린 시각 (null = 아직 디스크에서 안 읽음) */
  lastCleanup: number | null
  /** 알람 처리 중인가 — poll 이 알람이 없다고 잘못 보고 또 거는 일을 막는다 */
  alarmRunning: boolean
  /** 알람이 끊기지 않았는지 마지막으로 살핀 시각 */
  alarmCheckedAt: number
}

const memories = new WeakMap<object, HubMemory>()

export function memoryOf(sql: SqlLike): HubMemory {
  let memory = memories.get(sql)
  if (!memory) {
    memory = {
      pc: null,
      persisted: { at: 0, acceptsJobs: null, queueKey: null, appVersion: null },
      sceneCounts: null,
      lastCleanup: null,
      alarmRunning: false,
      alarmCheckedAt: 0
    }
    memories.set(sql, memory)
  }
  return memory
}

/** queue 비교용 키 — poll 마다 달라지는 updatedAt 은 뺀다 */
export function queueKey(queue: CloudQueueSummary | null): string | null {
  if (!queue) return null
  const { updatedAt: _updatedAt, ...rest } = queue
  void _updatedAt
  return JSON.stringify(rest)
}
