/**
 * 클라우드 생성 실행기 (설계 6절) — PC 가 꺼져 있을 때 DO 알람이 한 번에 한 장씩 NAI 로 만든다.
 *
 * 무료 보장: 매 장 해상도·스텝·i2i 를 검사하고, NAI 구독(Opus 등급·이번 달 무료 사용량·Anlas 잔액)을
 * V5 모델은 매 장 생성 직전에, 그 밖의 모델은 작업 첫 장 전과 이후 5장마다 다시 확인한다.
 * 하나라도 어긋나거나 불확실하면(Anlas 잔액 필드를 못 읽는 경우 포함) 그 작업을 멈춘다.
 * Anlas 가 줄었으면 작업을 멈추고 클라우드 생성을 끈다.
 *
 * 토큰이 바뀐 것은 세대 번호(kv nai:epoch)로 안다. 작업마다 「구독 확인을 마친 세대」를 기준 잔액과 함께 기억하고
 * (kv anlas:<작업> = `<세대>:<잔액>`), 지금 세대와 다르면 다음 장 전에 반드시 다시 확인한다.
 * 세대는 토큰을 읽는 같은 순간에 읽어 두고 확인이 끝난 뒤 그 값으로 기록하므로, 확인 응답을 기다리는 사이
 * 토큰이 바뀌면 기록된 세대가 낡은 것이 되어 다음 장 전에 또 확인한다.
 *
 * 한 번에 한 장만 만들고(무료 요금제 CPU 한도), 응답 zip 은 풀지 않고 R2 에 그대로 둔다.
 * at-least-once: 장을 시작하기 전에 in_flight=1·attempts+1 을 먼저 저장해, 알람이 다시 들어와도
 * 3번을 넘게 시도한 장은 실패로 넘기고 무한 재시도를 끊는다.
 */
import { processWildcards } from '../../../src/main/fragments/processor'
import { buildGenerateImagePayload } from '../../../src/main/nai/payload'
import { estimateAnlas } from '../../../src/shared/anlas'
import {
  CLOUD_FREE_MAX_PIXELS,
  CLOUD_FREE_MAX_STEPS,
  type CloudJobTarget,
  type CloudMainPatch,
  type CloudSceneLite
} from '../../../src/shared/cloud-contract'
import { isV5 } from '../../../src/shared/nai-models'
import { removeComments } from '../../../src/shared/nai-presets'
import { parseOpusUsage, quotaState } from '../../../src/shared/opus-usage'
import { patchPromptRequest } from '../../../src/shared/prompt-state'
import { rewriteRequestPrompt } from '../../../src/shared/futa'
import { mergePromptParts, refreshScenePrompts } from '../../../src/shared/scene-request'
import { withTransparentBackground } from '../../../src/shared/transparent-background'
import type { GenerationRequest } from '../../../src/shared/types'
import type { HubDeps, SqlLike } from './deps'
import { loadFragmentSource, loadSequentialCounters, saveSequentialCounters } from './fragments'
import { failCloudJobs, getSceneCopy, preparedKey } from './jobs'
import {
  activeMainPatch,
  adjustImageCounters,
  clearJobKv,
  enforceRetention,
  getJobRow,
  getSettings,
  JOB_COLUMNS,
  kvDel,
  kvGet,
  kvSet,
  kvSetJson,
  readNaiEpoch,
  setSettings,
  type JobRow
} from './store'
import { errorText, ID_ALPHABET, isRecord, randomString, scrub } from './util'

