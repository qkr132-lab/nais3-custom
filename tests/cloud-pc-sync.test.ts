import { EventEmitter } from 'events'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCloudClient } from '../src/main/cloud/client'
import { buildSnapshot, type SnapshotSource } from '../src/main/cloud/snapshot'
import {
  FULL_SYNC_MIN_GAP_MS,
  NAI_INFO_REFRESH_MS,
  POLL_INTERVAL_MS,
  QUOTA_FRESH_MS,
  chunkPrepared,
  createCloudSync,
  firstPngFromZip,
  jobOutcome,
  sameNaiBalance,
  type CloudSync
} from '../src/main/cloud/sync'
import type {
  CloudConfigPort,
  CloudImageDeps,
  ConnectImportResult,
  SaveGeneratedInput
} from '../src/main/cloud/types'
import {
  CLOUD_PROTOCOL,
  type CloudDevice,
  type CloudGeneratedImage,
  type CloudHashes,
  type CloudJob,
  type CloudOp,
  type CloudPcInfo,
  type CloudPreparedItem
} from '../src/shared/cloud-contract'
import type { OpusUsage } from '../src/shared/opus-usage'
import type { GenerationRequest, QueueItemLite, QueueStatusLite } from '../src/shared/types'

/**
 * 모바일 클라우드 — PC 메인 동기화 (커스텀).
 * 가짜 fetch(가짜 클라우드)·가짜 큐·메모리 설정으로 poll → 작업 → ack 흐름을 확인한다.
 * 비밀값·NAI 토큰은 가짜 값이고 실제 네트워크는 쓰지 않는다.
 */

const SECRET = 'test-pc-secret-ABCDEF123456'
const NAI_TOKEN = 'pst-test-FAKE-token-0123456789'

// ── 가짜 클라우드 ───────────────────────────────────────────────────

interface Call {
  method: string
  path: string
  headers: Record<string, string>
  json?: any // eslint-disable-line @typescript-eslint/no-explicit-any
  bytes?: Uint8Array
}

class FakeCloud {
  calls: Call[] = []
  protocol = CLOUD_PROTOCOL
  needsFullSync = false
  hashes: CloudHashes = { library: null, fragments: null, scenes: {}, prepared: {} }
  info: CloudPcInfo = {
    protocol: CLOUD_PROTOCOL,
    hasNaiToken: false,
    settings: { cloudGenEnabled: false, keepImages: 2000 },
    devices: 1,
    imagesStored: 0,
    cloudJobsActive: 0,
    quota: null
  }
  ops: CloudOp[] = []
  jobs: CloudJob[] = []
  jobStates = new Map<string, string>()
  generated: { item: CloudGeneratedImage; zip: Uint8Array }[] = []
  imported = new Map<string, number>()
  /** true 면 zip 내려받기가 헤더만 주고 본문을 읽다 시간 초과로 끊긴다 */
  brokenFiles = false
  devices: CloudDevice[] = [
    { id: 'd1', name: '내 폰', createdAt: 1, lastSeen: 2 },
    { id: 'd2', name: '태블릿', createdAt: 3, lastSeen: null }
  ]
  private failures = new Map<string, { left: number; status: number; body: unknown }>()

  failNext(
    key: string,
    times: number,
    status = 500,
    body: unknown = { ok: false, error: '실패' }
  ): void {
    this.failures.set(key, { left: times, status, body })
  }
  clearFailures(): void {
    this.failures.clear()
  }

  find(method: string, path: string): Call[] {
    return this.calls.filter((c) => c.method === method && c.path === path)
  }
  last(method: string, path: string): Call {
    const list = this.find(method, path)
    if (list.length === 0) throw new Error(`호출 없음: ${method} ${path}`)
    return list[list.length - 1]
  }
  /** 마지막 ack 에 실린 작업 ack */
  acks(): { opIds: number[]; jobs: { id: string; state: string; [key: string]: unknown }[] }[] {
    return this.find('POST', '/api/pc/ack').map((c) => c.json)
  }

  addJob(id: string, count: number, sceneId = 10): CloudJob {
    const job: CloudJob = {
      id,
      target: { type: 'scene', sceneId },
      label: `씬${sceneId}`,
      count,
      done: 0,
      failed: 0,
      state: 'queued',
      place: 'pc',
      runner: 'pc',
      error: null,
      createdAt: 1,
      updatedAt: 1
    }
    this.jobs.push(job)
    this.jobStates.set(id, 'queued')
    return job
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    })
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input))
    const method = (init.method ?? 'GET').toUpperCase()
    const path = url.pathname
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v
    }
    const call: Call = { method, path, headers }
    if (typeof init.body === 'string') call.json = JSON.parse(init.body)
    else if (init.body) call.bytes = init.body as Uint8Array
    this.calls.push(call)

    const key = `${method} ${path}`
    const failure = this.failures.get(key)
    if (failure && failure.left > 0) {
      failure.left--
      return this.json(failure.body, failure.status)
    }
    if (headers['x-nais-pc'] !== SECRET) return this.json({ ok: false, error: '인증 실패' }, 401)

    switch (key) {
      case 'POST /api/pc/poll':
        return this.json({
          ok: true,
          protocol: this.protocol,
          serverTime: 1,
          ops: this.ops,
          jobs: this.jobs.filter((j) => this.jobStates.get(j.id) === 'queued'),
          needsFullSync: this.needsFullSync
        })
      case 'POST /api/pc/ack': {
        const ids: number[] = call.json.opIds
        this.ops = this.ops.filter((o) => !ids.includes(o.id))
        for (const j of call.json.jobs as { id: string; state: string }[]) {
          this.jobStates.set(j.id, j.state === 'accepted' ? 'pc' : j.state)
        }
        return this.json({ ok: true })
      }
      case 'GET /api/pc/hashes':
        return this.json({ ok: true, ...this.hashes })
      case 'GET /api/pc/info':
        return this.json({ ok: true, ...this.info })
      case 'PUT /api/pc/library':
      case 'PUT /api/pc/scenes':
      case 'PUT /api/pc/scene-counts':
      case 'PUT /api/pc/fragments':
      case 'PUT /api/pc/prepared':
      case 'PUT /api/pc/nai-token':
      case 'DELETE /api/pc/nai-token':
        return this.json({ ok: true })
      case 'PUT /api/pc/settings':
        this.info = { ...this.info, settings: call.json }
        return this.json({ ok: true })
      case 'GET /api/pc/cloud-images':
        return this.json({
          ok: true,
          items: this.generated.filter((g) => !this.imported.has(g.item.id)).map((g) => g.item)
        })
      case 'POST /api/pc/pairing':
        return this.json({
          ok: true,
          code: 'ABCD2345',
          url: 'https://x/#pair=ABCD2345',
          expiresAt: 99,
          qrSvg: '<svg/>'
        })
      case 'GET /api/pc/devices':
        return this.json({ ok: true, items: this.devices })
    }
    let m = /^PUT \/api\/pc\/images\/(p\d+)(\/thumb)?$/.exec(key)
    if (m) return this.json({ ok: true })
    m = /^GET \/api\/pc\/cloud-images\/([^/]+)\/file$/.exec(key)
    if (m) {
      const g = this.generated.find((x) => x.item.id === decodeURIComponent(m![1]))
      if (g && this.brokenFiles) {
        const body = new ReadableStream({
          pull(controller) {
            controller.error(
              new DOMException('The operation was aborted due to timeout', 'TimeoutError')
            )
          }
        })
        return new Response(body, { status: 200 })
      }
      return g ? new Response(g.zip, { status: 200 }) : this.json({ ok: false, error: '없음' }, 404)
    }
    m = /^POST \/api\/pc\/cloud-images\/([^/]+)\/imported$/.exec(key)
    if (m) {
      this.imported.set(decodeURIComponent(m[1]), call.json.pcImageId)
      return this.json({ ok: true })
    }
    m = /^DELETE \/api\/pc\/devices\/([^/]+)$/.exec(key)
    if (m) {
      this.devices = this.devices.filter((d) => d.id !== decodeURIComponent(m![1]))
      return this.json({ ok: true, items: this.devices })
    }
    return this.json({ ok: false, error: `경로 없음 ${key}` }, 404)
  }
}

// ── 가짜 큐 ─────────────────────────────────────────────────────────

class FakeQueue extends EventEmitter {
  items: QueueItemLite[] = []
  cancelled: string[][] = []
  /** 큐 항목 id → 그 항목의 request.cloudJobId (진짜 큐는 request 안에 든다) */
  private cloudJobOf = new Map<string, string>()
  statusLite(): QueueStatusLite {
    return { items: this.items.map((i) => ({ ...i })), running: false, delayMs: 0 }
  }
  idsByCloudJob(jobId: string): string[] {
    return this.items.filter((i) => this.cloudJobOf.get(i.id) === jobId).map((i) => i.id)
  }
  cancel(ids: string[]): void {
    this.cancelled.push(ids)
    for (const i of this.items) {
      if (ids.includes(i.id) && (i.state === 'pending' || i.state === 'generating')) {
        i.state = 'cancelled'
      }
    }
    this.emit('changed', this.statusLite())
  }
  add(id: string, sceneId?: number, cloudJobId?: string): void {
    this.items.push({ id, state: 'pending', sceneId })
    if (cloudJobId) this.cloudJobOf.set(id, cloudJobId)
    this.emit('changed', this.statusLite())
  }
  finish(id: string, state: 'done' | 'failed', error?: string): void {
    const item = this.items.find((i) => i.id === id)!
    item.state = state
    item.error = error
    this.emit('changed', this.statusLite())
  }
}

// ── 메모리 설정 ─────────────────────────────────────────────────────

function memoryConfig(init: Partial<MemoryState> = {}): CloudConfigPort & { state: MemoryState } {
  const s: MemoryState = {
    url: 'https://cloud.test',
    secret: true,
    enabled: true,
    uploadImages: true,
    keepImages: 2000,
    gen: false,
    uploaded: [],
    pending: {},
    connect: 'none',
    ...init
  }
  return {
    state: s,
    url: () => s.url,
    hasSecret: () => s.secret,
    enabled: () => s.enabled,
    setEnabled: (v) => void (s.enabled = v),
    uploadImages: () => s.uploadImages,
    setUploadImages: (v) => void (s.uploadImages = v),
    keepImages: () => s.keepImages,
    setKeepImages: (n) => void (s.keepImages = n),
    cloudGenEnabled: () => s.gen,
    setCloudGenEnabled: (v) => void (s.gen = v),
    loadUploadState: () => ({
      uploaded: [...s.uploaded],
      ...(Object.keys(s.pending).length > 0 ? { pendingImported: { ...s.pending } } : {})
    }),
    saveUploadState: (state) => {
      if (s.saveFails) throw new Error('설정 저장 실패')
      s.uploaded = [...state.uploaded]
      s.pending = { ...(state.pendingImported ?? {}) }
    },
    importConnectFile: () => s.connect
  }
}
interface MemoryState {
  url: string
  secret: boolean
  enabled: boolean
  uploadImages: boolean
  keepImages: number
  gen: boolean
  uploaded: number[]
  /** 「가져왔다」 알림 대기표 (클라우드 그림 id → PC 그림 id) */
  pending: Record<string, number>
  /** true 면 올린 그림·알림 대기표를 설정에 쓰다 던진다 */
  saveFails?: boolean
  connect: ConnectImportResult
}

// ── 묶음 ────────────────────────────────────────────────────────────

const source = (): SnapshotSource => ({
  presets: [
    { id: 1, name: '기본', kind: 'scene', defaultWidth: null, defaultHeight: null, sceneCount: 1 },
    { id: 2, name: '둘째', kind: 'scene', defaultWidth: null, defaultHeight: null, sceneCount: 0 }
  ],
  scenes: [
    {
      id: 10,
      presetId: 1,
      kind: 'scene',
      name: '씬10',
      prompt: 'forest',
      negativePrompt: '',
      width: 832,
      height: 1216,
      reserveCount: 0,
      varietyPlus: false,
      sourceTags: '',
      targetTags: '',
      sourcePos: null,
      targetPos: null,
      exportNo: null,
      thumbnail: '',
      thumbnailPath: '',
      imageCount: 0
    }
  ],
  characters: [],
  charFolders: [],
  outfits: [],
  fragmentFolders: [],
  fragments: [{ id: 1, name: 'Hair', content: 'long', folderId: null }],
  mainParamsRaw: null,
  promptSplit: false,
  naiTier: 'opus'
})

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake-png-body')
])
const zipOf = (bytes: Uint8Array, name = 'image_0.png'): Promise<Uint8Array> =>
  new JSZip().file(name, bytes).generateAsync({ type: 'uint8array' })

interface Harness {
  cloud: FakeCloud
  config: ReturnType<typeof memoryConfig>
  queue: FakeQueue
  sync: CloudSync
  broadcasts: { channel: string; payload: any }[] // eslint-disable-line @typescript-eslint/no-explicit-any
  saved: SaveGeneratedInput[]
  images: { [K in keyof CloudImageDeps]: ReturnType<typeof vi.fn> }
  clock: { t: number }
  token: { value: string | null }
  recent: {
    id: number
    filePath: string
    sceneId: number | null
    seed: number | null
    kind: string
    createdAt: number
  }[]
  scenes: Map<number, { id: number; name: string; presetId: number }>
  /** 씬별 그림 수 (readSceneCounts 가 돌려주는 값) */
  counts: { value: Record<string, number> }
  /** true 로 두면 scenes:changed 알림을 보내다 던진다 (창이 이미 닫힌 경우) */
  fail: { broadcast: boolean }
  /** 앱을 껐다 켠 것처럼 같은 설정·클라우드·큐로 새 동기화를 만든다 (이전 것은 멈춘다) */
  restart: () => CloudSync
  channels: (channel: string) => any[] // eslint-disable-line @typescript-eslint/no-explicit-any
}

function harness(
  configInit: Partial<MemoryState> = {},
  opts: { withoutCounts?: boolean } = {}
): Harness {
  const cloud = new FakeCloud()
  const config = memoryConfig(configInit)
  const queue = new FakeQueue()
  const broadcasts: Harness['broadcasts'] = []
  const saved: SaveGeneratedInput[] = []
  const clock = { t: 1_000_000 }
  const token = { value: NAI_TOKEN as string | null }
  const recent: Harness['recent'] = []
  const scenes: Harness['scenes'] = new Map([[10, { id: 10, name: '씬10', presetId: 1 }]])
  const counts = { value: { '10': 0 } as Record<string, number> }
  const fail = { broadcast: false }
  let nextPcId = 100
  const images = {
    readForUpload: vi.fn(async () => ({
      webp: new Uint8Array([1, 2, 3]),
      thumb: new Uint8Array([4, 5]),
      width: 640,
      height: 960
    })),
    listRecent: vi.fn((limit: number) => recent.slice(0, limit)),
    presetIdOfScene: vi.fn((id: number) => scenes.get(id)?.presetId ?? null),
    findScene: vi.fn((id: number) => scenes.get(id) ?? null),
    presetName: vi.fn((id: number) => (id === 1 ? '기본' : null)),
    saveGenerated: vi.fn(async (input: SaveGeneratedInput) => {
      saved.push(input)
      return { id: nextPcId++, filePath: `/pics/${input.seed}.png` }
    })
  }
  const client = createCloudClient({
    fetch: cloud.fetch as typeof fetch,
    url: () => config.url(),
    secret: () => (config.state.secret ? SECRET : null)
  })
  const make = (): CloudSync =>
    createCloudSync({
      client,
      config,
      queue,
      broadcast: ((channel: string, payload: unknown) => {
        if (fail.broadcast && channel === 'scenes:changed') throw new Error('창이 이미 닫혔습니다')
        broadcasts.push({ channel, payload })
      }) as never,
      readSource: source,
      ...(opts.withoutCounts ? {} : { readSceneCounts: () => ({ ...counts.value }) }),
      images,
      getNaiToken: () => token.value,
      appVersion: '1.0.0-test',
      now: () => clock.t,
      sleep: async () => {}
    })
  const harnessValue: Harness = {
    cloud,
    config,
    queue,
    sync: make(),
    broadcasts,
    saved,
    images,
    clock,
    token,
    recent,
    scenes,
    counts,
    fail,
    restart: () => {
      harnessValue.sync.stop()
      harnessValue.sync = make()
      return harnessValue.sync
    },
    channels: (channel) => broadcasts.filter((b) => b.channel === channel).map((b) => b.payload)
  }
  return harnessValue
}

