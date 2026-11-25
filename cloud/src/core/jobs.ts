/**
 * 생성 작업 — 만들기·배정(설계 7절)·취소·재배정, 작업 일괄 실패.
 * PC 가 생성하는 작업은 queued → (PC 가 가져가 accepted) → pc → done/failed,
 * 클라우드가 생성하는 작업은 cloud → done/failed (실행은 cloudgen.ts).
 */
import {
  CLOUD_JOB_MAX_COUNT,
  type CloudCreateJob,
  type CloudCreateJobResponse,
  type CloudJob,
  type CloudJobPlace,
  type CloudJobTarget,
  type CloudSceneLite
} from '../../../src/shared/cloud-contract'
import type { HubDeps } from './deps'
import { isPcOnline } from './presence'
import { ensureAlarm } from './schedule'
import {
  addOp,
  clearJobKv,
  getJobRow,
  getSettings,
  hasNaiToken,
  hasPendingCharEdits,
  JOB_COLUMNS,
  rowToJob,
  type JobRow
} from './store'
import { HttpError, ID_ALPHABET, isInt, isRecord, randomString } from './util'

/** PC 에 넘긴 작업이 이 시간 동안 accepted 안 되고 PC 가 꺼졌으면 클라우드로 넘긴다 (auto 만) */
export const REASSIGN_AFTER_MS = 45_000
/** PC 가 받은(accepted) 작업이 PC 의 activeJobIds 에 없어도 이만큼은 기다린다 (넘겨받는 중일 수 있음) */
export const PC_LOST_GRACE_MS = 60_000
/** 잃어버린 작업의 오류 문구 — ack 가 이 문구를 알아보고 늦게 온 PC 의 최종 결과를 받아 준다 */
export const PC_LOST_JOB_ERROR = 'PC가 작업을 잃었습니다 (앱을 다시 켰거나 큐를 비움)'
/** 같은 requestId 로 다시 온 작업 만들기는 이 시간 안이면 새로 만들지 않고 앞서 만든 작업을 돌려준다 */
export const REQUEST_ID_WINDOW_MS = 10 * 60 * 1000
/** 클라우드 생성에는 PC 가 반영하기 전의 캐릭터 편집이 쓰이지 않는다는 안내 */
export const CHAR_EDIT_NOTICE = '캐릭터 편집은 PC가 켜져 반영된 뒤부터 클라우드 생성에 쓰입니다'
/** 아직 PC 가 못 가져간 auto 작업을 이 시간 동안만 15초 간격으로 다시 살핀다 */
const REASSIGN_WATCH_MS = 10 * 60 * 1000

export function preparedKey(target: CloudJobTarget): string {
  return target.type === 'scene' ? `scene:${target.sceneId}` : 'main'
}

export function getSceneCopy(deps: HubDeps, sceneId: number): CloudSceneLite | null {
  const row = deps.sql
    .exec<{ data: string }>(`SELECT data FROM scenes WHERE id = ?`, sceneId)
    .toArray()[0]
  return row ? (JSON.parse(row.data) as CloudSceneLite) : null
}

/** 요청 본문 검사 — 어긋나면 400 */
export function parseCreateJob(body: unknown): CloudCreateJob {
  if (!isRecord(body)) throw new HttpError(400, '요청 내용이 올바르지 않습니다')
  const target = body.target
  let parsed: CloudJobTarget
  if (isRecord(target) && target.type === 'main') parsed = { type: 'main' }
  else if (isRecord(target) && target.type === 'scene' && isInt(target.sceneId))
    parsed = { type: 'scene', sceneId: target.sceneId }
  else throw new HttpError(400, '생성할 대상이 올바르지 않습니다')
  if (!isInt(body.count) || body.count < 1 || body.count > CLOUD_JOB_MAX_COUNT)
    throw new HttpError(400, `장수는 1~${CLOUD_JOB_MAX_COUNT} 사이여야 합니다`)
  const place = body.place
  if (place !== 'auto' && place !== 'pc' && place !== 'cloud')
    throw new HttpError(400, '생성 위치가 올바르지 않습니다')
  const parsedInput: CloudCreateJob = {
    target: parsed,
    count: body.count,
    place: place as CloudJobPlace
  }
  if (body.requestId !== undefined && body.requestId !== null) {
    const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : ''
    if (requestId.length < 1 || requestId.length > 100)
      throw new HttpError(400, '요청 번호가 올바르지 않습니다 (1~100자)')
    parsedInput.requestId = requestId
  }
  return parsedInput
}