/** 한 장을 만든 뒤 다음 알람까지 */
export const STEP_DELAY_MS = 1500
/** 예외로 끝난 뒤 다시 시도하기까지 */
const ERROR_DELAY_MS = 5000
/** V5 가 아닌 모델의 구독 재확인 간격 (장 수) — 작업 첫 장 전에도 확인한다. V5 는 매 장 확인 */
const RECHECK_EVERY = 5
/** 429 를 만나 이 시각 전에는 어떤 경로로 알람이 와도 생성하지 않는다 (kv) */
const NOT_BEFORE_KEY = 'nai:notBefore'
/** Anlas 잔액 필드를 못 읽었을 때 작업을 멈추는 이유 */
export const ANLAS_UNKNOWN_ERROR = 'Anlas 잔액을 확인하지 못해 멈췄습니다'
/** 같은 장을 시작할 수 있는 횟수 — 넘으면 그 장을 실패로 넘긴다 */
const MAX_ATTEMPTS = 3
/** 429 를 만나 같은 장을 다시 시도하는 최대 횟수 */
const MAX_RATE_LIMIT_RETRIES = 6
const DEFAULT_RETRY_MS = 5000
const MAX_RETRY_MS = 5 * 60 * 1000

export interface StepResult {
  /** 알람을 더 걸어야 하는가 (남은 클라우드 작업이 있음) */
  again: boolean
  delayMs: number
}

/** 이 작업을 더 진행하지 않는다 (재시도해도 소용없는 이유) */
class StopJob extends Error {
  constructor(
    message: string,
    readonly disableCloudGen = false
  ) {
    super(message)
    this.name = 'StopJob'
  }
}

interface Subscription {
  tier: number
  /** 고정 + 구매 Anlas 잔액. 응답에서 숫자로 읽지 못하면 null (불확실 → 멈춘다) */
  anlas: number | null
  usage: unknown
}

function naiHost(deps: HubDeps): string {
  return (deps.env.NAI_HOST || 'https://image.novelai.net').replace(/\/+$/, '')
}

function hasMoreCloudJobs(deps: HubDeps): boolean {
  return deps.sql.exec(`SELECT 1 AS x FROM jobs WHERE state = 'cloud' LIMIT 1`).toArray().length > 0
}

function next(deps: HubDeps): StepResult {
  return { again: hasMoreCloudJobs(deps), delayMs: STEP_DELAY_MS }
}

/** 다음 클라우드 작업에서 장 하나를 만든다. 아무 일도 없으면 { again: false } */
export async function runCloudStep(deps: HubDeps): Promise<StepResult> {
  const { sql } = deps
  const job = sql
    .exec<JobRow>(
      `SELECT ${JOB_COLUMNS} FROM jobs WHERE state = 'cloud' ORDER BY created_at ASC, id ASC LIMIT 1`
    )
    .toArray()[0]
  if (!job) return { again: false, delayMs: 0 }

  if (!getSettings(sql).cloudGenEnabled) {
    failCloudJobs(deps, '클라우드 생성이 꺼져 있어 중단했습니다')
    return { again: false, delayMs: 0 }
  }
  const token = kvGet(sql, 'secret:nai')
  if (!token) {
    failCloudJobs(deps, 'NAI 토큰이 없음')
    return { again: false, delayMs: 0 }
  }
  // 이 토큰이 속한 세대 — 토큰과 같은 순간(await 없이)에 읽는다. 이 장의 구독 확인은 이 토큰으로 이 세대의 값으로 기록된다
  const epoch = readNaiEpoch(sql)

  // 429 로 쉬는 중이면 어떤 알람이 와도(새 작업 만들기·재배정 점검 포함) NAI 를 부르지 않는다
  const notBefore = Number(kvGet(sql, NOT_BEFORE_KEY))
  if (Number.isFinite(notBefore) && notBefore > deps.now()) {
    return { again: true, delayMs: notBefore - deps.now() }
  }

  const index = job.done + job.failed
  if (index >= job.count) {
    // 방어: 이미 장수를 채운 작업이 cloud 로 남아 있으면 마무리만 한다
    sql.exec(
      `UPDATE jobs SET state = ?, in_flight = 0, attempts = 0, updated_at = ? WHERE id = ? AND state = 'cloud'`,
      job.done > 0 ? 'done' : 'failed',
      deps.now(),
      job.id
    )
    clearJobKv(sql, job.id)
    return next(deps)
  }

  // 알람이 다시 들어왔는데 이 장이 이미 시작된 채로 3번을 넘겼다 — 이 장은 포기하고 넘어간다
  if (job.in_flight === 1 && job.attempts > MAX_ATTEMPTS) {
    const cause = job.error ? `: ${job.error}` : ''
    failImage(
      deps,
      job,
      `생성을 ${MAX_ATTEMPTS}번 넘게 시도했지만 끝내지 못해 건너뜁니다${cause}`.slice(0, 300)
    )
    return next(deps)
  }

  // 장을 시작하기 전에 먼저 저장 — 도중에 끊겨도 다시 들어왔을 때 알아본다
  sql.exec(
    `UPDATE jobs SET in_flight = 1, attempts = attempts + 1, updated_at = ? WHERE id = ?`,
    deps.now(),
    job.id
  )
  try {
    return await generateOne(deps, job, token, epoch, index)
  } catch (error) {
    if (error instanceof StopJob) {
      stopJob(deps, job.id, error)
      return next(deps)
    }
    // 일시적 실패 — 기록하고 조금 뒤에 같은 장을 다시 (attempts 가 무한 재시도를 끊는다)
    const message = scrub(errorText(error), token).slice(0, 300)
    sql.exec(
      `UPDATE jobs SET error = ?, updated_at = ? WHERE id = ? AND state = 'cloud'`,
      message,
      deps.now(),
      job.id
    )
    return { again: true, delayMs: ERROR_DELAY_MS }
  }
}

