/** 폰용 API (설계 5-2) — /api/pair 를 뺀 전부가 기기 토큰 인증을 통과한 뒤에만 들어온다 */
import {
  CLOUD_PROTOCOL,
  type CloudCharPatch,
  type CloudControlAction,
  type CloudCreateJobResponse,
  type CloudDriveIndex,
  type CloudMainPatch,
  type CloudPhoneScene,
  type CloudPhoneState,
  type CloudSceneLite,
  type CloudScenePatch
} from '../../../src/shared/cloud-contract'
import { consumePairAttempt, PAIR_MAX_BODY_BYTES, redeemPairing } from './auth'
import type { HubDeps } from './deps'
import { cancelJob, createJob, parseCreateJob } from './jobs'
import { driveR2Key } from './routes-pc'
import { ensureAlarmAlive } from './schedule'
import type { Route, RouteCtx } from './route'
import { getLastSeen, getQueueSummary, isPcOnline } from './presence'
import {
  addOp,
  applyCharPatch,
  applyMainPatch,
  applyScenePatch,
  getConfirmedQuota,
  getImageRow,
  getLibrary,
  getQuota,
  getSceneCounts,
  getSettings,
  hasNaiToken,
  isPcPending,
  IMAGE_COLUMNS,
  JOB_COLUMNS,
  kvGetJson,
  pendingScenePatches,
  queueEdit,
  removeImages,
  rowToImageItem,
  rowToJob,
  saveLibrary,
  thumbFlag,
  thumbKey,
  thumbKindFromRequest,
  thumbKindOf,
  thumbMime,
  type ImageRow,
  type JobRow
} from './store'
import { binary, HttpError, isInt, isRecord, ok, readBytes, readJson } from './util'

const MAX_THUMB_BYTES = 256 * 1024
/** 프롬프트 한 칸의 글자 수 상한 — 터무니없이 큰 편집이 줄에 쌓이지 않게 */
const MAX_TEXT_CHARS = 50_000
const IMAGE_ID = /^[pc][a-z0-9]{1,40}$/

// ── 상태 ────────────────────────────────────────────────────────────

function cloudGenStatus(deps: HubDeps): CloudPhoneState['cloudGen'] {
  const settings = getSettings(deps.sql)
  const hasToken = hasNaiToken(deps.sql)
  let reason: string | null = null
  if (!settings.cloudGenEnabled) reason = '클라우드 생성이 꺼져 있습니다'
  else if (!hasToken) reason = 'NAI 토큰이 클라우드에 없습니다'
  else {
    // 「지금 불가」 이유는 클라우드가 직접 확인한 최근 값만 쓴다 (PC 가 올린 값은 표시용)
    const quota = getConfirmedQuota(deps)
    if (quota && quota.state !== 'available') {
      reason =
        quota.state === 'exhausted'
          ? '이번 달 무료 사용량을 모두 썼습니다'
          : '이번 달 무료 사용량이 확인되지 않았습니다'
    }
  }
  return {
    enabled: settings.cloudGenEnabled,
    hasNaiToken: hasToken,
    ready: reason === null,
    reason,
    quota: getQuota(deps)
  }
}

async function state(deps: HubDeps): Promise<Response> {
  const { sql } = deps
  // 알람이 끊긴 채 클라우드 작업이 남았으면 여기서 되살린다 (폰이 보는 동안 4초마다 들어오는 요청)
  await ensureAlarmAlive(deps)
  const jobs = sql
    .exec<JobRow>(
      `SELECT ${JOB_COLUMNS} FROM jobs ORDER BY updated_at DESC, created_at DESC LIMIT 30`
    )
    .toArray()
    .map(rowToJob)
  const result: CloudPhoneState = {
    protocol: CLOUD_PROTOCOL,
    serverTime: deps.now(),
    pc: {
      online: isPcOnline(deps),
      lastSeen: getLastSeen(sql),
      queue: getQueueSummary(sql)
    },
    library: getLibrary(sql),
    cloudGen: cloudGenStatus(deps),
    jobs
  }
  return ok({ ...result })
}

// ── 씬 ──────────────────────────────────────────────────────────────

