// 폰 화면 로컬 확인용 모의 서버 — 실제 워커·NAI 없이 public/ 과 가짜 /api/* 를 돌려준다.
//   node cloud/scripts/build-web.mjs && node cloud/scripts/mock-api.mjs
//   브라우저: http://127.0.0.1:8790/#pair=TESTCODE  (연결 코드 TESTCODE)
// 응답 모양은 src/shared/cloud-contract.ts 를 따른다. 그림은 작은 단색(그라데이션) PNG·zip 을 즉석에서 만든다.
// 확인용 조작: /mock/pc?online=0|1  /mock/cloud?ready=0|1&reason=…  /mock/fail  /mock/seed?n=60  /mock/reset
//   /mock/quota?state=available|exhausted|unknown|none[&ago=분]  (클라우드가 확인한 무료 사용량. none = 확인한 적 없음)
//   /mock/break?what=state|images|more|thumb&mode=500|hang|off  (그 요청만 서버 오류 / 응답 없이 멈춤 / 정상)
//   /mock/break?what=jobs&mode=lose  (다음 작업 만들기 한 번: 작업은 만들어지는데 폰은 504 만 받음 — 응답 유실 흉내)
//   /mock/stats  (요청 횟수: state·images·more)  /mock/pending?on=1  (PC가 아직 반영 안 한 캐릭터 편집이 있음)
// 미반영 표시: 클라우드가 만들고 PC가 아직 안 가져간 그림은 pcPending=true — 지우려면 ?force=1 (없으면 409).
// 작업 만들기는 requestId 가 같으면 10분 안에 앞서 만든 작업을 돌려준다. 썸네일은 image/webp·image/jpeg 를 받는다.
import { zipSync } from 'fflate'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gradientPng } from '../web/tools/png.mjs'

const PORT = Number(process.env.PORT ?? 8790)
const PAIR_CODE = 'TESTCODE'
const PROTOCOL = 1
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rand12 = () => randomBytes(9).toString('base64url').slice(0, 12)

// ── 상태 ────────────────────────────────────────────────────────────

const MIN = 60_000
let mock
let tokens
let presets
let scenes
let characters
let images
let jobs
let nextPcImageId
let pairFails
let requestIds