async function generateOne(
  deps: HubDeps,
  job: JobRow,
  token: string,
  epoch: number,
  index: number
): Promise<StepResult> {
  const { sql } = deps
  const target = JSON.parse(job.target) as CloudJobTarget

  // 1) 완성 요청 → 씬 최신 프롬프트 재병합 → 투명 배경
  const prepared = loadPrepared(deps, target)
  let request = prepared.request
  // 폰에서 고친 메인 프롬프트를 완성 요청에 얹는다 — 씬 재병합보다 먼저.
  // PC 가 아직 반영(ack)하지 않은 편집은 물론, ack 했어도 이 완성 요청 행이 ack 뒤로 아직 새로 올라오지 않았으면 계속 얹는다
  const mainPatch = activeMainPatch(sql, prepared.updatedAt)
  if (mainPatch) request = overlayMainPatch(request, mainPatch, target)
  let scene: CloudSceneLite | null = null
  if (target.type === 'scene') {
    scene = getSceneCopy(deps, target.sceneId)
    if (!scene) throw new StopJob('씬이 클라우드에 없습니다 (PC를 한 번 켜 주세요)')
    request = refreshScenePrompts(request, scene)
    // 폰에서 고친 해상도도 따른다 — PC 가 만든 씬 요청은 이미지 변환이 아니면 씬 해상도를 그대로 쓴다.
    // (무료 범위 검사가 실제로 만들 크기를 보게 하는 효과도 있다)
    if (!request.source && finiteNumber(scene.width) && finiteNumber(scene.height)) {
      request = { ...request, width: scene.width, height: scene.height }
    }
  }
  if (request.transparentBackground === true) request = withTransparentBackground(request, true)

  // 2) 무료 조건 — 네트워크 없이 보는 것부터
  // PC 가 올린 완성 요청의 i2i 는 원본 그림 없이 자리표시 객체({ strength, noise, imageBase64: '' })만 남는다 —
  // 그림이 비어 있어도 객체가 있으면 i2i 요청이다
  if (request.source != null) throw new StopJob('i2i 요청이라 클라우드에서 생성하지 않습니다')
  if (request.width * request.height > CLOUD_FREE_MAX_PIXELS) {
    throw new StopJob(
      `해상도가 무료 범위(1024×1024 이하)를 넘어 클라우드 생성을 멈췄습니다 (${request.width}×${request.height})`
    )
  }
  if (request.steps > CLOUD_FREE_MAX_STEPS) {
    throw new StopJob(
      `스텝이 무료 범위(${CLOUD_FREE_MAX_STEPS} 이하)를 넘어 클라우드 생성을 멈췄습니다 (${request.steps})`
    )
  }

  // 3) NAI 구독 확인 — V5 는 매 장, 그 밖의 모델은 작업 첫 장 전·이후 5장마다.
  //    그 밖에 확인이 필요한 때: 이 작업이 확인을 마친 세대가 없거나 지금 세대와 다를 때(토큰이 바뀜),
  //    첫 장 직후 확인이 끝나지 못했을 때(verify 표시)
  const baseline = readAnlasBaseline(sql, job.id)
  const needsCheck =
    isV5(request.model) ||
    index % RECHECK_EVERY === 0 ||
    baseline == null ||
    baseline.epoch !== epoch ||
    kvGet(sql, `verify:${job.id}`) != null
  if (needsCheck) {
    const sub = await fetchSubscription(deps, token)
    verifyFreeTier(deps, job.id, request.model, sub, epoch)
    kvDel(sql, `verify:${job.id}`)
  }
  // 이 작업은 위 확인(Opus·사용량 남음)을 이미 통과했다 — 공용 판정으로 한 번 더 무료인지 본다
  const estimate = estimateAnlas({
    model: request.model,
    quota: 'available',
    width: request.width,
    height: request.height,
    steps: request.steps,
    isOpus: true,
    batchCount: 1
  })
  if (!estimate.free) throw new StopJob('무료 범위가 아니라서 클라우드 생성을 멈췄습니다')

  // 4) 조각·와일드카드 치환 + 새 시드 (PC 큐의 생성 직전 처리와 같은 순서)
  const fragments = await loadFragmentSource(deps)
  const before = loadSequentialCounters(sql)
  const counters = new Map(before)
  const rng = (): number => deps.random()
  const sub = (text: string | undefined): string =>
    processWildcards(removeComments(text ?? ''), fragments, rng, { sequentialCounters: counters })
  const processed: GenerationRequest = {
    ...request,
    prompt: sub(request.prompt),
    negativePrompt: sub(request.negativePrompt),
    characterPrompts: request.characterPrompts.map((c) => ({
      ...c,
      prompt: sub(c.prompt),
      negativePrompt: sub(c.negativePrompt)
    })),
    seed: Math.floor(deps.random() * 4294967296)
  }
  // 순차 조각 카운터는 여기서 저장하지 않는다 — 그림 저장에 성공한 뒤에만 저장해야
  // 429·예외로 같은 장을 다시 시도해도 줄이 한 칸씩 소모되지 않는다

  // 5) NAI 호출 — 바이브·캐릭터 레퍼런스는 보내지 않는다
  const sentPayload = JSON.stringify(buildGenerateImagePayload(processed, { imageFormat: 'png' }))
  const response = await deps.fetch(`${naiHost(deps)}/ai/generate-image`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/x-zip-compressed'
    },
    body: sentPayload
  })

  if (response.status === 429) return rateLimited(deps, job, response)
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel()
    throw new StopJob('NAI 토큰이 거부되어 클라우드 생성을 멈췄습니다')
  }
  if (response.status === 402) {
    await response.body?.cancel()
    throw new StopJob('NAI 가 Anlas 결제를 요구해 클라우드 생성을 멈췄습니다', true)
  }
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
  if (!response.ok) {
    const text = scrub((await response.text().catch(() => '')).slice(0, 200), token)
    failImage(deps, job, `생성 실패 ${response.status}: ${text}`)
    return next(deps)
  }
  const body = new Uint8Array(await response.arrayBuffer())
  if (contentType.includes('json') || contentType.includes('text/') || !isZip(body)) {
    const text =
      contentType.includes('json') || contentType.includes('text/')
        ? scrub(new TextDecoder().decode(body.subarray(0, 200)), token)
        : ''
    failImage(
      deps,
      job,
      `NAI 응답이 그림 묶음(zip)이 아닙니다 (${contentType || '형식 없음'})${text ? `: ${text}` : ''}`
    )
    return next(deps)
  }

  // 6) 응답 zip 을 풀지 않고 R2 에 그대로 + 행·작업 갱신 (R2 이후는 await 없이 한 덩어리)
  const id = 'c' + randomString(12, ID_ALPHABET)
  const key = `img/${id}.zip`
  await deps.bucket.put(key, body, { httpMetadata: { contentType: 'application/zip' } })

  const current = getJobRow(sql, job.id)
  if (!current || current.state !== 'cloud') {
    // 만드는 동안 취소됐다 — 결과는 버린다
    await deps.bucket.delete(key)
    return next(deps)
  }
  const now = deps.now()
  sql.exec(
    `INSERT INTO images (id, source, scene_id, preset_id, job_id, seed, width, height, created_at, has_thumb, format, r2_key, sent_payload, imported, pc_image_id)
     VALUES (?, 'cloud', ?, ?, ?, ?, ?, ?, ?, 0, 'zip', ?, ?, 0, NULL)`,
    id,
    target.type === 'scene' ? target.sceneId : null,
    scene ? scene.presetId : null,
    job.id,
    processed.seed,
    processed.width,
    processed.height,
    now,
    key,
    sentPayload
  )
  adjustImageCounters(sql, 1, 1)
  saveSequentialCounters(sql, before, counters)
  kvDel(sql, NOT_BEFORE_KEY)
  const done = current.done + 1
  const finished = done + current.failed >= current.count
  sql.exec(
    `UPDATE jobs SET done = ?, state = ?, in_flight = 0, attempts = 0,
       error = CASE WHEN failed > 0 THEN error ELSE NULL END, updated_at = ?
     WHERE id = ? AND state = 'cloud'`,
    done,
    finished ? 'done' : 'cloud',
    now,
    job.id
  )
  kvDel(sql, `rl:${job.id}`)

  await enforceRetention(deps)

  // 7) 안전망: 첫 성공 장 바로 뒤 Anlas 잔액이 줄었는지 확인한다
  if (current.done === 0) await verifyAfterFirstImage(deps, job.id, token, epoch)
  const after = getJobRow(sql, job.id)
  if (after && (after.state === 'done' || after.state === 'failed' || after.state === 'cancelled'))
    clearJobKv(sql, job.id)
  return next(deps)
}

