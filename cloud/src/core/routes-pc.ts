/** PC 용 API (설계 5-1) — 모두 x-nais-pc 인증을 통과한 뒤에만 들어온다 */
import {
  CLOUD_PROTOCOL,
  type CloudAckRequest,
  type CloudGeneratedImage,
  type CloudHashes,
  type CloudImageMeta,
  type CloudLibrary,
  type CloudPcInfo,
  type CloudPollResponse,
  type CloudPreparedItem,
  type CloudQueueSummary,
  type CloudSceneLite,
  type CloudSettings
} from '../../../src/shared/cloud-contract'
import { createPairing } from './auth'
import type { HubDeps } from './deps'
import { FRAGMENTS_KEY, sanitizeFragments } from './fragments'
import { failCloudJobs, failLostPcJobs, PC_LOST_JOB_ERROR } from './jobs'
import { maybeDailyCleanup } from './maintenance'
import { recordPoll } from './presence'
import type { Route, RouteCtx as Ctx } from './route'
import { ensureAlarmAlive } from './schedule'
import {
  adjustImageCounters,
  applyScenePatch,
  bumpNaiEpoch,
  clearJobKv,
  enforceRetention,
  getImageCounters,
  getImageRow,
  getJobRow,
  getQuota,
  getSettings,
  hasLibrary,
  hasNaiToken,
  IMAGE_COLUMNS,
  JOB_COLUMNS,
  kvDel,
  kvGet,
  kvGetJson,
  kvSet,
  kvSetJson,
  overlayPendingLibraryOps,
  pendingOpRowsForPoll,
  pendingScenePatches,
  placeholders,
  readPreparedHashes,
  recordAckedMainPatch,
  rowToJob,
  rowToOp,
  saveLibrary,
  setSceneCounts,
  setSettings,
  thumbFlag,
  thumbKey,
  thumbKindFromRequest,
  thumbKindOf,
  thumbMime,
  writePreparedHashes,
  type ImageRow,
  type JobRow
} from './store'
import {
  binary,
  chunk,
  fromBase64Url,
  HttpError,
  isInt,
  isNonEmptyString,
  isRecord,
  ok,
  readBytes,
  readJson,
  sha256Hex
} from './util'

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_THUMB_BYTES = 512 * 1024
const MAX_PREPARED_ITEMS = 200
const MAX_PREPARED_CHARS = 2 * 1024 * 1024
const MAX_OPS_PER_POLL = 200
/** 씬 업로드를 한 문장에 몇 행씩 넣을지 (DO SQL 은 쿼리당 바인딩 100개 — 행당 4개) */
const SCENE_UPSERT_ROWS = 24

function bodyRecord(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw new HttpError(400, '요청 내용이 올바르지 않습니다')
  return body
}

function nullableInt(value: unknown): number | null {
  if (value == null) return null
  if (!isInt(value)) throw new HttpError(400, '요청 내용이 올바르지 않습니다')
  return value
}

// ── 정보·해시 ───────────────────────────────────────────────────────

function info(deps: HubDeps): Response {
  const { sql } = deps
  const count = (query: string): number => sql.exec<{ n: number }>(query).one().n
  const result: CloudPcInfo = {
    protocol: CLOUD_PROTOCOL,
    hasNaiToken: hasNaiToken(sql),
    settings: getSettings(sql),
    devices: count(`SELECT COUNT(*) AS n FROM devices`),
    // 그림 수는 카운터 한 행에서 — 30초마다 오는 요청이 그림 표를 훑지 않게
    imagesStored: getImageCounters(sql).total,
    // jobs_active 인덱스에서 state='cloud' 행만 센다
    cloudJobsActive: count(`SELECT COUNT(*) AS n FROM jobs WHERE state = 'cloud'`),
    quota: getQuota(deps)
  }
  return ok({ ...result })
}

function hashes(deps: HubDeps): Response {
  const { sql } = deps
  const scenes: Record<string, string> = {}
  for (const row of sql
    .exec<{ preset_id: number; hash: string }>(`SELECT preset_id, hash FROM scene_hash`)
    .toArray()) {
    scenes[String(row.preset_id)] = row.hash
  }
  const result: CloudHashes = {
    library: kvGet(sql, 'hash:library'),
    fragments: kvGet(sql, 'hash:fragments'),
    scenes,
    // 완성 요청 해시는 kv 한 덩어리 캐시에서 (표 전체를 훑지 않는다)
    prepared: readPreparedHashes(sql)
  }
  return ok({ ...result })
}

