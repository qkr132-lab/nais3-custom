// 테스트 전용 — 종단 통합 시험용 「세계」.
// 워커(handleRequest·runCloudStep·handleAlarm) · PC 메인(createCloudSync + 실제 GenerationQueue) ·
// 가상 렌더러(폰 편집·작업 반영) · 폰(Request 직접)을 한 곳에 맞물린다.
// 진짜 NAI·네트워크는 쓰지 않고, 비밀값·NAI 토큰은 가짜 값이다.
import { expect, vi } from 'vitest'
import { createCloudClient } from '../../../src/main/cloud/client'
import {
  hashValue,
  type CharacterInput,
  type SnapshotSource
} from '../../../src/main/cloud/snapshot'
import { createCloudSync, type CloudSync } from '../../../src/main/cloud/sync'
import type {
  CloudConfigPort,
  CloudImageDeps,
  ConnectImportResult,
  SaveGeneratedInput
} from '../../../src/main/cloud/types'
import { GenerationQueue } from '../../../src/main/queue/generation-queue'
import { handleRequest } from '../../../cloud/src/core/router'
import type {
  CloudJob,
  CloudOp,
  CloudPreparedItem,
  CloudWork,
  CloudWorkResult
} from '../../../src/shared/cloud-contract'
import type { Fragment, GenerationRequest, Scene } from '../../../src/shared/types'
import { Harness, NAI_TOKEN, ORIGIN, PC_SECRET, type Dict } from './harness'

export { NAI_TOKEN, ORIGIN, PC_SECRET }
export type { Dict }

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ── PC 의 가짜 DB ───────────────────────────────────────────────────

export interface FakeImage {
  id: number
  filePath: string
  sceneId: number | null
  seed: number
  kind: string
  width: number
  height: number
}

export function makeScene(id: number, presetId: number, over: Partial<Scene> = {}): Scene {
  return {
    id,
    presetId,
    kind: 'scene',
    name: `씬 ${id}`,
    prompt: `scene prompt ${id}`,
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
    imageCount: 0,
    ...over
  }
}

/** 프리셋 2(씬 프리셋 「기본 씬」 · 배경 프리셋 「배경」) · 씬 3 · 캐릭터 2 · 조각 1 */
export class FakePcDb {
  presets = [
    { id: 1, name: '기본 씬', kind: 'scene' as const },
    { id: 2, name: '배경', kind: 'background' as const }
  ]
  scenes: Scene[] = [
    makeScene(1, 1, { name: '숲속', prompt: 'forest path, daylight' }),
    makeScene(2, 1, { name: '바닷가', prompt: 'beach, smile' }),
    makeScene(3, 2, { name: '교실', kind: 'background', prompt: 'classroom, window' })
  ]
  characters: CharacterInput[] = [
    {
      id: 10,
      name: '하나',
      prompt: 'hana, black hair',
      negativePrompt: '',
      enabled: true,
      folderId: null,
      role: null,
      outfitId: null
    },
    {
      id: 11,
      name: '두리',
      prompt: 'duri, blonde hair',
      negativePrompt: '',
      enabled: false,
      folderId: null,
      role: null,
      outfitId: null
    }
  ]
  fragments: Fragment[] = [
    { id: 1, name: 'hair', content: 'long hair\nshort hair', folderId: null }
  ]
  main = {
    prompt: '1girl, solo',
    negativePrompt: 'lowres',
    model: 'nai-diffusion-4-5-full',
    width: 832,
    height: 1216,
    steps: 28
  }
  images: FakeImage[] = []
  nextImageId = 100
  /** 휴지통에 든 씬 id — scenes:get 은 그래도 돌려주지만 scenes:isLive 는 거짓이고 목록·동기화에서는 빠진다 */
  readonly trashed = new Set<number>()

  /** scenes:get — 휴지통 씬도 돌려준다 */
  scene(id: number): Scene | undefined {
    return this.scenes.find((s) => s.id === id)
  }

  /** 휴지통에 들지 않은 씬 (listAllScenesLite 와 같다) */
  liveScenes(): Scene[] {
    return this.scenes.filter((s) => !this.trashed.has(s.id))
  }

  /** scenes:isLive */
  isLive(id: number): boolean {
    return this.scene(id) != null && !this.trashed.has(id)
  }

  updateScene(id: number, patch: Partial<Scene>): void {
    const scene = this.scene(id)
    if (scene) Object.assign(scene, patch)
  }