let h: Harness
beforeEach(() => {
  h = harness()
})
afterEach(() => {
  h.sync.stop()
  vi.useRealTimers()
})

/** 이 안의 글자 어디에도 비밀이 없어야 한다 */
const expectNoSecrets = (value: unknown): void => {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
  expect(text).not.toContain(SECRET)
  expect(text).not.toContain(NAI_TOKEN)
  expect(text).not.toMatch(/pst-/)
}

// ── 순수 도우미 ─────────────────────────────────────────────────────

describe('chunkPrepared · jobOutcome · firstPngFromZip', () => {
  const item = (key: string, pad = 0): CloudPreparedItem => ({
    key,
    hash: 'h',
    request: { prompt: 'x'.repeat(pad) } as unknown as GenerationRequest
  })

  it('개수 200개 단위로 나눈다', () => {
    const items = Array.from({ length: 450 }, (_, i) => item(`scene:${i}`))
    expect(chunkPrepared(items).map((c) => c.length)).toEqual([200, 200, 50])
    expect(chunkPrepared([])).toEqual([])
  })

  it('크기 한도도 지킨다 (한 개가 한도보다 커도 혼자 한 묶음)', () => {
    const items = [item('a', 400), item('b', 400), item('c', 400), item('big', 5000)]
    const chunks = chunkPrepared(items, 200, 1000)
    expect(chunks.map((c) => c.map((i) => i.key))).toEqual([['a', 'b'], ['c'], ['big']])
  })

  const status = (...items: QueueItemLite[]): QueueStatusLite => ({
    items,
    running: true,
    delayMs: 0
  })
  const scrub = (t: string): string => t.replace(NAI_TOKEN, '***')

  it('하나라도 진행 중이면 아직', () => {
    expect(
      jobOutcome(
        'j',
        ['a', 'b'],
        status({ id: 'a', state: 'done' }, { id: 'b', state: 'generating' }),
        scrub
      )
    ).toBeNull()
    expect(jobOutcome('j', ['a'], status({ id: 'a', state: 'pending' }), scrub)).toBeNull()
  })

  it('하나라도 만들었으면 done(실패·취소는 실패 장수), 하나도 못 만들었으면 failed', () => {
    expect(
      jobOutcome(
        'j',
        ['a', 'b', 'c'],
        status(
          { id: 'a', state: 'done' },
          { id: 'b', state: 'failed', error: 'x' },
          { id: 'c', state: 'cancelled' }
        ),
        scrub
      )
    ).toEqual({ id: 'j', state: 'done', done: 1, failed: 2 })
    expect(
      jobOutcome(
        'j',
        ['a', 'b'],
        status(
          { id: 'a', state: 'failed', error: `NAI 오류 ${NAI_TOKEN}` },
          { id: 'b', state: 'cancelled' }
        ),
        scrub
      )
    ).toEqual({ id: 'j', state: 'failed', done: 0, failed: 2, error: 'NAI 오류 ***' })
    expect(jobOutcome('j', ['a'], status({ id: 'a', state: 'cancelled' }), scrub)).toMatchObject({
      state: 'failed',
      error: '취소됨'
    })
  })

  it('큐에서 사라진 항목은 실패로 센다', () => {
    expect(jobOutcome('j', ['gone'], status(), scrub)).toMatchObject({ state: 'failed', failed: 1 })
  })

  it('zip 의 첫 파일이 PNG 가 아니면 거부한다', async () => {
    expect((await firstPngFromZip(await zipOf(PNG))).equals(PNG)).toBe(true)
    await expect(firstPngFromZip(await zipOf(Buffer.from('not png')))).rejects.toThrow('형식')
    await expect(
      firstPngFromZip(await new JSZip().generateAsync({ type: 'uint8array' }))
    ).rejects.toThrow('없습니다')
  })
})

// ── poll ────────────────────────────────────────────────────────────

describe('poll', () => {
  it('비밀값 헤더·판·큐 요약을 싣고, 렌더러가 준비되기 전엔 acceptsJobs=false', async () => {
    h.queue.items.push({ id: 'q', state: 'generating', sceneId: 10 })
    await h.sync.pollOnce()
    const first = h.cloud.last('POST', '/api/pc/poll')
    expect(first.headers['x-nais-pc']).toBe(SECRET)
    expect(first.json).toMatchObject({
      protocol: CLOUD_PROTOCOL,
      appVersion: '1.0.0-test',
      acceptsJobs: false,
      activeJobIds: [],
      queue: { generating: 1, pending: 0, generatingSceneId: 10, updatedAt: h.clock.t }
    })
    h.sync.rendererReady()
    await h.sync.pollOnce()
    expect(h.cloud.last('POST', '/api/pc/poll').json.acceptsJobs).toBe(true)
  })

  it('동기화가 꺼져 있거나 비밀값이 없으면 아무것도 보내지 않는다', async () => {
    h.config.state.enabled = false
    await h.sync.pollOnce()
    h.config.state.enabled = true
    h.config.state.secret = false
    await h.sync.pollOnce()
    expect(h.cloud.calls).toHaveLength(0)
    expect(h.sync.status()).toMatchObject({ configured: false, connected: false })
  })

  it('연결 실패는 던지지 않고 상태에 한국어로 남긴다 (비밀값은 안 섞인다)', async () => {
    h.cloud.failNext('POST /api/pc/poll', 1, 401, { ok: false, error: `인증 실패 ${SECRET}` })
    await expect(h.sync.pollOnce()).resolves.toBeUndefined()
    const status = h.sync.status()
    expect(status.connected).toBe(false)
    expect(status.error).toBe('클라우드 연결 실패 (401) — 인증 실패 ***')
    expectNoSecrets(status)
    await h.sync.pollOnce()
    expect(h.sync.status()).toMatchObject({ connected: true, error: null })
  })

  it('서버에 닿지 못해도 던지지 않는다', async () => {
    const down = createCloudClient({
      fetch: (async () => {
        throw new TypeError(`fetch failed ${SECRET}`)
      }) as unknown as typeof fetch,
      url: () => 'https://cloud.test',
      secret: () => SECRET
    })
    await expect(down.request('/api/pc/info')).rejects.toThrow('클라우드에 연결하지 못했습니다')
    await expect(down.request('/api/pc/info')).rejects.not.toThrow(SECRET)
  })

  it('상태 broadcast 는 바뀔 때만', async () => {
    await h.sync.pollOnce()
    const n = h.channels('cloud:status').length
    expect(n).toBeGreaterThan(0)
    await h.sync.pollOnce()
    await h.sync.pollOnce()
    expect(h.channels('cloud:status')).toHaveLength(n)
    h.cloud.failNext('POST /api/pc/poll', 1, 500)
    await h.sync.pollOnce()
    expect(h.channels('cloud:status').length).toBe(n + 1)
  })

  it('판이 다르면 작업을 넘기지 않고 올리지도 않는다', async () => {
    h.cloud.protocol = 99
    h.cloud.addJob('j1', 1)
    h.sync.rendererReady()
    await h.sync.pollOnce()
    expect(h.sync.status().protocolMismatch).toBe(true)
    expect(h.channels('cloud:work')).toHaveLength(0)
    h.sync.onImageSaved({ id: 1, filePath: '/a.png', seed: 1, kind: 't2i', width: 1, height: 1 })
    expect(h.sync.status().pendingUploads).toBe(0)
    expect(await h.sync.syncOnce()).toBe(false)
    expect(h.cloud.find('PUT', '/api/pc/library')).toHaveLength(0)
  })
})

// ── 폰 작업 ─────────────────────────────────────────────────────────

describe('폰 작업 — poll → cloud:work → workDone → 큐 완료 → done ack', () => {
  it('같은 작업을 두 번 넘기지 않고, 큐 항목이 전부 끝나면 개수와 함께 done ack', async () => {
    h.cloud.addJob('j1', 2)
    h.sync.rendererReady()
    await h.sync.pollOnce()
    const work = h.channels('cloud:work')
    expect(work).toHaveLength(1)
    expect(work[0].jobs.map((j: CloudJob) => j.id)).toEqual(['j1'])
    await h.sync.pollOnce()
    expect(h.channels('cloud:work')).toHaveLength(1)

    h.queue.add('q1', 10)
    h.queue.add('q2', 10)
    await h.sync.workDone({ opIds: [], jobs: [{ id: 'j1', queueIds: ['q1', 'q2'] }] })
    expect(h.cloud.acks().at(-1)).toEqual({ opIds: [], jobs: [{ id: 'j1', state: 'accepted' }] })
    expect(h.cloud.jobStates.get('j1')).toBe('pc')

    h.queue.finish('q1', 'done')
    await new Promise((r) => setTimeout(r, 0))
    expect(h.cloud.acks()).toHaveLength(1) // q2 가 아직 — 중간 ack 없음
    h.queue.finish('q2', 'done')
    await vi.waitFor(() => expect(h.cloud.acks()).toHaveLength(2))
    expect(h.cloud.acks()[1]).toEqual({
      opIds: [],
      jobs: [{ id: 'j1', state: 'done', done: 2, failed: 0 }]
    })
    expect(h.cloud.jobStates.get('j1')).toBe('done')
  })

  it('일부만 실패해도 done(실패 장수 포함), 전부 실패면 failed + 오류 문구(토큰은 가림)', async () => {
    h.cloud.addJob('j1', 2)
    h.cloud.addJob('j2', 1)
    h.sync.rendererReady()
    await h.sync.pollOnce()
    h.queue.add('a')
    h.queue.add('b')
    h.queue.add('c')
    await h.sync.workDone({
      opIds: [],
      jobs: [
        { id: 'j1', queueIds: ['a', 'b'] },
        { id: 'j2', queueIds: ['c'] }
      ]
    })
    h.queue.finish('a', 'done')
    h.queue.finish('b', 'failed', 'x')
    h.queue.finish('c', 'failed', `HTTP 401 ${NAI_TOKEN}`)
    await vi.waitFor(() => expect(h.cloud.jobStates.get('j2')).toBe('failed'))
    const finals = h.cloud
      .acks()
      .flatMap((a) => a.jobs)
      .filter((j) => j.state !== 'accepted')
    expect(finals).toContainEqual({ id: 'j1', state: 'done', done: 1, failed: 1 })
    const j2 = finals.find((j) => j.id === 'j2')
    expect(j2).toMatchObject({ state: 'failed', done: 0, failed: 1 })
    expectNoSecrets(j2)
    expect(j2.error).toContain('HTTP 401')
  })

  it('렌더러가 error 를 주면 큐를 건드리지 않고 failed ack', async () => {
    h.cloud.addJob('j1', 3)
    h.sync.rendererReady()
    await h.sync.pollOnce()
    await h.sync.workDone({
      opIds: [],
      jobs: [{ id: 'j1', queueIds: [], error: '씬이 PC에 없음' }]
    })
    expect(h.cloud.acks().at(-1)?.jobs).toEqual([
      { id: 'j1', state: 'failed', done: 0, failed: 3, error: '씬이 PC에 없음' }
    ])
    expect(h.queue.cancelled).toHaveLength(0)
    await h.sync.pollOnce()
    expect(h.channels('cloud:work')).toHaveLength(1)
  })

  it('큐 항목이 하나도 안 들어갔으면 failed', async () => {
    h.cloud.addJob('j1', 1)
    h.sync.rendererReady()
    await h.sync.pollOnce()
    await h.sync.workDone({ opIds: [], jobs: [{ id: 'j1', queueIds: [] }] })
    expect(h.cloud.jobStates.get('j1')).toBe('failed')
  })

  it('넘겨 받자마자 이미 끝나 있으면 바로 done ack', async () => {
    h.cloud.addJob('j1', 1)
    h.sync.rendererReady()
    await h.sync.pollOnce()
    h.queue.items.push({ id: 'q1', state: 'done' })
    await h.sync.workDone({ opIds: [], jobs: [{ id: 'j1', queueIds: ['q1'] }] })
    await vi.waitFor(() => expect(h.cloud.jobStates.get('j1')).toBe('done'))
  })

  it('렌더러가 준비되기 전에는 아무것도 넘기지 않고, 준비되면 넘긴다', async () => {
    h.cloud.addJob('j1', 1)
    h.cloud.ops.push({ id: 1, at: 1, type: 'main:update', patch: { prompt: 'p' } })
    await h.sync.pollOnce()
    expect(h.channels('cloud:work')).toHaveLength(0)
    h.sync.rendererReady()
    await h.sync.pollOnce()
    expect(h.channels('cloud:work')).toHaveLength(1)
  })
})

describe('편집 ops', () => {
  const ops: CloudOp[] = [
    { id: 7, at: 1, type: 'scene:update', sceneId: 10, patch: { name: '새 이름' } },
    { id: 4, at: 1, type: 'char:update', charId: 5, patch: { enabled: true } }
  ]

  it('id 순으로 한 번만 넘기고, workDone 의 opIds 를 ack 한다', async () => {
    h.cloud.ops = [...ops]
    h.sync.rendererReady()
    await h.sync.pollOnce()
    expect(h.channels('cloud:work')[0].ops.map((o: CloudOp) => o.id)).toEqual([4, 7])
    await h.sync.pollOnce()
    expect(h.channels('cloud:work')).toHaveLength(1)
    await h.sync.workDone({ opIds: [4, 7], jobs: [] })
    expect(h.cloud.acks().at(-1)).toEqual({ opIds: [4, 7], jobs: [] })
    expect(h.cloud.ops).toHaveLength(0)
  })

  it('렌더러가 다시 떴다고 알리면 답을 못 받은 ops 를 처음부터 다시 넘긴다', async () => {
    h.cloud.ops = [...ops]
    h.sync.rendererReady()
    await h.sync.pollOnce()
    h.sync.rendererReady() // 새로고침
    await h.sync.pollOnce()
    expect(h.channels('cloud:work')).toHaveLength(2)
  })

  it('ack 가 실패하면 쌓아 뒀다가 다음 poll 에서 다시 보낸다', async () => {
    h.cloud.ops = [...ops]
    h.sync.rendererReady()
    await h.sync.pollOnce()
    h.cloud.failNext('POST /api/pc/ack', 1)
    await h.sync.workDone({ opIds: [4, 7], jobs: [] })
    expect(h.cloud.ops).toHaveLength(2)
    await h.sync.pollOnce()
    expect(h.cloud.ops).toHaveLength(0)
    expect(h.channels('cloud:work')).toHaveLength(1) // 다시 넘기지는 않는다
  })
})