// ── 업로드 ──────────────────────────────────────────────────────────

async function putLibrary({ deps, request }: Ctx): Promise<Response> {
  const body = bodyRecord(await readJson(request, 8_000_000, 8_000_000))
  const library = body.library as CloudLibrary | undefined
  if (
    !isNonEmptyString(body.hash) ||
    !isRecord(library) ||
    !Array.isArray(library.presets) ||
    !Array.isArray(library.characters) ||
    !isRecord(library.main)
  ) {
    throw new HttpError(400, '라이브러리 내용이 올바르지 않습니다')
  }
  const { sql } = deps
  // PC 가 보낸 값 위에 아직 PC 가 반영하지 않은 폰 편집(char·main)을 다시 얹는다
  overlayPendingLibraryOps(sql, library)
  saveLibrary(sql, library)
  kvSet(sql, 'hash:library', body.hash)

  // 라이브러리에 없는 프리셋의 씬·해시는 지운다 (씬을 올릴 때마다 scene_hash 에 프리셋 한 줄이 남으므로
  // 그 표만 보면 된다 — scenes 표를 훑지 않는다)
  const known = new Set(library.presets.map((p) => p.id))
  const stored = sql.exec<{ preset_id: number }>(`SELECT preset_id FROM scene_hash`).toArray()
  for (const row of stored) {
    if (known.has(row.preset_id)) continue
    sql.exec(`DELETE FROM scenes WHERE preset_id = ?`, row.preset_id)
    sql.exec(`DELETE FROM scene_hash WHERE preset_id = ?`, row.preset_id)
  }
  return ok()
}

/**
 * 프리셋의 씬을 올린다 — 차분 반영. 프리셋 씬을 지웠다 다시 쓰지 않고, 기존과 다른 행만 쓰고
 * (INSERT … ON CONFLICT DO UPDATE … WHERE 달라졌을 때만), 이번 업로드에 없는 id 만 지운다.
 * 씬 1000개 중 1개만 바뀐 업로드가 쓰는 행은 그 1개와 해시 한 줄뿐이다 (DO 무료 요금제 하루 쓰기 10만 행).
 */
async function putScenes({ deps, request }: Ctx): Promise<Response> {
  const body = bodyRecord(await readJson(request, 40_000_000, 16_000_000))
  if (!isInt(body.presetId) || !Array.isArray(body.scenes) || !isNonEmptyString(body.hash)) {
    throw new HttpError(400, '씬 내용이 올바르지 않습니다')
  }
  const presetId = body.presetId
  const { sql } = deps
  const patches = pendingScenePatches(sql)
  // 전부 검사한 뒤에 쓴다 (중간에 거절해도 이전 씬이 남도록)
  const incoming = body.scenes.map((raw, index) => {
    if (!isRecord(raw) || !isInt(raw.id)) throw new HttpError(400, '씬 내용이 올바르지 않습니다')
    // 그림 수는 씬 본문에 두지 않는다 (옛 PC 가 보낸 값은 버린다 — scene-counts 로 따로 받음)
    const { imageCount: _imageCount, ...rest } = raw
    void _imageCount
    const scene = { ...rest, presetId } as unknown as CloudSceneLite
    const patch = patches.get(scene.id)
    const merged = patch ? applyScenePatch(scene, patch) : scene
    return {
      id: merged.id,
      sortOrder: typeof merged.sortOrder === 'number' ? merged.sortOrder : index,
      data: JSON.stringify(merged)
    }
  })

  const existing = new Map<number, { sortOrder: number; data: string }>()
  for (const row of sql
    .exec<{ id: number; sort_order: number; data: string }>(
      `SELECT id, sort_order, data FROM scenes WHERE preset_id = ?`,
      presetId
    )
    .toArray()) {
    existing.set(row.id, { sortOrder: row.sort_order, data: row.data })
  }

  const changed = incoming.filter((scene) => {
    const before = existing.get(scene.id)
    return !before || before.data !== scene.data || before.sortOrder !== scene.sortOrder
  })
  for (const part of chunk(changed, SCENE_UPSERT_ROWS)) {
    sql.exec(
      `INSERT INTO scenes (id, preset_id, sort_order, data) VALUES ${part.map(() => '(?, ?, ?, ?)').join(', ')}
       ON CONFLICT(id) DO UPDATE SET preset_id = excluded.preset_id, sort_order = excluded.sort_order, data = excluded.data
       WHERE scenes.data <> excluded.data OR scenes.preset_id <> excluded.preset_id OR scenes.sort_order <> excluded.sort_order`,
      ...part.flatMap((scene) => [scene.id, presetId, scene.sortOrder, scene.data])
    )
  }

  const uploaded = new Set(incoming.map((scene) => scene.id))
  const stale = [...existing.keys()].filter((id) => !uploaded.has(id))
  for (const part of chunk(stale, 50)) {
    sql.exec(
      `DELETE FROM scenes WHERE preset_id = ? AND id IN (${placeholders(part.length)})`,
      presetId,
      ...part
    )
  }

  sql.exec(
    `INSERT INTO scene_hash (preset_id, hash) VALUES (?, ?)
     ON CONFLICT(preset_id) DO UPDATE SET hash = excluded.hash WHERE scene_hash.hash <> excluded.hash`,
    presetId,
    body.hash
  )
  return ok()
}