// ── 요청 준비 ───────────────────────────────────────────────────────

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * 폰에서 고친 메인 프롬프트를 완성 요청 위에 얹는다 (PC 의 cloud-bridge applyMainPatch 와 같은 규칙).
 * 얹는 패치 = PC 가 아직 반영(ack)하지 않은 편집 + ack 했지만 이 완성 요청이 ack 뒤로 아직 새로 올라오지 않은 편집 (activeMainPatch).
 * - 메인 작업: 요청의 prompt · promptParts · negativePrompt 에 바로 (후타 재조립 계획이 실린 요청이면 폰에서 고친 글에도 같은 치환을 다시 적용한다)
 * - 씬 작업: 예약 당시 기본 부분(sceneBasePrompt · sceneBasePromptParts · sceneBaseNegativePrompt · sceneBaseAdditionalPrompt)에 —
 *   뒤이어 refreshScenePrompts 가 씬 프롬프트와 다시 합친다. 기본 부분이 없는 옛 요청은 그대로 둔다
 */
export function overlayMainPatch(
  request: GenerationRequest,
  patch: CloudMainPatch,
  target: CloudJobTarget
): GenerationRequest {
  if (target.type === 'main') {
    const patched = promptPatched(request, patch)
    // 폰에서 고친 메인 글은 원문이다 — 후타 재조립 치환이 사라지지 않게 같은 계획으로 다시 적용 (바뀐 게 없으면 요청 그대로)
    return patched.futaPlan ? rewriteRequestPrompt(patched.futaPlan, patched).request : patched
  }
  if (request.sceneBasePrompt == null) return request
  const base = promptPatched(
    {
      ...request,
      prompt: request.sceneBasePrompt,
      promptParts: request.sceneBasePromptParts,
      negativePrompt: request.sceneBaseNegativePrompt ?? ''
    },
    patch
  )
  return {
    ...request,
    sceneBasePrompt: base.prompt,
    sceneBasePromptParts: base.promptParts,
    sceneBaseNegativePrompt: base.negativePrompt,
    sceneBaseAdditionalPrompt: base.promptParts?.additional ?? request.sceneBaseAdditionalPrompt
  }
}