describe('반영 못 한 편집 (failedOpIds) → 다음 라이브러리 업로드 강제', () => {
  const sameHashes = (): CloudHashes => {
    const snap = buildSnapshot(source())
    return {
      library: snap.libraryHash,
      fragments: snap.fragments.hash,
      scenes: Object.fromEntries(snap.scenes.map((b) => [String(b.presetId), b.hash])),
      prepared: {}
    }
  }
  const libraryPuts = (): number => h.cloud.find('PUT', '/api/pc/library').length

  it('해시가 같아도 라이브러리를 한 번 올리고, 그 뒤에는 해시 비교로 돌아간다', async () => {
    h.cloud.hashes = sameHashes()
    await h.sync.syncOnce()
    expect(libraryPuts()).toBe(0)

    await h.sync.workDone({ opIds: [4], failedOpIds: [4], jobs: [] })
    expect(h.cloud.acks().at(-1)).toMatchObject({ opIds: [4] }) // 실패한 편집도 ack 는 한다
    await h.sync.syncOnce()
    expect(libraryPuts()).toBe(1)
    expect(h.cloud.last('PUT', '/api/pc/library').json.hash).toBe(
      buildSnapshot(source()).libraryHash
    )

    await h.sync.syncOnce() // 한 번만 강제한다
    expect(libraryPuts()).toBe(1)
  })

  it('실패가 없으면(failedOpIds 가 없거나 비어 있으면) 해시가 같을 때 올리지 않는다', async () => {
    h.cloud.hashes = sameHashes()
    await h.sync.workDone({ opIds: [4, 7], jobs: [] })
    await h.sync.workDone({ opIds: [8], failedOpIds: [], jobs: [] })
    await h.sync.syncOnce()
    expect(libraryPuts()).toBe(0)
  })

  it('편집이 반영된 뒤 3초 안에 알아서 올린다 (opIds 가 비어 있어도)', async () => {
    vi.useFakeTimers()
    h.cloud.hashes = sameHashes()
    await h.sync.workDone({ opIds: [], failedOpIds: [4], jobs: [] })
    await vi.advanceTimersByTimeAsync(2_900)
    expect(libraryPuts()).toBe(0)
    await vi.advanceTimersByTimeAsync(200)
    expect(libraryPuts()).toBe(1)
  })

  it('올리지 못하면 강제를 풀지 않고 다음 동기화에서 다시 올린다', async () => {
    h.cloud.hashes = sameHashes()
    await h.sync.workDone({ opIds: [4], failedOpIds: [4], jobs: [] })
    h.cloud.failNext('PUT /api/pc/library', 1)
    expect(await h.sync.syncOnce()).toBe(false)
    h.cloud.clearFailures()
    expect(await h.sync.syncOnce()).toBe(true)
    expect(libraryPuts()).toBe(2)
    await h.sync.syncOnce()
    expect(libraryPuts()).toBe(2)
  })

  it('동기화가 꺼져 있는 동안 받은 실패는 켜진 뒤 첫 올리기에서 반영한다', async () => {
    h.cloud.hashes = sameHashes()
    h.config.state.enabled = false
    await h.sync.workDone({ opIds: [4], failedOpIds: [4], jobs: [] })
    expect(await h.sync.syncOnce()).toBe(false)
    expect(libraryPuts()).toBe(0)
    h.config.state.enabled = true
    await h.sync.syncOnce()
    expect(libraryPuts()).toBe(1)
  })

  // ── 실패 줄의 ack 가 워커에 닿은 뒤에만 되돌린다 ──

  /** 호출 기록을 「메서드 경로」 글자로 */
  const trail = (): string[] => h.cloud.calls.map((c) => `${c.method} ${c.path}`)

  it('실패한 줄의 ack 가 아직 안 닿았으면 강제 업로드를 미루고 플래그를 지켰다가, ack 가 닿은 뒤 올린다', async () => {
    h.cloud.hashes = sameHashes()
    h.cloud.failNext('POST /api/pc/ack', 2)
    await h.sync.workDone({ opIds: [4], failedOpIds: [4], jobs: [] }) // ack 첫 번째 유실

    // 동기화가 대기 중인 ack 를 먼저 보내 보지만 이것도 유실 — 올리면 워커가 미반영 줄을 다시 덧입히므로 이번엔 올리지 않는다
    expect(await h.sync.syncOnce()).toBe(true)
    expect(h.cloud.find('POST', '/api/pc/ack')).toHaveLength(2)
    expect(libraryPuts()).toBe(0)

    // ack 가 닿으면 곧바로 같은 동기화에서 올린다
    expect(await h.sync.syncOnce()).toBe(true)
    expect(h.cloud.acks().at(-1)).toMatchObject({ opIds: [4] })
    expect(libraryPuts()).toBe(1)
    const order = trail()
    expect(order.lastIndexOf('POST /api/pc/ack')).toBeLessThan(
      order.lastIndexOf('PUT /api/pc/library')
    )

    await h.sync.syncOnce() // 한 번만 강제한다
    expect(libraryPuts()).toBe(1)
  })

  it('해시가 달라 일반 업로드가 나가도 ack 전이면 강제 플래그는 남겨, 닿은 뒤 한 번 더 올린다', async () => {
    // 클라우드의 해시가 PC 와 다르다 → 일반 업로드는 나간다. 그러나 이 업로드는 미반영 줄을 덧입힌 값이라 되돌림이 아니다
    h.cloud.failNext('POST /api/pc/ack', 2)
    await h.sync.workDone({ opIds: [4], failedOpIds: [4], jobs: [] })
    await h.sync.syncOnce()
    expect(libraryPuts()).toBe(1)

    h.cloud.hashes = sameHashes() // 방금 올린 것으로 클라우드 해시가 맞았다
    await h.sync.syncOnce()
    expect(libraryPuts()).toBe(2) // 이번엔 ack 가 닿았으니 강제로 한 번 더
    await h.sync.syncOnce()
    expect(libraryPuts()).toBe(2)
  })

  describe('실패한 scene:update', () => {
    const sceneOp = (id: number, sceneId: number): CloudOp => ({
      id,
      at: 1,
      type: 'scene:update',
      sceneId,
      patch: { name: '새 이름' }
    })
    const scenePuts = (): { presetId: number }[] =>
      h.cloud.find('PUT', '/api/pc/scenes').map((c) => c.json)
    /** 메인이 폰 편집을 렌더러에 넘긴 상태 */
    const handOver = async (...ops: CloudOp[]): Promise<void> => {
      h.cloud.ops.push(...ops)
      h.sync.rendererReady()
      await h.sync.pollOnce()
      expect(h.channels('cloud:work').flatMap((w) => w.ops)).toHaveLength(ops.length)
    }

    it('그 씬이 든 프리셋을 해시와 무관하게 한 번 다시 올리고, 그 뒤에는 해시 비교로 돌아간다', async () => {
      h.cloud.hashes = sameHashes()
      await handOver(sceneOp(7, 10))
      await h.sync.workDone({ opIds: [7], failedOpIds: [7], jobs: [] })

      expect(await h.sync.syncOnce()).toBe(true)
      expect(scenePuts().map((p) => p.presetId)).toEqual([1]) // 씬이 든 프리셋 1 만 (2 는 아님)
      expect(h.cloud.last('PUT', '/api/pc/scenes').json.scenes[0]).toMatchObject({
        id: 10,
        name: '씬10'
      })

      await h.sync.syncOnce()
      expect(scenePuts()).toHaveLength(1)
    })

    it('ack 가 닿기 전에는 올리지 않고, 닿은 뒤에 올린다 (라이브러리와 같은 규칙)', async () => {
      h.cloud.hashes = sameHashes()
      await handOver(sceneOp(7, 10))
      h.cloud.failNext('POST /api/pc/ack', 2)
      await h.sync.workDone({ opIds: [7], failedOpIds: [7], jobs: [] })

      expect(await h.sync.syncOnce()).toBe(true)
      expect(scenePuts()).toHaveLength(0)
      expect(libraryPuts()).toBe(0)

      expect(await h.sync.syncOnce()).toBe(true)
      expect(scenePuts().map((p) => p.presetId)).toEqual([1])
      expect(libraryPuts()).toBe(1)
      const order = trail()
      expect(order.lastIndexOf('POST /api/pc/ack')).toBeLessThan(
        order.lastIndexOf('PUT /api/pc/scenes')
      )
    })

    it('프리셋 올리기가 실패하면 그 씬은 되돌릴 목록에 남고, 이미 올린 라이브러리는 다시 올리지 않는다', async () => {
      h.cloud.hashes = sameHashes()
      await handOver(sceneOp(7, 10))
      await h.sync.workDone({ opIds: [7], failedOpIds: [7], jobs: [] })

      h.cloud.failNext('PUT /api/pc/scenes', 1)
      expect(await h.sync.syncOnce()).toBe(false)
      expect(libraryPuts()).toBe(1)
      h.cloud.clearFailures()
      expect(await h.sync.syncOnce()).toBe(true)
      expect(scenePuts().map((p) => p.presetId)).toEqual([1, 1]) // 실패한 시도 + 성공
      expect(libraryPuts()).toBe(1)

      await h.sync.syncOnce()
      expect(scenePuts()).toHaveLength(2)
    })

    it('반영된 줄이나 넘긴 적 없는 줄 번호의 실패로는 씬을 다시 올리지 않는다 (라이브러리만)', async () => {
      h.cloud.hashes = sameHashes()
      await handOver(sceneOp(7, 10))
      await h.sync.workDone({ opIds: [7], jobs: [] }) // 7번은 반영됨 — 기록을 지운다
      await h.sync.workDone({ opIds: [7, 9], failedOpIds: [7, 9], jobs: [] }) // 이제 7번은 기억에 없다
      await h.sync.syncOnce()
      expect(scenePuts()).toHaveLength(0)
      expect(libraryPuts()).toBe(1)
    })

    it('PC 에서 지워진 씬(스냅샷에 없음)이면 올릴 프리셋이 없다', async () => {
      h.cloud.hashes = sameHashes()
      await handOver(sceneOp(7, 99))
      await h.sync.workDone({ opIds: [7], failedOpIds: [7], jobs: [] })
      expect(await h.sync.syncOnce()).toBe(true)
      expect(scenePuts()).toHaveLength(0)
      // 지워진 씬 id 는 되돌릴 목록에 남아 맴돌지 않는다
      await h.sync.syncOnce()
      expect(scenePuts()).toHaveLength(0)
    })

    it('렌더러가 새로고침돼 같은 줄을 다시 받아도 그 줄이 실패하면 씬을 되돌린다', async () => {
      h.cloud.hashes = sameHashes()
      await handOver(sceneOp(7, 10)) // 결과를 못 받은 채 렌더러가 사라졌다
      h.sync.rendererReady() // 새 렌더러
      await h.sync.pollOnce()
      expect(h.channels('cloud:work').flatMap((w) => w.ops)).toHaveLength(2) // 다시 넘겼다
      await h.sync.workDone({ opIds: [7], failedOpIds: [7], jobs: [] })
      await h.sync.syncOnce()
      expect(scenePuts().map((p) => p.presetId)).toEqual([1])
    })

    it('char·main 줄이 실패하면 씬은 건드리지 않는다', async () => {
      h.cloud.hashes = sameHashes()
      await handOver({ id: 4, at: 1, type: 'char:update', charId: 5, patch: { enabled: true } })
      await h.sync.workDone({ opIds: [4], failedOpIds: [4], jobs: [] })
      await h.sync.syncOnce()
      expect(scenePuts()).toHaveLength(0)
      expect(libraryPuts()).toBe(1)
    })
  })
})

describe('job:cancel', () => {
  it('큐에 들어간 작업이면 그 큐 id 들을 취소하고 op 를 ack, PC 가 만든 장수·실패 장수를 끝 ack 로 알린다', async () => {
    h.cloud.addJob('j1', 2)
    h.sync.rendererReady()
    await h.sync.pollOnce()
    h.queue.add('q1', 10)
    h.queue.add('q2', 10)
    await h.sync.workDone({ opIds: [], jobs: [{ id: 'j1', queueIds: ['q1', 'q2'] }] })

    h.cloud.ops.push({ id: 9, at: 1, type: 'job:cancel', jobId: 'j1' })
    await h.sync.pollOnce()
    expect(h.queue.cancelled).toContainEqual(['q1', 'q2'])
    expect(h.cloud.ops).toHaveLength(0) // ack 됨
    await vi.waitFor(() =>
      expect(
        h.cloud
          .acks()
          .flatMap((a) => a.jobs)
          .filter((j) => j.state !== 'accepted')
      ).toHaveLength(1)
    )
    // 클라우드는 취소 상태를 그대로 두고 장수만 반영하므로 끝 ack 를 보내도 안전하다
    const finals = h.cloud
      .acks()
      .flatMap((a) => a.jobs)
      .filter((j) => j.state !== 'accepted')
    expect(finals).toEqual([{ id: 'j1', state: 'failed', done: 0, failed: 2, error: '취소됨' }])
    expect(h.channels('cloud:work').flatMap((w) => w.ops)).toHaveLength(0) // 렌더러에는 안 넘김
  })

  it('일부는 이미 만들고 나서 취소하면 만든 장수를 done 으로 알린다', async () => {
    h.cloud.addJob('j1', 3)
    h.sync.rendererReady()
    await h.sync.pollOnce()
    h.queue.add('q1', 10)
    h.queue.add('q2', 10)
    h.queue.add('q3', 10)
    await h.sync.workDone({ opIds: [], jobs: [{ id: 'j1', queueIds: ['q1', 'q2', 'q3'] }] })
    h.queue.finish('q1', 'done')
    h.cloud.ops.push({ id: 9, at: 1, type: 'job:cancel', jobId: 'j1' })
    await h.sync.pollOnce()
    await vi.waitFor(() =>
      expect(
        h.cloud
          .acks()
          .flatMap((a) => a.jobs)
          .filter((j) => j.state !== 'accepted')
      ).toEqual([{ id: 'j1', state: 'done', done: 1, failed: 2 }])
    )
  })

  it('취소 요청이 먼저 와 있던 작업이 큐에 들어오면 취소하고 그 끝 ack 가 accepted 에 덮이지 않는다', async () => {
    h.cloud.addJob('j1', 2)
    h.sync.rendererReady()
    await h.sync.pollOnce()
    h.cloud.ops.push({ id: 9, at: 1, type: 'job:cancel', jobId: 'j1' })
    await h.sync.pollOnce() // 아직 큐에 없다 — 취소만 기억해 둔다
    h.queue.add('q1', 10)
    h.queue.add('q2', 10)
    await h.sync.workDone({ opIds: [], jobs: [{ id: 'j1', queueIds: ['q1', 'q2'] }] })
    expect(h.queue.cancelled).toContainEqual(['q1', 'q2'])
    await vi.waitFor(() =>
      expect(h.cloud.acks().at(-1)?.jobs).toEqual([
        { id: 'j1', state: 'failed', done: 0, failed: 2, error: '취소됨' }
      ])
    )
  })

  it('렌더러가 아직 큐에 못 넣은 작업의 취소는 workDone 이 오는 즉시 적용한다', async () => {
    h.cloud.addJob('j1', 1)
    h.sync.rendererReady()
    await h.sync.pollOnce()
    h.cloud.ops.push({ id: 9, at: 1, type: 'job:cancel', jobId: 'j1' })
    await h.sync.pollOnce()
    expect(h.queue.cancelled).toHaveLength(0)
    h.queue.add('q1', 10)
    await h.sync.workDone({ opIds: [], jobs: [{ id: 'j1', queueIds: ['q1'] }] })
    expect(h.queue.cancelled).toContainEqual(['q1'])
  })

  it('취소된 작업은 아직 넘기지 않았어도 새로 넘기지 않는다', async () => {
    h.cloud.addJob('j1', 1)
    h.cloud.ops.push({ id: 9, at: 1, type: 'job:cancel', jobId: 'j1' })
    h.sync.rendererReady()
    await h.sync.pollOnce()
    expect(h.channels('cloud:work')).toHaveLength(0)
  })
})