/** 씬 id → PC 그림 수. PC 가 60초에 한 번 이하·바뀌었을 때만 보낸다 — 폰 응답의 imageCount 가 된다 */
async function putSceneCounts({ deps, request }: Ctx): Promise<Response> {
  const body = bodyRecord(await readJson(request, 4_000_000))
  if (!isRecord(body.counts)) throw new HttpError(400, '그림 수 내용이 올바르지 않습니다')
  const counts: Record<string, number> = {}
  for (const [id, n] of Object.entries(body.counts)) {
    if (!/^\d+$/.test(id) || !isInt(n) || n < 0)
      throw new HttpError(400, '그림 수 내용이 올바르지 않습니다')
    if (n > 0) counts[id] = n // 0 은 저장하지 않는다 (없으면 0)
  }
  setSceneCounts(deps.sql, counts)
  return ok()
}

async function putPrepared({ deps, request }: Ctx): Promise<Response> {
  const body = bodyRecord(await readJson(request, MAX_PREPARED_CHARS))
  if (!Array.isArray(body.items)) throw new HttpError(400, '생성 정보 내용이 올바르지 않습니다')
  if (body.items.length > MAX_PREPARED_ITEMS)
    throw new HttpError(413, '한 번에 보낼 수 있는 개수를 넘었습니다')
  const items: CloudPreparedItem[] = []
  for (const raw of body.items) {
    if (
      !isRecord(raw) ||
      typeof raw.key !== 'string' ||
      !/^(main|scene:\d+)$/.test(raw.key) ||
      !isNonEmptyString(raw.hash) ||
      !isRecord(raw.request)
    ) {
      throw new HttpError(400, '생성 정보 내용이 올바르지 않습니다')
    }
    items.push(raw as unknown as CloudPreparedItem)
  }
  let allKeys: string[] | null = null
  if (body.allKeys !== undefined) {
    if (!Array.isArray(body.allKeys) || !body.allKeys.every((k) => typeof k === 'string'))
      throw new HttpError(400, '생성 정보 내용이 올바르지 않습니다')
    allKeys = body.allKeys as string[]
  }
  const { sql } = deps
  const hashes = readPreparedHashes(sql)
  const now = deps.now()
  let dirty = false
  for (const item of items) {
    // 내용이 그대로면 쓰지 않는다 (같은 걸 다시 보내도 쓰기 행이 늘지 않게). 바뀐 행만 바뀐 시각(updated_at)을 남긴다 —
    // ack 된 메인 편집을 이 행에 덧입혀야 하는지(ack 뒤로 새로 올라왔는지) 가리는 데 쓴다
    sql.exec(
      `INSERT INTO prepared (key, hash, request, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET hash = excluded.hash, request = excluded.request, updated_at = excluded.updated_at
       WHERE prepared.hash <> excluded.hash OR prepared.request <> excluded.request`,
      item.key,
      item.hash,
      JSON.stringify(item.request),
      now
    )
    if (hashes[item.key] !== item.hash) {
      hashes[item.key] = item.hash
      dirty = true
    }
  }
  if (allKeys) {
    const keep = new Set(allKeys)
    const stale = Object.keys(hashes).filter((k) => !keep.has(k))
    for (const part of chunk(stale, 50)) {
      sql.exec(`DELETE FROM prepared WHERE key IN (${placeholders(part.length)})`, ...part)
      for (const key of part) delete hashes[key]
      dirty = true
    }
  }
  if (dirty) writePreparedHashes(sql, hashes)
  return ok()
}