function promptPatched(request: GenerationRequest, patch: CloudMainPatch): GenerationRequest {
  const next: Partial<GenerationRequest> = {}
  if (typeof patch.negativePrompt === 'string') next.negativePrompt = patch.negativePrompt
  if (request.promptParts != null && patch.promptParts) next.promptParts = patch.promptParts
  else if (typeof patch.prompt === 'string') next.prompt = patch.prompt
  else if (patch.promptParts) next.prompt = mergePromptParts(patch.promptParts)
  return patchPromptRequest(request, next)
}

/** PC 가 올린 완성 요청과, 그 행의 내용이 마지막으로 바뀐 시각 (옛 행이라 시각이 없으면 0) */
function loadPrepared(
  deps: HubDeps,
  target: CloudJobTarget
): { request: GenerationRequest; updatedAt: number } {
  const row = deps.sql
    .exec<{ request: string; updated_at: number | null }>(
      `SELECT request, updated_at FROM prepared WHERE key = ?`,
      preparedKey(target)
    )
    .toArray()[0]
  if (!row) {
    throw new StopJob(
      target.type === 'scene'
        ? 'PC가 이 씬의 생성 정보를 아직 안 올렸습니다 (PC를 한 번 켜 주세요)'
        : 'PC가 메인 생성 정보를 아직 안 올렸습니다 (PC를 한 번 켜 주세요)'
    )
  }
  let raw: unknown = null
  try {
    raw = JSON.parse(row.request)
  } catch {
    raw = null
  }
  if (
    !isRecord(raw) ||
    typeof raw.prompt !== 'string' ||
    typeof raw.model !== 'string' ||
    !finiteNumber(raw.width) ||
    !finiteNumber(raw.height) ||
    !finiteNumber(raw.steps)
  ) {
    throw new StopJob('저장된 생성 정보가 올바르지 않습니다 (PC를 한 번 켜 주세요)')
  }
  const text = (value: unknown): string => (typeof value === 'string' ? value : '')
  const request = {
    ...raw,
    negativePrompt: text(raw.negativePrompt),
    characterPrompts: Array.isArray(raw.characterPrompts)
      ? raw.characterPrompts.filter(isRecord).map((c) => ({
          ...c,
          prompt: text(c.prompt),
          negativePrompt: text(c.negativePrompt)
        }))
      : []
  } as unknown as GenerationRequest
  return { request, updatedAt: finiteNumber(row.updated_at) ? row.updated_at : 0 }
}