// ── 해시 비교 올리기 ────────────────────────────────────────────────

describe('해시 비교 올리기', () => {
  const localHashes = (): CloudHashes => {
    const snap = buildSnapshot(source())
    return {
      library: snap.libraryHash,
      fragments: snap.fragments.hash,
      scenes: Object.fromEntries(snap.scenes.map((b) => [String(b.presetId), b.hash])),
      prepared: {}
    }
  }

  it('클라우드가 비어 있으면 라이브러리 → 프리셋별 씬 → 조각 → 씬 그림 수 순으로 전부 올린다', async () => {
    expect(await h.sync.syncOnce()).toBe(true)
    const puts = h.cloud.calls.filter((c) => c.method === 'PUT').map((c) => c.path)
    expect(puts).toEqual([
      '/api/pc/library',
      '/api/pc/scenes',
      '/api/pc/scenes',
      '/api/pc/fragments',
      '/api/pc/scene-counts'
    ])
    const lib = h.cloud.last('PUT', '/api/pc/library').json
    expect(lib.hash).toBe(buildSnapshot(source()).libraryHash)
    expect(lib.library.presets.map((p: { id: number }) => p.id)).toEqual([1, 2])
    const scenes = h.cloud.find('PUT', '/api/pc/scenes').map((c) => c.json)
    expect(scenes.map((s) => [s.presetId, s.scenes.length])).toEqual([
      [1, 1],
      [2, 0]
    ])
    expect(h.cloud.last('PUT', '/api/pc/fragments').json.byPath).toEqual({ hair: ['long'] })
    expect(h.cloud.last('PUT', '/api/pc/scene-counts').json).toEqual({ counts: { '10': 0 } })
    // 씬 본문에는 그림 수가 없다
    expect(JSON.stringify(scenes)).not.toContain('imageCount')
    expect(h.sync.status().lastSyncAt).toBe(h.clock.t)
    expectNoSecrets(h.cloud.calls.map((c) => c.json))
  })

  it('해시가 같은 것은 건너뛰고 다른 것만 올린다', async () => {
    h.cloud.hashes = localHashes()
    h.cloud.hashes.scenes['1'] = 'old'
    await h.sync.syncOnce()
    expect(
      h.cloud.calls
        .filter((c) => c.method === 'PUT' && c.path !== '/api/pc/scene-counts')
        .map((c) => [c.path, c.json.presetId])
    ).toEqual([['/api/pc/scenes', 1]])
    h.cloud.calls.length = 0
    h.cloud.hashes = localHashes()
    await h.sync.syncOnce()
    expect(h.cloud.calls.filter((c) => c.method === 'PUT')).toHaveLength(0)
  })

  it('needsFullSync 면 해시가 같아도 전부 올리고 완성 요청을 다시 만들어 달라고 알린다 (연달아 반복하지 않는다)', async () => {
    h.cloud.hashes = localHashes()
    h.cloud.needsFullSync = true
    await h.sync.pollOnce()
    expect(h.cloud.calls.filter((c) => c.method === 'PUT').map((c) => c.path)).toEqual([
      '/api/pc/library',
      '/api/pc/scenes',
      '/api/pc/scenes',
      '/api/pc/fragments',
      '/api/pc/scene-counts'
    ])
    expect(h.cloud.find('GET', '/api/pc/hashes')).toHaveLength(0) // 전체 올리기는 해시를 안 본다
    expect(h.channels('cloud:needPrepared')).toEqual([{ full: true }])

    await h.sync.pollOnce() // 간격 안 — 다시 안 한다
    expect(h.channels('cloud:needPrepared')).toHaveLength(1)
    h.clock.t += FULL_SYNC_MIN_GAP_MS
    await h.sync.pollOnce()
    expect(h.channels('cloud:needPrepared')).toHaveLength(2)
  })

  it('전체 올리기가 실패하면 needPrepared 를 보내지 않는다', async () => {
    h.cloud.needsFullSync = true
    h.cloud.failNext('PUT /api/pc/library', 1)
    await h.sync.pollOnce()
    expect(h.channels('cloud:needPrepared')).toHaveLength(0)
    expect(h.sync.status().error).toContain('(500)')
  })

  it('동시에 여러 번 불러도 순서대로 하나씩 돌고, 대기 중인 보통 동기화는 하나로 합친다', async () => {
    const results = await Promise.all([h.sync.syncOnce(), h.sync.syncOnce(), h.sync.syncOnce()])
    expect(results).toEqual([true, true, true])
    expect(h.cloud.find('GET', '/api/pc/hashes').length).toBeLessThanOrEqual(2)
  })
})

// ── 그림 올리기 ─────────────────────────────────────────────────────

describe('그림 올리기', () => {
  const saved = (id: number, sceneId?: number): void =>
    h.sync.onImageSaved({
      id,
      filePath: `/pics/${id}.png`,
      sceneId,
      seed: 77,
      kind: 'scene',
      width: 832,
      height: 1216
    })

  it('본문·메타 헤더·썸네일을 올리고 올린 id 를 기억한다', async () => {
    saved(5, 10)
    await h.sync.drainUploads()
    const put = h.cloud.last('PUT', '/api/pc/images/p5')
    expect(put.headers['content-type']).toBe('image/webp')
    expect(Array.from(put.bytes!)).toEqual([1, 2, 3])
    const meta = JSON.parse(Buffer.from(put.headers['x-nais-meta'], 'base64url').toString('utf8'))
    expect(meta).toEqual({
      pcImageId: 5,
      sceneId: 10,
      presetId: 1,
      seed: 77,
      width: 832,
      height: 1216,
      createdAt: h.clock.t,
      kind: 'scene'
    })
    expect(Array.from(h.cloud.last('PUT', '/api/pc/images/p5/thumb').bytes!)).toEqual([4, 5])
    expect(h.config.state.uploaded).toEqual([5])
    expect(h.sync.status().pendingUploads).toBe(0)
  })

  it('실패하면 3번 다시 해 보고(첫 시도 포함 4번) 그래도 안 되면 포기하며 상태에 표시한다', async () => {
    h.cloud.failNext('PUT /api/pc/images/p5', 99, 500)
    saved(5)
    await h.sync.drainUploads()
    expect(h.cloud.find('PUT', '/api/pc/images/p5')).toHaveLength(4)
    expect(h.config.state.uploaded).toEqual([])
    expect(h.sync.status().pendingUploads).toBe(0)
    // 올리지 못한 그림은 오류 문구에 섞지 않고 숫자로 알린다
    expect(h.sync.status().failedUploads).toBe(1)
    expect(h.sync.status().error).toContain('(500)')
    h.cloud.clearFailures()
    await h.sync.pollOnce()
    expect(h.sync.status().error).toBeNull()
    expect(h.sync.status().failedUploads).toBe(1)

    // 나중에 [최근 올리기]로 다시 시도하면 올라간다
    h.cloud.clearFailures()
    h.recent.push({
      id: 5,
      filePath: '/pics/5.png',
      sceneId: null,
      seed: 77,
      kind: 'scene',
      createdAt: 5
    })
    expect(h.sync.uploadRecent(10)).toEqual({ queued: 1 })
    await h.sync.drainUploads()
    expect(h.config.state.uploaded).toEqual([5])
    expect(h.sync.status().error).toBeNull()
    expect(h.sync.status().failedUploads).toBe(0)
  })

  it('두 번 실패하고 세 번째에 성공하면 올라간 것으로 센다', async () => {
    h.cloud.failNext('PUT /api/pc/images/p5', 2, 503)
    saved(5)
    await h.sync.drainUploads()
    expect(h.cloud.find('PUT', '/api/pc/images/p5')).toHaveLength(3)
    expect(h.config.state.uploaded).toEqual([5])
    expect(h.cloud.find('PUT', '/api/pc/images/p5/thumb')).toHaveLength(1)
  })

  it('요청 자체가 틀린 실패(4xx)는 다시 하지 않는다', async () => {
    h.cloud.failNext('PUT /api/pc/images/p5', 99, 413)
    saved(5)
    await h.sync.drainUploads()
    expect(h.cloud.find('PUT', '/api/pc/images/p5')).toHaveLength(1)
    h.cloud.clearFailures()
    await h.sync.pollOnce()
    expect(h.sync.status()).toMatchObject({ error: null, failedUploads: 1 })
  })

  it('파일을 못 읽으면 다시 하지 않고 실패로 센다', async () => {
    h.images.readForUpload.mockRejectedValueOnce(new Error('ENOENT'))
    saved(5)
    await h.sync.drainUploads()
    expect(h.cloud.find('PUT', '/api/pc/images/p5')).toHaveLength(0)
    expect(h.sync.status()).toMatchObject({ error: null, failedUploads: 1 })
  })

  it('그림 올리기가 꺼져 있으면 올리지 않는다', async () => {
    h.sync.setUploadImages(false)
    saved(5)
    await h.sync.drainUploads()
    expect(h.cloud.calls).toHaveLength(0)
    expect(h.sync.status().uploadImages).toBe(false)
  })

  it('이미 올린 그림은 다시 올리지 않고, 같은 그림이 대기열에 두 번 들어가지 않는다', async () => {
    h.config.state.uploaded = [3]
    h.recent.push(
      { id: 4, filePath: '/pics/4.png', sceneId: null, seed: 1, kind: 't2i', createdAt: 4 },
      { id: 3, filePath: '/pics/3.png', sceneId: null, seed: 1, kind: 't2i', createdAt: 3 }
    )
    expect(h.sync.uploadRecent(100)).toEqual({ queued: 1 })
    expect(h.sync.uploadRecent(100)).toEqual({ queued: 0 }) // 4 는 대기열/업로드 중
    await h.sync.drainUploads()
    expect(h.cloud.find('PUT', '/api/pc/images/p4')).toHaveLength(1)
    expect(h.cloud.find('PUT', '/api/pc/images/p3')).toHaveLength(0)
    expect(h.config.state.uploaded).toEqual([3, 4])
    expect(h.sync.uploadRecent(100)).toEqual({ queued: 0 })
  })

  it('동시에 2개까지만 올린다', async () => {
    let running = 0
    let peak = 0
    h.images.readForUpload.mockImplementation(async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      return { webp: new Uint8Array([1]), thumb: null, width: 1, height: 1 }
    })
    for (let i = 1; i <= 6; i++) saved(i)
    expect(h.sync.status().pendingUploads).toBe(6)
    await h.sync.drainUploads()
    expect(peak).toBe(2)
    expect(h.config.state.uploaded).toEqual([1, 2, 3, 4, 5, 6])
    expect(h.cloud.find('PUT', '/api/pc/images/p1/thumb')).toHaveLength(0) // 썸네일이 없으면 안 올림
  })
})

// ── 클라우드가 만든 그림 가져오기 ───────────────────────────────────

describe('클라우드 생성분 가져오기', () => {
  const generated = (id: string, sceneId: number | null): CloudGeneratedImage => ({
    id,
    jobId: 'j1',
    sceneId,
    presetId: sceneId == null ? null : 1,
    seed: 4242,
    sentPayload: '{"input":"p"}',
    createdAt: 1
  })

  it('zip 의 PNG 를 씬 폴더 규칙대로 저장하고, 씬 갱신 알림 + imported 를 보낸다', async () => {
    h.cloud.generated.push({ item: generated('cA', 10), zip: await zipOf(PNG) })
    await h.sync.importOnce()
    expect(h.saved).toHaveLength(1)
    expect(h.saved[0]).toMatchObject({
      sentPayload: '{"input":"p"}',
      seed: 4242,
      kind: 'scene',
      sceneId: 10,
      format: 'png',
      sceneName: '씬10',
      scenePresetName: '기본'
    })
    expect(h.saved[0].png.equals(PNG)).toBe(true)
    expect(h.channels('scenes:changed')).toEqual([{ sceneId: 10, filePath: '/pics/4242.png' }])
    expect(h.cloud.imported.get('cA')).toBe(100)
    expect(h.sync.status().importedCount).toBe(1)

    await h.sync.importOnce() // 가져간 것은 목록에서 빠진다
    expect(h.saved).toHaveLength(1)
  })

  it('씬이 PC 에서 지워졌으면 씬 없이 일반 그림으로 저장한다', async () => {
    h.scenes.clear()
    h.cloud.generated.push({ item: generated('cA', 10), zip: await zipOf(PNG) })
    await h.sync.importOnce()
    expect(h.saved[0]).toMatchObject({ kind: 't2i', format: 'png', seed: 4242 })
    expect(h.saved[0]).not.toHaveProperty('sceneId')
    expect(h.saved[0]).not.toHaveProperty('sceneName')
    expect(h.channels('scenes:changed')).toHaveLength(0)
    expect(h.cloud.imported.get('cA')).toBe(100)
  })

  it('씬이 없는 그림(메인 생성)은 t2i 로 저장한다', async () => {
    h.cloud.generated.push({ item: generated('cA', null), zip: await zipOf(PNG) })
    await h.sync.importOnce()
    expect(h.saved[0]).toMatchObject({ kind: 't2i' })
    expect(h.images.findScene).not.toHaveBeenCalled()
  })

  it('가져왔다는 알림이 실패해도 그림을 다시 저장하지 않고, 다음에 알림만 다시 보낸다', async () => {
    h.cloud.generated.push({ item: generated('cA', 10), zip: await zipOf(PNG) })
    h.cloud.failNext('POST /api/pc/cloud-images/cA/imported', 1)
    await h.sync.importOnce()
    expect(h.saved).toHaveLength(1)
    expect(h.cloud.imported.has('cA')).toBe(false)
    await h.sync.importOnce()
    expect(h.saved).toHaveLength(1)
    expect(h.cloud.imported.get('cA')).toBe(100)
  })

  it('가져온 그림은 PC 그림으로 다시 올리지 않는다', async () => {
    h.cloud.generated.push({ item: generated('cA', 10), zip: await zipOf(PNG) })
    await h.sync.importOnce()
    h.recent.push({
      id: 100,
      filePath: '/pics/4242.png',
      sceneId: 10,
      seed: 4242,
      kind: 'scene',
      createdAt: 1
    })
    expect(h.sync.uploadRecent(10)).toEqual({ queued: 0 })
    expect(h.config.state.uploaded).toContain(100)
  })

  it('PNG 가 아닌 파일이면 저장하지 않고, 세 번 실패하면 이번 실행에서는 건너뛴다', async () => {
    h.cloud.generated.push({ item: generated('bad', 10), zip: await zipOf(Buffer.from('not png')) })
    h.cloud.generated.push({ item: generated('good', 10), zip: await zipOf(PNG) })
    for (let i = 0; i < 5; i++) await h.sync.importOnce()
    expect(h.saved).toHaveLength(1)
    expect(h.cloud.imported.has('good')).toBe(true)
    expect(h.cloud.find('GET', '/api/pc/cloud-images/bad/file')).toHaveLength(3)
    expect(h.sync.status().error).toContain('가져오기 실패')
  })

  it('poll 직후에는 클라우드 생성 작업이 있을 때만 가져온다', async () => {
    h.cloud.generated.push({ item: generated('cA', 10), zip: await zipOf(PNG) })
    await h.sync.pollOnce()
    expect(h.cloud.find('GET', '/api/pc/cloud-images')).toHaveLength(0)
    h.cloud.info = { ...h.cloud.info, cloudJobsActive: 2 }
    await h.sync.refreshInfo()
    expect(h.sync.status().cloudJobsActive).toBe(2)
    await h.sync.pollOnce()
    expect(h.cloud.find('GET', '/api/pc/cloud-images')).toHaveLength(1)
    expect(h.saved).toHaveLength(1)
  })
})