async function putFragments({ deps, request }: Ctx): Promise<Response> {
  const body = bodyRecord(await readJson(request, 20_000_000, 16_000_000))
  const byPath = sanitizeFragments(body.byPath)
  if (!byPath || !isNonEmptyString(body.hash))
    throw new HttpError(400, '조각 내용이 올바르지 않습니다')
  // 파일을 먼저 올리고 해시를 나중에 — 해시가 옛 파일을 가리키는 순간이 없게
  await deps.bucket.put(FRAGMENTS_KEY, JSON.stringify(byPath), {
    httpMetadata: { contentType: 'application/json' }
  })
  kvSet(deps.sql, 'hash:fragments', body.hash)
  return ok()
}

// ── 작업 주고받기 ───────────────────────────────────────────────────

/** poll 의 activeJobIds — 문자열 배열일 때만 인정 (아니면 null = 정리하지 않음) */
function parseActiveJobIds(value: unknown): Set<string> | null {
  if (!Array.isArray(value) || !value.every((id) => typeof id === 'string')) return null
  return new Set(value as string[])
}

async function poll({ deps, request }: Ctx): Promise<Response> {
  const body = bodyRecord(await readJson(request, 200_000))
  const { sql } = deps
  const now = deps.now()
  // 켜짐 표시는 메모리에 두고 디스크에는 60초에 한 번·바뀔 때만 쓴다 (5초마다 오는 요청)
  recordPoll(deps, {
    acceptsJobs: body.acceptsJobs === true,
    appVersion: typeof body.appVersion === 'string' ? body.appVersion.slice(0, 40) : null,
    queue: isRecord(body.queue) ? (body.queue as unknown as CloudQueueSummary) : null
  })
  maybeDailyCleanup(deps)
  await ensureAlarmAlive(deps)

  // PC 가 큐에 들고 있는 작업 목록을 보냈으면, 거기 없는 pc 작업(앱 재시작·큐 비움)을 실패로 정리한다.
  // 목록 필드가 없거나 모양이 어긋난 옛 요청은 정리하지 않는다
  const active = parseActiveJobIds(body.activeJobIds)
  if (active) failLostPcJobs(deps, active)

  // 줄 수(200)와 합계 크기(2MB) 안에서 앞에서부터 — 나머지는 이 줄들이 ack 된 뒤 다음 poll 에
  const ops = pendingOpRowsForPoll(sql, MAX_OPS_PER_POLL).map(rowToOp)
  const jobs = sql
    .exec<JobRow>(
      `SELECT ${JOB_COLUMNS} FROM jobs WHERE state = 'queued' AND runner = 'pc' ORDER BY created_at ASC LIMIT 50`
    )
    .toArray()
    .map(rowToJob)
  const result: CloudPollResponse = {
    protocol: CLOUD_PROTOCOL,
    serverTime: now,
    ops,
    jobs,
    needsFullSync: !hasLibrary(sql)
  }
  return ok({ ...result })
}

/**
 * PC 가 반영하지 못한 편집은 워커 사본에만 남는다 — 그 대상의 해시(씬이면 그 프리셋, 캐릭터·메인이면 라이브러리)를 지워
 * PC 의 다음 동기화가 해시 차이로 실제 값을 다시 올리게 한다. PC 의 되돌림 플래그는 메모리에만 있어
 * ack 직후 앱이 꺼지면 사라지므로 워커 쪽에도 남긴다. 이미 ack 된 줄(중복 ack)은 건너뛴다
 */
function forgetHashesOfFailedOps(deps: HubDeps, ids: number[]): void {
  const { sql } = deps
  for (const part of chunk(ids, 50)) {
    const rows = sql
      .exec<{ type: string; payload: string }>(
        `SELECT type, payload FROM ops WHERE acked = 0 AND id IN (${placeholders(part.length)})`,
        ...part
      )
      .toArray()
    for (const row of rows) {
      if (row.type === 'scene:update') {
        const sceneId = (JSON.parse(row.payload) as { sceneId?: unknown }).sceneId
        if (isInt(sceneId))
          sql.exec(
            `DELETE FROM scene_hash WHERE preset_id = (SELECT preset_id FROM scenes WHERE id = ?)`,
            sceneId
          )
      } else if (row.type === 'char:update' || row.type === 'main:update') {
        kvDel(sql, 'hash:library')
      }
    }
  }
}