  source(): SnapshotSource {
    const live = this.liveScenes()
    return {
      presets: this.presets.map((p) => ({
        ...p,
        defaultWidth: null,
        defaultHeight: null,
        sceneCount: live.filter((s) => s.presetId === p.id).length
      })),
      scenes: live.map((s) => ({ ...s })),
      characters: this.characters.map((c) => ({ ...c })),
      charFolders: [],
      outfits: [{ id: 1, name: '교복' }],
      fragmentFolders: [],
      fragments: this.fragments.map((f) => ({ ...f })),
      mainParamsRaw: JSON.stringify(this.main),
      promptSplit: false,
      naiTier: 'opus'
    }
  }
}

// ── 요청 조립 (렌더러의 buildSceneRequest · buildMainRequest 흉내) ─────

export function baseRequest(over: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    seed: -1,
    prompt: '',
    negativePrompt: '',
    model: 'nai-diffusion-4-5-full',
    width: 832,
    height: 1216,
    steps: 28,
    cfgScale: 5,
    cfgRescale: 0,
    sampler: 'k_euler_ancestral',
    noiseSchedule: 'karras',
    variety: false,
    qualityToggle: false,
    ucPreset: 4,
    characterPrompts: [],
    useCoords: false,
    ...over
  }
}

const enabledCharacters = (db: FakePcDb): GenerationRequest['characterPrompts'] =>
  db.characters
    .filter((c) => c.enabled)
    .map((c) => ({ prompt: c.prompt, negativePrompt: c.negativePrompt, enabled: true }))

export function mainRequest(db: FakePcDb): GenerationRequest {
  return baseRequest({
    prompt: db.main.prompt,
    negativePrompt: db.main.negativePrompt,
    model: db.main.model,
    width: db.main.width,
    height: db.main.height,
    steps: db.main.steps,
    characterPrompts: enabledCharacters(db)
  })
}

/** 씬 요청 — 기본 프롬프트(메인) + 씬 프롬프트. 클라우드는 sceneBase* 로 폰에서 고친 씬 프롬프트를 다시 합친다 */
export function sceneRequest(db: FakePcDb, scene: Scene): GenerationRequest {
  const base = db.main.prompt
  return baseRequest({
    prompt: scene.prompt ? `${base}, ${scene.prompt}` : base,
    negativePrompt: scene.negativePrompt
      ? `${db.main.negativePrompt}, ${scene.negativePrompt}`
      : db.main.negativePrompt,
    model: db.main.model,
    width: scene.width,
    height: scene.height,
    steps: db.main.steps,
    characterPrompts: enabledCharacters(db),
    sceneId: scene.id,
    sceneBasePrompt: base,
    sceneBaseNegativePrompt: db.main.negativePrompt
  })
}

/** 렌더러가 올리는 완성 요청 묶음 (시드 -1) */
export function buildPrepared(db: FakePcDb): CloudPreparedItem[] {
  const toItem = (key: string, request: GenerationRequest): CloudPreparedItem => ({
    key,
    hash: hashValue(request),
    request
  })
  return [
    toItem('main', mainRequest(db)),
    ...db.liveScenes().map((s) => toItem(`scene:${s.id}`, sceneRequest(db, s)))
  ]
}

// ── 메모리 설정 ─────────────────────────────────────────────────────

export interface MemoryConfigState {
  url: string
  secret: boolean
  enabled: boolean
  uploadImages: boolean
  keepImages: number
  gen: boolean
  uploaded: number[]
  /** 가져왔다고 아직 못 알린 클라우드 그림 (설정 cloud_upload_state 의 pendingImported) */
  pendingImported: Record<string, number>
  connect: ConnectImportResult
}

export type MemoryConfig = CloudConfigPort & { state: MemoryConfigState }

function memoryConfig(): MemoryConfig {
  const s: MemoryConfigState = {
    url: ORIGIN,
    secret: true,
    enabled: true,
    uploadImages: true,
    keepImages: 2000,
    gen: false,
    uploaded: [],
    pendingImported: {},
    connect: 'none'
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
    // 실제 설정(config.ts)처럼 두 기록을 한 덩어리로 저장하고, 앱이 다시 켜져도 읽어 온다
    loadUploadState: () => ({
      uploaded: [...s.uploaded],
      ...(Object.keys(s.pendingImported).length > 0
        ? { pendingImported: { ...s.pendingImported } }
        : {})
    }),
    saveUploadState: (state) => {
      s.uploaded = [...state.uploaded]
      s.pendingImported = { ...(state.pendingImported ?? {}) }
    },
    importConnectFile: () => s.connect
  }
}

// ── 막이 · 오류 ─────────────────────────────────────────────────────

const abortError = (): Error =>
  Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })

/** 가짜 generate 를 붙들어 두는 문 — release 하면 대기 중인 것이 한꺼번에 풀린다. 취소(abort)는 거절로 */
class Gate {
  private open = false
  private waiters: (() => void)[] = []
  wait(signal: AbortSignal): Promise<void> {
    if (this.open) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      this.waiters.push(resolve)
      signal.addEventListener('abort', () => reject(abortError()), { once: true })
    })
  }
  release(): void {
    this.open = true
    for (const w of this.waiters.splice(0)) w()
  }
}

// ── 가상 렌더러 ─────────────────────────────────────────────────────

/**
 * cloud-bridge.ts + cloud-prepared.ts 의 동작을 흉내 낸다 (스토어·IPC 대신 가짜 DB·메인 직접 호출).
 * 편집은 가짜 DB 에 반영, 작업은 cloudJobId 를 단 요청 count 개를 큐에 enqueueMany, 끝나면 workDone.
 */
export class VirtualRenderer {
  /** 이미 처리한 작업의 결과 — 실제 브리지의 doneJobs (새로고침하면 사라진다) */
  readonly doneJobs = new Map<string, CloudWorkResult['jobs'][number]>()
  /**
   * 이미 처리한 편집 줄 → 반영에 성공했는가 (실제 브리지의 appliedOps).
   * 실패도 기억해, 같은 줄이 다시 오면 다시 반영하지 않고 failedOpIds 에 계속 실어 보낸다
   */
  readonly appliedOps = new Map<number, boolean>()
  /** 이 조건에 맞는 편집은 반영에 실패한다 (scenes:update IPC 오류 같은 것) — 비워 두면 모두 반영된다 */
  failOp: ((op: CloudOp) => boolean) | null = null
  /** 켜 둘 수 있는 캐릭터 수 상한 (cloud-bridge 의 getMaxCharacters) — 넘겨 켜는 편집은 실패한다 */
  maxCharacters = Number.POSITIVE_INFINITY
  /** 마지막으로 메인에 보낸 완성 요청 해시 (cloud-prepared 의 sent) */
  readonly sentPrepared = new Map<string, string>()
  readonly errors: unknown[] = []
  /** 받은 cloud:work 기록 */
  readonly works: CloudWork[] = []
  /** 켜 두면 다음 한 번은 큐에 넣기까지만 하고 workDone 을 부르지 않는다 (처리 도중 새로고침 흉내) */
  dropWorkDone = false
  /** 진행 중인 일 수 (World.settle 이 본다) */
  busy = 0
  private chain: Promise<void> = Promise.resolve()
  private cloudGenOn = false
  private seedCounter = 1000

  constructor(private readonly pc: Pc) {}

  private run(task: () => Promise<void>): void {
    this.busy++
    this.chain = this.chain
      .then(task)
      .catch((e) => void this.errors.push(e))
      .finally(() => void this.busy--)
  }

  onWork(work: CloudWork): void {
    this.works.push(work)
    this.run(() => this.handle(work))
  }

  onNeedPrepared(full: boolean): void {
    if (full) this.sentPrepared.clear()
    this.run(() => this.pushPrepared())
  }

  onStatus(enabled: boolean): void {
    const was = this.cloudGenOn
    this.cloudGenOn = enabled
    if (enabled && !was) this.run(() => this.pushPrepared())
  }

  /** 생성 설정·캐릭터·씬이 바뀌었다 (cloud-prepared 의 touch) */
  touch(): void {
    if (this.cloudGenOn) this.run(() => this.pushPrepared())
  }

  /** 반영한다. 못 하면 던진다 (cloud-bridge 의 applyOp 와 같다 — 상한을 넘겨 캐릭터를 켜는 편집도 실패) */
  private applyOp(op: CloudOp): void {
    if (this.failOp?.(op)) throw new Error('시험: 편집 반영 실패')
    const db = this.pc.world.db
    switch (op.type) {
      case 'scene:update':
        db.updateScene(op.sceneId, op.patch)
        break
      case 'char:update': {
        const card = db.characters.find((c) => c.id === op.charId)
        if (op.patch.enabled === true) {
          const others = db.characters.filter((c) => c.enabled && c.id !== op.charId).length
          if (others >= this.maxCharacters) {
            throw new Error(`캐릭터는 최대 ${this.maxCharacters}명까지 켤 수 있습니다`)
          }
        }
        if (card) Object.assign(card, op.patch)
        break
      }
      case 'main:update': {
        if (typeof op.patch.prompt === 'string') db.main.prompt = op.patch.prompt
        if (typeof op.patch.negativePrompt === 'string')
          db.main.negativePrompt = op.patch.negativePrompt
        break
      }
      case 'job:cancel':
        break
    }
  }