// ── 클라우드 생성 · NAI 토큰 ────────────────────────────────────────

describe('클라우드 생성 켜기·끄기', () => {
  it('켜면 토큰과 설정을 올리고 완성 요청을 다시 만들어 달라고 알린다 (토큰은 그 요청 본문에만)', async () => {
    const status = await h.sync.setCloudGen(true)
    expect(h.cloud.last('PUT', '/api/pc/nai-token').json).toEqual({ token: NAI_TOKEN })
    expect(h.cloud.last('PUT', '/api/pc/settings').json).toEqual({
      cloudGenEnabled: true,
      keepImages: 2000
    })
    expect(h.channels('cloud:needPrepared')).toEqual([{ full: false }])
    expect(h.config.state.gen).toBe(true)
    expect(status.cloudGen.enabled).toBe(true)
    // 토큰은 어디에도 새지 않는다
    expectNoSecrets(status)
    expectNoSecrets(h.broadcasts)
    for (const call of h.cloud.calls) {
      if (call.path !== '/api/pc/nai-token') expectNoSecrets(call.json)
      expect(JSON.stringify(call.headers)).not.toContain(NAI_TOKEN)
    }
  })

  it('NAI 토큰이 없으면 클라우드를 부르지 않고 한국어 오류', async () => {
    h.token.value = null
    await expect(h.sync.setCloudGen(true)).rejects.toThrow('NAI 토큰이 설정되지 않았습니다')
    expect(h.cloud.calls).toHaveLength(0)
    expect(h.config.state.gen).toBe(false)
  })

  it('설정 올리기가 실패하면 맡긴 토큰을 도로 지우고 켜지 않는다', async () => {
    h.cloud.failNext('PUT /api/pc/settings', 1)
    await expect(h.sync.setCloudGen(true)).rejects.toThrow('(500)')
    expect(h.cloud.find('DELETE', '/api/pc/nai-token')).toHaveLength(1)
    expect(h.config.state.gen).toBe(false)
  })

  it('토큰 올리기가 실패하면 그대로 오류, 켜지 않는다', async () => {
    h.cloud.failNext('PUT /api/pc/nai-token', 1, 400)
    await expect(h.sync.setCloudGen(true)).rejects.toThrow('(400)')
    expect(h.config.state.gen).toBe(false)
    expect(h.cloud.find('PUT', '/api/pc/settings')).toHaveLength(0)
  })

  it('끄면 토큰부터 지우고 설정을 올린다. 토큰 지우기가 실패하면 켜 둔 채 오류', async () => {
    await h.sync.setCloudGen(true)
    h.cloud.calls.length = 0
    h.cloud.failNext('DELETE /api/pc/nai-token', 1)
    await expect(h.sync.setCloudGen(false)).rejects.toThrow('(500)')
    expect(h.config.state.gen).toBe(true)
    const status = await h.sync.setCloudGen(false)
    expect(h.config.state.gen).toBe(false)
    expect(status.cloudGen.enabled).toBe(false)
    expect(h.cloud.last('PUT', '/api/pc/settings').json).toEqual({
      cloudGenEnabled: false,
      keepImages: 2000
    })
    const order = h.cloud.calls.map((c) => `${c.method} ${c.path}`)
    expect(order.indexOf('DELETE /api/pc/nai-token')).toBeLessThan(
      order.lastIndexOf('PUT /api/pc/settings')
    )
  })

  it('연결 정보가 없으면 켤 수 없다', async () => {
    h.config.state.secret = false
    await expect(h.sync.setCloudGen(true)).rejects.toThrow('연결 정보')
  })

  it('NAI 토큰이 바뀌면 (클라우드 생성이 켜져 있을 때만) 새 토큰을 다시 올린다', async () => {
    h.token.value = 'pst-test-FAKE-first'
    await h.sync.onNaiTokenChanged()
    expect(h.cloud.calls).toHaveLength(0) // 꺼져 있음

    await h.sync.setCloudGen(true)
    h.cloud.calls.length = 0
    h.token.value = 'pst-test-FAKE-second'
    await h.sync.onNaiTokenChanged()
    expect(h.cloud.calls.map((c) => [c.method, c.path, c.json])).toEqual([
      ['PUT', '/api/pc/nai-token', { token: 'pst-test-FAKE-second' }]
    ])
    // 실패해도 던지지 않는다
    h.cloud.failNext('PUT /api/pc/nai-token', 1)
    await expect(h.sync.onNaiTokenChanged()).resolves.toBeUndefined()
  })

  it('클라우드가 안전망으로 스스로 껐으면 PC 도 끈 것으로 따른다', async () => {
    await h.sync.setCloudGen(true)
    h.cloud.info = {
      ...h.cloud.info,
      settings: { cloudGenEnabled: false, keepImages: 2000 },
      hasNaiToken: false
    }
    await h.sync.refreshInfo()
    expect(h.config.state.gen).toBe(false)
    expect(h.sync.status().cloudGen).toMatchObject({ enabled: false, hasToken: false })
  })

  it('PC 는 꺼 뒀는데 클라우드가 켜져 있으면 끄는 쪽으로만 맞춘다, 보관 장수가 다르면 PC 값으로 맞춘다', async () => {
    h.cloud.info = { ...h.cloud.info, settings: { cloudGenEnabled: true, keepImages: 500 } }
    await h.sync.refreshInfo()
    expect(h.cloud.last('PUT', '/api/pc/settings').json).toEqual({
      cloudGenEnabled: false,
      keepImages: 2000
    })
    expect(h.config.state.gen).toBe(false)
  })

  it('보관 장수를 바꾸면 클라우드 설정도 맞춘다 (연결이 안 돼도 저장은 된다)', async () => {
    await h.sync.setKeepImages(5000)
    expect(h.cloud.last('PUT', '/api/pc/settings').json).toEqual({
      cloudGenEnabled: false,
      keepImages: 5000
    })
    h.cloud.failNext('PUT /api/pc/settings', 1)
    const status = await h.sync.setKeepImages(1000)
    expect(status.keepImages).toBe(1000)
  })
})

// ── 완성 요청(prepared) ─────────────────────────────────────────────

describe('cloud:prepared', () => {
  const item = (key: string, hash = 'h1'): CloudPreparedItem => ({
    key,
    hash,
    request: { prompt: key } as unknown as GenerationRequest
  })

  it('바뀐 것만 200개씩 올리고 allKeys 는 마지막 묶음에만 싣는다', async () => {
    const items = Array.from({ length: 450 }, (_, i) => item(`scene:${i}`))
    const allKeys = items.map((i) => i.key)
    await h.sync.putPrepared({ items, allKeys })
    const puts = h.cloud.find('PUT', '/api/pc/prepared').map((c) => c.json)
    expect(puts.map((p) => p.items.length)).toEqual([200, 200, 50])
    expect(puts.map((p) => 'allKeys' in p)).toEqual([false, false, true])
    expect(puts[2].allKeys).toHaveLength(450)

    // 똑같이 다시 주면 아무것도 안 보낸다
    h.cloud.calls.length = 0
    await h.sync.putPrepared({ items, allKeys })
    expect(h.cloud.find('PUT', '/api/pc/prepared')).toHaveLength(0)

    // 하나만 바뀌면 그 하나만
    await h.sync.putPrepared({ items: [item('scene:3', 'h2')], allKeys })
    expect(
      h.cloud
        .find('PUT', '/api/pc/prepared')
        .map((c) => c.json.items.map((i: CloudPreparedItem) => i.key))
    ).toEqual([['scene:3']])
  })

  it('바뀐 것이 없어도 남는 키가 있으면 지우라고 allKeys 만 보낸다', async () => {
    await h.sync.putPrepared({ items: [item('main'), item('scene:1')] })
    await h.sync.putPrepared({ items: [item('main')], allKeys: ['main'] })
    const last = h.cloud.last('PUT', '/api/pc/prepared').json
    expect(last).toEqual({ items: [], allKeys: ['main'] })
    h.cloud.calls.length = 0
    await h.sync.putPrepared({ items: [item('main')], allKeys: ['main'] })
    expect(h.cloud.find('PUT', '/api/pc/prepared')).toHaveLength(0)
  })

  it('클라우드가 이미 가진 해시는 건너뛴다', async () => {
    h.cloud.hashes.prepared = { main: 'same' }
    await h.sync.putPrepared({ items: [item('main', 'same'), item('scene:1')] })
    expect(
      h.cloud.last('PUT', '/api/pc/prepared').json.items.map((i: CloudPreparedItem) => i.key)
    ).toEqual(['scene:1'])
  })

  it('동기화가 꺼져 있으면 보내지 않고 던진다 (조용히 돌려보내면 렌더러가 올린 것으로 기록한다)', async () => {
    h.config.state.enabled = false
    await expect(h.sync.putPrepared({ items: [item('main')] })).rejects.toThrow('동기화가 꺼져')
    expect(h.cloud.calls).toHaveLength(0)
  })

  it('연결 정보가 없거나 앱·워커 판이 다를 때도 던지고, 무엇을 못 했는지 한국어로 알린다', async () => {
    h.config.state.secret = false
    await expect(h.sync.putPrepared({ items: [item('main')] })).rejects.toThrow('연결 정보가 없어')
    h.config.state.secret = true
    h.cloud.protocol = 99
    await h.sync.pollOnce()
    expect(h.sync.status().protocolMismatch).toBe(true)
    await expect(h.sync.putPrepared({ items: [item('main')] })).rejects.toThrow('판이 달라')
    expect(h.cloud.find('PUT', '/api/pc/prepared')).toHaveLength(0)
  })

  it('동기화를 다시 켜면 완성 요청을 처음부터 다시 올리게 하고, 클라우드가 가진 해시도 다시 읽는다', async () => {
    await h.sync.putPrepared({ items: [item('main')] })
    expect(h.cloud.find('GET', '/api/pc/hashes')).toHaveLength(1)
    expect(h.channels('cloud:needPrepared')).toHaveLength(0)

    await h.sync.setEnabled(false)
    expect(h.channels('cloud:needPrepared')).toHaveLength(0) // 끌 때는 아무 일 없다
    await h.sync.setEnabled(true)
    expect(h.channels('cloud:needPrepared')).toEqual([{ full: true }])
    await h.sync.setEnabled(true) // 이미 켜져 있으면 또 보내지 않는다
    expect(h.channels('cloud:needPrepared')).toHaveLength(1)

    // 꺼진 사이 클라우드 저장소가 바뀌었을 수 있다 — 해시를 다시 읽어 비교한다
    h.cloud.hashes.prepared = {}
    await h.sync.putPrepared({ items: [item('main')] })
    expect(h.cloud.find('GET', '/api/pc/hashes')).toHaveLength(2)
    expect(h.cloud.find('PUT', '/api/pc/prepared')).toHaveLength(2)
  })

  it('클라우드가 전체 올리기를 요구한 뒤의 완성 요청은 클라우드가 가졌다는 해시를 믿지 않고 전부 다시 올린다', async () => {
    h.cloud.hashes.prepared = { main: 'h1' } // 저장소가 비었는데 낡은 해시 표가 남아 있다고 치고
    h.cloud.needsFullSync = true
    await h.sync.pollOnce()
    expect(h.channels('cloud:needPrepared')).toEqual([{ full: true }])
    h.cloud.calls.length = 0
    await h.sync.putPrepared({ items: [item('main', 'h1')] })
    expect(h.cloud.find('GET', '/api/pc/hashes')).toHaveLength(0)
    expect(h.cloud.find('PUT', '/api/pc/prepared')).toHaveLength(1)
  })

  it('앱·워커 판이 달랐다가 다시 맞으면 완성 요청을 처음부터 다시 올리게 한다 (처음부터 맞을 때는 아니다)', async () => {
    await h.sync.pollOnce()
    await h.sync.refreshInfo()
    expect(h.channels('cloud:needPrepared')).toHaveLength(0)

    h.cloud.protocol = 99
    h.cloud.info = { ...h.cloud.info, protocol: 99 }
    await h.sync.pollOnce()
    await h.sync.refreshInfo()
    expect(h.sync.status().protocolMismatch).toBe(true)
    expect(h.channels('cloud:needPrepared')).toHaveLength(0)

    h.cloud.protocol = CLOUD_PROTOCOL
    await h.sync.pollOnce() // poll 이 먼저 맞은 것을 알아도
    expect(h.sync.status().protocolMismatch).toBe(false)
    expect(h.channels('cloud:needPrepared')).toEqual([{ full: true }])
    h.cloud.info = { ...h.cloud.info, protocol: CLOUD_PROTOCOL }
    await h.sync.refreshInfo() // 정보 확인이 뒤따라도 한 번뿐
    expect(h.channels('cloud:needPrepared')).toHaveLength(1)
  })

  it('실패하면 던지고 해시를 기억하지 않아 다음에 다시 보낸다', async () => {
    h.cloud.failNext('PUT /api/pc/prepared', 1)
    await expect(h.sync.putPrepared({ items: [item('main')] })).rejects.toThrow('(500)')
    await h.sync.putPrepared({ items: [item('main')] })
    expect(h.cloud.find('PUT', '/api/pc/prepared')).toHaveLength(2)
  })
})

// ── 기기 · 연결 코드 · 기타 ─────────────────────────────────────────

describe('연결 코드와 기기', () => {
  it('연결 코드는 필요한 필드만 돌려주고, 기기 해제는 남은 목록과 기기 수를 갱신한다', async () => {
    expect(await h.sync.pairing()).toEqual({
      code: 'ABCD2345',
      url: 'https://x/#pair=ABCD2345',
      expiresAt: 99,
      qrSvg: '<svg/>'
    })
    expect((await h.sync.devices()).items).toHaveLength(2)
    expect(h.sync.status().devices).toBe(2)
    const after = await h.sync.revokeDevice('d1')
    expect(after.items.map((d) => d.id)).toEqual(['d2'])
    expect(h.sync.status().devices).toBe(1)
  })

  it('syncNow 는 정보·동기화·poll·가져오기를 한 번에 하고 상태를 돌려준다', async () => {
    const status = await h.sync.syncNow()
    expect(status).toMatchObject({ configured: true, enabled: true, connected: true, devices: 1 })
    expect(h.cloud.find('GET', '/api/pc/info')).toHaveLength(1)
    expect(h.cloud.find('PUT', '/api/pc/library')).toHaveLength(1)
    expect(h.cloud.find('POST', '/api/pc/poll')).toHaveLength(1)
    expect(h.cloud.find('GET', '/api/pc/cloud-images')).toHaveLength(1)
  })

  it('연결 파일이 틀리면 상태 오류로 알리고, 새로 가져왔으면 바로 맞춘다', async () => {
    h.config.state.connect = 'invalid'
    await h.sync.pollOnce()
    expect(h.sync.status().error).toContain('cloud-connect.json')
    h.config.state.connect = 'none'
    await h.sync.pollOnce()
    expect(h.sync.status().error).toBeNull()
  })

  it('동기화를 켜고 끄는 설정은 상태에 바로 반영된다', async () => {
    expect((await h.sync.setEnabled(false)).enabled).toBe(false)
    expect((await h.sync.setEnabled(true)).enabled).toBe(true)
    expect(h.channels('cloud:status').at(-1)).toMatchObject({ enabled: true })
  })
})