async function ack({ deps, request }: Ctx): Promise<Response> {
  const body = bodyRecord(await readJson(request, 200_000)) as unknown as Partial<CloudAckRequest>
  const { sql } = deps
  const now = deps.now()
  const opIds = Array.isArray(body.opIds) ? body.opIds.filter(isInt) : []
  const failedOpIds = new Set(Array.isArray(body.failedOpIds) ? body.failedOpIds.filter(isInt) : [])
  // ack 된 메인 프롬프트 편집은 PC 가 새 완성 요청을 올릴 때까지 클라우드 생성이 계속 덧입힌다 (ack 표시 전에 남긴다)
  // PC 가 반영하지 못한 줄은 덧입히지 않는다 — PC 값이 그대로이므로
  recordAckedMainPatch(
    deps,
    opIds.filter((id) => !failedOpIds.has(id))
  )
  forgetHashesOfFailedOps(
    deps,
    opIds.filter((id) => failedOpIds.has(id))
  )
  for (const part of chunk(opIds, 50)) {
    sql.exec(`UPDATE ops SET acked = 1 WHERE id IN (${placeholders(part.length)})`, ...part)
  }
  // 반영이 끝난 편집 줄은 하루 뒤에 지운다 — 하루 한 번 정리(maintenance)가 한다 (ack 마다 표를 훑지 않는다)

  const jobs = Array.isArray(body.jobs) ? body.jobs : []
  for (const item of jobs) {
    if (!isRecord(item) || typeof item.id !== 'string') continue
    const row = getJobRow(sql, item.id)
    if (!row) continue
    const state = item.state
    const done = isInt(item.done) && item.done >= 0 ? item.done : row.done
    const failed = isInt(item.failed) && item.failed >= 0 ? item.failed : row.failed
    if (row.state === 'cancelled') {
      // 취소된 작업은 상태를 되살리지 않고, PC 가 알려 준 장수만 반영한다
      if (state === 'done' || state === 'failed')
        sql.exec(
          `UPDATE jobs SET done = ?, failed = ?, updated_at = ? WHERE id = ?`,
          done,
          failed,
          now,
          row.id
        )
      continue
    }
    if (row.state === 'done' || row.state === 'failed') {
      // 「PC가 작업을 잃었습니다」로 정리됐는데 PC 의 최종 결과가 늦게 도착했다 — 그 결과를 따른다
      const lateResult =
        row.state === 'failed' &&
        row.runner === 'pc' &&
        row.error === PC_LOST_JOB_ERROR &&
        (state === 'done' || state === 'failed')
      if (!lateResult) continue
    }
    if (state === 'accepted') {
      if (row.runner === 'pc' && row.state === 'queued') {
        sql.exec(
          `UPDATE jobs SET state = 'pc', accepted_at = ?, updated_at = ? WHERE id = ?`,
          now,
          now,
          row.id
        )
      }
    } else if (state === 'done' || state === 'failed') {
      if (row.runner !== 'pc') continue
      const error =
        state === 'failed'
          ? typeof item.error === 'string' && item.error
            ? item.error.slice(0, 300)
            : 'PC에서 생성하지 못했습니다'
          : null
      sql.exec(
        `UPDATE jobs SET state = ?, done = ?, failed = ?, error = ?, updated_at = ? WHERE id = ?`,
        state,
        done,
        failed,
        error,
        now,
        row.id
      )
      clearJobKv(sql, row.id)
    }
  }
  return ok()
}

// ── 그림 ────────────────────────────────────────────────────────────

const PC_IMAGE_ID = /^p\d+$/
const CLOUD_IMAGE_ID = /^c[a-z0-9]+$/

function parseMeta(request: Request): CloudImageMeta {
  const header = request.headers.get('x-nais-meta')
  if (!header) throw new HttpError(400, '그림 정보(x-nais-meta)가 없습니다')
  let meta: unknown
  try {
    meta = JSON.parse(new TextDecoder().decode(fromBase64Url(header)))
  } catch {
    throw new HttpError(400, '그림 정보를 읽지 못했습니다')
  }
  if (
    !isRecord(meta) ||
    !isInt(meta.pcImageId) ||
    !isInt(meta.width) ||
    !isInt(meta.height) ||
    typeof meta.createdAt !== 'number' ||
    !Number.isFinite(meta.createdAt)
  ) {
    throw new HttpError(400, '그림 정보가 올바르지 않습니다')
  }
  return {
    pcImageId: meta.pcImageId,
    sceneId: nullableInt(meta.sceneId),
    presetId: nullableInt(meta.presetId),
    seed: nullableInt(meta.seed),
    width: meta.width,
    height: meta.height,
    createdAt: meta.createdAt,
    kind: typeof meta.kind === 'string' ? meta.kind : ''
  }
}