function reset() {
  mock = {
    pcOnline: true,
    cloudReady: true,
    cloudReason: null,
    failNext: false,
    // 클라우드가 마지막으로 확인한 무료 사용량 (CloudQuota). 확인한 적 없으면 null
    quota: { state: 'available', checkedAt: Date.now() - 3 * MIN },
    // 요청 종류별 고장 내기: null | '500' | 'hang'
    breaks: { state: null, images: null, more: null, thumb: null, jobs: null },
    // 요청 종류별 받은 횟수
    counts: { state: 0, images: 0, more: 0 },
    // PC가 아직 반영하지 않은 캐릭터 편집이 있는 시각 (없으면 null)
    charPendingSince: null
  }
  tokens = new Map()
  requestIds = new Map()
  pairFails = 0
  nextPcImageId = 200

  presets = [
    { id: 1, name: '기본 컷', kind: 'scene', sortOrder: 0 },
    { id: 2, name: '일상 연출', kind: 'scene', sortOrder: 1 },
    { id: 3, name: '배경 모음', kind: 'background', sortOrder: 2 }
  ]

  const mk = (id, presetId, kind, name, prompt, width, height) => ({
    id,
    presetId,
    kind,
    name,
    prompt,
    negativePrompt: 'lowres, bad anatomy, bad hands, text, error, worst quality',
    width,
    height,
    reserveCount: 0,
    sortOrder: id,
    sourceTags: '',
    targetTags: '',
    exportNo: null,
    pendingSince: null
  })
  scenes = [
    mk(1, 1, 'scene', '벚꽃 아래 미소', '1girl, cherry blossoms, smile, spring, petals', 832, 1216),
    mk(2, 1, 'scene', '비 오는 정류장', '1girl, bus stop, rain, umbrella, wet', 832, 1216),
    mk(3, 1, 'scene', '교실 창가', '1girl, classroom, window, sunset, sitting', 1216, 832),
    mk(4, 1, 'scene', '노을 해변 산책', '1girl, beach, sunset, walking, wind', 1216, 832),
    mk(5, 1, 'scene', '밤하늘 옥상', '1girl, rooftop, night sky, stars, looking up', 832, 1216),
    mk(6, 1, 'scene', '카페 테라스', '1girl, cafe, terrace, tea, afternoon', 1024, 1024),
    mk(
      7,
      1,
      'scene',
      '겨울 골목에 눈 내리는 저녁 풍경과 가로등 아래 기다리는 장면',
      '1girl, snow, alley, streetlight, scarf',
      832,
      1216
    ),
    mk(8, 1, 'scene', '도서관', '1girl, library, bookshelf, reading', 832, 1216),
    mk(9, 2, 'scene', '아침 식사', '1girl, breakfast, kitchen, morning light', 832, 1216),
    mk(10, 2, 'scene', '자전거 길', '1girl, bicycle, riverside, summer', 1216, 832),
    mk(11, 2, 'scene', '빨래 너는 오후', '1girl, laundry, balcony, sunny', 832, 1216),
    mk(12, 2, 'scene', '서점 구석', '1girl, bookstore, corner, smile', 832, 1216),
    mk(13, 2, 'scene', '기차 안 창밖', '1girl, train, window, scenery', 1216, 832),
    mk(
      14,
      3,
      'background',
      '교정 벚나무 길',
      'no humans, school yard, cherry trees, scenery',
      1216,
      832
    ),
    mk(15, 3, 'background', '빈 교실', 'no humans, empty classroom, sunset', 1216, 832),
    mk(16, 3, 'background', '골목 야경', 'no humans, alley, night, neon', 832, 1216),
    mk(17, 3, 'background', '바닷가 정자', 'no humans, seaside, gazebo, evening', 1216, 832)
  ]

  characters = [
    {
      id: 1,
      name: '하루',
      folderId: 1,
      enabled: true,
      prompt: 'haru, black hair',
      negativePrompt: '',
      role: 'source',
      outfitId: null,
      sortOrder: 0
    },
    {
      id: 2,
      name: '미나',
      folderId: 1,
      enabled: false,
      prompt: 'mina, brown hair',
      negativePrompt: '',
      role: 'target',
      outfitId: null,
      sortOrder: 1
    },
    {
      id: 3,
      name: '선생님',
      folderId: 2,
      enabled: false,
      prompt: 'teacher, glasses',
      negativePrompt: '',
      role: null,
      outfitId: null,
      sortOrder: 2
    },
    {
      id: 4,
      name: '고양이',
      folderId: null,
      enabled: true,
      prompt: 'cat, sitting',
      negativePrompt: '',
      role: null,
      outfitId: null,
      sortOrder: 3
    },
    {
      id: 5,
      name: '이름이 아주 길어서 줄바꿈이 필요한 캐릭터 카드 예시',
      folderId: 2,
      enabled: false,
      prompt: 'x',
      negativePrompt: '',
      role: null,
      outfitId: null,
      sortOrder: 4
    }
  ]

  images = []
  jobs = []
  const t0 = Date.now()
  let n = 0
  for (const scene of scenes.slice(0, 10)) {
    const howMany = 2 + (scene.id % 3)
    for (let k = 0; k < howMany; k++) {
      const cloud = (scene.id + k) % 3 === 0
      // 클라우드 그림은 일부만 PC가 가져간 상태 (나머지는 pcPending)
      images.push(
        makeImage(
          scene,
          cloud ? 'cloud' : 'pc',
          t0 - (n++ * 4 + 3) * MIN,
          cloud ? (k % 2 === 0 ? false : true) : true,
          cloud ? (scene.id + k) % 2 === 1 : true
        )
      )
    }
  }
  // 메인 생성분 몇 장
  for (let k = 0; k < 3; k++) {
    images.push(
      makeImage(null, k === 1 ? 'cloud' : 'pc', t0 - (n++ * 4 + 3) * MIN, k !== 1, k !== 1)
    )
  }

  jobs = [
    {
      id: 'j-old-1',
      target: { type: 'scene', sceneId: 1 },
      label: scenes[0].name,
      count: 4,
      done: 4,
      failed: 0,
      state: 'done',
      place: 'auto',
      runner: 'pc',
      error: null,
      createdAt: t0 - 50 * MIN,
      updatedAt: t0 - 48 * MIN
    },
    {
      id: 'j-old-2',
      target: { type: 'scene', sceneId: 3 },
      label: scenes[2].name,
      count: 3,
      done: 1,
      failed: 2,
      state: 'failed',
      place: 'cloud',
      runner: 'cloud',
      error: '이번 달 무료 사용량이 확인되지 않아 클라우드 생성을 멈췄습니다',
      createdAt: t0 - 90 * MIN,
      updatedAt: t0 - 88 * MIN
    },
    {
      id: 'j-old-3',
      target: { type: 'main' },
      label: '메인 생성',
      count: 8,
      done: 2,
      failed: 0,
      state: 'cancelled',
      place: 'auto',
      runner: 'pc',
      error: null,
      createdAt: t0 - 150 * MIN,
      updatedAt: t0 - 147 * MIN
    }
  ]
}