function listScenes({ deps, url }: RouteCtx): Response {
  const raw = url.searchParams.get('presetId')
  const presetId = raw == null || raw === '' ? NaN : Number(raw)
  if (!Number.isInteger(presetId)) throw new HttpError(400, '프리셋 번호가 필요합니다')
  const { sql } = deps
  // 씬마다 가장 최근 그림 — images_scene2 커버링 인덱스에서 씬당 한 항목만 읽는다 (한 쿼리로 씬과 함께)
  const rows = sql
    .exec<{ id: number; data: string; latest: string | null }>(
      `SELECT s.id AS id, s.data AS data,
         (SELECT i.id FROM images i WHERE i.scene_id = s.id ORDER BY i.created_at DESC, i.id DESC LIMIT 1) AS latest
       FROM scenes s WHERE s.preset_id = ? ORDER BY s.sort_order ASC, s.id ASC`,
      presetId
    )
    .toArray()
  const pending = new Set(pendingScenePatches(sql).keys())
  const counts = getSceneCounts(sql)
  const items: CloudPhoneScene[] = rows.map((row) => ({
    ...(JSON.parse(row.data) as CloudSceneLite),
    imageCount: counts[String(row.id)] ?? 0,
    latestImageId: row.latest,
    pendingEdit: pending.has(row.id)
  }))
  return ok({ items })
}

function text(value: unknown, field: string, min = 0, max = MAX_TEXT_CHARS): string {
  if (typeof value !== 'string') throw new HttpError(400, `${field} 값이 올바르지 않습니다`)
  const length = value.trim().length
  if (length < min || value.length > max)
    throw new HttpError(400, `${field} 길이가 올바르지 않습니다`)
  return value
}

function parseScenePatch(body: unknown): CloudScenePatch {
  if (!isRecord(body)) throw new HttpError(400, '요청 내용이 올바르지 않습니다')
  const patch: CloudScenePatch = {}
  if (body.name !== undefined) patch.name = text(body.name, '이름', 1, 100).trim()
  if (body.prompt !== undefined) patch.prompt = text(body.prompt, '프롬프트')
  if (body.negativePrompt !== undefined)
    patch.negativePrompt = text(body.negativePrompt, '네거티브')
  for (const field of ['width', 'height'] as const) {
    const value = body[field]
    if (value === undefined) continue
    if (!isInt(value) || value < 64 || value > 2048 || value % 64 !== 0) {
      throw new HttpError(400, '해상도는 64의 배수로 64~2048 사이여야 합니다')
    }
    patch[field] = value
  }
  if (Object.keys(patch).length === 0) throw new HttpError(400, '바꿀 내용이 없습니다')
  return patch
}