async function putImage({ deps, request, params }: Ctx): Promise<Response> {
  const id = params[0]
  if (!PC_IMAGE_ID.test(id)) throw new HttpError(400, '그림 번호가 올바르지 않습니다')
  const meta = parseMeta(request)
  if (`p${meta.pcImageId}` !== id) throw new HttpError(400, '그림 번호와 정보가 맞지 않습니다')
  const bytes = await readBytes(request, MAX_IMAGE_BYTES)
  if (bytes.byteLength === 0) throw new HttpError(400, '그림 파일이 비어 있습니다')
  const key = `img/${id}.webp`
  await deps.bucket.put(key, bytes, { httpMetadata: { contentType: 'image/webp' } })
  // 아래는 await 없이 한 덩어리 — 있던 행인지 보고 쓰는 것까지 끊기지 않는다
  const existed = deps.sql.exec(`SELECT 1 AS x FROM images WHERE id = ?`, id).toArray().length > 0
  // 같은 id 면 덮어쓴다 (썸네일 표시는 그대로)
  deps.sql.exec(
    `INSERT INTO images (id, source, scene_id, preset_id, job_id, seed, width, height, created_at, has_thumb, format, r2_key, sent_payload, imported, pc_image_id)
     VALUES (?, 'pc', ?, ?, NULL, ?, ?, ?, ?, 0, 'webp', ?, NULL, 0, ?)
     ON CONFLICT(id) DO UPDATE SET scene_id = excluded.scene_id, preset_id = excluded.preset_id,
       seed = excluded.seed, width = excluded.width, height = excluded.height,
       created_at = excluded.created_at, r2_key = excluded.r2_key, pc_image_id = excluded.pc_image_id`,
    id,
    meta.sceneId,
    meta.presetId,
    meta.seed,
    meta.width,
    meta.height,
    meta.createdAt,
    key,
    meta.pcImageId
  )
  if (!existed) adjustImageCounters(deps.sql, 1, 0)
  await enforceRetention(deps)
  return ok()
}

async function putImageThumb({ deps, request, params }: Ctx): Promise<Response> {
  const id = params[0]
  if (!PC_IMAGE_ID.test(id)) throw new HttpError(400, '그림 번호가 올바르지 않습니다')
  const kind = thumbKindFromRequest(request)
  const bytes = await readBytes(request, MAX_THUMB_BYTES)
  if (bytes.byteLength === 0) throw new HttpError(400, '썸네일이 비어 있습니다')
  const row = getImageRow(deps.sql, id)
  if (!row) throw new HttpError(404, '그림을 찾을 수 없습니다')
  const key = thumbKey(id, kind)
  await deps.bucket.put(key, bytes, { httpMetadata: { contentType: thumbMime(kind) } })
  // R2 를 기다리는 사이 그림이 지워졌으면 방금 올린 파일을 버린다
  const after = getImageRow(deps.sql, id)
  if (!after) {
    await deps.bucket.delete(key)
    throw new HttpError(404, '그림을 찾을 수 없습니다')
  }
  // 형식이 바뀌어 올라오면 옛 형식의 파일은 지운다
  const previous = thumbKindOf(after.has_thumb)
  if (previous && previous !== kind) await deps.bucket.delete(thumbKey(id, previous))
  deps.sql.exec(`UPDATE images SET has_thumb = ? WHERE id = ?`, thumbFlag(kind), id)
  return ok()
}

function listCloudImages(deps: HubDeps): Response {
  // images_cloud_pending 부분 인덱스(created_at, id)를 그대로 따라 읽는다 — 최대 50행
  const rows = deps.sql
    .exec<ImageRow>(
      `SELECT ${IMAGE_COLUMNS} FROM images WHERE source = 'cloud' AND imported = 0
       ORDER BY created_at ASC, id ASC LIMIT 50`
    )
    .toArray()
  const items: CloudGeneratedImage[] = rows.map((r) => ({
    id: r.id,
    jobId: r.job_id ?? '',
    sceneId: r.scene_id,
    presetId: r.preset_id,
    seed: r.seed ?? 0,
    sentPayload: r.sent_payload ?? '',
    createdAt: r.created_at
  }))
  return ok({ items })
}