  private runJob(job: CloudJob): string[] {
    const db = this.pc.world.db
    const count = Math.max(1, Math.min(20, Math.floor(job.count) || 1))
    let base: GenerationRequest
    if (job.target.type === 'main') {
      base = mainRequest(db)
    } else {
      // cloud-bridge.runJob 과 같은 순서 — scenes:get 은 휴지통 씬도 돌려주므로 scenes:isLive 를 먼저 본다
      if (!db.isLive(job.target.sceneId)) throw new Error('씬이 PC에 없음')
      const scene = db.scene(job.target.sceneId)
      if (!scene) throw new Error('씬이 PC에 없음')
      base = sceneRequest(db, scene)
    }
    const requests: GenerationRequest[] = []
    for (let i = 0; i < count; i++) {
      requests.push({ ...base, seed: this.seedCounter++, cloudJobId: job.id })
    }
    return this.pc.queue.enqueueMany(requests)
  }

  private async handle(work: CloudWork): Promise<void> {
    const opIds: number[] = []
    /** 반영하지 못한 줄 (이전에 실패한 줄 포함) — 메인에 알려 폰 사본을 PC 실제 값으로 되돌리게 한다 */
    const failedOpIds: number[] = []
    for (const op of [...work.ops].sort((a, b) => a.id - b.id)) {
      const known = this.appliedOps.get(op.id)
      if (known === undefined) {
        let applied = true
        try {
          this.applyOp(op)
        } catch {
          applied = false
        }
        this.appliedOps.set(op.id, applied)
        if (!applied) failedOpIds.push(op.id)
      } else if (!known) {
        failedOpIds.push(op.id)
      }
      opIds.push(op.id)
    }
    const jobs: CloudWorkResult['jobs'] = []
    for (const job of work.jobs) {
      const known = this.doneJobs.get(job.id)
      if (known) {
        jobs.push(known)
        continue
      }
      let result: CloudWorkResult['jobs'][number]
      try {
        result = { id: job.id, queueIds: this.runJob(job) }
      } catch (e) {
        result = { id: job.id, queueIds: [], error: e instanceof Error ? e.message : String(e) }
      }
      this.doneJobs.set(job.id, result)
      jobs.push(result)
    }
    if (opIds.length === 0 && jobs.length === 0) return
    if (opIds.length > 0 || jobs.length > 0) this.touch()
    if (this.dropWorkDone) {
      this.dropWorkDone = false
      return
    }
    // 실제 브리지처럼 — 실패한 줄이 없으면 failedOpIds 자리 자체를 만들지 않는다
    await this.pc.sync.workDone({
      opIds,
      ...(failedOpIds.length > 0 ? { failedOpIds } : {}),
      jobs
    })
  }

  private async pushPrepared(): Promise<void> {
    const items = buildPrepared(this.pc.world.db)
    const changed = items.filter((i) => this.sentPrepared.get(i.key) !== i.hash)
    const gone = [...this.sentPrepared.keys()].filter((k) => !items.some((i) => i.key === k))
    if (changed.length === 0 && gone.length === 0) return
    await this.pc.sync.putPrepared({ items: changed, allKeys: items.map((i) => i.key) })
    for (const item of changed) this.sentPrepared.set(item.key, item.hash)
    for (const key of gone) this.sentPrepared.delete(key)
  }
}

// ── PC 한 대 (메인 프로세스 + 렌더러 한 창) ───────────────────────────

export class Pc {
  readonly queue: GenerationQueue
  readonly sync: CloudSync
  renderer: VirtualRenderer
  readonly broadcasts: { channel: string; payload: unknown }[] = []
  /** 가짜 generate 가 처리한 요청 */
  readonly generated: { queueId: string; request: GenerationRequest }[] = []
  /** enqueueMany 호출마다 넘어온 요청들 */
  readonly enqueueCalls: GenerationRequest[][] = []
  /** 켜 두면 generate 가 이 문장으로 던진다 (생성 실패 흉내) */
  failGenerateWith: string | null = null
  /** 앱이 꺼졌다 — 이후 클라우드 요청은 전부 실패한다 */
  dead = false
  private gate: Gate | null = null

