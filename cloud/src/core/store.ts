/**
 * 저장소 접근 도우미 — kv, 설정, 라이브러리, 편집 줄(ops), 작업·그림 행 변환, 그림 수 카운터, 보관 정리.
 * SQL 은 전부 동기 호출이다. 서로 이어진 쓰기 사이에는 await 를 끼우지 않는다
 * (DO 는 await 없는 구간을 한 덩어리로 저장하므로 중간 상태가 보이지 않는다).
 */
import {
  type CloudCharPatch,
  type CloudImageItem,
  type CloudJob,
  type CloudJobTarget,
  type CloudLibrary,
  type CloudMainPatch,
  type CloudOp,
  type CloudQuota,
  type CloudSceneLite,
  type CloudScenePatch,
  type CloudSettings
} from '../../../src/shared/cloud-contract'
import { parseOpusUsage, quotaState } from '../../../src/shared/opus-usage'
import type { HubDeps, SqlLike } from './deps'
import { memoryOf } from './memory'
import { chunk, HttpError, isRecord } from './util'

// ── kv ──────────────────────────────────────────────────────────────

export function kvGet(sql: SqlLike, k: string): string | null {
  const row = sql.exec<{ v: string }>(`SELECT v FROM kv WHERE k = ?`, k).toArray()[0]
  return row ? row.v : null
}

/** 값을 읽어 오지 않고 있는지만 본다 (라이브러리처럼 큰 값용) */
export function kvHas(sql: SqlLike, k: string): boolean {
  return sql.exec(`SELECT 1 AS x FROM kv WHERE k = ?`, k).toArray().length > 0
}