describe('큐 알림 구독', () => {
  it('지켜볼 작업이 있는 동안만 큐 알림을 듣고, 끝나면 놓는다', async () => {
    expect(h.queue.listenerCount('changed')).toBe(0)
    h.cloud.addJob('j1', 1)
    h.sync.rendererReady()
    await h.sync.pollOnce()
    expect(h.queue.listenerCount('changed')).toBe(0) // 넘기기만 했고 아직 큐에 안 들어갔다
    h.queue.add('q1', 10)
    await h.sync.workDone({ opIds: [], jobs: [{ id: 'j1', queueIds: ['q1'] }] })
    expect(h.queue.listenerCount('changed')).toBe(1)
    h.queue.finish('q1', 'done')
    await vi.waitFor(() => expect(h.cloud.jobStates.get('j1')).toBe('done'))
    expect(h.queue.listenerCount('changed')).toBe(0)
  })

  it('stop 하면 남은 구독도 놓는다', async () => {
    vi.useFakeTimers()
    h.cloud.addJob('j1', 1)
    h.sync.start()
    h.sync.rendererReady()
    await vi.advanceTimersByTimeAsync(10)
    h.queue.add('q1', 10)
    await h.sync.workDone({ opIds: [], jobs: [{ id: 'j1', queueIds: ['q1'] }] })
    expect(h.queue.listenerCount('changed')).toBe(1)
    h.sync.stop()
    expect(h.queue.listenerCount('changed')).toBe(0)
  })
})

describe('타이머', () => {
  it('start 하면 바로 한 번 맞추고 5초마다 poll, stop 하면 멈춘다', async () => {
    vi.useFakeTimers()
    h.sync.start()
    await vi.advanceTimersByTimeAsync(10)
    expect(h.cloud.find('POST', '/api/pc/poll')).toHaveLength(1)
    expect(h.cloud.find('GET', '/api/pc/hashes')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(h.cloud.find('POST', '/api/pc/poll')).toHaveLength(2)
    h.sync.stop()
    const n = h.cloud.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.cloud.calls).toHaveLength(n)
  })

  it('렌더러가 준비됐다고 알리면 바로 poll 한다', async () => {
    vi.useFakeTimers()
    h.sync.start()
    await vi.advanceTimersByTimeAsync(10)
    const before = h.cloud.find('POST', '/api/pc/poll').length
    h.sync.rendererReady()
    await vi.advanceTimersByTimeAsync(10)
    expect(h.cloud.find('POST', '/api/pc/poll').length).toBe(before + 1)
    expect(h.cloud.last('POST', '/api/pc/poll').json.acceptsJobs).toBe(true)
  })

  it('30초마다 해시를 다시 비교한다', async () => {
    vi.useFakeTimers()
    h.sync.start()
    await vi.advanceTimersByTimeAsync(10)
    const before = h.cloud.find('GET', '/api/pc/hashes').length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.cloud.find('GET', '/api/pc/hashes').length).toBe(before + 1)
  })
})

// ── 2차: 잃은 작업 정리용 activeJobIds ──────────────────────────────

describe('poll — activeJobIds', () => {
  const lastActive = (): string[] =>
    [...(h.cloud.last('POST', '/api/pc/poll').json.activeJobIds as string[])].sort()

  it('큐를 지켜보는 작업을 전부 싣고, 끝 ack 가 클라우드에 닿을 때까지는 끝난 작업도 싣는다', async () => {
    h.cloud.addJob('j1', 1)
    h.cloud.addJob('j2', 1)
    h.sync.rendererReady()
    await h.sync.pollOnce()
    expect(lastActive()).toEqual([]) // 렌더러에 넘기기만 했다 — 아직 PC 큐에 없다

    h.queue.add('q1', 10)
    h.queue.add('q2', 10)
    await h.sync.workDone({
      opIds: [],
      jobs: [
        { id: 'j1', queueIds: ['q1'] },
        { id: 'j2', queueIds: ['q2'] }
      ]
    })
    await h.sync.pollOnce()
    expect(lastActive()).toEqual(['j1', 'j2'])

    // j1 이 끝났는데 끝 ack 가 가지 못한다 — 클라우드가 잃은 것으로 오해하지 않게 계속 싣는다
    h.cloud.failNext('POST /api/pc/ack', 99)
    h.queue.finish('q1', 'done')
    await new Promise((r) => setTimeout(r, 0))
    await h.sync.pollOnce()
    expect(lastActive()).toEqual(['j1', 'j2'])

    h.cloud.clearFailures()
    await h.sync.pollOnce() // 이 poll 이 끝 ack 를 보낸다
    expect(h.cloud.jobStates.get('j1')).toBe('done')
    await h.sync.pollOnce()
    expect(lastActive()).toEqual(['j2'])

    h.queue.finish('q2', 'failed', 'x')
    await vi.waitFor(() => expect(h.cloud.jobStates.get('j2')).toBe('failed'))
    await new Promise((r) => setTimeout(r, 0)) // ack 응답까지 처리되어 쌓아 둔 끝 ack 가 비워지길
    await h.sync.pollOnce()
    expect(lastActive()).toEqual([])
  })

  it('렌더러가 error 를 준 작업도 끝 ack 가 갈 때까지 싣는다', async () => {
    h.cloud.addJob('j1', 1)
    h.sync.rendererReady()
    await h.sync.pollOnce()
    h.cloud.failNext('POST /api/pc/ack', 1)
    await h.sync.workDone({
      opIds: [],
      jobs: [{ id: 'j1', queueIds: [], error: '씬이 PC에 없음' }]
    })
    await h.sync.pollOnce()
    expect(lastActive()).toEqual(['j1'])
  })
})

// ── 2차: 큐에 이미 있는 작업은 다시 넘기지 않는다 ───────────────────

describe('중복 방지 — 큐에 이미 이 작업의 항목이 있을 때', () => {
  it('렌더러가 큐에 넣고 답하기 전에 새로고침됐다면, 다시 넘기지 않고 그 큐 id 들로 이어 받는다', async () => {
    h.cloud.addJob('j1', 2)
    h.sync.rendererReady()
    await h.sync.pollOnce()
    expect(h.channels('cloud:work')).toHaveLength(1)

    // 렌더러가 cloudJobId 를 단 요청을 큐에 넣었지만 workDone 을 부르기 전에 죽었다
    h.queue.add('q1', 10, 'j1')
    h.queue.add('q2', 10, 'j1')
    h.sync.rendererReady() // 새로고침 — 넘겼다는 기억이 지워진다
    await h.sync.pollOnce()

    expect(h.channels('cloud:work')).toHaveLength(1) // 두 번째로 넘기지 않았다
    expect(h.cloud.acks().at(-1)).toEqual({ opIds: [], jobs: [{ id: 'j1', state: 'accepted' }] })
    expect(h.cloud.jobStates.get('j1')).toBe('pc')
    expect(h.queue.listenerCount('changed')).toBe(1)

    await h.sync.pollOnce()
    expect(h.cloud.last('POST', '/api/pc/poll').json.activeJobIds).toEqual(['j1'])

    h.queue.finish('q1', 'done')
    h.queue.finish('q2', 'failed', 'x')
    await vi.waitFor(() => expect(h.cloud.jobStates.get('j1')).toBe('done'))
    expect(h.cloud.acks().at(-1)?.jobs).toEqual([{ id: 'j1', state: 'done', done: 1, failed: 1 }])
    expect(h.queue.listenerCount('changed')).toBe(0)
  })

  it('큐에 항목이 없으면 새로고침 뒤 다시 넘긴다 (렌더러가 큐에 넣기 전에 죽은 경우)', async () => {
    h.cloud.addJob('j1', 1)
    h.sync.rendererReady()
    await h.sync.pollOnce()
    h.queue.add('other', 10) // 다른 작업의 항목은 상관없다
    h.sync.rendererReady()
    await h.sync.pollOnce()
    expect(h.channels('cloud:work')).toHaveLength(2)
    expect(h.cloud.jobStates.get('j1')).toBe('queued')
  })

  it('처음 넘기기 직전에도 확인한다 — 렌더러가 준비되기 전이어도 이어 받는다', async () => {
    h.queue.add('q1', 10, 'j1') // 메인이 큐를 들고 있는데 클라우드는 아직 queued 로 안다 (accepted ack 유실)
    h.cloud.addJob('j1', 1)
    await h.sync.pollOnce() // rendererReady 전
    expect(h.channels('cloud:work')).toHaveLength(0)
    expect(h.cloud.jobStates.get('j1')).toBe('pc')
    h.sync.rendererReady()
    await h.sync.pollOnce()
    expect(h.channels('cloud:work')).toHaveLength(0)
  })

  it('이어 받은 항목이 이미 다 끝나 있으면 바로 끝 ack (끝난 작업이 늦게 온 poll 로 다시 돌지 않는다)', async () => {
    h.queue.add('q1', 10, 'j1')
    h.queue.finish('q1', 'done')
    h.cloud.addJob('j1', 1)
    h.sync.rendererReady()
    await h.sync.pollOnce()
    await vi.waitFor(() => expect(h.cloud.jobStates.get('j1')).toBe('done'))
    expect(h.channels('cloud:work')).toHaveLength(0)
    expect(h.queue.listenerCount('changed')).toBe(0)
  })

  it('취소 요청이 먼저 와 있던 작업이면 이어 받으면서 그 큐 항목들을 취소한다', async () => {
    h.queue.add('q1', 10, 'j1')
    h.queue.add('q2', 10, 'j1')
    h.cloud.addJob('j1', 2)
    h.cloud.ops.push({ id: 9, at: 1, type: 'job:cancel', jobId: 'j1' })
    h.sync.rendererReady()
    await h.sync.pollOnce()
    expect(h.queue.cancelled).toContainEqual(['q1', 'q2'])
    expect(h.channels('cloud:work')).toHaveLength(0)
  })

  it('이미 지켜보는 작업은 다시 이어 받지 않는다', async () => {
    h.cloud.addJob('j1', 1)
    h.sync.rendererReady()
    await h.sync.pollOnce()
    h.queue.add('q1', 10, 'j1')
    await h.sync.workDone({ opIds: [], jobs: [{ id: 'j1', queueIds: ['q1'] }] })
    const acksBefore = h.cloud.acks().length
    h.cloud.jobStates.set('j1', 'queued') // 클라우드가 아직 queued 로 보인다고 치고 (늦은 응답)
    await h.sync.pollOnce()
    expect(h.cloud.acks()).toHaveLength(acksBefore) // accepted 를 또 보내지 않는다
    expect(h.channels('cloud:work')).toHaveLength(1)
  })
})

// ── 2차: 계정 정보(naiInfo) · 무료 사용량 ───────────────────────────