// ── NAI 구독 확인 ───────────────────────────────────────────────────

async function fetchSubscription(deps: HubDeps, token: string): Promise<Subscription> {
  const response = await deps.fetch(`${naiHost(deps)}/user/subscription`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  })
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel()
    throw new StopJob('NAI 토큰이 거부되어 클라우드 생성을 멈췄습니다')
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`NAI 구독 정보를 확인하지 못했습니다 (HTTP ${response.status})`)
  }
  let data: unknown
  try {
    data = await response.json()
  } catch {
    data = null
  }
  if (!isRecord(data) || typeof data.tier !== 'number') {
    throw new Error('NAI 구독 정보를 읽지 못했습니다')
  }
  // 두 잔액 필드 중 하나라도 숫자로 못 읽으면 잔액을 모르는 것으로 둔다 (0 으로 치면 Anlas 가 줄어도 못 알아본다)
  const steps = isRecord(data.trainingStepsLeft) ? data.trainingStepsLeft : {}
  const fixed = steps.fixedTrainingStepsLeft
  const purchased = steps.purchasedTrainingSteps
  return {
    tier: data.tier,
    anlas: finiteNumber(fixed) && finiteNumber(purchased) ? fixed + purchased : null,
    usage: data.usage
  }
}

/** 작업의 Anlas 기준값 — 어느 토큰 세대에서 잰 값인지 함께 묶는다. 그 세대는 곧 「이 작업이 구독 확인을 마친 마지막 세대」다 */
interface AnlasBaseline {
  epoch: number
  anlas: number
}