/** 클라우드로 생성할 준비가 됐는가 — 아니면 사람이 읽는 이유 */
export function cloudReadiness(deps: HubDeps, target: CloudJobTarget): string | null {
  if (!getSettings(deps.sql).cloudGenEnabled)
    return '클라우드 생성이 꺼져 있습니다 (PC → 설정 → 모바일에서 켜세요)'
  if (!hasNaiToken(deps.sql))
    return 'NAI 토큰이 클라우드에 없습니다 (PC에서 클라우드 생성을 다시 켜세요)'
  const has = deps.sql
    .exec(`SELECT 1 AS x FROM prepared WHERE key = ?`, preparedKey(target))
    .toArray().length
  if (!has) {
    return target.type === 'scene'
      ? 'PC가 이 씬의 생성 정보를 아직 안 올렸습니다 (PC를 한 번 켜 주세요)'
      : 'PC가 메인 생성 정보를 아직 안 올렸습니다 (PC를 한 번 켜 주세요)'
  }
  return null
}

export async function createJob(
  deps: HubDeps,
  input: CloudCreateJob
): Promise<CloudCreateJobResponse> {
  const { sql } = deps
  const now = deps.now()

  // 응답이 중간에 유실돼 폰이 같은 요청을 다시 보냈다 — 새로 만들지 않고 앞서 만든 작업을 돌려준다
  if (input.requestId) {
    const earlier = sql
      .exec<JobRow>(
        `SELECT ${JOB_COLUMNS} FROM jobs WHERE request_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1`,
        input.requestId,
        now - REQUEST_ID_WINDOW_MS
      )
      .toArray()[0]
    if (earlier) return { job: rowToJob(earlier) }
  }

  let label = '메인 생성'
  if (input.target.type === 'scene') {
    const scene = getSceneCopy(deps, input.target.sceneId)
    if (!scene) throw new HttpError(404, '씬을 찾을 수 없습니다')
    label = scene.name
  }

  const online = isPcOnline(deps)
  const toPc = input.place === 'pc' || (input.place === 'auto' && online)
  let state: CloudJob['state'] = 'queued'
  let runner: 'pc' | 'cloud' = 'pc'
  let notice: string | undefined
  if (toPc) {
    if (!online) notice = 'PC가 꺼져 있습니다. PC가 켜지면 생성합니다.'
  } else {
    const reason = cloudReadiness(deps, input.target)
    if (reason)
      throw new HttpError(400, input.place === 'auto' ? `PC가 꺼져 있습니다. ${reason}` : reason)
    state = 'cloud'
    runner = 'cloud'
    // 클라우드는 PC 가 반영하기 전의 캐릭터 편집을 완성 요청에 얹을 수 없다 (메인·씬 프롬프트는 얹는다)
    if (hasPendingCharEdits(sql)) notice = CHAR_EDIT_NOTICE
  }

  const id = 'j' + randomString(12, ID_ALPHABET)
  sql.exec(
    `INSERT INTO jobs (id, target, label, count, done, failed, state, place, runner, error, created_at, updated_at, in_flight, attempts, request_id)
     VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, NULL, ?, ?, 0, 0, ?)`,
    id,
    JSON.stringify(input.target),
    label,
    input.count,
    state,
    input.place,
    runner,
    now,
    now,
    input.requestId ?? null
  )

  if (runner === 'cloud') await ensureAlarm(deps, now)
  else if (input.place === 'auto') await ensureAlarm(deps, now + REASSIGN_AFTER_MS + 1000)

  return { job: rowToJob(getJobRow(sql, id) as JobRow), notice }
}