describe('계정 정보 (library.naiInfo) 와 무료 사용량', () => {
  const usage = (percent = 73, isNegative = false, purchasedPercent = 0): OpusUsage => ({
    percent,
    purchasedPercent,
    isNegative,
    timeUntilNextPercent: 600
  })
  const naiInfoSent = (): unknown => h.cloud.last('PUT', '/api/pc/library').json.library.naiInfo

  it('sameNaiBalance — 다음 회복까지 남은 시간은 비교하지 않는다', () => {
    const a = { tier: 'opus', anlas: 5, opusUsage: usage() }
    expect(sameNaiBalance(a, { ...a, opusUsage: { ...usage(), timeUntilNextPercent: 1 } })).toBe(
      true
    )
    expect(sameNaiBalance(a, { ...a, anlas: 4 })).toBe(false)
    expect(sameNaiBalance(a, { ...a, opusUsage: usage(72) })).toBe(false)
    expect(sameNaiBalance(a, { ...a, opusUsage: usage(73, true) })).toBe(false)
    expect(sameNaiBalance(a, { ...a, opusUsage: null })).toBe(false)
    expect(sameNaiBalance({ ...a, opusUsage: null }, { ...a, opusUsage: null })).toBe(true)
  })

  it('sameNaiBalance — 충전 아이템 추가분이 바뀌어도 다르다 (커스텀)', () => {
    const a = { tier: 'opus', anlas: 5, opusUsage: usage(0) }
    expect(sameNaiBalance(a, { ...a, opusUsage: usage(0, false, 100) })).toBe(false)
    expect(sameNaiBalance({ ...a, opusUsage: usage(0, false, 100) }, a)).toBe(false)
    expect(sameNaiBalance(a, { ...a, opusUsage: usage(0, false, 99.5) })).toBe(false)
    // 키가 없는 옛 값은 추가분 0 과 같다
    const legacy = { percent: 0, isNegative: false, timeUntilNextPercent: 600 } as OpusUsage
    expect(sameNaiBalance(a, { ...a, opusUsage: legacy })).toBe(true)
  })

  it('일반분 0%인 채 추가분만 생기면 바로 「남음」으로 알리고 올린다 (커스텀)', async () => {
    vi.useFakeTimers()
    h.sync.onNaiInfo({ tier: 'opus', anlas: 5, opusUsage: usage(0) })
    expect(h.sync.status().cloudGen.quota).toBe('unknown')
    await vi.advanceTimersByTimeAsync(3_100)
    expect(h.cloud.find('GET', '/api/pc/hashes')).toHaveLength(1)

    // 충전 아이템을 쓴 직후 — 일반분·초과 여부·Anlas 는 그대로, 추가분만 100
    h.clock.t += 60_000
    h.sync.onNaiInfo({ tier: 'opus', anlas: 5, opusUsage: usage(0, false, 100) })
    expect(h.sync.status().cloudGen.quota).toBe('available')
    await vi.advanceTimersByTimeAsync(3_100)
    expect(h.cloud.find('GET', '/api/pc/hashes')).toHaveLength(2)
    expect(naiInfoSent()).toMatchObject({ opusUsage: { percent: 0, purchasedPercent: 100 } })
  })

  it('조회 전에는 설정의 등급만, 조회 뒤에는 Anlas·사용량·시각을 실어 올린다', async () => {
    await h.sync.syncOnce()
    expect(naiInfoSent()).toEqual({ tier: 'opus', anlas: null, opusUsage: null, updatedAt: 0 })

    h.clock.t += 5000
    h.sync.onNaiInfo({ tier: 'opus', anlas: 12345, opusUsage: usage() })
    await h.sync.syncOnce()
    expect(naiInfoSent()).toEqual({
      tier: 'opus',
      anlas: 12345,
      opusUsage: usage(),
      updatedAt: h.clock.t
    })
    expectNoSecrets(naiInfoSent())
  })

  it('해시가 바뀌면 올리고, 그대로면 건너뛴다', async () => {
    await h.sync.syncOnce()
    const first = h.cloud.last('PUT', '/api/pc/library').json
    const same = { ...h.cloud.hashes, library: first.hash }
    h.cloud.hashes = same
    h.cloud.calls.length = 0
    await h.sync.syncOnce()
    expect(h.cloud.find('PUT', '/api/pc/library')).toHaveLength(0)

    h.sync.onNaiInfo({ tier: 'opus', anlas: 1, opusUsage: null })
    await h.sync.syncOnce()
    const second = h.cloud.last('PUT', '/api/pc/library').json
    expect(second.hash).not.toBe(first.hash)
    h.cloud.hashes = { ...same, library: second.hash }
    h.cloud.calls.length = 0
    await h.sync.syncOnce()
    expect(h.cloud.find('PUT', '/api/pc/library')).toHaveLength(0)
  })

  it('바뀌었을 때만 3초 뒤 올리도록 예약한다 (같은 값은 시각도 그대로)', async () => {
    vi.useFakeTimers()
    h.sync.onNaiInfo({ tier: 'opus', anlas: 7, opusUsage: usage() })
    await vi.advanceTimersByTimeAsync(2_900)
    expect(h.cloud.find('GET', '/api/pc/hashes')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(200)
    expect(h.cloud.find('GET', '/api/pc/hashes')).toHaveLength(1)
    expect((naiInfoSent() as { updatedAt: number }).updatedAt).toBe(h.clock.t)

    // 같은 값(남은 시간만 다름) — 다시 올리지 않고 시각도 그대로
    const firstAt = h.clock.t
    h.clock.t += 60_000
    h.sync.onNaiInfo({
      tier: 'opus',
      anlas: 7,
      opusUsage: { ...usage(), timeUntilNextPercent: 100 }
    })
    await vi.advanceTimersByTimeAsync(3_100)
    expect(h.cloud.find('GET', '/api/pc/hashes')).toHaveLength(1)
    expect((naiInfoSent() as { updatedAt: number }).updatedAt).toBe(firstAt)

    // 오래되면 시각만 새로 찍는다
    h.clock.t += NAI_INFO_REFRESH_MS
    h.sync.onNaiInfo({ tier: 'opus', anlas: 7, opusUsage: usage() })
    await vi.advanceTimersByTimeAsync(3_100)
    expect(h.cloud.find('GET', '/api/pc/hashes')).toHaveLength(2)
    expect((naiInfoSent() as { updatedAt: number }).updatedAt).toBe(h.clock.t)
  })

  it('조회에 실패한 결과(전부 null)는 이전 값을 지우지 않는다', async () => {
    h.sync.onNaiInfo({ tier: 'opus', anlas: 9, opusUsage: usage() })
    h.sync.onNaiInfo({ tier: null, anlas: null, opusUsage: null })
    await h.sync.syncOnce()
    expect(naiInfoSent()).toMatchObject({ anlas: 9 })
  })

  it('동기화가 꺼져 있으면 올리기를 예약하지 않는다', async () => {
    vi.useFakeTimers()
    h.config.state.enabled = false
    h.sync.onNaiInfo({ tier: 'opus', anlas: 7, opusUsage: usage() })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.cloud.calls).toHaveLength(0)
  })

  it('무료 사용량: 클라우드가 30분 안에 확인한 값 → 아니면 PC 가 잰 Opus 사용량 → 둘 다 없으면 null', async () => {
    expect(h.sync.status().cloudGen.quota).toBeNull()

    h.sync.onNaiInfo({ tier: 'paper', anlas: 5, opusUsage: null }) // Opus 가 아니라 사용량이 없다
    expect(h.sync.status().cloudGen.quota).toBeNull()

    h.sync.onNaiInfo({ tier: 'opus', anlas: 5, opusUsage: usage(73) })
    expect(h.sync.status().cloudGen.quota).toBe('available')
    h.sync.onNaiInfo({ tier: 'opus', anlas: 5, opusUsage: usage(0) })
    expect(h.sync.status().cloudGen.quota).toBe('unknown') // 0% 인데 초과도 아님
    h.sync.onNaiInfo({ tier: 'opus', anlas: 5, opusUsage: usage(0, true) })
    expect(h.sync.status().cloudGen.quota).toBe('exhausted')

    // 클라우드가 방금 확인한 값이 우선
    h.cloud.info = { ...h.cloud.info, quota: { state: 'available', checkedAt: h.clock.t - 60_000 } }
    await h.sync.refreshInfo()
    expect(h.sync.status().cloudGen.quota).toBe('available')

    // 30분이 지나면 클라우드 값을 믿지 않고 PC 가 잰 값으로
    h.clock.t += QUOTA_FRESH_MS
    expect(h.sync.status().cloudGen.quota).toBe('exhausted')
  })

  it('클라우드 확인값은 정확히 30분 전까지 믿는다', async () => {
    h.cloud.info = { ...h.cloud.info, quota: { state: 'exhausted', checkedAt: h.clock.t } }
    await h.sync.refreshInfo()
    h.clock.t += QUOTA_FRESH_MS
    expect(h.sync.status().cloudGen.quota).toBe('exhausted')
    h.clock.t += 1
    expect(h.sync.status().cloudGen.quota).toBeNull()
  })

  it('상태 broadcast 에 무료 사용량 변화가 반영된다', async () => {
    await h.sync.pollOnce()
    const n = h.channels('cloud:status').length
    h.sync.onNaiInfo({ tier: 'opus', anlas: 5, opusUsage: usage(73) })
    expect(h.channels('cloud:status').length).toBe(n + 1)
    expect(h.channels('cloud:status').at(-1).cloudGen.quota).toBe('available')
  })
})

// ── 2차: 로컬 NAI 토큰이 사라졌을 때 ────────────────────────────────

describe('NAI 토큰 삭제 → 클라우드 사본도 지우고 클라우드 생성 끄기', () => {
  it('클라우드 생성이 켜져 있는데 토큰이 없어졌으면 토큰 삭제 → 설정 끄기 → 로컬 플래그 끄기', async () => {
    await h.sync.setCloudGen(true)
    h.cloud.calls.length = 0
    h.token.value = null
    await h.sync.onNaiTokenChanged()

    expect(h.cloud.find('PUT', '/api/pc/nai-token')).toHaveLength(0) // 새 토큰을 올리지 않는다
    expect(h.cloud.find('DELETE', '/api/pc/nai-token')).toHaveLength(1)
    expect(h.cloud.last('PUT', '/api/pc/settings').json).toEqual({
      cloudGenEnabled: false,
      keepImages: 2000
    })
    const order = h.cloud.calls.map((c) => `${c.method} ${c.path}`)
    expect(order.indexOf('DELETE /api/pc/nai-token')).toBeLessThan(
      order.indexOf('PUT /api/pc/settings')
    )
    expect(h.config.state.gen).toBe(false)
    expect(h.sync.status().cloudGen.enabled).toBe(false)
    expect(h.channels('cloud:status').at(-1).cloudGen.enabled).toBe(false)
  })

  it('클라우드 생성이 꺼져 있으면 아무것도 하지 않는다', async () => {
    h.token.value = null
    await h.sync.onNaiTokenChanged()
    expect(h.cloud.calls).toHaveLength(0)
  })

  it('연결 정보가 없으면 아무것도 하지 않는다', async () => {
    await h.sync.setCloudGen(true)
    h.cloud.calls.length = 0
    h.config.state.secret = false
    h.token.value = null
    await h.sync.onNaiTokenChanged()
    expect(h.cloud.calls).toHaveLength(0)
  })

  it('토큰이 남아 있으면 (다른 계정으로 넘어간 경우) 기존대로 새 토큰을 다시 맡긴다', async () => {
    await h.sync.setCloudGen(true)
    h.cloud.calls.length = 0
    h.token.value = 'pst-test-FAKE-next-account'
    await h.sync.onNaiTokenChanged()
    expect(h.cloud.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['PUT /api/pc/nai-token'])
    expect(h.config.state.gen).toBe(true)
  })

  it('토큰 지우기가 실패해도 던지지 않고 켜 둔 채 두며, 다음 정보 확인 때 다시 끈다', async () => {
    await h.sync.setCloudGen(true)
    h.cloud.calls.length = 0
    h.token.value = null
    h.cloud.failNext('DELETE /api/pc/nai-token', 1)
    await expect(h.sync.onNaiTokenChanged()).resolves.toBeUndefined()
    expect(h.config.state.gen).toBe(true)
    expect(h.cloud.find('PUT', '/api/pc/settings')).toHaveLength(0)
    expect(h.cloud.find('GET', '/api/pc/info')).toHaveLength(0) // 바로 또 시도하지 않는다

    await h.sync.refreshInfo()
    expect(h.cloud.find('DELETE', '/api/pc/nai-token')).toHaveLength(2)
    expect(h.config.state.gen).toBe(false)
    expect(h.cloud.last('PUT', '/api/pc/settings').json).toMatchObject({ cloudGenEnabled: false })
    expect(h.sync.status().cloudGen).toMatchObject({ enabled: false, hasToken: false })
  })

  it('정보 확인 때도 토큰 없이 켜져 있으면 끈다 (앱을 다시 켠 뒤에도)', async () => {
    h.config.state.gen = true
    h.token.value = null
    h.cloud.info = {
      ...h.cloud.info,
      hasNaiToken: true,
      settings: { cloudGenEnabled: true, keepImages: 2000 }
    }
    await h.sync.refreshInfo()
    expect(h.config.state.gen).toBe(false)
    expect(h.cloud.find('DELETE', '/api/pc/nai-token')).toHaveLength(1)
    expect(h.sync.status().cloudGen).toMatchObject({ enabled: false, hasToken: false })
  })

  it('토큰은 어디에도 새지 않는다', async () => {
    await h.sync.setCloudGen(true)
    h.cloud.calls.length = 0
    h.token.value = null
    await h.sync.onNaiTokenChanged()
    expectNoSecrets(h.broadcasts)
    expectNoSecrets(h.sync.status())
    for (const call of h.cloud.calls) expectNoSecrets(call.json)
  })
})

// ── 3차: 씬 그림 수는 씬 본문과 따로 ────────────────────────────────

describe('씬 그림 수 (PUT /api/pc/scene-counts)', () => {
  const savedImage = (id: number, sceneId?: number): void =>
    h.sync.onImageSaved({
      id,
      filePath: `/pics/${id}.png`,
      sceneId,
      seed: 1,
      kind: sceneId == null ? 't2i' : 'scene',
      width: 1,
      height: 1
    })
  const countPuts = (): { counts: Record<string, number> }[] =>
    h.cloud.find('PUT', '/api/pc/scene-counts').map((c) => c.json)
  /** 시계와 가짜 타이머를 같이 흘린다 (동기화는 주입한 시계로 간격을 잰다) */
  const elapse = async (ms: number): Promise<void> => {
    h.clock.t += ms
    await vi.advanceTimersByTimeAsync(ms)
  }

  it('씬 그림이 저장되면 3초 뒤 그림 수만 올린다 — 씬 스냅샷(해시 비교·라이브러리·씬 본문)은 다시 만들지 않는다', async () => {
    vi.useFakeTimers()
    h.counts.value = { '10': 1 }
    savedImage(5, 10)
    await elapse(2_900)
    expect(countPuts()).toHaveLength(0)
    await elapse(200)
    expect(countPuts()).toEqual([{ counts: { '10': 1 } }])
    expect(h.cloud.find('GET', '/api/pc/hashes')).toHaveLength(0)
    expect(h.cloud.find('PUT', '/api/pc/scenes')).toHaveLength(0)
    expect(h.cloud.find('PUT', '/api/pc/library')).toHaveLength(0)
    await h.sync.drainUploads()
    expect(h.cloud.find('PUT', '/api/pc/images/p5')).toHaveLength(1) // 그림은 그대로 올라간다
  })

  it('연달아 그림이 저장돼도 그림 수는 60초에 한 번 이하로만 올린다', async () => {
    vi.useFakeTimers()
    h.counts.value = { '10': 1 }
    savedImage(1, 10)
    await elapse(3_100)
    expect(countPuts()).toHaveLength(1)

    // 큐 반복으로 200장이 쏟아진다 — 몇 초 간격으로 계속 저장되고 그림 수도 계속 늘어난다
    for (let i = 2; i <= 200; i++) {
      h.counts.value = { '10': i }
      savedImage(i, 10)
      await elapse(250)
    }
    // 마지막으로 올린 지 50초가 안 됐다 — 아직 한 번도 더 안 올렸다
    expect(countPuts()).toHaveLength(1)
    expect(h.cloud.find('GET', '/api/pc/hashes')).toHaveLength(0)
    await elapse(60_000)
    expect(countPuts()).toHaveLength(2)
    expect(countPuts()[1]).toEqual({ counts: { '10': 200 } })
    await elapse(120_000)
    expect(countPuts()).toHaveLength(2) // 그 뒤로 그림이 없으면 더 올리지 않는다
  })

  it('씬이 없는 그림(메인 탭)은 아무것도 하지 않는다 — 스냅샷도 그림 수도 건드리지 않는다', async () => {
    vi.useFakeTimers()
    savedImage(7)
    await elapse(120_000)
    expect(countPuts()).toHaveLength(0)
    expect(h.cloud.find('GET', '/api/pc/hashes')).toHaveLength(0)
    expect(h.cloud.find('PUT', '/api/pc/library')).toHaveLength(0)
    await h.sync.drainUploads()
    expect(h.cloud.find('PUT', '/api/pc/images/p7')).toHaveLength(1) // 올리기만 한다
  })

  it('그림 올리기가 꺼져 있어도 씬 그림 수는 올린다. 동기화가 꺼져 있으면 아무것도 안 한다', async () => {
    vi.useFakeTimers()
    h.sync.setUploadImages(false)
    h.counts.value = { '10': 4 }
    savedImage(1, 10)
    await elapse(3_100)
    expect(countPuts()).toEqual([{ counts: { '10': 4 } }])
    expect(h.cloud.find('PUT', '/api/pc/images/p1')).toHaveLength(0)

    h.config.state.enabled = false
    h.counts.value = { '10': 5 }
    savedImage(2, 10)
    await elapse(120_000)
    expect(countPuts()).toHaveLength(1)
  })

  it('전체 동기화는 그림 수가 지난번과 같으면 올리지 않고, 달라졌어도 60초가 지난 뒤에 올린다', async () => {
    await h.sync.syncOnce()
    expect(countPuts()).toHaveLength(1)

    h.clock.t += 61_000
    await h.sync.syncOnce() // 같은 수 — 안 올린다
    expect(countPuts()).toHaveLength(1)

    h.counts.value = { '10': 2 }
    h.clock.t += 10_000
    await h.sync.syncOnce() // 센 지 10초 — 아직 다시 세지 않는다
    expect(countPuts()).toHaveLength(1)
    h.clock.t += 51_000
    await h.sync.syncOnce()
    expect(countPuts()).toEqual([{ counts: { '10': 0 } }, { counts: { '10': 2 } }])
  })

  it('올리다 실패해도 던지지 않고 동기화는 성공으로 치며, 다음 간격이 지나면 다시 올린다', async () => {
    h.cloud.failNext('PUT /api/pc/scene-counts', 1)
    expect(await h.sync.syncOnce()).toBe(true)
    expect(countPuts()).toHaveLength(1)
    h.clock.t += 61_000
    await h.sync.syncOnce()
    expect(countPuts()).toHaveLength(2)
    h.clock.t += 61_000
    await h.sync.syncOnce()
    expect(countPuts()).toHaveLength(2) // 이제 같은 수
  })

  it('클라우드 저장소가 새로 생겨 전체 올리기를 요구하면 간격이나 같은 수와 상관없이 다시 올린다', async () => {
    await h.sync.syncOnce()
    expect(countPuts()).toHaveLength(1)
    h.cloud.needsFullSync = true
    await h.sync.pollOnce() // 같은 시각·같은 수
    expect(countPuts()).toHaveLength(2)
  })

  it('새 연결 파일을 가져와도 처음부터 다시 올린다', async () => {
    await h.sync.syncOnce()
    expect(countPuts()).toHaveLength(1)
    h.config.state.connect = 'imported'
    await h.sync.pollOnce()
    h.config.state.connect = 'none'
    await vi.waitFor(() => expect(countPuts()).toHaveLength(2)) // 바로 이어지는 맞추기에서
  })

  it('클라우드에서 가져온 씬 그림도 그 씬의 그림 수를 바꾼다', async () => {
    const zip = await zipOf(PNG)
    // 압축 라이브러리가 setImmediate 를 쓰므로 그건 진짜로 둔다
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    h.cloud.generated.push({
      item: {
        id: 'cA',
        jobId: 'j1',
        sceneId: 10,
        presetId: 1,
        seed: 4242,
        sentPayload: '{"input":"p"}',
        createdAt: 1
      },
      zip
    })
    h.counts.value = { '10': 1 }
    await h.sync.importOnce()
    expect(countPuts()).toHaveLength(0)
    await elapse(3_100)
    expect(countPuts()).toEqual([{ counts: { '10': 1 } }])
  })

  it('stop 하면 기다리던 그림 수 올리기도 취소한다', async () => {
    vi.useFakeTimers()
    savedImage(1, 10)
    h.sync.stop()
    await elapse(120_000)
    expect(countPuts()).toHaveLength(0)
  })

  it('씬별 그림 수를 읽는 함수가 없으면 읽어 온 씬의 imageCount 로 대신한다', async () => {
    const plain = harness({}, { withoutCounts: true })
    await plain.sync.syncOnce()
    expect(plain.cloud.last('PUT', '/api/pc/scene-counts').json).toEqual({ counts: { '10': 0 } })
    plain.sync.stop()
  })

  it('잔액이 바뀌어도 방금(60초 안) 맞췄으면 스냅샷 만들기를 예약하지 않는다 (30초 주기가 맡는다)', async () => {
    vi.useFakeTimers()
    await h.sync.syncOnce()
    const before = h.cloud.find('GET', '/api/pc/hashes').length
    h.sync.onNaiInfo({ tier: 'opus', anlas: 100, opusUsage: null })
    h.clock.t += 10_000
    h.sync.onNaiInfo({ tier: 'opus', anlas: 99, opusUsage: null })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.cloud.find('GET', '/api/pc/hashes')).toHaveLength(before)
    h.clock.t += 60_000
    h.sync.onNaiInfo({ tier: 'opus', anlas: 98, opusUsage: null })
    await vi.advanceTimersByTimeAsync(3_100)
    expect(h.cloud.find('GET', '/api/pc/hashes')).toHaveLength(before + 1)
  })
})