/** kv anlas:<작업> = `<세대>:<잔액>`. 모양이 어긋난 값(세대 없는 옛 형식 포함)은 없는 것으로 → 다음 장 전에 다시 확인한다 */
function readAnlasBaseline(sql: SqlLike, jobId: string): AnlasBaseline | null {
  const saved = kvGet(sql, `anlas:${jobId}`)
  const match = saved == null ? null : /^(\d+):(-?\d+(?:\.\d+)?)$/.exec(saved)
  return match ? { epoch: Number(match[1]), anlas: Number(match[2]) } : null
}

function writeAnlasBaseline(sql: SqlLike, jobId: string, baseline: AnlasBaseline): void {
  kvSet(sql, `anlas:${jobId}`, `${baseline.epoch}:${baseline.anlas}`)
}

/**
 * Opus 등급 · V5 무료 사용량 · Anlas 잔액을 보고 하나라도 어긋나면 작업을 멈춘다.
 * epoch = 이 확인에 쓴 토큰을 읽은 순간의 세대 — 확인이 끝나면 이 값으로 기록한다
 */
function verifyFreeTier(
  deps: HubDeps,
  jobId: string,
  model: string,
  sub: Subscription,
  epoch: number
): void {
  const { sql } = deps
  if (sub.tier < 3) {
    throw new StopJob('Opus 구독이 아니어서 클라우드 생성을 멈췄습니다 (Anlas가 나갈 수 있음)')
  }
  const quota = quotaState(parseOpusUsage(sub.usage))
  kvSetJson(sql, 'nai:quota', { state: quota, checkedAt: deps.now() })
  if (isV5(model) && quota !== 'available') {
    throw new StopJob(
      quota === 'exhausted'
        ? '이번 달 무료 사용량을 모두 써서 클라우드 생성을 멈췄습니다'
        : '이번 달 무료 사용량이 확인되지 않아 클라우드 생성을 멈췄습니다'
    )
  }
  checkAnlas(deps, jobId, sub.anlas, epoch)
}

/**
 * 이 작업이 시작된 뒤(또는 마지막 확인 뒤) Anlas 가 줄었으면 멈춘다. 아니면 기준값을 갱신.
 * 다른 세대(다른 토큰 = 다른 계정일 수 있음)에서 잰 기준값은 견주지 않고 새 값으로 바꾼다
 */
function checkAnlas(deps: HubDeps, jobId: string, anlas: number | null, epoch: number): void {
  if (anlas == null) throw new StopJob(ANLAS_UNKNOWN_ERROR)
  const previous = readAnlasBaseline(deps.sql, jobId)
  if (previous && previous.epoch === epoch && anlas < previous.anlas) {
    throw new StopJob('Anlas가 차감되어 중단했습니다', true)
  }
  writeAnlasBaseline(deps.sql, jobId, { epoch, anlas })
}

/**
 * 첫 성공 장 바로 뒤의 Anlas 확인. 확인이 안 되면 다음 장을 만들기 전에 다시 확인하도록 표시를 남긴다.
 * (이 표시는 이 함수만 세우고 지운다 — 토큰이 바뀌는 것은 표시가 아니라 세대 번호로 안다)
 */