export function kvSet(sql: SqlLike, k: string, v: string): void {
  sql.exec(`INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, v)
}

export function kvDel(sql: SqlLike, k: string): void {
  sql.exec(`DELETE FROM kv WHERE k = ?`, k)
}

export function kvGetJson<T>(sql: SqlLike, k: string): T | null {
  const text = kvGet(sql, k)
  if (text == null) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

export function kvSetJson(sql: SqlLike, k: string, value: unknown): void {
  kvSet(sql, k, JSON.stringify(value))
}

/** `?,?,?` 자리표시자 */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',')
}

// ── 설정·라이브러리 ─────────────────────────────────────────────────

export const DEFAULT_SETTINGS: CloudSettings = { cloudGenEnabled: false, keepImages: 2000 }

export function getSettings(sql: SqlLike): CloudSettings {
  const saved = kvGetJson<Partial<CloudSettings>>(sql, 'settings')
  return {
    cloudGenEnabled: saved?.cloudGenEnabled === true,
    keepImages:
      typeof saved?.keepImages === 'number' ? saved.keepImages : DEFAULT_SETTINGS.keepImages
  }
}

export function setSettings(sql: SqlLike, settings: CloudSettings): void {
  kvSetJson(sql, 'settings', settings)
}

export function getLibrary(sql: SqlLike): CloudLibrary | null {
  return kvGetJson<CloudLibrary>(sql, 'library')
}

/** 라이브러리를 저장한다 */
export function saveLibrary(sql: SqlLike, library: CloudLibrary): void {
  kvSetJson(sql, 'library', library)
}

/** 라이브러리가 저장돼 있는가 — 큰 JSON 을 읽어 오지 않고 있는지만 본다 (poll 의 needsFullSync) */
export function hasLibrary(sql: SqlLike): boolean {
  return kvHas(sql, 'library')
}

export function hasNaiToken(sql: SqlLike): boolean {
  return !!kvGet(sql, 'secret:nai')
}

// ── NAI 토큰 세대 (kv nai:epoch) ────────────────────────────────────

export const NAI_EPOCH_KEY = 'nai:epoch'

/**
 * 맡긴 토큰이 바뀌거나 지워질 때마다 하나씩 올라가는 번호 (값이 없으면 0).
 * 클라우드 생성은 작업마다 「구독 확인을 마친 세대」를 기억해 두고, 지금 세대와 다르면 다음 장 전에 반드시 다시 확인한다 —
 * 확인 응답을 기다리는 사이 토큰이 바뀌어도 표시가 지워질 일이 없다 (번호는 올라가기만 한다)
 */
export function readNaiEpoch(sql: SqlLike): number {
  const value = Number(kvGet(sql, NAI_EPOCH_KEY))
  return Number.isInteger(value) && value >= 0 ? value : 0
}

/** 토큰을 바꾸거나 지울 때 부른다. 돌려주는 값 = 새 세대 번호 */
export function bumpNaiEpoch(sql: SqlLike): number {
  const next = readNaiEpoch(sql) + 1
  kvSet(sql, NAI_EPOCH_KEY, String(next))
  return next
}

// ── 씬 그림 수 (PC 가 PUT /api/pc/scene-counts 로 보낸다) ───────────

/** 씬 id(문자열) → PC 그림 수. 저장된 적이 없으면 빈 객체 */
export function getSceneCounts(sql: SqlLike): Record<string, number> {
  const memory = memoryOf(sql)
  if (!memory.sceneCounts) {
    const saved = kvGetJson<unknown>(sql, 'scene:counts')
    const counts: Record<string, number> = {}
    if (isRecord(saved)) {
      for (const [id, n] of Object.entries(saved)) {
        if (typeof n === 'number' && Number.isInteger(n) && n >= 0) counts[id] = n
      }
    }
    memory.sceneCounts = counts
  }
  return memory.sceneCounts
}

/** 통째로 바꾼다. 같으면 아무것도 쓰지 않는다. 돌려주는 값 = 실제로 썼는가 */
export function setSceneCounts(sql: SqlLike, counts: Record<string, number>): boolean {
  const text = JSON.stringify(counts)
  const memory = memoryOf(sql)
  if (kvGet(sql, 'scene:counts') === text) {
    memory.sceneCounts = counts
    return false
  }
  kvSet(sql, 'scene:counts', text)
  memory.sceneCounts = counts
  return true
}

// ── 완성 요청 해시 캐시 (kv hash:prepared = 키 → 해시 JSON 한 덩어리) ──

const PREPARED_HASH_KEY = 'hash:prepared'
/** 캐시가 이보다 크면 두지 않는다 (kv 한 행의 크기 한도 안에서 — 그때는 표에서 읽는다) */
const MAX_PREPARED_HASH_CACHE_CHARS = 1_500_000

/** prepared 표에서 키 → 해시 맵을 새로 만든다 (캐시가 없을 때·하루 한 번 바로잡을 때) */
export function rebuildPreparedHashes(sql: SqlLike): Record<string, string> {
  const map: Record<string, string> = {}
  for (const row of sql
    .exec<{ key: string; hash: string }>(`SELECT key, hash FROM prepared`)
    .toArray()) {
    map[row.key] = row.hash
  }
  writePreparedHashes(sql, map)
  return map
}

/** 키 → 해시 맵. 캐시 한 행만 읽는다 (없으면 표에서 만들어 둔다) */
export function readPreparedHashes(sql: SqlLike): Record<string, string> {
  const cached = kvGetJson<unknown>(sql, PREPARED_HASH_KEY)
  if (isRecord(cached)) return cached as Record<string, string>
  return rebuildPreparedHashes(sql)
}

export function writePreparedHashes(sql: SqlLike, map: Record<string, string>): void {
  const text = JSON.stringify(map)
  if (text.length > MAX_PREPARED_HASH_CACHE_CHARS) kvDel(sql, PREPARED_HASH_KEY)
  else kvSet(sql, PREPARED_HASH_KEY, text)
}

// ── 무료 사용량 ─────────────────────────────────────────────────────

/** 클라우드가 직접 확인한 무료 사용량을 믿고 쓰는 시간 — 이보다 오래되면 PC 가 올린 값을 먼저 본다 */
export const QUOTA_FRESH_MS = 30 * 60 * 1000

/** kv `nai:quota` (클라우드가 NAI 구독 확인 때 남긴 값) — 모양이 어긋나면 없는 것으로 */
function readCloudQuota(sql: SqlLike): CloudQuota | null {
  const saved = kvGetJson<unknown>(sql, 'nai:quota')
  if (!isRecord(saved)) return null
  const { state, checkedAt } = saved
  if (state !== 'available' && state !== 'exhausted' && state !== 'unknown') return null
  if (typeof checkedAt !== 'number' || !Number.isFinite(checkedAt)) return null
  return { state, checkedAt }
}

/** 클라우드가 확인한 값 중 30분 이내인 것 (폰이 「지금 불가」 이유로 보여 줄 수 있는 값) */
export function getConfirmedQuota(deps: HubDeps): CloudQuota | null {
  const quota = readCloudQuota(deps.sql)
  return quota && deps.now() - quota.checkedAt < QUOTA_FRESH_MS ? quota : null
}

/**
 * 화면에 알려 줄 무료 사용량. 우선순위:
 * 1) 클라우드가 30분 안에 확인한 값
 * 2) PC 가 library.naiInfo 로 올린 Opus 사용량 (checkedAt = naiInfo.updatedAt)
 * 3) 오래됐더라도 클라우드가 마지막으로 확인한 값 (checkedAt 으로 얼마나 묵었는지 보인다)
 * 아무것도 없으면 null
 */
export function getQuota(deps: HubDeps): CloudQuota | null {
  const confirmed = getConfirmedQuota(deps)
  if (confirmed) return confirmed
  const info = getLibrary(deps.sql)?.naiInfo
  if (isRecord(info) && typeof info.updatedAt === 'number' && Number.isFinite(info.updatedAt)) {
    if (
      (info.turboEnabled === true || info.autoSwitchEnabled === true) &&
      Array.isArray(info.accounts)
    ) {
      for (const acc of info.accounts) {
        if (isRecord(acc)) {
          const u = parseOpusUsage(acc.opusUsage)
          if (u && quotaState(u) === 'available') {
            return { state: 'available', checkedAt: info.updatedAt }
          }
        }
      }
    }
    const usage = parseOpusUsage(info.opusUsage)
    if (usage) return { state: quotaState(usage), checkedAt: info.updatedAt }
  }
  return readCloudQuota(deps.sql)
}

// ── 편집 줄 (ops) ───────────────────────────────────────────────────

export type OpRow = { id: number; type: string; payload: string; at: number; acked: number }

/** 미반영 편집 줄 한도 — 폰 토큰 하나가 줄을 끝없이 쌓아 DO 메모리·poll 응답을 터뜨리지 못하게 */
export const MAX_PENDING_OPS = 300
export const MAX_OP_BYTES = 200 * 1024
/**
 * poll 응답 한 번에 싣는 편집 줄 합계이자, 미반영 줄 전체 크기 한도 — 미반영 줄은 늘 poll 한 번에 다 실려 가고
 * (줄 수 × 줄 크기 한도의 최악값 60MB 가 한 번에 메모리로 올라오지도 않는다). 넘는 편집은 429
 */
export const MAX_POLL_OP_BYTES = 2 * 1024 * 1024
export const MAX_PENDING_OP_BYTES = MAX_POLL_OP_BYTES
export const OPS_FULL_MESSAGE = '편집이 너무 많이 쌓였습니다. PC를 켜서 반영한 뒤 다시 시도하세요'

const encoder = new TextEncoder()

function byteLength(text: string): number {
  return encoder.encode(text).byteLength
}

/** 폰이 PC 에 전할 편집 (job:cancel 은 별도) */
export type CloudEdit =
  | { type: 'scene:update'; sceneId: number; patch: CloudScenePatch }
  | { type: 'char:update'; charId: number; patch: CloudCharPatch }
  | { type: 'main:update'; patch: CloudMainPatch }

function sameTarget(edit: CloudEdit, payload: Record<string, unknown>): boolean {
  if (edit.type === 'scene:update') return payload.sceneId === edit.sceneId
  if (edit.type === 'char:update') return payload.charId === edit.charId
  return true
}

/**
 * 메인 패치 둘을 합친다 — 새 값이 이긴다.
 * 한 쪽만 남긴다: 새 패치가 분할 프롬프트면 옛 통짜 프롬프트는, 통짜면 옛 분할은 버린다
 */
export function mergeMainPatch(old: CloudMainPatch, next: CloudMainPatch): CloudMainPatch {
  const patch: CloudMainPatch = { ...old, ...next }
  if ('promptParts' in next && !('prompt' in next)) delete patch.prompt
  if ('prompt' in next && !('promptParts' in next)) delete patch.promptParts
  return patch
}

/** 같은 대상의 먼저 온 편집에 새 편집을 합친다 — 새 값이 이긴다 */
function mergePayload(
  edit: CloudEdit,
  old: Record<string, unknown>
): Record<string, unknown> & { patch: Record<string, unknown> } {
  const oldPatch = isRecord(old.patch) ? old.patch : {}
  const patch: Record<string, unknown> =
    edit.type === 'main:update'
      ? { ...mergeMainPatch(oldPatch as CloudMainPatch, edit.patch) }
      : { ...oldPatch, ...edit.patch }
  const { type: _type, ...rest } = edit
  void _type
  return { ...rest, patch }
}

/**
 * 폰 편집을 줄에 세운다. 같은 대상(scene id·char id·main)의 미반영 줄이 있으면 새로 쌓지 않고 합친다 —
 * 합칠 때는 옛 줄을 지우고 새 번호로 다시 세운다 (PC 가 옛 줄을 이미 받아 반영 중이어도 그 확인이 합친 줄을 덮지 않도록).
 * 줄 수·줄 크기·전체 크기 어느 한도든 넘으면 429. 돌려주는 값은 줄 번호
 */
export function queueEdit(deps: HubDeps, edit: CloudEdit): number {
  const { sql } = deps
  const same = sql
    .exec<OpRow>(
      `SELECT id, type, payload, at, acked FROM ops WHERE acked = 0 AND type = ? ORDER BY id ASC`,
      edit.type
    )
    .toArray()
    .map((row) => ({ row, payload: JSON.parse(row.payload) as Record<string, unknown> }))
    .find((entry) => sameTarget(edit, entry.payload))

  let payload: Record<string, unknown>
  if (same) {
    payload = mergePayload(edit, same.payload)
  } else {
    const { type: _type, ...rest } = edit
    void _type
    payload = rest
  }
  const text = JSON.stringify(payload)
  const size = byteLength(text)
  if (size > MAX_OP_BYTES) throw new HttpError(429, OPS_FULL_MESSAGE)

  const totals = sql
    .exec<{ n: number; bytes: number | null }>(
      `SELECT COUNT(*) AS n, SUM(length(CAST(payload AS BLOB))) AS bytes FROM ops WHERE acked = 0`
    )
    .one()
  const replacedBytes = same ? byteLength(same.row.payload) : 0
  if (
    (!same && totals.n >= MAX_PENDING_OPS) ||
    (totals.bytes ?? 0) - replacedBytes + size > MAX_PENDING_OP_BYTES
  ) {
    throw new HttpError(429, OPS_FULL_MESSAGE)
  }

  if (same) sql.exec(`DELETE FROM ops WHERE id = ?`, same.row.id)
  return sql
    .exec<{ id: number }>(
      `INSERT INTO ops (type, payload, at, acked) VALUES (?, ?, ?, 0) RETURNING id`,
      edit.type,
      text,
      deps.now()
    )
    .one().id
}

/** 한도 없이 한 줄을 세운다 (job:cancel 처럼 PC 가 직접 처리하는 짧은 줄) */
export function addOp(
  deps: HubDeps,
  type: CloudOp['type'],
  payload: Record<string, unknown>
): number {
  const cursor = deps.sql.exec<{ id: number }>(
    `INSERT INTO ops (type, payload, at, acked) VALUES (?, ?, ?, 0) RETURNING id`,
    type,
    JSON.stringify(payload),
    deps.now()
  )
  return cursor.one().id
}

export function rowToOp(row: OpRow): CloudOp {
  const payload = JSON.parse(row.payload) as Record<string, unknown>
  return { ...payload, id: row.id, at: row.at, type: row.type } as CloudOp
}

/** PC 가 아직 반영(ack)하지 않은 편집 줄 — id 순 */
export function pendingOpRows(sql: SqlLike, limit = 1000): OpRow[] {
  return sql
    .exec<OpRow>(
      `SELECT id, type, payload, at, acked FROM ops WHERE acked = 0 ORDER BY id ASC LIMIT ?`,
      limit
    )
    .toArray()
}

/**
 * poll 응답에 실을 미반영 줄 — 줄 수(maxRows)와 합계 크기(maxBytes, 첫 줄은 항상 포함)를 넘지 않게 앞에서부터.
 * 미반영 줄 전체가 queueEdit 의 한도(2MB) 안이라 보통은 한 번에 다 실린다 — 한도 도입 전에 쌓인 줄이 있을 때만 잘린다
 */
export function pendingOpRowsForPoll(
  sql: SqlLike,
  maxRows: number,
  maxBytes = MAX_POLL_OP_BYTES
): OpRow[] {
  const rows: OpRow[] = []
  let total = 0
  for (const row of pendingOpRows(sql, maxRows)) {
    const size = byteLength(row.payload)
    if (rows.length > 0 && total + size > maxBytes) break
    rows.push(row)
    total += size
  }
  return rows
}

/** 미반영 char:update 줄이 있는가 (클라우드 생성에는 쓰이지 않음을 알리려고) */
export function hasPendingCharEdits(sql: SqlLike): boolean {
  return (
    sql.exec(`SELECT 1 AS x FROM ops WHERE acked = 0 AND type = 'char:update' LIMIT 1`).toArray()
      .length > 0
  )
}

// ── 편집 덧입히기 ───────────────────────────────────────────────────

export function applyScenePatch(scene: CloudSceneLite, patch: CloudScenePatch): CloudSceneLite {
  const next = { ...scene }
  if (patch.name !== undefined) next.name = patch.name
  if (patch.prompt !== undefined) next.prompt = patch.prompt
  if (patch.negativePrompt !== undefined) next.negativePrompt = patch.negativePrompt
  if (patch.width !== undefined) next.width = patch.width
  if (patch.height !== undefined) next.height = patch.height
  return next
}

export function applyCharPatch(
  library: CloudLibrary,
  charId: number,
  patch: CloudCharPatch
): boolean {
  const target = library.characters.find((c) => c.id === charId)
  if (!target) return false
  if (patch.enabled !== undefined) target.enabled = patch.enabled
  if (patch.prompt !== undefined) target.prompt = patch.prompt
  return true
}

export function applyMainPatch(library: CloudLibrary, patch: CloudMainPatch): void {
  if (patch.prompt !== undefined) library.main.prompt = patch.prompt
  if (patch.promptParts !== undefined) library.main.promptParts = patch.promptParts
  if (patch.negativePrompt !== undefined) library.main.negativePrompt = patch.negativePrompt
}

/** 라이브러리에 미반영 char·main 편집을 id 순으로 다시 덧입힌다 (PC 가 보낸 옛 값으로 덮인 뒤) */
export function overlayPendingLibraryOps(sql: SqlLike, library: CloudLibrary): void {
  for (const row of pendingOpRows(sql)) {
    const payload = JSON.parse(row.payload) as { charId?: number; patch?: unknown }
    if (row.type === 'char:update' && typeof payload.charId === 'number') {
      applyCharPatch(library, payload.charId, payload.patch as CloudCharPatch)
    } else if (row.type === 'main:update') {
      applyMainPatch(library, payload.patch as CloudMainPatch)
    }
  }
}

/** 씬 id → 미반영 scene 패치를 id 순으로 합친 것 */
export function pendingScenePatches(sql: SqlLike): Map<number, CloudScenePatch> {
  const merged = new Map<number, CloudScenePatch>()
  for (const row of pendingOpRows(sql)) {
    if (row.type !== 'scene:update') continue
    const payload = JSON.parse(row.payload) as { sceneId: number; patch: CloudScenePatch }
    merged.set(payload.sceneId, { ...merged.get(payload.sceneId), ...payload.patch })
  }
  return merged
}

/** 미반영 main:update 패치를 id 순으로 합친 것 (없으면 null) — 클라우드 생성이 완성 요청 위에 얹는다 */
export function pendingMainPatch(sql: SqlLike): CloudMainPatch | null {
  let merged: CloudMainPatch | null = null
  for (const row of pendingOpRows(sql)) {
    if (row.type !== 'main:update') continue
    const payload = JSON.parse(row.payload) as { patch?: CloudMainPatch }
    if (!isRecord(payload.patch)) continue
    merged = { ...(merged ?? {}), ...payload.patch }
  }
  return merged
}

// ── ack 된 메인 편집의 덧입힘 (kv main:lastPatch) ───────────────────

/**
 * PC 가 main:update 를 ack 한 뒤에도 완성 요청(prepared)은 PC 가 새로 올릴 때까지(약 20초) 옛 프롬프트다.
 * 그 사이 클라우드 생성이 옛 프롬프트로 나가지 않게, ack 된 패치와 ack 시각을 남겨 두고
 * 그 완성 요청 행이 ack 시각 뒤에 다시 올라오기 전까지 계속 덧입힌다 (activeMainPatch)
 */
export const ACKED_MAIN_PATCH_KEY = 'main:lastPatch'

export interface AckedMainPatch {
  patch: CloudMainPatch
  ackedAt: number
}

/** 남겨 둔 ack 된 패치 — 모양이 어긋나면 없는 것으로 */
export function readAckedMainPatch(sql: SqlLike): AckedMainPatch | null {
  const saved = kvGetJson<unknown>(sql, ACKED_MAIN_PATCH_KEY)
  if (!isRecord(saved) || !isRecord(saved.patch)) return null
  if (typeof saved.ackedAt !== 'number' || !Number.isFinite(saved.ackedAt)) return null
  return { patch: saved.patch as CloudMainPatch, ackedAt: saved.ackedAt }
}

/** 완성 요청 행의 내용이 마지막으로 바뀐 시각 (행이 없거나 옛 행이라 시각이 없으면 0) */
export function preparedUpdatedAt(sql: SqlLike, key: string): number {
  const row = sql
    .exec<{ updated_at: number | null }>(`SELECT updated_at FROM prepared WHERE key = ?`, key)
    .toArray()[0]
  return typeof row?.updated_at === 'number' ? row.updated_at : 0
}

/**
 * 이번 ack 로 처음 반영 처리되는(acked=0) main:update 줄의 패치를 id 순으로 합쳐 남긴다. ack 표시 **전에** 부른다.
 * 이미 ack 된 줄(같은 ack 의 재시도)은 세지 않으므로 시각이 밀리지 않는다.
 * 앞서 남긴 패치는 'main' 완성 요청이 그 뒤로 아직 새로 올라오지 않았을 때만 이어 받는다 —
 * 이미 새로 올라왔으면 그 패치는 끝난 것이라, 그 뒤 PC 에서 고친 값을 옛 패치로 되돌리지 않도록 버린다
 */
export function recordAckedMainPatch(deps: HubDeps, opIds: readonly number[]): void {
  const { sql } = deps
  const rows: OpRow[] = []
  for (const part of chunk([...opIds], 50)) {
    rows.push(
      ...sql
        .exec<OpRow>(
          `SELECT id, type, payload, at, acked FROM ops
           WHERE acked = 0 AND type = 'main:update' AND id IN (${placeholders(part.length)})`,
          ...part
        )
        .toArray()
    )
  }
  rows.sort((a, b) => a.id - b.id)
  let patch: CloudMainPatch | null = null
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as { patch?: unknown }
    if (!isRecord(payload.patch)) continue
    patch = mergeMainPatch(patch ?? {}, payload.patch as CloudMainPatch)
  }
  if (!patch) return
  const earlier = readAckedMainPatch(sql)
  if (earlier && preparedUpdatedAt(sql, 'main') <= earlier.ackedAt) {
    patch = mergeMainPatch(earlier.patch, patch)
  }
  kvSetJson(sql, ACKED_MAIN_PATCH_KEY, { patch, ackedAt: deps.now() })
}

/**
 * 클라우드 생성이 완성 요청 위에 얹을 메인 패치 — 아직 PC 가 반영 안 한 것(미반영 줄) +
 * ack 됐지만 이 완성 요청 행(preparedAt = 그 행의 마지막 변경 시각)이 ack 뒤로 아직 안 바뀐 것. 없으면 null
 */
export function activeMainPatch(sql: SqlLike, preparedAt: number): CloudMainPatch | null {
  const pending = pendingMainPatch(sql)
  const acked = readAckedMainPatch(sql)
  const kept = acked && preparedAt <= acked.ackedAt ? acked.patch : null
  if (kept && pending) return mergeMainPatch(kept, pending)
  return pending ?? kept
}

// ── 작업 행 ─────────────────────────────────────────────────────────

export type JobRow = {
  id: string
  target: string
  label: string
  count: number
  done: number
  failed: number
  state: string
  place: string
  runner: string | null
  error: string | null
  created_at: number
  updated_at: number
  in_flight: number
  attempts: number
}

export const JOB_COLUMNS = `id, target, label, count, done, failed, state, place, runner, error, created_at, updated_at, in_flight, attempts`

export function getJobRow(sql: SqlLike, id: string): JobRow | undefined {
  return sql.exec<JobRow>(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`, id).toArray()[0]
}