/** imported: PC가 가져갔는가 (PC 그림은 항상 true, 클라우드 생성분은 PC가 켜져 있으면 곧 true 가 된다) */
function makeImage(scene, source, createdAt, hasThumb, imported = source === 'pc') {
  const pc = source === 'pc'
  const width = scene?.width ?? 832
  const height = scene?.height ?? 1216
  return {
    id: pc ? `p${nextPcImageId++}` : `c${rand12()}`,
    source,
    sceneId: scene?.id ?? null,
    presetId: scene?.presetId ?? null,
    jobId: null,
    seed: Math.floor(Math.random() * 4294967295),
    width,
    height,
    createdAt,
    hasThumb,
    format: pc ? 'webp' : 'zip',
    imported,
    thumbBytes: null,
    thumbType: null
  }
}

reset()

// ── 그림 바이트 ─────────────────────────────────────────────────────

function hueOf(id) {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
}

const pngCache = new Map()
function pngFor(img, divisor) {
  const key = `${img.id}:${divisor}`
  let bytes = pngCache.get(key)
  if (!bytes) {
    bytes = gradientPng(
      Math.round(img.width / divisor),
      Math.round(img.height / divisor),
      hueOf(img.id)
    )
    pngCache.set(key, bytes)
  }
  return bytes
}

// ── 응답 도우미 ─────────────────────────────────────────────────────

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end(text)
}
const ok = (res, body = {}) => sendJson(res, 200, { ok: true, ...body })
const fail = (res, status, error) => sendJson(res, status, { ok: false, error })

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks)
}

async function readJson(req) {
  const buf = await readBody(req)
  if (buf.length === 0) return {}
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    return null
  }
}

function deviceOf(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')
  return m && tokens.has(m[1]) ? { token: m[1], ...tokens.get(m[1]) } : null
}

/** 그림 행에서 계약 필드(CloudImageItem)만. pcPending = 클라우드 생성분인데 PC가 아직 안 가져감 */
function imageView(img) {
  const { id, source, sceneId, presetId, jobId, seed, width, height, createdAt, hasThumb, format } =
    img
  const pcPending = source === 'cloud' && !img.imported
  return {
    id,
    source,
    sceneId,
    presetId,
    jobId,
    seed,
    width,
    height,
    createdAt,
    hasThumb,
    format,
    pcPending
  }
}