async function verifyAfterFirstImage(
  deps: HubDeps,
  jobId: string,
  token: string,
  epoch: number
): Promise<void> {
  kvSet(deps.sql, `verify:${jobId}`, '1')
  try {
    const sub = await fetchSubscription(deps, token)
    checkAnlas(deps, jobId, sub.anlas, epoch)
    kvDel(deps.sql, `verify:${jobId}`)
  } catch (error) {
    if (error instanceof StopJob) stopJob(deps, jobId, error)
    // 그 밖의 실패(일시적 네트워크 오류)는 표시를 남겨 두고 다음 장 전에 다시 확인한다
  }
}

// ── 끝내기 ──────────────────────────────────────────────────────────

/** 429 — Retry-After(없으면 5초)만큼 미루고 같은 장을 다시. 6번 넘으면 그 장을 실패로 */
async function rateLimited(deps: HubDeps, job: JobRow, response: Response): Promise<StepResult> {
  const { sql } = deps
  const waitMs = parseRetryAfter(response)
  await response.body?.cancel()
  const count = Number(kvGet(sql, `rl:${job.id}`) ?? 0) + 1
  if (count > MAX_RATE_LIMIT_RETRIES) {
    failImage(
      deps,
      job,
      `속도 제한(429)이 ${MAX_RATE_LIMIT_RETRIES}번 넘게 이어져 이 장을 건너뜁니다`
    )
    return next(deps)
  }
  kvSet(sql, `rl:${job.id}`, String(count))
  // 기다렸다 다시 하는 것이므로 이 시도는 「장을 시작한 횟수」에 세지 않는다
  sql.exec(
    `UPDATE jobs SET in_flight = 0, attempts = MAX(attempts - 1, 0), updated_at = ? WHERE id = ?`,
    deps.now(),
    job.id
  )
  const delayMs = Math.max(STEP_DELAY_MS, Math.min(waitMs, MAX_RETRY_MS))
  // 이 시각 전에는 어떤 경로로 알람이 와도 NAI 를 부르지 않는다 (runCloudStep 맨 앞에서 막는다)
  kvSet(sql, NOT_BEFORE_KEY, String(deps.now() + delayMs))
  return { again: true, delayMs }
}

function parseRetryAfter(response: Response): number {
  const header = response.headers.get('retry-after')
  if (header) {
    const seconds = Number(header)
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  }
  return DEFAULT_RETRY_MS
}

function isZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4
  )
}

/** 이 장만 실패로 센다. 마지막 장이면 작업을 끝낸다 (하나라도 만들었으면 done) */
function failImage(deps: HubDeps, job: JobRow, message: string): void {
  const failed = job.failed + 1
  const finished = job.done + failed >= job.count
  deps.sql.exec(
    `UPDATE jobs SET failed = ?, state = ?, error = ?, in_flight = 0, attempts = 0, updated_at = ?
     WHERE id = ? AND state = 'cloud'`,
    failed,
    finished ? (job.done > 0 ? 'done' : 'failed') : 'cloud',
    message,
    deps.now(),
    job.id
  )
  kvDel(deps.sql, `rl:${job.id}`)
  if (finished) clearJobKv(deps.sql, job.id)
}

/** 작업 전체를 실패로 — Anlas 감소·결제 요구면 클라우드 생성도 끈다 */
function stopJob(deps: HubDeps, jobId: string, error: StopJob): void {
  deps.sql.exec(
    `UPDATE jobs SET state = CASE WHEN state = 'cloud' THEN 'failed' ELSE state END,
       error = ?, in_flight = 0, attempts = 0, updated_at = ?
     WHERE id = ? AND state IN ('cloud', 'done')`,
    error.message,
    deps.now(),
    jobId
  )
  clearJobKv(deps.sql, jobId)
  if (error.disableCloudGen)
    setSettings(deps.sql, { ...getSettings(deps.sql), cloudGenEnabled: false })
}