function toPhoneScene(deps: HubDeps, scene: CloudSceneLite): CloudPhoneScene {
  const latest = deps.sql
    .exec<{ id: string }>(
      `SELECT id FROM images WHERE scene_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      scene.id
    )
    .toArray()[0]
  const pending = pendingScenePatches(deps.sql).has(scene.id)
  return {
    ...scene,
    imageCount: getSceneCounts(deps.sql)[String(scene.id)] ?? 0,
    latestImageId: latest?.id ?? null,
    pendingEdit: pending
  }
}

async function patchScene({ deps, request, params }: RouteCtx): Promise<Response> {
  const sceneId = Number(params[0])
  const patch = parseScenePatch(await readJson(request, 400_000))
  const row = deps.sql
    .exec<{ data: string }>(`SELECT data FROM scenes WHERE id = ?`, sceneId)
    .toArray()[0]
  if (!row) throw new HttpError(404, '씬을 찾을 수 없습니다')
  const scene = applyScenePatch(JSON.parse(row.data) as CloudSceneLite, patch)
  // 한도(개수·크기)를 넘으면 여기서 429/413 — 씬 사본은 아직 바뀌지 않는다
  queueEdit(deps, { type: 'scene:update', sceneId, patch })
  deps.sql.exec(`UPDATE scenes SET data = ? WHERE id = ?`, JSON.stringify(scene), sceneId)
  return ok({ scene: toPhoneScene(deps, scene) })
}

// ── 캐릭터·메인 ─────────────────────────────────────────────────────

async function patchCharacter({ deps, request, params }: RouteCtx): Promise<Response> {
  const charId = Number(params[0])
  const body = await readJson(request, 400_000)
  if (!isRecord(body)) throw new HttpError(400, '요청 내용이 올바르지 않습니다')
  const patch: CloudCharPatch = {}
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean')
      throw new HttpError(400, '켜기/끄기 값이 올바르지 않습니다')
    patch.enabled = body.enabled
  }
  if (body.prompt !== undefined) patch.prompt = text(body.prompt, '프롬프트')
  if (Object.keys(patch).length === 0) throw new HttpError(400, '바꿀 내용이 없습니다')
  const library = getLibrary(deps.sql)
  if (!library) throw new HttpError(409, 'PC 정보가 아직 클라우드에 올라오지 않았습니다')
  if (!applyCharPatch(library, charId, patch)) throw new HttpError(404, '캐릭터를 찾을 수 없습니다')
  queueEdit(deps, { type: 'char:update', charId, patch })
  saveLibrary(deps.sql, library)
  return ok()
}

async function patchMain({ deps, request }: RouteCtx): Promise<Response> {
  const body = await readJson(request, 400_000)
  if (!isRecord(body)) throw new HttpError(400, '요청 내용이 올바르지 않습니다')
  const patch: CloudMainPatch = {}
  if (body.prompt !== undefined) patch.prompt = text(body.prompt, '프롬프트')
  if (body.negativePrompt !== undefined)
    patch.negativePrompt = text(body.negativePrompt, '네거티브')
  if (body.promptParts !== undefined) {
    const parts = body.promptParts
    if (!isRecord(parts)) throw new HttpError(400, '분할 프롬프트 값이 올바르지 않습니다')
    patch.promptParts = {
      base: text(parts.base, '고정 프롬프트'),
      additional: text(parts.additional, '가변 프롬프트'),
      detail: text(parts.detail, '디테일 프롬프트')
    }
  }
  if (Object.keys(patch).length === 0) throw new HttpError(400, '바꿀 내용이 없습니다')
  const library = getLibrary(deps.sql)
  if (!library) throw new HttpError(409, 'PC 정보가 아직 클라우드에 올라오지 않았습니다')
  applyMainPatch(library, patch)
  queueEdit(deps, { type: 'main:update', patch })
  saveLibrary(deps.sql, library)
  return ok()
}

// ── 작업 ────────────────────────────────────────────────────────────

async function postJob({ deps, request }: RouteCtx): Promise<Response> {
  const input = parseCreateJob(await readJson(request, 10_000))
  const { job, notice } = await createJob(deps, input)
  const result: CloudCreateJobResponse = notice ? { job, notice } : { job }
  return ok({ ...result })
}

function postCancel({ deps, params }: RouteCtx): Response {
  return ok({ job: cancelJob(deps, params[0]) })
}

// ── 그림 ────────────────────────────────────────────────────────────

function optionalInt(url: URL, name: string): number | null {
  const raw = url.searchParams.get(name)
  if (raw == null || raw === '') return null
  const value = Number(raw)
  if (!Number.isInteger(value)) throw new HttpError(400, `${name} 값이 올바르지 않습니다`)
  return value
}

function listImages({ deps, url }: RouteCtx): Response {
  const sceneId = optionalInt(url, 'sceneId')
  const presetId = optionalInt(url, 'presetId')
  const limitRaw = optionalInt(url, 'limit')
  const limit = Math.min(Math.max(limitRaw ?? 40, 1), 100)

  const where: string[] = []
  const args: unknown[] = []
  if (sceneId != null) {
    where.push('scene_id = ?')
    args.push(sceneId)
  }
  if (presetId != null) {
    where.push('preset_id = ?')
    args.push(presetId)
  }
  // before = 이전 쪽 마지막 그림의 created_at (숫자) — next 는 같은 시각 그림을 빠뜨리지 않게 `시각:id` 로 내보낸다
  const before = url.searchParams.get('before')
  if (before) {
    const plain = /^(\d+)$/.exec(before)
    const composite = /^(\d+):([a-z0-9]+)$/.exec(before)
    if (plain) {
      where.push('created_at < ?')
      args.push(Number(plain[1]))
    } else if (composite) {
      where.push('(created_at < ? OR (created_at = ? AND id < ?))')
      args.push(Number(composite[1]), Number(composite[1]), composite[2])
    } else {
      throw new HttpError(400, 'before 값이 올바르지 않습니다')
    }
  }
  const rows = deps.sql
    .exec<ImageRow>(
      `SELECT ${IMAGE_COLUMNS} FROM images ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      ...args,
      limit + 1
    )
    .toArray()
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  return ok({
    items: page.map(rowToImageItem),
    next: rows.length > limit && last ? `${last.created_at}:${last.id}` : null
  })
}