  constructor(readonly world: World) {
    this.queue = new GenerationQueue((request, id, signal) => this.generate(request, id, signal))
    this.queue.setDelayMs(0)
    const enqueueMany = this.queue.enqueueMany.bind(this.queue)
    this.queue.enqueueMany = (requests: GenerationRequest[]): string[] => {
      this.enqueueCalls.push(requests)
      return enqueueMany(requests)
    }
    this.renderer = new VirtualRenderer(this)
    const client = createCloudClient({
      fetch: ((input: string | URL | Request, init?: RequestInit) => {
        if (this.dead) return Promise.reject(new TypeError(`fetch failed ${PC_SECRET}`))
        return world.fetch(input, init)
      }) as typeof fetch,
      url: () => world.config.url(),
      secret: () => PC_SECRET
    })
    this.sync = createCloudSync({
      client,
      config: world.config,
      queue: this.queue,
      broadcast: ((channel: string, payload: unknown) =>
        this.onBroadcast(channel, payload)) as never,
      readSource: () => world.db.source(),
      images: world.imageDeps,
      getNaiToken: () => world.naiToken,
      appVersion: '1.0.0-e2e',
      now: () => world.cloud.clock,
      sleep: async () => {}
    })
  }

  private onBroadcast(channel: string, payload: unknown): void {
    // 기록은 그 순간의 복사본으로 (뒤에 객체가 바뀌어도 당시 내용을 본다)
    this.broadcasts.push({ channel, payload: JSON.parse(JSON.stringify(payload ?? null)) })
    if (this.dead) return
    if (channel === 'cloud:work') this.renderer.onWork(payload as CloudWork)
    else if (channel === 'cloud:needPrepared') {
      this.renderer.onNeedPrepared((payload as { full: boolean }).full)
    } else if (channel === 'cloud:status') {
      this.renderer.onStatus(!!(payload as { cloudGen: { enabled: boolean } }).cloudGen.enabled)
    }
  }

  channel<T = Dict>(name: string): T[] {
    return this.broadcasts.filter((b) => b.channel === name).map((b) => b.payload as T)
  }

  /** 큐에 쌓인 생성을 붙들어 둔다 (release 전까지 첫 항목이 generating 에서 멈춤) */
  hold(): void {
    if (!this.gate) this.gate = new Gate() // 이미 붙들었으면 그대로 (먼저 건 문이 풀리지 않은 채 남지 않게)
  }

  release(): void {
    this.gate?.release()
    this.gate = null
  }

  private async generate(
    request: GenerationRequest,
    id: string,
    signal: AbortSignal
  ): Promise<string> {
    if (this.gate) await this.gate.wait(signal)
    if (signal.aborted) throw abortError()
    if (this.failGenerateWith) throw new Error(this.failGenerateWith)
    const db = this.world.db
    const imageId = db.nextImageId++
    const filePath = `C:/fake/pics/${imageId}.png`
    const sceneId = request.sceneId ?? null
    db.images.push({
      id: imageId,
      filePath,
      sceneId,
      seed: request.seed,
      kind: sceneId != null ? 'scene' : 't2i',
      width: request.width,
      height: request.height
    })
    if (sceneId != null) {
      const scene = db.scene(sceneId)
      if (scene) scene.imageCount++
    }
    this.generated.push({ queueId: id, request })
    this.world.cloud.tick(1000) // 그림마다 만든 시각이 다르다
    // index.ts 의 저장 직후 훅
    this.sync.onImageSaved({
      id: imageId,
      filePath,
      sceneId: request.sceneId,
      seed: request.seed,
      kind: sceneId != null ? 'scene' : 't2i',
      width: request.width,
      height: request.height
    })
    return filePath
  }

  /** 렌더러만 새로고침 — 메모리(처리 기록)는 사라지고 메인에 다시 준비됐다고 알린다 */
  reloadRenderer(): VirtualRenderer {
    this.renderer = new VirtualRenderer(this)
    this.sync.rendererReady()
    return this.renderer
  }

  /** 앱 종료 — 큐 항목은 멈춘 채 사라지고, 이후 클라우드 요청은 나가지 않는다 */
  kill(): void {
    this.dead = true
    this.sync.stop()
    // 프로세스가 죽었으니 큐도 더는 돌지 않는다 (남은 항목이 뒤에서 계속 만들어 내지 않게)
    const live = this.queue
      .statusLite()
      .items.filter((i) => i.state === 'pending' || i.state === 'generating')
      .map((i) => i.id)
    if (live.length > 0) this.queue.cancel(live)
  }
}

// ── 실제 렌더러 스토어의 「모두 취소」 ─────────────────────────────────

export interface RendererIpcCall {
  channel: string
  req: unknown
}