async function cloudImageFile({ deps, params }: Ctx): Promise<Response> {
  const id = params[0]
  const row = CLOUD_IMAGE_ID.test(id) ? getImageRow(deps.sql, id) : undefined
  if (!row || row.source !== 'cloud') throw new HttpError(404, '그림을 찾을 수 없습니다')
  const object = await deps.bucket.get(row.r2_key)
  if (!object) throw new HttpError(404, '그림 파일을 찾을 수 없습니다')
  return binary(object.body, 'application/zip', 200, { 'content-length': String(object.size) })
}

async function cloudImageImported({ deps, request, params }: Ctx): Promise<Response> {
  const id = params[0]
  const body = bodyRecord(await readJson(request, 10_000))
  if (!isInt(body.pcImageId)) throw new HttpError(400, 'PC 그림 번호가 올바르지 않습니다')
  const row = CLOUD_IMAGE_ID.test(id) ? getImageRow(deps.sql, id) : undefined
  if (!row || row.source !== 'cloud') throw new HttpError(404, '그림을 찾을 수 없습니다')
  deps.sql.exec(`UPDATE images SET imported = 1, pc_image_id = ? WHERE id = ?`, body.pcImageId, id)
  // 아직 안 가져간 그림이었으면 그 카운터를 하나 내린다 (이미 가져간 그림에 다시 알려 온 경우는 그대로)
  if (row.imported === 0) adjustImageCounters(deps.sql, 0, -1)
  return ok()
}

// ── NAI 토큰·설정·기기 ──────────────────────────────────────────────

async function putNaiToken({ deps, request }: Ctx): Promise<Response> {
  const body = bodyRecord(await readJson(request, 10_000))
  const token = typeof body.token === 'string' ? body.token.trim() : ''
  if (!token || token.length > 1000) throw new HttpError(400, 'NAI 토큰이 비어 있습니다')
  const changed = kvGet(deps.sql, 'secret:nai') !== token
  kvSet(deps.sql, 'secret:nai', token)
  kvDel(deps.sql, 'nai:quota') // 다른 계정일 수 있으니 이전 확인 결과는 버린다
  // 토큰이 바뀌었으면 세대 번호를 올린다 — 진행 중인 cloud 작업은 다른 세대에서 잰 확인·기준 잔액을 믿지 않고
  // 다음 장 전에 반드시 다시 확인한다. (같은 토큰을 다시 맡기는 것은 PC 가 켜질 때마다 있는 일이라 올리지 않는다)
  if (changed) bumpNaiEpoch(deps.sql)
  return ok() // 응답에 토큰을 돌려주지 않는다
}

function deleteNaiToken(deps: HubDeps): Response {
  kvDel(deps.sql, 'secret:nai')
  kvDel(deps.sql, 'nai:quota')
  bumpNaiEpoch(deps.sql)
  failCloudJobs(deps, 'NAI 토큰이 없음') // 작업마다 기준 잔액·확인 표시도 함께 치운다
  return ok()
}

async function putSettings({ deps, request }: Ctx): Promise<Response> {
  const body = bodyRecord(await readJson(request, 10_000))
  if (
    typeof body.cloudGenEnabled !== 'boolean' ||
    !isInt(body.keepImages) ||
    body.keepImages < 100 ||
    body.keepImages > 20000
  ) {
    throw new HttpError(400, '설정 값이 올바르지 않습니다 (보관 장수는 100~20000)')
  }
  const settings: CloudSettings = {
    cloudGenEnabled: body.cloudGenEnabled,
    keepImages: body.keepImages
  }
  setSettings(deps.sql, settings)
  return ok()
}

function listDevices(
  deps: HubDeps
): { id: string; name: string; createdAt: number; lastSeen: number | null }[] {
  return deps.sql
    .exec<{ id: string; name: string; created_at: number; last_seen: number | null }>(
      `SELECT id, name, created_at, last_seen FROM devices ORDER BY created_at ASC`
    )
    .toArray()
    .map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastSeen: r.last_seen }))
}

// ── 연결된 PC 폴더 (드라이브) ───────────────────────────────────────

export async function driveR2Key(relPath: string, thumb: boolean): Promise<string> {
  const hash = await sha256Hex(relPath)
  return thumb ? `drive-thumb/${hash}.webp` : `drive-img/${hash}.webp`
}