/** 목록 순서: 만든 시각 내림차순, 같으면 id 내림차순 (워커와 같은 기준) */
function newestFirst(a, b) {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

/** 다음 페이지 표식 `<만든 시각>:<id>` 풀기. 숫자만 와도 받는다 */
function parseCursor(raw) {
  if (!raw) return null
  const m = /^(\d+)(?::(.+))?$/.exec(raw)
  return m ? { createdAt: Number(m[1]), id: m[2] ?? null } : null
}

/** 표식보다 뒤(더 오래됨)에 오는 그림인가 */
function afterCursor(img, cursor) {
  if (img.createdAt !== cursor.createdAt) return img.createdAt < cursor.createdAt
  return cursor.id == null ? false : img.id < cursor.id
}

// ── 장면·작업 계산 ──────────────────────────────────────────────────

function sceneView(scene) {
  const own = images.filter((i) => i.sceneId === scene.id)
  const { pendingSince, ...lite } = scene
  return {
    ...lite,
    imageCount: own.length,
    latestImageId: own.length ? own.reduce((a, b) => (b.createdAt > a.createdAt ? b : a)).id : null,
    pendingEdit: pendingSince != null
  }
}

function libraryView() {
  return {
    presets: presets.map((p) => ({
      ...p,
      sceneCount: scenes.filter((s) => s.presetId === p.id).length
    })),
    characters,
    charFolders: [
      { id: 1, name: '주인공 일행', parentId: null },
      { id: 2, name: '학교', parentId: null }
    ],
    outfits: [{ id: 1, name: '교복' }],
    main: mainParams,
    naiInfo: {
      tier: 'Opus',
      anlas: 10234,
      opusUsage: { percent: 73, isNegative: false, timeUntilNextPercent: 4800 },
      updatedAt: Date.now() - 6 * MIN
    }
  }
}

const mainParams = {
  prompt: '1girl, solo, masterpiece, best quality, smile',
  promptParts: {
    base: 'masterpiece, best quality, 1girl, solo',
    additional: 'smile, looking at viewer, upper body',
    detail: 'detailed background, soft lighting, depth of field'
  },
  promptSplit: true,
  negativePrompt: 'lowres, bad anatomy, bad hands, text, error',
  model: 'nai-diffusion-4-5-full',
  width: 832,
  height: 1216,
  steps: 28
}

function queueSummary() {
  const running = jobs.filter((j) => j.runner === 'pc' && j.state === 'pc')
  const waiting = jobs.filter((j) => j.runner === 'pc' && j.state === 'queued')
  const left = (j) => j.count - j.done - j.failed
  return {
    running: running.length > 0,
    pending:
      waiting.reduce((n, j) => n + left(j), 0) +
      running.reduce((n, j) => n + Math.max(0, left(j) - 1), 0),
    generating: running.length > 0 ? 1 : 0,
    done: 0,
    failed: 0,
    generatingSceneId: running[0]?.target.type === 'scene' ? running[0].target.sceneId : null,
    updatedAt: Date.now()
  }
}

/** 워커의 cloudGenStatus 와 같은 규칙: 30분 안에 확인한 결과가 「남음」이 아니면 지금은 불가 */
const QUOTA_FRESH_MS = 30 * MIN
function quotaReason() {
  const q = mock.quota
  if (!q || q.state === 'available' || Date.now() - q.checkedAt >= QUOTA_FRESH_MS) return null
  return q.state === 'exhausted'
    ? '이번 달 무료 사용량을 모두 썼습니다'
    : '이번 달 무료 사용량이 확인되지 않았습니다'
}

/** 클라우드 생성이 막힌 이유 (가능하면 null) */
function cloudBlockedReason() {
  if (!mock.cloudReady)
    return mock.cloudReason ?? '이번 달 무료 사용량이 확인되지 않아 클라우드 생성을 멈췄습니다'
  return quotaReason()
}

function stateView() {
  const blocked = cloudBlockedReason()
  return {
    protocol: PROTOCOL,
    serverTime: Date.now(),
    pc: {
      online: mock.pcOnline,
      lastSeen: mock.pcOnline ? Date.now() - 2000 : Date.now() - 7 * MIN,
      queue: mock.pcOnline ? queueSummary() : null
    },
    library: libraryView(),
    cloudGen: {
      enabled: true,
      hasNaiToken: true,
      ready: blocked === null,
      reason: blocked,
      quota: mock.quota
    },
    jobs: [...jobs].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30)
  }
}