function requireImage(deps: HubDeps, id: string): ImageRow {
  const row = IMAGE_ID.test(id) ? getImageRow(deps.sql, id) : undefined
  if (!row) throw new HttpError(404, '그림을 찾을 수 없습니다')
  return row
}

async function getImage({ deps, params }: RouteCtx): Promise<Response> {
  const row = requireImage(deps, params[0])
  const object = await deps.bucket.get(row.r2_key)
  if (!object) throw new HttpError(404, '그림 파일을 찾을 수 없습니다')
  return binary(object.body, row.format === 'zip' ? 'application/zip' : 'image/webp', 200, {
    'content-length': String(object.size)
  })
}

async function getThumb({ deps, params }: RouteCtx): Promise<Response> {
  const row = requireImage(deps, params[0])
  const kind = thumbKindOf(row.has_thumb)
  if (!kind) throw new HttpError(404, '썸네일이 없습니다')
  const object = await deps.bucket.get(thumbKey(row.id, kind))
  if (!object) throw new HttpError(404, '썸네일이 없습니다')
  // 올라온 형식 그대로 돌려준다 (iOS Safari 는 WebP 를 못 만들어 JPEG 로 올린다)
  return binary(object.body, thumbMime(kind), 200, { 'content-length': String(object.size) })
}

async function putThumb({ deps, request, params }: RouteCtx): Promise<Response> {
  requireImage(deps, params[0])
  const kind = thumbKindFromRequest(request)
  const bytes = await readBytes(request, MAX_THUMB_BYTES)
  if (bytes.byteLength === 0) throw new HttpError(400, '썸네일이 비어 있습니다')
  // await 뒤에 다시 읽어서 확인한다
  const row = requireImage(deps, params[0])
  if (row.source !== 'cloud' || row.has_thumb) {
    throw new HttpError(409, '이 그림에는 썸네일을 올릴 수 없습니다')
  }
  const key = thumbKey(row.id, kind)
  await deps.bucket.put(key, bytes, { httpMetadata: { contentType: thumbMime(kind) } })
  // R2 를 기다리는 사이 그림이 지워졌거나 다른 썸네일이 먼저 붙었으면 방금 올린 파일을 버린다
  const after = getImageRow(deps.sql, row.id)
  if (!after || after.has_thumb) {
    await deps.bucket.delete(key)
    if (!after) throw new HttpError(404, '그림을 찾을 수 없습니다')
    throw new HttpError(409, '이 그림에는 썸네일을 올릴 수 없습니다')
  }
  deps.sql.exec(`UPDATE images SET has_thumb = ? WHERE id = ?`, thumbFlag(kind), row.id)
  return ok()
}

/**
 * 클라우드 사본 삭제. PC 로 아직 안 옮겨진 클라우드 생성분은 이 사본이 유일하므로
 * ?force=1 이 없으면 409 로 막는다 (폰이 다른 확인 문구로 다시 물어본 뒤 force 를 붙여 보낸다)
 */
async function deleteImage({ deps, params, url }: RouteCtx): Promise<Response> {
  const row = requireImage(deps, params[0])
  if (isPcPending(row) && url.searchParams.get('force') !== '1') {
    throw new HttpError(409, 'PC로 아직 옮기지 않은 그림입니다. 지우면 다시 받을 수 없습니다')
  }
  await removeImages(deps, [row])
  return ok()
}

// ── PC 제어 & 연결된 폴더(드라이브) ─────────────────────────────────