export function cancelJob(deps: HubDeps, id: string): CloudJob {
  const row = getJobRow(deps.sql, id)
  if (!row) throw new HttpError(404, '작업을 찾을 수 없습니다')
  if (row.state === 'done' || row.state === 'failed' || row.state === 'cancelled')
    return rowToJob(row)
  deps.sql.exec(
    `UPDATE jobs SET state = 'cancelled', in_flight = 0, attempts = 0, updated_at = ? WHERE id = ?`,
    deps.now(),
    id
  )
  // PC 가 맡은(또는 맡을) 작업이면 PC 메인이 큐 항목을 직접 취소하도록 줄에 세운다
  if (row.runner === 'pc') addOp(deps, 'job:cancel', { jobId: id })
  clearJobKv(deps.sql, id)
  return rowToJob(getJobRow(deps.sql, id) as JobRow)
}

/** 클라우드가 맡은 작업을 전부 실패로 (토큰 삭제·생성 끔 등) */
export function failCloudJobs(deps: HubDeps, message: string): number {
  const rows = deps.sql.exec<{ id: string }>(`SELECT id FROM jobs WHERE state = 'cloud'`).toArray()
  if (rows.length === 0) return 0
  deps.sql.exec(
    `UPDATE jobs SET state = 'failed', error = ?, in_flight = 0, attempts = 0, updated_at = ? WHERE state = 'cloud'`,
    message,
    deps.now()
  )
  for (const row of rows) clearJobKv(deps.sql, row.id)
  return rows.length
}

/**
 * state 'pc' 인데 PC 가 큐에 들고 있다고 알린 작업(activeIds)에 없고, PC 가 받은 지 60초가 지난 작업을
 * 실패로 정리한다 (앱을 다시 켰거나 큐를 비워 PC 가 작업을 잃은 경우). 돌려주는 값 = 정리한 작업 수.
 * 받은 시각이 없는 옛 행은 updated_at 으로 갈음한다.
 */
export function failLostPcJobs(deps: HubDeps, activeIds: ReadonlySet<string>): number {
  const now = deps.now()
  const rows = deps.sql
    .exec<{ id: string }>(
      `SELECT id FROM jobs WHERE state = 'pc' AND runner = 'pc' AND COALESCE(accepted_at, updated_at) <= ?`,
      now - PC_LOST_GRACE_MS
    )
    .toArray()
  let lost = 0
  for (const row of rows) {
    if (activeIds.has(row.id)) continue
    deps.sql.exec(
      `UPDATE jobs SET state = 'failed', error = ?, updated_at = ? WHERE id = ? AND state = 'pc'`,
      PC_LOST_JOB_ERROR,
      now,
      row.id
    )
    clearJobKv(deps.sql, row.id)
    lost++
  }
  return lost
}

/**
 * auto 작업 중 PC 가 45초 동안 못 가져갔고 PC 가 꺼졌으면 클라우드로 넘긴다.
 * 클라우드로 생성할 준비가 안 됐으면 queued 로 둔다 (PC 가 켜지면 처리).
 * 돌려주는 값 = 다시 살펴볼 시각 (필요 없으면 null)
 */
export function reassignStaleJobs(deps: HubDeps): { nextCheckAt: number | null } {
  const now = deps.now()
  const rows = deps.sql
    .exec<JobRow>(
      `SELECT ${JOB_COLUMNS} FROM jobs WHERE state = 'queued' AND runner = 'pc' AND place = 'auto'
       ORDER BY created_at ASC`
    )
    .toArray()
  if (rows.length === 0) return { nextCheckAt: null }
  const online = isPcOnline(deps)
  let next: number | null = null
  const watch = (at: number): void => {
    next = next == null ? at : Math.min(next, at)
  }
  for (const row of rows) {
    const dueAt = row.created_at + REASSIGN_AFTER_MS
    if (now < dueAt) {
      watch(dueAt + 500)
      continue
    }
    if (online) {
      // PC 가 켜져 있는데 아직 안 가져갔다 — 꺼지는 순간을 놓치지 않게 잠시 더 살핀다
      if (now - row.created_at < REASSIGN_WATCH_MS) watch(now + 15_000)
      continue
    }
    const target = JSON.parse(row.target) as CloudJobTarget
    if (cloudReadiness(deps, target) != null) continue
    deps.sql.exec(
      `UPDATE jobs SET state = 'cloud', runner = 'cloud', updated_at = ? WHERE id = ? AND state = 'queued'`,
      now,
      row.id
    )
  }
  return { nextCheckAt: next }
}