// 1.2초마다 작업을 한 걸음씩 진행한다
function tick() {
  const now = Date.now()
  for (const job of jobs) {
    if (job.state === 'queued' && mock.pcOnline) {
      job.waited = (job.waited ?? 0) + 1
      if (job.waited >= 2) {
        job.state = 'pc'
        job.updatedAt = now
      }
    } else if (job.state === 'pc' || job.state === 'cloud') {
      job.step = (job.step ?? 0) + 1
      const every = job.state === 'cloud' ? 2 : 1
      if (job.step % every !== 0) continue
      if (job.state === 'cloud' && mock.failNext) {
        mock.failNext = false
        job.failed = job.count - job.done
        job.state = 'failed'
        job.error = '이번 달 무료 사용량이 확인되지 않아 클라우드 생성을 멈췄습니다'
        job.updatedAt = now
        continue
      }
      const scene =
        job.target.type === 'scene' ? scenes.find((s) => s.id === job.target.sceneId) : null
      const img = makeImage(scene ?? null, job.runner, now, job.runner === 'pc')
      img.jobId = job.id
      img.autoImport = true // 클라우드가 만든 그림은 PC가 켜져 있으면 곧 가져간다
      images.push(img)
      job.done += 1
      job.updatedAt = now
      if (job.done + job.failed >= job.count) job.state = 'done'
    }
  }
  for (const scene of scenes) {
    if (scene.pendingSince != null && mock.pcOnline && now - scene.pendingSince > 6000)
      scene.pendingSince = null
  }
  for (const img of images) {
    if (img.autoImport && !img.imported && mock.pcOnline && now - img.createdAt > 8000)
      img.imported = true
  }
  if (mock.charPendingSince != null && mock.pcOnline && now - mock.charPendingSince > 6000)
    mock.charPendingSince = null
}
setInterval(tick, 1200).unref()

// ── /api 라우터 ─────────────────────────────────────────────────────

/** 확인용 고장 내기: 그 종류에 고장이 걸려 있으면 응답을 대신 처리하고 true (hang 은 클라이언트가 끊을 때까지 답하지 않는다) */
async function applyBreak(kind, res) {
  const mode = mock.breaks[kind]
  if (!mode) return false
  if (mode === 'hang') {
    await new Promise((resolve) => res.on('close', resolve))
    return true
  }
  fail(res, 500, '서버에 문제가 생겼습니다')
  return true
}