/**
 * 실제 렌더러 스토어(generation-store.cancelAll → scenes-store.restoreReserves)를 이 세계의 PC 에 연결해 한 번 누른다.
 * 스토어가 읽는 큐 상태는 메인의 진짜 statusLite(), 스토어가 부르는 IPC 는 진짜 큐·가짜 DB 로 이어진다.
 * 돌려주는 값 = 스토어가 부른 IPC 기록. 전역(window · localStorage)은 끝나면 되돌린다.
 */
export async function pressCancelAll(pc: Pc): Promise<RendererIpcCall[]> {
  const calls: RendererIpcCall[] = []
  const db = pc.world.db
  const handlers: Record<string, (req: never) => unknown> = {
    'queue:cancel': (req: { ids: string[] }) => void pc.queue.cancel(req.ids),
    'scenes:get': (req: { id: number }) => ({ scene: db.scene(req.id) ?? null }),
    'scenes:update': (req: { id: number; patch: Partial<Scene> }) =>
      void db.updateScene(req.id, req.patch),
    'scenes:list': () => ({ items: db.liveScenes().map((s) => ({ ...s })) })
  }
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined })
  vi.stubGlobal('window', {
    nais: {
      invoke: async (channel: string, req: unknown): Promise<unknown> => {
        calls.push({ channel, req })
        const handler = handlers[channel]
        if (!handler) throw new Error(`시험: 응답기가 없는 채널 ${channel}`)
        return handler(req as never)
      },
      on: (): (() => void) => () => undefined
    }
  })
  try {
    const { useGenerationStore } = await import('../../../src/renderer/src/stores/generation-store')
    // 메인이 렌더러로 보내는 요약 그대로 (cloudJobId 가 실려 있어야 폰 작업 항목을 가린다)
    useGenerationStore.setState({ queue: pc.queue.statusLite() })
    await useGenerationStore.getState().cancelAll()
  } finally {
    vi.unstubAllGlobals()
  }
  return calls
}

// ── 세계 ────────────────────────────────────────────────────────────

interface Injection {
  match: (method: string, path: string) => boolean
  respond: () => Response | Error
  left: number
}

/** 잔재 없이 끝나도록 — 응답에 담긴 글을 모두 모아 비밀값 검사에 쓴다 */
export class World {
  readonly cloud = new Harness()
  readonly db = new FakePcDb()
  readonly config = memoryConfig()
  naiToken: string | null = NAI_TOKEN
  phoneToken = ''
  readonly pcs: Pc[] = []
  /** 워커가 돌려준 글 응답 전부 (PC·폰 모두) */
  readonly responses: { label: string; text: string }[] = []
  /** PC → 워커 요청 기록 */
  readonly requests: { method: string; path: string; status: number; json?: Dict }[] = []
  inflight = 0
  private injections: Injection[] = []

  /** saveGeneratedImage 모의 — PC 에 새 그림 번호를 주고 호출 인자를 기록한다 */
  readonly saveGenerated = vi.fn(async (input: SaveGeneratedInput) => {
    const id = this.db.nextImageId++
    const filePath = `C:/fake/saved/${id}.png`
    // 씬 그림이면 그 씬의 그림 수가 늘어난다 (PC 가 직접 만든 것과 같다)
    if (input.sceneId != null) {
      const scene = this.db.scene(input.sceneId)
      if (scene) scene.imageCount++
    }
    this.db.images.push({
      id,
      filePath,
      sceneId: input.sceneId ?? null,
      seed: input.seed,
      kind: input.kind,
      width: 0,
      height: 0
    })
    return { id, filePath }
  })