async function postControl({ deps, request }: RouteCtx): Promise<Response> {
  const body = await readJson(request, 20_000)
  if (!isRecord(body) || !isRecord(body.action) || typeof body.action.kind !== 'string') {
    throw new HttpError(400, '제어 요청이 올바르지 않습니다')
  }
  const action = body.action as unknown as CloudControlAction
  const opId = addOp(deps, 'pc:control', { action })
  return ok({ opId })
}

function getDriveIndex(deps: HubDeps): Response {
  const index = kvGetJson<CloudDriveIndex>(deps.sql, 'drive:index')
  const cachedFiles = kvGetJson<Record<string, number>>(deps.sql, 'drive:cached') ?? {}
  return ok({ index, cachedFiles })
}

async function getDriveFile({ deps, url }: RouteCtx): Promise<Response> {
  const relPath = (url.searchParams.get('path') ?? '').trim()
  const thumb = url.searchParams.get('thumb') === '1'
  if (!relPath) throw new HttpError(400, '경로가 비어 있습니다')
  const key = await driveR2Key(relPath, thumb)
  let object = await deps.bucket.get(key)
  if (!object && thumb) {
    // 썸네일이 아직 없으면 원본 WebP 로 대체
    object = await deps.bucket.get(await driveR2Key(relPath, false))
  }
  if (!object) throw new HttpError(404, '클라우드에 아직 동기화되지 않은 그림입니다')
  return binary(object.body, 'image/webp', 200, {
    'content-length': String(object.size)
  })
}

// ── 연결 ────────────────────────────────────────────────────────────

export async function pairRoute({ deps, request }: RouteCtx): Promise<Response> {
  // 시도 제한을 본문을 읽기 전에 건다 — 커다란 본문을 계속 보내는 공격이 메모리를 쓰기 전에 막힌다
  consumePairAttempt(deps)
  let body: unknown = null
  try {
    body = await readJson(request, PAIR_MAX_BODY_BYTES, PAIR_MAX_BODY_BYTES)
  } catch (error) {
    // 너무 큰 본문은 413 으로 알리고, 깨진 본문은 틀린 코드와 같게 다룬다
    if (error instanceof HttpError && error.status === 413) throw error
  }
  const result = await redeemPairing(deps, body)
  return ok({ ...result })
}

export const phoneRoutes: Route[] = [
  {
    method: 'GET',
    pattern: /^\/api\/me$/,
    handle: ({ device }) => ok({ deviceId: device?.id, name: device?.name })
  },
  { method: 'GET', pattern: /^\/api\/state$/, handle: ({ deps }) => state(deps) },
  { method: 'GET', pattern: /^\/api\/scenes$/, handle: listScenes },
  { method: 'PATCH', pattern: /^\/api\/scenes\/(\d+)$/, handle: patchScene },
  { method: 'PATCH', pattern: /^\/api\/characters\/(\d+)$/, handle: patchCharacter },
  { method: 'PATCH', pattern: /^\/api\/main$/, handle: patchMain },
  { method: 'POST', pattern: /^\/api\/jobs$/, handle: postJob },
  { method: 'POST', pattern: /^\/api\/jobs\/([^/]+)\/cancel$/, handle: postCancel },
  { method: 'GET', pattern: /^\/api\/images$/, handle: listImages },
  { method: 'GET', pattern: /^\/api\/images\/([^/]+)$/, handle: getImage },
  { method: 'GET', pattern: /^\/api\/images\/([^/]+)\/thumb$/, handle: getThumb },
  { method: 'PUT', pattern: /^\/api\/images\/([^/]+)\/thumb$/, handle: putThumb },
  { method: 'DELETE', pattern: /^\/api\/images\/([^/]+)$/, handle: deleteImage },
  { method: 'POST', pattern: /^\/api\/control$/, handle: postControl },
  { method: 'GET', pattern: /^\/api\/drive\/index$/, handle: ({ deps }) => getDriveIndex(deps) },
  { method: 'GET', pattern: /^\/api\/drive\/file$/, handle: getDriveFile },
  {
    method: 'POST',
    pattern: /^\/api\/logout$/,
    handle: ({ deps, device }) => {
      if (device) deps.sql.exec(`DELETE FROM devices WHERE id = ?`, device.id)
      return ok()
    }
  }
]