async function handleApi(req, res, url) {
  await sleep(60)
  const p = url.pathname
  const method = req.method

  if (method === 'POST' && p === '/api/pair') {
    const body = await readJson(req)
    if (!body) return fail(res, 400, '요청 본문이 올바르지 않습니다')
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (name.length < 1 || name.length > 40) return fail(res, 400, '기기 이름은 1~40자여야 합니다')
    if (String(body.code ?? '').toUpperCase() !== PAIR_CODE) {
      pairFails++
      return fail(
        res,
        400,
        pairFails >= 5
          ? '실패가 너무 많아 이 코드는 폐기되었습니다'
          : '연결 코드가 맞지 않거나 만료되었습니다'
      )
    }
    const token = `mock-${randomBytes(24).toString('base64url')}`
    const deviceId = `d${rand12()}`
    tokens.set(token, { deviceId, name })
    return ok(res, { token, deviceId })
  }

  const device = deviceOf(req)
  if (!device) return fail(res, 401, '연결이 해제되었습니다')

  if (method === 'GET' && p === '/api/me')
    return ok(res, { deviceId: device.deviceId, name: device.name })
  if (method === 'GET' && p === '/api/state') {
    mock.counts.state++
    if (await applyBreak('state', res)) return
    return ok(res, stateView())
  }
  if (method === 'POST' && p === '/api/logout') {
    tokens.delete(device.token)
    return ok(res)
  }

  if (method === 'GET' && p === '/api/scenes') {
    const presetId = Number(url.searchParams.get('presetId'))
    return ok(res, { items: scenes.filter((s) => s.presetId === presetId).map(sceneView) })
  }

  let m = /^\/api\/scenes\/(\d+)$/.exec(p)
  if (m && method === 'PATCH') {
    const scene = scenes.find((s) => s.id === Number(m[1]))
    if (!scene) return fail(res, 404, '씬을 찾을 수 없습니다')
    const body = await readJson(req)
    if (!body) return fail(res, 400, '요청 본문이 올바르지 않습니다')
    if (body.name !== undefined) {
      const name = String(body.name).trim()
      if (name.length < 1 || name.length > 100) return fail(res, 400, '이름은 1~100자여야 합니다')
      scene.name = name
    }
    for (const key of ['width', 'height']) {
      if (body[key] === undefined) continue
      const v = body[key]
      if (!Number.isInteger(v) || v < 64 || v > 2048 || v % 64 !== 0)
        return fail(res, 400, '해상도는 64의 배수, 64~2048이어야 합니다')
      scene[key] = v
    }
    if (body.prompt !== undefined) scene.prompt = String(body.prompt)
    if (body.negativePrompt !== undefined) scene.negativePrompt = String(body.negativePrompt)
    scene.pendingSince = Date.now()
    return ok(res, { scene: sceneView(scene) })
  }

  m = /^\/api\/characters\/(\d+)$/.exec(p)
  if (m && method === 'PATCH') {
    const c = characters.find((x) => x.id === Number(m[1]))
    if (!c) return fail(res, 404, '캐릭터를 찾을 수 없습니다')
    const body = await readJson(req)
    if (body?.enabled !== undefined) c.enabled = !!body.enabled
    if (body?.prompt !== undefined) c.prompt = String(body.prompt)
    mock.charPendingSince = Date.now() // PC가 켜지면 반영된다
    return ok(res)
  }

  if (method === 'PATCH' && p === '/api/main') {
    const body = await readJson(req)
    if (!body) return fail(res, 400, '요청 본문이 올바르지 않습니다')
    if (body.prompt !== undefined) mainParams.prompt = String(body.prompt)
    if (body.promptParts !== undefined) mainParams.promptParts = body.promptParts
    if (body.negativePrompt !== undefined) mainParams.negativePrompt = String(body.negativePrompt)
    return ok(res)
  }

  if (method === 'POST' && p === '/api/jobs') {
    const body = await readJson(req)
    const count = body?.count
    if (!Number.isInteger(count) || count < 1 || count > 20)
      return fail(res, 400, '장수는 1~20이어야 합니다')
    const place = body.place ?? 'auto'
    // 같은 requestId 가 10분 안에 다시 오면 새로 만들지 않고 앞서 만든 작업을 돌려준다
    const requestId = typeof body.requestId === 'string' ? body.requestId : null
    if (requestId) {
      const prev = requestIds.get(requestId)
      if (prev && Date.now() - prev.at < 10 * MIN) {
        console.log(`  같은 요청 id 로 다시 옴 → 앞서 만든 작업 ${prev.job.id} 를 돌려줌`)
        return ok(res, { job: prev.job })
      }
    }
    let label = '메인 생성'
    if (body.target?.type === 'scene') {
      const scene = scenes.find((s) => s.id === body.target.sceneId)
      if (!scene) return fail(res, 404, '씬을 찾을 수 없습니다')
      label = scene.name
    }
    const viaPc = place === 'pc' || (place === 'auto' && mock.pcOnline)
    const blocked = viaPc ? null : cloudBlockedReason()
    if (blocked) {
      return fail(res, 400, `지금은 클라우드에서 생성할 수 없습니다: ${blocked}`)
    }
    // CloudCreateJobResponse.notice — PC 에 맡겼는데 꺼져 있을 때 / 클라우드가 만드는데 PC가 아직 반영 안 한 캐릭터 편집이 있을 때
    const notice = viaPc
      ? !mock.pcOnline
        ? 'PC가 꺼져 있습니다. PC가 켜지면 생성합니다.'
        : undefined
      : mock.charPendingSince != null
        ? '캐릭터 편집은 PC가 켜져 반영된 뒤부터 클라우드 생성에 쓰입니다'
        : undefined
    const now = Date.now()
    const job = {
      id: `j${rand12()}`,
      target: body.target,
      label,
      count,
      done: 0,
      failed: 0,
      state: viaPc ? 'queued' : 'cloud',
      place,
      runner: viaPc ? 'pc' : 'cloud',
      error: null,
      createdAt: now,
      updatedAt: now
    }
    jobs.push(job)
    if (requestId) requestIds.set(requestId, { job, at: now })
    if (mock.breaks.jobs === 'lose') {
      // 서버에서는 만들어졌는데 폰은 성공 응답을 못 받는 상황을 한 번 흉내 낸다.
      // (소켓을 끊으면 Chrome 이 같은 요청을 알아서 다시 보내 시험이 흐려지므로 게이트웨이 시간 초과로 답한다)
      mock.breaks.jobs = null
      return fail(res, 504, '응답 시간이 초과되었습니다')
    }
    return ok(res, notice ? { job, notice } : { job })
  }

  m = /^\/api\/jobs\/([^/]+)\/cancel$/.exec(p)
  if (m && method === 'POST') {
    const job = jobs.find((j) => j.id === m[1])
    if (!job) return fail(res, 404, '작업을 찾을 수 없습니다')
    if (job.state === 'queued' || job.state === 'pc' || job.state === 'cloud') {
      job.state = 'cancelled'
      job.updatedAt = Date.now()
    }
    return ok(res, { job })
  }

  if (method === 'GET' && p === '/api/images') {
    const sceneId = url.searchParams.get('sceneId')
    const presetId = url.searchParams.get('presetId')
    const cursor = parseCursor(url.searchParams.get('before'))
    const kind = url.searchParams.get('before') ? 'more' : 'images'
    mock.counts[kind]++
    if (await applyBreak(kind, res)) return
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 40) || 40))
    const list = images
      .filter((i) => (sceneId ? i.sceneId === Number(sceneId) : true))
      .filter((i) => (presetId ? i.presetId === Number(presetId) : true))
      .filter((i) => (cursor ? afterCursor(i, cursor) : true))
      .sort(newestFirst)
    const page = list.slice(0, limit)
    const items = page.map(imageView)
    const last = page[page.length - 1]
    return ok(res, {
      items,
      next: list.length > limit ? `${last.createdAt}:${last.id}` : null
    })
  }

  m = /^\/api\/images\/([^/]+)(\/thumb)?$/.exec(p)
  if (m) {
    const img = images.find((i) => i.id === m[1])
    if (!img) return fail(res, 404, '그림을 찾을 수 없습니다')
    const isThumb = !!m[2]
    if (method === 'GET' && !isThumb) {
      if (img.source === 'cloud') {
        const zip = zipSync({ 'image_0.png': [new Uint8Array(pngFor(img, 4)), { level: 0 }] })
        res.writeHead(200, { 'content-type': 'application/zip', 'cache-control': 'no-store' })
        return res.end(Buffer.from(zip))
      }
      // 모의 서버는 WebP 를 만들 수 없어서 PC 그림도 PNG 바이트를 돌려준다
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
      return res.end(pngFor(img, 4))
    }
    if (method === 'GET' && isThumb) {
      if (!img.hasThumb) return fail(res, 404, '썸네일이 없습니다')
      res.writeHead(200, {
        'content-type': img.thumbType ?? 'image/png',
        'cache-control': 'no-store'
      })
      return res.end(img.thumbBytes ?? pngFor(img, 8))
    }
    if (method === 'PUT' && isThumb) {
      if (await applyBreak('thumb', res)) return
      if (img.source !== 'cloud' || img.hasThumb)
        return fail(res, 400, '썸네일을 올릴 수 없는 그림입니다')
      // 워커처럼 WebP 와 JPEG 둘 다 받고, 받은 형식 그대로 돌려준다 (iOS Safari 는 WebP 를 못 만들어 JPEG)
      const type = String(req.headers['content-type'] ?? '')
        .split(';')[0]
        .trim()
      if (type !== 'image/webp' && type !== 'image/jpeg')
        return fail(res, 415, '썸네일은 WebP 또는 JPEG 여야 합니다')
      const bytes = await readBody(req)
      if (bytes.length > 256 * 1024) return fail(res, 413, '썸네일이 너무 큽니다')
      img.thumbBytes = bytes
      img.thumbType = type
      img.hasThumb = true
      console.log(`  썸네일 받음 ${img.id} ${bytes.length}바이트 ${img.thumbType}`)
      return ok(res)
    }
    if (method === 'DELETE' && !isThumb) {
      // PC가 아직 안 가져간 클라우드 생성분은 이 사본이 유일하다 — ?force=1 없이는 지우지 않는다
      const pcPending = img.source === 'cloud' && !img.imported
      if (pcPending && url.searchParams.get('force') !== '1')
        return fail(res, 409, 'PC로 아직 옮기지 않은 그림입니다. 지우면 다시 받을 수 없습니다')
      images = images.filter((i) => i.id !== img.id)
      return ok(res)
    }
  }

  return fail(res, 404, '찾을 수 없습니다')
}