async function putDriveIndex({ deps, request }: Ctx): Promise<Response> {
  const body = bodyRecord(await readJson(request, 2_000_000))
  if (!isRecord(body.index) || !Array.isArray(body.index.folders)) {
    throw new HttpError(400, '폴더 색인이 올바르지 않습니다')
  }
  kvSetJson(deps.sql, 'drive:index', body.index)
  return ok()
}

async function putDriveImage({ deps, request, url }: Ctx): Promise<Response> {
  const relPath = (url.searchParams.get('path') ?? '').trim()
  const isThumb = url.searchParams.get('thumb') === '1'
  if (!relPath || relPath.length > 600) throw new HttpError(400, '경로가 올바르지 않습니다')
  const bytes = await readBytes(request, isThumb ? MAX_THUMB_BYTES : MAX_IMAGE_BYTES)
  if (bytes.byteLength === 0) throw new HttpError(400, '그림 파일이 비어 있습니다')
  const key = await driveR2Key(relPath, isThumb)
  await deps.bucket.put(key, bytes, { httpMetadata: { contentType: 'image/webp' } })
  if (!isThumb) {
    const cached = kvGetJson<Record<string, number>>(deps.sql, 'drive:cached') ?? {}
    cached[relPath] = deps.now()
    const keys = Object.keys(cached)
    if (keys.length > 3000) {
      for (const k of keys.slice(0, keys.length - 3000)) delete cached[k]
    }
    kvSetJson(deps.sql, 'drive:cached', cached)
  }
  return ok()
}

export const pcRoutes: Route[] = [
  { method: 'GET', pattern: /^\/api\/pc\/info$/, handle: ({ deps }) => info(deps) },
  { method: 'GET', pattern: /^\/api\/pc\/hashes$/, handle: ({ deps }) => hashes(deps) },
  { method: 'PUT', pattern: /^\/api\/pc\/library$/, handle: putLibrary },
  { method: 'PUT', pattern: /^\/api\/pc\/scenes$/, handle: putScenes },
  { method: 'PUT', pattern: /^\/api\/pc\/scene-counts$/, handle: putSceneCounts },
  { method: 'PUT', pattern: /^\/api\/pc\/prepared$/, handle: putPrepared },
  { method: 'PUT', pattern: /^\/api\/pc\/fragments$/, handle: putFragments },
  { method: 'PUT', pattern: /^\/api\/pc\/drive-index$/, handle: putDriveIndex },
  { method: 'PUT', pattern: /^\/api\/pc\/drive-image$/, handle: putDriveImage },
  { method: 'POST', pattern: /^\/api\/pc\/poll$/, handle: poll },
  { method: 'POST', pattern: /^\/api\/pc\/ack$/, handle: ack },
  { method: 'PUT', pattern: /^\/api\/pc\/images\/([^/]+)$/, handle: putImage },
  { method: 'PUT', pattern: /^\/api\/pc\/images\/([^/]+)\/thumb$/, handle: putImageThumb },
  {
    method: 'GET',
    pattern: /^\/api\/pc\/cloud-images$/,
    handle: ({ deps }) => listCloudImages(deps)
  },
  { method: 'GET', pattern: /^\/api\/pc\/cloud-images\/([^/]+)\/file$/, handle: cloudImageFile },
  {
    method: 'POST',
    pattern: /^\/api\/pc\/cloud-images\/([^/]+)\/imported$/,
    handle: cloudImageImported
  },
  { method: 'PUT', pattern: /^\/api\/pc\/nai-token$/, handle: putNaiToken },
  {
    method: 'DELETE',
    pattern: /^\/api\/pc\/nai-token$/,
    handle: ({ deps }) => deleteNaiToken(deps)
  },
  { method: 'PUT', pattern: /^\/api\/pc\/settings$/, handle: putSettings },
  {
    method: 'POST',
    pattern: /^\/api\/pc\/pairing$/,
    handle: ({ deps, request }) => ok({ ...createPairing(deps, request) })
  },
  {
    method: 'GET',
    pattern: /^\/api\/pc\/devices$/,
    handle: ({ deps }) => ok({ items: listDevices(deps) })
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/pc\/devices\/([^/]+)$/,
    handle: ({ deps, params }) => {
      deps.sql.exec(`DELETE FROM devices WHERE id = ?`, params[0])
      return ok({ items: listDevices(deps) })
    }
  }
]