// ── 3차: NAI 토큰 교체 PUT 이 실패했을 때 ────────────────────────────

describe('NAI 토큰 교체가 클라우드에 닿지 못했을 때', () => {
  const tokenPuts = (): { token: string }[] =>
    h.cloud.find('PUT', '/api/pc/nai-token').map((c) => c.json)

  it('성공할 때까지 정보 확인 때마다 새 토큰을 다시 올리고, 올린 뒤에는 멈춘다', async () => {
    await h.sync.setCloudGen(true)
    h.cloud.calls.length = 0
    h.token.value = 'pst-test-FAKE-second'
    h.cloud.failNext('PUT /api/pc/nai-token', 2) // 바꾼 순간과 첫 재시도가 실패
    await h.sync.onNaiTokenChanged()
    expect(tokenPuts()).toHaveLength(1)

    await h.sync.refreshInfo()
    expect(tokenPuts()).toHaveLength(2)
    await h.sync.refreshInfo()
    expect(tokenPuts()).toEqual([
      { token: 'pst-test-FAKE-second' },
      { token: 'pst-test-FAKE-second' },
      { token: 'pst-test-FAKE-second' }
    ])
    await h.sync.refreshInfo()
    expect(tokenPuts()).toHaveLength(3) // 올렸으니 더 올리지 않는다
  })

  it('다시 올릴 때는 그 사이 또 바뀐 최신 토큰을 올린다', async () => {
    await h.sync.setCloudGen(true)
    h.cloud.calls.length = 0
    h.token.value = 'pst-test-FAKE-second'
    h.cloud.failNext('PUT /api/pc/nai-token', 1)
    await h.sync.onNaiTokenChanged()
    h.token.value = 'pst-test-FAKE-third'
    await h.sync.refreshInfo()
    expect(tokenPuts().at(-1)).toEqual({ token: 'pst-test-FAKE-third' })
  })

  it('그 사이 클라우드 생성을 껐거나 토큰이 없어졌으면 옛 토큰 교체를 다시 시도하지 않는다', async () => {
    await h.sync.setCloudGen(true)
    h.cloud.calls.length = 0
    h.token.value = 'pst-test-FAKE-second'
    h.cloud.failNext('PUT /api/pc/nai-token', 1)
    await h.sync.onNaiTokenChanged()
    await h.sync.setCloudGen(false)
    h.cloud.calls.length = 0
    h.token.value = 'pst-test-FAKE-third'
    await h.sync.refreshInfo()
    expect(tokenPuts()).toHaveLength(0)

    // 토큰이 아예 없어진 경우도 새로 올릴 게 없다
    await h.sync.setCloudGen(true)
    h.token.value = 'pst-test-FAKE-fourth'
    h.cloud.failNext('PUT /api/pc/nai-token', 1)
    await h.sync.onNaiTokenChanged()
    h.token.value = null
    h.cloud.calls.length = 0
    await h.sync.refreshInfo()
    expect(tokenPuts()).toHaveLength(0)
    expect(h.config.state.gen).toBe(false)
  })

  it('다시 올리는 요청에도 토큰은 어디에도 새지 않는다', async () => {
    await h.sync.setCloudGen(true)
    h.token.value = 'pst-test-FAKE-second'
    h.cloud.failNext('PUT /api/pc/nai-token', 1, 500, {
      ok: false,
      error: '실패 pst-test-FAKE-second'
    })
    await h.sync.onNaiTokenChanged()
    await h.sync.refreshInfo()
    expect(JSON.stringify(h.sync.status())).not.toContain('FAKE-second')
    expect(JSON.stringify(h.broadcasts)).not.toContain('FAKE-second')
  })
})

// ── 3차: 클라우드 저장소가 새로 생겼을 때 「이미 올림」 기록 ──────────

describe('클라우드 저장소가 새로 생겼을 때', () => {
  const twoRecent = (): void => {
    h.config.state.uploaded = [3, 4]
    h.recent.push(
      { id: 4, filePath: '/pics/4.png', sceneId: null, seed: 1, kind: 't2i', createdAt: 4 },
      { id: 3, filePath: '/pics/3.png', sceneId: null, seed: 1, kind: 't2i', createdAt: 3 }
    )
  }

  it('연결 파일을 새로 가져오면 「이미 올림」 기록을 비워 [최근 올리기]가 다시 올린다', async () => {
    twoRecent()
    expect(h.sync.uploadRecent(100)).toEqual({ queued: 0 })
    h.config.state.connect = 'imported'
    await h.sync.pollOnce()
    h.config.state.connect = 'none'
    expect(h.config.state.uploaded).toEqual([])
    expect(h.sync.uploadRecent(100)).toEqual({ queued: 2 })
    await h.sync.drainUploads()
    expect(h.config.state.uploaded).toEqual([3, 4])
    expect(h.cloud.find('PUT', '/api/pc/images/p3')).toHaveLength(1)
  })

  it('클라우드가 전체 올리기를 요구해도(저장소 초기화) 비우고, 간격 안에 또 요구하면 다시 비우지 않는다', async () => {
    twoRecent()
    h.cloud.needsFullSync = true
    await h.sync.pollOnce()
    expect(h.config.state.uploaded).toEqual([])
    expect(h.sync.uploadRecent(100)).toEqual({ queued: 2 })
    await h.sync.drainUploads()
    expect(h.config.state.uploaded).toEqual([3, 4])

    await h.sync.pollOnce() // 15초 안 — 전체 올리기도, 기록 비우기도 다시 하지 않는다
    expect(h.config.state.uploaded).toEqual([3, 4])
    h.clock.t += FULL_SYNC_MIN_GAP_MS
    await h.sync.pollOnce()
    expect(h.config.state.uploaded).toEqual([])
  })

  it('가져왔다 알림 대기표는 비우지 않는다 (같은 클라우드면 아직 유효하다)', async () => {
    h.config.state.pending = { cA: 100 }
    twoRecent()
    h.cloud.needsFullSync = true
    await h.sync.pollOnce()
    expect(h.config.state.uploaded).toEqual([])
    expect(h.config.state.pending).toEqual({ cA: 100 })
  })
})

// ── 3차: 가져왔다 알림 대기표를 설정에 적어 둔다 ─────────────────────

describe('클라우드 그림 가져오기 — 알림 대기표 영속', () => {
  const generated = (id: string, sceneId: number | null = 10): CloudGeneratedImage => ({
    id,
    jobId: 'j1',
    sceneId,
    presetId: sceneId == null ? null : 1,
    seed: 4242,
    sentPayload: '{"input":"p"}',
    createdAt: 1
  })

  it('알림이 실패하면 설정에 적고, 앱을 다시 켜도 같은 그림을 다시 저장하지 않으며 알림부터 다시 보낸다', async () => {
    h.cloud.generated.push({ item: generated('cA'), zip: await zipOf(PNG) })
    h.cloud.failNext('POST /api/pc/cloud-images/cA/imported', 1)
    await h.sync.importOnce()
    expect(h.saved).toHaveLength(1)
    expect(h.config.state.pending).toEqual({ cA: 100 })
    expect(h.config.state.uploaded).toContain(100)

    const restarted = h.restart() // 앱을 껐다 켰다 — 메모리는 사라졌다
    h.cloud.calls.length = 0
    await restarted.importOnce()
    expect(h.saved).toHaveLength(1) // 클라우드는 아직 imported=0 으로 주지만 다시 저장하지 않는다
    expect(h.cloud.imported.get('cA')).toBe(100)
    expect(h.config.state.pending).toEqual({})
    // 알림이 목록 조회보다 먼저 나갔다
    const paths = h.cloud.calls.map((c) => `${c.method} ${c.path}`)
    expect(paths.indexOf('POST /api/pc/cloud-images/cA/imported')).toBeLessThan(
      paths.indexOf('GET /api/pc/cloud-images')
    )
  })

  it('알림이 성공하면 대기표에서 빠져 설정에도 남지 않는다', async () => {
    h.cloud.generated.push({ item: generated('cA'), zip: await zipOf(PNG) })
    await h.sync.importOnce()
    expect(h.config.state.pending).toEqual({})
    expect(h.config.state.uploaded).toEqual([100])
  })

  it('저장 직후 설정 쓰기나 창 알림이 던져도 같은 그림을 다시 받지 않는다', async () => {
    h.cloud.generated.push({ item: generated('cA'), zip: await zipOf(PNG) })
    h.config.state.saveFails = true
    h.fail.broadcast = true
    for (let i = 0; i < 5; i++) await h.sync.importOnce()
    expect(h.saved).toHaveLength(1)
    expect(h.cloud.imported.get('cA')).toBe(100) // 알림은 갔다
    expect(h.sync.status().importedCount).toBe(1)
    expect(h.sync.status().error).toBeNull() // 연결도 오류 문구도 멀쩡하다
  })

  it('클라우드에 그 그림이 없다고(404) 하면 대기표에서 빼고 다른 그림 가져오기를 막지 않는다', async () => {
    h.config.state.pending = { gone: 7 }
    h.cloud.failNext('POST /api/pc/cloud-images/gone/imported', 1, 404)
    h.cloud.generated.push({ item: generated('cB'), zip: await zipOf(PNG) })
    await h.sync.importOnce()
    expect(h.config.state.pending).toEqual({})
    expect(h.saved).toHaveLength(1)
    expect(h.cloud.imported.get('cB')).toBe(100)
  })

  it('알림이 계속 안 가면(연결 문제) 대기표를 남겨 두고 목록 조회는 미룬다', async () => {
    h.config.state.pending = { cA: 7 }
    h.cloud.failNext('POST /api/pc/cloud-images/cA/imported', 99, 503)
    await h.sync.importOnce()
    expect(h.config.state.pending).toEqual({ cA: 7 })
    expect(h.cloud.find('GET', '/api/pc/cloud-images')).toHaveLength(0)
  })

  it('zip 을 받다 끊겨도 영문 오류를 띄우거나 실패 횟수를 소진하지 않는다 (연결 문제로 다음 차례에)', async () => {
    h.cloud.generated.push({ item: generated('cA'), zip: await zipOf(PNG) })
    h.cloud.brokenFiles = true
    for (let i = 0; i < 5; i++) await h.sync.importOnce()
    expect(h.saved).toHaveLength(0)
    const text = h.sync.status().error ?? ''
    expect(text).not.toMatch(/[A-Za-z]{4,}/) // 영문 문구가 아니다
    expect(text).toContain('시간 초과')
    h.cloud.brokenFiles = false
    await h.sync.importOnce() // 세 번을 넘게 실패했어도 건너뛰지 않고 가져온다
    expect(h.saved).toHaveLength(1)
  })
})

// ── 3차: 보관 장수를 바꿔도 꺼진 클라우드 생성을 되살리지 않는다 ─────

describe('보관 장수 변경', () => {
  it('클라우드가 Anlas 안전망으로 끈 클라우드 생성을 되살리지 않는다', async () => {
    await h.sync.setCloudGen(true)
    // 클라우드가 스스로 껐지만 PC 는 아직 모른다 (정보 확인은 30초마다)
    h.cloud.info = {
      ...h.cloud.info,
      settings: { cloudGenEnabled: false, keepImages: 2000 },
      hasNaiToken: false
    }
    h.cloud.calls.length = 0
    const status = await h.sync.setKeepImages(500)
    expect(h.cloud.last('PUT', '/api/pc/settings').json).toEqual({
      cloudGenEnabled: false,
      keepImages: 500
    })
    expect(h.cloud.info.settings.cloudGenEnabled).toBe(false)
    expect(h.config.state.gen).toBe(false)
    expect(status).toMatchObject({ keepImages: 500, cloudGen: { enabled: false } })
  })

  it('클라우드 생성이 켜져 있으면 켠 채로 보관 장수만 바뀐다', async () => {
    await h.sync.setCloudGen(true)
    h.cloud.calls.length = 0
    await h.sync.setKeepImages(500)
    expect(h.cloud.last('PUT', '/api/pc/settings').json).toEqual({
      cloudGenEnabled: true,
      keepImages: 500
    })
    expect(h.config.state.gen).toBe(true)
  })

  it('동기화가 꺼져 있으면 저장만 하고 클라우드는 부르지 않는다', async () => {
    h.config.state.enabled = false
    const status = await h.sync.setKeepImages(800)
    expect(status.keepImages).toBe(800)
    expect(h.cloud.calls).toHaveLength(0)
  })
})