// ── 확인용 조작 ─────────────────────────────────────────────────────

function handleMock(res, url) {
  const q = url.searchParams
  if (url.pathname === '/mock/pc') mock.pcOnline = q.get('online') !== '0'
  else if (url.pathname === '/mock/cloud') {
    mock.cloudReady = q.get('ready') !== '0'
    mock.cloudReason = q.get('reason')
  } else if (url.pathname === '/mock/quota') {
    // state=available|exhausted|unknown|none, ago=몇 분 전에 확인했는가(기본 0)
    const state = q.get('state') ?? 'available'
    if (state === 'none') mock.quota = null
    else if (['available', 'exhausted', 'unknown'].includes(state)) {
      const ago = Math.max(0, Number(q.get('ago') ?? 0) || 0)
      mock.quota = { state, checkedAt: Date.now() - ago * MIN }
    } else return fail(res, 400, 'state 는 available|exhausted|unknown|none 중 하나')
  } else if (url.pathname === '/mock/fail') mock.failNext = true
  else if (url.pathname === '/mock/break') {
    // what=state|images|more|thumb|jobs, mode=500|hang|off (jobs 는 lose: 작업은 만들어졌는데 504 로 답함, 한 번만)
    const what = q.get('what') ?? ''
    const mode = q.get('mode') ?? 'off'
    if (!(what in mock.breaks))
      return fail(res, 400, 'what 은 state|images|more|thumb|jobs 중 하나')
    if (!['500', 'hang', 'lose', 'off'].includes(mode))
      return fail(res, 400, 'mode 는 500|hang|lose|off 중 하나')
    mock.breaks[what] = mode === 'off' ? null : mode
  } else if (url.pathname === '/mock/stats') return ok(res, { counts: mock.counts })
  else if (url.pathname === '/mock/pending')
    mock.charPendingSince = q.get('on') === '0' ? null : Date.now()
  else if (url.pathname === '/mock/seed') {
    // 그림을 n 장 더 채운다 (무한 스크롤 확인용). tie=3 이면 3장씩 같은 시각으로 만든다 (같은 시각 그림 확인용)
    const n = Math.min(300, Number(q.get('n') ?? 60) || 60)
    const tie = Math.max(1, Number(q.get('tie') ?? 1) || 1)
    const t0 = Date.now() - 200 * MIN
    for (let k = 0; k < n; k++) {
      images.push(
        makeImage(
          scenes[k % 10],
          k % 4 === 0 ? 'cloud' : 'pc',
          t0 - Math.floor(k / tie) * MIN,
          k % 8 !== 0,
          k % 8 !== 0
        )
      )
    }
  } else if (url.pathname === '/mock/reset') reset()
  else return fail(res, 404, '찾을 수 없습니다')
  return ok(res, { mock })
}

// ── 정적 파일 ───────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json'
}

async function serveStatic(res, pathname) {
  let rel = decodeURIComponent(pathname)
  if (rel === '/' || !path.extname(rel)) rel = '/index.html' // 화면 경로는 모두 SPA
  const file = path.join(publicDir, rel)
  if (!file.startsWith(publicDir)) {
    res.writeHead(403)
    return res.end()
  }
  try {
    const data = await readFile(file)
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache'
    })
    res.end(data)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('없는 파일입니다. 먼저 node cloud/scripts/build-web.mjs 를 실행하세요.')
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  res.on('finish', () => {
    if (url.pathname.startsWith('/api') || url.pathname.startsWith('/mock')) {
      console.log(`${req.method} ${url.pathname}${url.search} ${res.statusCode}`)
    }
  })
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url)
    else if (url.pathname.startsWith('/mock/')) handleMock(res, url)
    else await serveStatic(res, url.pathname)
  } catch (err) {
    console.error(err)
    if (!res.headersSent) fail(res, 500, '모의 서버 오류')
    else res.end()
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`모의 서버: http://127.0.0.1:${PORT}/#pair=${PAIR_CODE}`)
})