  readonly imageDeps: CloudImageDeps = {
    readForUpload: async (id) => {
      const image = this.db.images.find((i) => i.id === id)
      const text = new TextEncoder().encode(`img-${id}`)
      return {
        webp: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, ...text]),
        thumb: new Uint8Array([0x52, 0x49, 0x46, 0x46, ...text]),
        width: image?.width || 832,
        height: image?.height || 1216
      }
    },
    listRecent: (limit) =>
      [...this.db.images]
        .reverse()
        .slice(0, limit)
        .map((i) => ({
          id: i.id,
          filePath: i.filePath,
          sceneId: i.sceneId,
          seed: i.seed,
          kind: i.kind,
          createdAt: this.cloud.clock + i.id // 번호가 클수록 나중에 만든 그림
        })),
    presetIdOfScene: (sceneId) => this.db.scene(sceneId)?.presetId ?? null,
    // 휴지통에 든 씬은 없는 것으로 본다 (실제 findScene 과 같다)
    findScene: (sceneId) => {
      const scene = this.db.isLive(sceneId) ? this.db.scene(sceneId) : undefined
      return scene ? { id: scene.id, name: scene.name, presetId: scene.presetId } : null
    },
    presetName: (presetId) => this.db.presets.find((p) => p.id === presetId)?.name ?? null,
    saveGenerated: (input) => this.saveGenerated(input)
  }

  /** PC → 워커 (표준 Request 를 handleRequest 로 바로) */
  readonly fetch = async (
    input: string | URL | Request,
    init: RequestInit = {}
  ): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    )
    const method = (init.method ?? 'GET').toUpperCase()
    const path = url.pathname
    this.inflight++
    try {
      let json: Dict | undefined
      if (typeof init.body === 'string') json = JSON.parse(init.body)
      const injection = this.injections.find((i) => i.left > 0 && i.match(method, path))
      if (injection) {
        injection.left--
        const made = injection.respond()
        if (made instanceof Error) throw made
        // 시험이 꾸민 응답이라 워커가 만든 글이 아니다 — 비밀값 검사 대상(responses)에 넣지 않는다
        this.requests.push({ method, path, status: made.status, json })
        return made
      }
      const res = await handleRequest(
        this.cloud.deps,
        new Request(url.href, {
          method,
          headers: init.headers,
          body: init.body as BodyInit | null | undefined,
          signal: init.signal
        })
      )
      this.requests.push({ method, path, status: res.status, json })
      await this.record(`pc ${method} ${path}`, res)
      return res
    } finally {
      this.inflight--
    }
  }

  /** 글 응답이면 복사해서 기록한다 (그림·zip 같은 이진 응답은 건너뜀) */
  private async record(label: string, res: Response): Promise<void> {
    const type = (res.headers.get('content-type') ?? '').toLowerCase()
    if (!/json|text|xml|svg/.test(type)) return
    this.responses.push({ label, text: await res.clone().text() })
  }

  /** 다음 n번 이 요청을 가로채서 응답을 대신 준다 (Error 면 던진다) */
  inject(
    match: (method: string, path: string) => boolean,
    respond: () => Response | Error,
    times = 1
  ): void {
    this.injections.push({ match, respond, left: times })
  }

  /** 새 PC 앱을 띄운다 (렌더러까지 준비됨). 앞의 PC 는 그대로 둔다 — 끄려면 kill() */
  startPc(opts: { rendererReady?: boolean } = {}): Pc {
    const pc = new Pc(this)
    this.pcs.push(pc)
    if (opts.rendererReady !== false) pc.sync.rendererReady()
    return pc
  }

  tick(ms: number): void {
    this.cloud.tick(ms)
  }

  // ── 폰 ──────────────────────────────────────────────────────────

  /** PC 가 연결 코드를 만들고 폰이 연결한다 → 폰 토큰 (this.phoneToken 에도 둔다) */
  async pairPhone(pc: Pc, name = '내 폰'): Promise<string> {
    const pairing = await pc.sync.pairing()
    const res = await this.cloud.call('POST', '/api/pair', { body: { code: pairing.code, name } })
    const text = await res.text()
    this.responses.push({ label: 'phone POST /api/pair', text })
    this.phoneToken = (JSON.parse(text) as { token: string }).token
    return this.phoneToken
  }

  /** 폰 JSON 요청 */
  async phone(
    method: string,
    path: string,
    body?: unknown,
    token = this.phoneToken
  ): Promise<{ status: number; json: Dict }> {
    const res = await this.cloud.call(method, path, { auth: token || undefined, body })
    const text = await res.text()
    this.responses.push({ label: `phone ${method} ${path}`, text })
    return { status: res.status, json: JSON.parse(text) as Dict }
  }

  /** 폰 이진 요청 (그림 원본) */
  async phoneBytes(
    path: string,
    token = this.phoneToken
  ): Promise<{ status: number; type: string; bytes: Uint8Array }> {
    const res = await this.cloud.call('GET', path, { auth: token })
    return {
      status: res.status,
      type: res.headers.get('content-type') ?? '',
      bytes: new Uint8Array(await res.arrayBuffer())
    }
  }

  /** 폰이 작업을 만든다 (requestId 를 주면 응답 유실 재시도 방지용 번호가 실린다) */
  async createJob(
    target: { type: 'scene'; sceneId: number } | { type: 'main' },
    count: number,
    place: 'auto' | 'pc' | 'cloud' = 'auto',
    requestId?: string
  ): Promise<{ status: number; json: Dict; id: string }> {
    const made = await this.phone('POST', '/api/jobs', {
      target,
      count,
      place,
      ...(requestId ? { requestId } : {})
    })
    return { ...made, id: (made.json.job?.id ?? '') as string }
  }

  /** PC → 워커 요청 중 이 메서드·경로의 것 (오래된 순) */
  requestsOf(method: string, path: string): World['requests'] {
    return this.requests.filter((r) => r.method === method && r.path === path)
  }

  /** 폰이 본 작업 하나 */
  async phoneJob(id: string): Promise<CloudJob> {
    const state = await this.phone('GET', '/api/state')
    const job = (state.json.jobs as CloudJob[]).find((j) => j.id === id)
    if (!job) throw new Error(`폰 작업 목록에 ${id} 가 없음`)
    return job
  }

  // ── 워커 쪽 도우미 ──────────────────────────────────────────────

  job(id: string): Dict {
    return this.cloud.jobRow(id)
  }

  /** 걸려 있는 알람을 모두 울린다 (클라우드 생성) */
  runAlarms(max = 60): Promise<number> {
    return this.cloud.runAlarms(max)
  }

  unackedOps(): number {
    return this.cloud.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ops WHERE acked = 0`).one()
      .n
  }

  // ── 기다리기 ────────────────────────────────────────────────────

  /** 진행 중인 요청·렌더러 일이 없는 상태가 이어질 때까지 (큐 자체는 기다리지 않는다) */
  async settle(): Promise<void> {
    for (let calm = 0; calm < 3;) {
      await sleep(5)
      const busy = this.inflight > 0 || this.pcs.some((p) => p.renderer.busy > 0)
      calm = busy ? 0 : calm + 1
    }
  }

  /** 렌더러·요청이 가라앉고 올리기 대기열도 비었다 */
  async drain(pc: Pc): Promise<void> {
    await this.settle()
    await pc.sync.drainUploads()
    await this.settle()
  }

  /** 큐 항목이 전부 끝 상태가 될 때까지 */
  async queueIdle(pc: Pc, timeout = 5000): Promise<void> {
    await vi.waitFor(
      () => {
        const items = pc.queue.statusLite().items
        expect(items.every((i) => i.state !== 'pending' && i.state !== 'generating')).toBe(true)
      },
      { timeout, interval: 10 }
    )
  }

  async waitFor(check: () => void, timeout = 5000): Promise<void> {
    await vi.waitFor(check, { timeout, interval: 10 })
  }

  // ── 비밀값 검사 ─────────────────────────────────────────────────

  /** 워커 저장소(표·R2)를 글자열로 — NAI 토큰이 맡겨진 단 한 줄(kv secret:nai)만 뺀다 */
  dumpCloudStorage(): string {
    const sql = this.cloud.sql
    const tables = sql
      .exec<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
      )
      .toArray()
    const parts: string[] = []
    for (const { name } of tables) {
      const rows =
        name === 'kv'
          ? sql.exec(`SELECT k, v FROM kv WHERE k <> 'secret:nai'`).toArray()
          : sql.exec(`SELECT * FROM ${name}`).toArray()
      parts.push(`${name}: ${JSON.stringify(rows)}`)
    }
    for (const [key, file] of this.cloud.bucket.files) {
      parts.push(`r2 ${key}: ${Buffer.from(file.bytes).toString('latin1')}`)
    }
    return parts.join('\n')
  }

  /** 어느 응답·broadcast·상태 문자열·저장소에도 가짜 NAI 토큰과 PC 비밀값이 없다 */
  assertNoSecrets(extra: [string, string][] = [], moreSecrets: string[] = []): void {
    const haystacks: [string, string][] = [
      ...this.responses.map((r): [string, string] => [r.label, r.text]),
      ...this.pcs.flatMap((pc, index) => [
        ...pc.broadcasts.map((b): [string, string] => [
          `pc${index} broadcast ${b.channel}`,
          JSON.stringify(b.payload)
        ]),
        [`pc${index} status`, JSON.stringify(pc.sync.status())] as [string, string]
      ]),
      ...extra
    ]
    const secrets = [NAI_TOKEN, PC_SECRET, ...moreSecrets]
    for (const [label, text] of haystacks) {
      for (const secret of secrets) expect(text, label).not.toContain(secret)
      expect(text, label).not.toMatch(/pst-/)
    }
    const storage = this.dumpCloudStorage()
    for (const secret of secrets) expect(storage, '워커 저장소').not.toContain(secret)
  }

  /** 테스트 끝 — 막아 둔 것을 풀고 PC 를 끈다 */
  dispose(): void {
    for (const pc of this.pcs) {
      pc.release()
      pc.kill()
    }
  }
}