export function rowToJob(row: JobRow): CloudJob {
  return {
    id: row.id,
    target: JSON.parse(row.target) as CloudJobTarget,
    label: row.label,
    count: row.count,
    done: row.done,
    failed: row.failed,
    state: row.state as CloudJob['state'],
    place: row.place as CloudJob['place'],
    runner: (row.runner as CloudJob['runner']) ?? null,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function isFinalState(state: string): boolean {
  return state === 'done' || state === 'failed' || state === 'cancelled'
}

/** 작업이 끝나면 그 작업의 임시 kv(Anlas 기준값 등)를 치운다 */
export function clearJobKv(sql: SqlLike, jobId: string): void {
  sql.exec(
    `DELETE FROM kv WHERE k IN (?, ?, ?)`,
    `anlas:${jobId}`,
    `verify:${jobId}`,
    `rl:${jobId}`
  )
}

// ── 그림 행 ─────────────────────────────────────────────────────────

export type ImageRow = {
  id: string
  source: string
  scene_id: number | null
  preset_id: number | null
  job_id: string | null
  seed: number | null
  width: number
  height: number
  created_at: number
  has_thumb: number
  format: string
  r2_key: string
  sent_payload: string | null
  imported: number
  pc_image_id: number | null
}

export const IMAGE_COLUMNS = `id, source, scene_id, preset_id, job_id, seed, width, height, created_at, has_thumb, format, r2_key, sent_payload, imported, pc_image_id`

export function getImageRow(sql: SqlLike, id: string): ImageRow | undefined {
  return sql.exec<ImageRow>(`SELECT ${IMAGE_COLUMNS} FROM images WHERE id = ?`, id).toArray()[0]
}

/** 클라우드 생성분인데 PC 가 아직 안 가져갔는가 — 지우면 유일한 사본이 사라진다 */
export function isPcPending(row: { source: string; imported: number }): boolean {
  return row.source === 'cloud' && row.imported === 0
}

export function rowToImageItem(row: ImageRow): CloudImageItem {
  return {
    id: row.id,
    source: row.source as CloudImageItem['source'],
    sceneId: row.scene_id,
    presetId: row.preset_id,
    jobId: row.job_id,
    seed: row.seed,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
    hasThumb: row.has_thumb > 0,
    format: row.format as CloudImageItem['format'],
    pcPending: isPcPending(row)
  }
}

// ── 썸네일 (images.has_thumb: 0 없음 · 1 WebP · 2 JPEG) ─────────────

export type ThumbKind = 'webp' | 'jpeg'

export function thumbKindOf(hasThumb: number): ThumbKind | null {
  return hasThumb === 1 ? 'webp' : hasThumb === 2 ? 'jpeg' : null
}

export function thumbFlag(kind: ThumbKind): number {
  return kind === 'jpeg' ? 2 : 1
}

export function thumbKey(id: string, kind: ThumbKind = 'webp'): string {
  return kind === 'jpeg' ? `thumb/${id}.jpg` : `thumb/${id}.webp`
}

export function thumbMime(kind: ThumbKind): string {
  return kind === 'jpeg' ? 'image/jpeg' : 'image/webp'
}

/** 올라온 썸네일의 형식 — image/webp · image/jpeg 만 받는다 (헤더가 없으면 예전처럼 WebP) */
export function thumbKindFromRequest(request: Request): ThumbKind {
  const type = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (type === '' || type === 'image/webp') return 'webp'
  if (type === 'image/jpeg' || type === 'image/jpg') return 'jpeg'
  throw new HttpError(415, '썸네일은 WebP 또는 JPEG만 올릴 수 있습니다')
}

// ── 그림 수 카운터 (kv n:images = `전체,PC가 아직 안 가져간 클라우드 생성분`) ──

export interface ImageCounters {
  total: number
  pending: number
}

/** 표를 세어 카운터를 새로 쓴다 (처음 쓸 때, 판을 올린 뒤, 하루 한 번 어긋남을 바로잡을 때) */
export function recountImages(sql: SqlLike): ImageCounters {
  const total = sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM images`).one().n
  const pending = sql
    .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM images WHERE source = 'cloud' AND imported = 0`)
    .one().n
  const text = `${total},${pending}`
  if (kvGet(sql, 'n:images') !== text) kvSet(sql, 'n:images', text)
  return { total, pending }
}

/** 저장된 카운터 (없거나 깨졌으면 null) */
function readImageCounters(sql: SqlLike): ImageCounters | null {
  const saved = kvGet(sql, 'n:images')
  if (saved == null) return null
  const [total, pending] = saved.split(',').map(Number)
  if (Number.isInteger(total) && Number.isInteger(pending) && total >= 0 && pending >= 0) {
    return { total, pending }
  }
  return null
}

export function getImageCounters(sql: SqlLike): ImageCounters {
  return readImageCounters(sql) ?? recountImages(sql)
}

/**
 * 표를 바꾼 **뒤에** 부른다 — 카운터를 늘리고 줄인다 (음수로는 내려가지 않는다).
 * 카운터가 없으면(옛 저장소 · 처음) 지금 표를 세어 채우는 것으로 갈음한다. 이미 바뀐 표를 센 값이라 변화량을 또 더하지 않는다
 */
export function adjustImageCounters(sql: SqlLike, dTotal: number, dPending: number): void {
  if (dTotal === 0 && dPending === 0) return
  const now = readImageCounters(sql)
  if (!now) {
    recountImages(sql)
    return
  }
  const total = Math.max(0, now.total + dTotal)
  const pending = Math.min(total, Math.max(0, now.pending + dPending))
  kvSet(sql, 'n:images', `${total},${pending}`)
}

type RemovableImage = { id: string; r2_key: string; has_thumb: number }

/** R2 파일과 행을 함께 지운다 (R2 먼저 — 실패하면 행이 남아 다음에 다시 시도된다). 카운터도 맞춘다 */
export async function removeImages(deps: HubDeps, rows: RemovableImage[]): Promise<void> {
  if (rows.length === 0) return
  const keys = rows.flatMap((r) => {
    const kind = thumbKindOf(r.has_thumb)
    return kind ? [r.r2_key, thumbKey(r.id, kind)] : [r.r2_key]
  })
  for (const part of chunk(keys, 500)) await deps.bucket.delete(part)
  // R2 를 기다리는 사이 다른 요청이 같은 행을 먼저 지웠을 수 있다 — 지금 실제로 있는 행만 세어 카운터를 맞춘다
  let removed = 0
  let removedPending = 0
  for (const part of chunk(
    rows.map((r) => r.id),
    50
  )) {
    const marks = placeholders(part.length)
    const existing = deps.sql
      .exec<{ source: string; imported: number }>(
        `SELECT source, imported FROM images WHERE id IN (${marks})`,
        ...part
      )
      .toArray()
    deps.sql.exec(`DELETE FROM images WHERE id IN (${marks})`, ...part)
    removed += existing.length
    removedPending += existing.filter(isPcPending).length
  }
  adjustImageCounters(deps.sql, -removed, -removedPending)
}

/**
 * 보관 정리 — keepImages 를 넘는 가장 오래된 것부터 지운다.
 * PC 가 아직 안 가져간 클라우드 생성분(source='cloud' AND imported=0)은 세지도 지우지도 않는다.
 * 세는 값은 카운터에서 읽어 그림 업로드마다 표를 훑지 않는다.
 */
export async function enforceRetention(deps: HubDeps): Promise<number> {
  const keep = getSettings(deps.sql).keepImages
  const { total, pending } = getImageCounters(deps.sql)
  const excess = total - pending - keep
  if (excess <= 0) return 0
  const rows = deps.sql
    .exec<RemovableImage>(
      `SELECT id, r2_key, has_thumb FROM images WHERE NOT (source = 'cloud' AND imported = 0)
       ORDER BY created_at ASC, id ASC LIMIT ?`,
      excess
    )
    .toArray()
  await removeImages(deps, rows)
  return rows.length
}
