import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudPcStatus, CloudWork, CloudWorkResult } from '../src/shared/cloud-contract'
import type { CharacterCard, GenerationRequest, Scene } from '../src/shared/types'

/**
 * 모바일 클라우드 — PC 렌더러 쪽 (cloud-bridge · cloud-prepared · generation/scenes 스토어 리팩터).
 * window.nais 는 메모리 가짜라 NAI·네트워크·파일에 닿지 않는다.
 */

const { calls, responders, listeners, emit, invoke } = vi.hoisted(() => {
  const calls: { channel: string; req: unknown }[] = []
  const responders = new Map<string, (req: unknown) => unknown>()
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const invoke = vi.fn(async (channel: string, req: unknown) => {
    calls.push({ channel, req })
    const responder = responders.get(channel)
    if (!responder) throw new Error(`테스트: 응답기가 없는 채널 ${channel}`)
    return responder(req)
  })
  const emit = (channel: string, payload: unknown): void =>
    listeners.get(channel)?.forEach((listener) => listener(payload))
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() })
  vi.stubGlobal('window', {
    nais: {
      invoke,
      on: (channel: string, listener: (payload: unknown) => void) => {
        const set = listeners.get(channel) ?? new Set()
        set.add(listener)
        listeners.set(channel, set)
        return () => set.delete(listener)
      }
    }
  })
  return { calls, responders, listeners, emit, invoke }
})

import {
  hashText,
  startCloudPrepared,
  stableStringify,
  toCloudRequest
} from '../src/renderer/src/lib/cloud-prepared'
import { startCloudBridge } from '../src/renderer/src/lib/cloud-bridge'
import { DEFAULT_REQUEST, useGenerationStore } from '../src/renderer/src/stores/generation-store'
import {
  buildSceneRequest,
  enqueueSceneRequests,
  useScenesStore
} from '../src/renderer/src/stores/scenes-store'
import { setMaxCharacters, useCharactersStore } from '../src/renderer/src/stores/characters-store'
import { useOutfitsStore } from '../src/renderer/src/stores/outfits-store'
import { useCharRefsStore, useVibesStore } from '../src/renderer/src/stores/refs-store'
import { useSceneExtrasStore } from '../src/renderer/src/stores/scene-extras-store'
import { useToastStore } from '../src/renderer/src/stores/toast-store'

const card = (id: number, prompt: string, enabled = false): CharacterCard =>
  ({
    id,
    name: `card ${id}`,
    prompt,
    negativePrompt: '',
    enabled,
    center: { x: 0.5, y: 0.5 },
    role: null,
    slotNo: null,
    charRefId: null,
    partnerTags: '',
    outfitId: null
  }) as CharacterCard

const makeScene = (id: number, over: Partial<Scene> = {}): Scene =>
  ({
    id,
    presetId: 1,
    kind: 'scene',
    name: `씬 ${id}`,
    prompt: `forest ${id}`,
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
  }) as Scene

const callsOf = (channel: string): { channel: string; req: unknown }[] =>
  calls.filter((c) => c.channel === channel)

let queueSeq = 0
function installResponders(): void {
  responders.clear()
  const enqueueIds = (n: number): string[] => Array.from({ length: n }, () => `q${++queueSeq}`)
  responders.set('settings:set', () => undefined)
  responders.set('queue:enqueue', (req) => ({ ids: enqueueIds((req as { count: number }).count) }))
  responders.set('queue:enqueueMany', (req) => ({
    ids: enqueueIds((req as { requests: unknown[] }).requests.length)
  }))
  responders.set('queue:cancel', () => undefined)
  responders.set('scenes:update', () => undefined)
  responders.set('scenes:list', () => ({ items: [] }))
  responders.set('scenes:get', (req) => ({ scene: makeScene((req as { id: number }).id) }))
  responders.set('scenes:isLive', () => ({ live: true }))
  responders.set('chars:update', () => undefined)
  responders.set('cloud:workDone', () => undefined)
  responders.set('cloud:rendererReady', () => undefined)
  responders.set('cloud:prepared', () => undefined)
}

function resetStores(): void {
  useGenerationStore.setState({
    hydrated: true,
    request: { ...DEFAULT_REQUEST, prompt: '1girl', negativePrompt: 'bad' },
    seedLocked: false,
    batchCount: 3,
    promptSplitEnabled: false,
    transparentBackground: false,
    source: null,
    queue: null
  })
  useCharactersStore.setState({ loaded: true, items: [] })
  useOutfitsStore.setState({
    loaded: true,
    items: [],
    stripOnNude: false,
    exposeWorn: false,
    futaReassembly: false,
    futaViewFix: true,
    eyesClosedStrip: false,
    nudePinkNipples: false
  })
  useVibesStore.setState({ loaded: true, items: [] })
  useCharRefsStore.setState({ loaded: true, items: [] })
  useSceneExtrasStore.setState({
    loaded: true,
    sequenceEnabled: false,
    entries: [],
    additionsEnabled: false,
    additions: {},
    nudeStrips: {},
    transparentBackgrounds: {}
  })
  useScenesStore.setState({
    scenes: [],
    presets: [],
    libraryKind: 'scene',
    libraryLoading: false,
    activePresetId: 1,
    selectedId: null
  })
  useToastStore.setState({ toasts: [] })
  setMaxCharacters(6)
}

beforeEach(() => {
  calls.length = 0
  listeners.clear()
  queueSeq = 0
  installResponders()
  resetStores()
})

describe('해시·정리 도우미', () => {
  it('FNV-1a 64 공개 시험값과 같다', () => {
    expect(hashText('')).toBe('cbf29ce484222325')
    expect(hashText('a')).toBe('af63dc4c8601ec8c')
    expect(hashText('foobar')).toBe('85944171f73967e8')
  })

  it('stableStringify 는 키 순서와 undefined 에 흔들리지 않는다', () => {
    const a = { b: 1, a: { y: [1, undefined, 3], x: 'ㄱ' }, c: undefined }
    const b = { a: { x: 'ㄱ', y: [1, undefined, 3] }, b: 1 }
    expect(stableStringify(a)).toBe(stableStringify(b))
    expect(stableStringify(a)).toBe('{"a":{"x":"ㄱ","y":[1,null,3]},"b":1}')
  })

  it('toCloudRequest 는 시드를 빼고 i2i 이미지는 싣지 않되 source 자리는 남긴다', () => {
    const plain = toCloudRequest({ ...DEFAULT_REQUEST, seed: 777 })
    expect(plain.seed).toBe(-1)
    expect('source' in plain).toBe(false)
    const i2i = toCloudRequest({
      ...DEFAULT_REQUEST,
      seed: 5,
      source: { imageBase64: 'AAAA'.repeat(1000), maskBase64: 'BBBB', strength: 0.7, noise: 0.1 }
    })
    expect(i2i.source).toEqual({ imageBase64: '', strength: 0.7, noise: 0.1 })
  })

  it('toCloudRequest 는 입은 옷 자동 젖힘 메모를 싣지 않는다 (화면 표시용 — 해시도 안 흔든다)', () => {
    const base = { ...DEFAULT_REQUEST, seed: 1 }
    const note = {
      charIndex: 0,
      charId: 1,
      name: 'a',
      area: 'lower' as const,
      status: 'added' as const,
      tags: ['skirt lift'],
      garments: ['skirt'],
      evidence: ['sex'],
      reason: '아래: skirt lift 붙임'
    }
    const withNotes = toCloudRequest({ ...base, exposeNotes: [note] })
    expect('exposeNotes' in withNotes).toBe(false)
    expect(hashText(stableStringify(withNotes))).toBe(
      hashText(stableStringify(toCloudRequest(base)))
    )
  })

  it('toCloudRequest: source 가 없으면 i2i 강도·노이즈를 빼서 해시가 그 값에 흔들리지 않는다', () => {
    const base = { ...DEFAULT_REQUEST, seed: 1 }
    const a = toCloudRequest({ ...base, i2iStrength: 0.3, i2iNoise: 0.2 })
    const b = toCloudRequest({ ...base, i2iStrength: 0.9, i2iNoise: 0 })
    const none = toCloudRequest(base)
    for (const r of [a, b, none]) {
      expect('i2iStrength' in r).toBe(false)
      expect('i2iNoise' in r).toBe(false)
    }
    const hashOf = (r: GenerationRequest): string => hashText(stableStringify(r))
    expect(hashOf(a)).toBe(hashOf(b))
    expect(hashOf(a)).toBe(hashOf(none))
    // 소스 없이 값만 바뀐 것 말고 진짜 요청 내용이 바뀌면 해시도 바뀐다
    expect(hashOf(toCloudRequest({ ...base, prompt: '다른 프롬프트' }))).not.toBe(hashOf(none))
  })

  it('toCloudRequest: source 가 있으면 i2i 강도·노이즈는 그대로 두고 값이 바뀌면 해시도 바뀐다', () => {
    const source = { imageBase64: 'IMG', strength: 0.7, noise: 0.1 }
    const a = toCloudRequest({ ...DEFAULT_REQUEST, source, i2iStrength: 0.3, i2iNoise: 0.2 })
    expect(a).toMatchObject({ i2iStrength: 0.3, i2iNoise: 0.2 })
    const b = toCloudRequest({ ...DEFAULT_REQUEST, source, i2iStrength: 0.4, i2iNoise: 0.2 })
    expect(hashText(stableStringify(a))).not.toBe(hashText(stableStringify(b)))
    // 값이 정해져 있지 않으면 자리를 만들지 않는다
    const unset = toCloudRequest({ ...DEFAULT_REQUEST, source })
    expect('i2iStrength' in unset).toBe(false)
    expect('i2iNoise' in unset).toBe(false)
  })
})

describe('generation-store 리팩터 — generate 동작 그대로', () => {
  it('generate: 배치 수만큼 한 번에 넣고, 시드를 상태·main_params 에 반영하고, 미리보기를 비운다', async () => {
    useGenerationStore.setState({ previewPng: 'x', viewingFilePath: '/a.png' })
    await useGenerationStore.getState().generate()

    const enqueue = callsOf('queue:enqueue')
    expect(enqueue).toHaveLength(1)
    const { request, count } = enqueue[0].req as { request: GenerationRequest; count: number }
    expect(count).toBe(3)
    expect(request.prompt).toBe('1girl')
    expect(request.seed).toBeGreaterThanOrEqual(0)
    // 시드 고정이 아니면 이번에 뽑은 시드가 화면 상태에 들어간다
    const state = useGenerationStore.getState()
    expect(state.request.seed).toBe(request.seed)
    expect(state.previewPng).toBeNull()
    expect(state.viewingFilePath).toBeNull()
    const saved = callsOf('settings:set').find(
      (c) => (c.req as { key: string }).key === 'main_params'
    )
    expect(JSON.parse((saved!.req as { value: string }).value).seed).toBe(request.seed)
  })

  it('generate: 시드 고정이면 그 시드를 쓰고 상태의 request 는 그대로 둔다', async () => {
    const locked = { ...DEFAULT_REQUEST, prompt: 'locked', seed: 1234 }
    useGenerationStore.setState({ request: locked, seedLocked: true })
    await useGenerationStore.getState().generate()
    const { request } = callsOf('queue:enqueue')[0].req as { request: GenerationRequest }
    expect(request.seed).toBe(1234)
    expect(useGenerationStore.getState().request).toBe(locked)
  })

  it('generate: 캐릭터·i2i 소스는 완성 요청에만 들어가고 저장본(main_params)에는 없다', async () => {
    useCharactersStore.setState({ items: [card(1, 'blue eyes', true), card(2, 'green eyes')] })
    useGenerationStore.setState({
      source: { imageBase64: 'IMG', width: 512, height: 768 }
    })
    await useGenerationStore.getState().generate()
    const { request } = callsOf('queue:enqueue')[0].req as { request: GenerationRequest }
    expect(request.characterPrompts.map((c) => c.prompt)).toEqual(['blue eyes'])
    expect(request.source?.imageBase64).toBe('IMG')
    expect(request.width).toBe(512)
    expect(request.height).toBe(768)
    const saved = callsOf('settings:set').find(
      (c) => (c.req as { key: string }).key === 'main_params'
    )
    const base = JSON.parse((saved!.req as { value: string }).value)
    expect(base.characterPrompts).toEqual([])
    expect(base.source).toBeUndefined()
    expect(base.width).toBe(DEFAULT_REQUEST.width)
  })

  it('buildMainRequest: 큐·저장·상태를 건드리지 않고 완성 요청만 만든다', async () => {
    const before = useGenerationStore.getState().request
    useCharactersStore.setState({ items: [card(1, 'blue eyes', true)] })
    const built = await useGenerationStore.getState().buildMainRequest()
    expect(built.characterPrompts[0].prompt).toBe('blue eyes')
    expect(built.seed).toBeGreaterThanOrEqual(0)
    expect(callsOf('queue:enqueue')).toHaveLength(0)
    expect(callsOf('settings:set')).toHaveLength(0)
    expect(useGenerationStore.getState().request).toBe(before)
  })

  it('generateMain: 지정한 장수만큼 넣고 큐 id 들을 돌려준다 (시드 정책은 generate 와 같다)', async () => {
    const ids = await useGenerationStore.getState().generateMain(2)
    expect(ids).toEqual(['q1', 'q2'])
    const { request, count } = callsOf('queue:enqueue')[0].req as {
      request: GenerationRequest
      count: number
    }
    expect(count).toBe(2)
    expect(useGenerationStore.getState().request.seed).toBe(request.seed)
    expect(callsOf('settings:set')).toHaveLength(1)
    // 폰 작업 id 를 주지 않으면 요청에 cloudJobId 자리 자체가 없다
    expect('cloudJobId' in request).toBe(false)
  })

  it('generateMain: cloudJobId 는 큐에 넣는 요청에만 달리고 화면 상태·저장본에는 남지 않는다', async () => {
    await useGenerationStore.getState().generateMain(2, 'job-main')
    const { request } = callsOf('queue:enqueue')[0].req as { request: GenerationRequest }
    expect(request.cloudJobId).toBe('job-main')
    expect('cloudJobId' in useGenerationStore.getState().request).toBe(false)
    const saved = callsOf('settings:set').find(
      (c) => (c.req as { key: string }).key === 'main_params'
    )
    expect(JSON.parse((saved!.req as { value: string }).value).cloudJobId).toBeUndefined()
    // 클라우드용 완성 요청(buildMainRequest)에도 작업 id 는 없다
    expect('cloudJobId' in (await useGenerationStore.getState().buildMainRequest())).toBe(false)
  })
})

describe('PC에 불러 둔 i2i 소스 — 클라우드용 계산과 폰 작업은 무시한다', () => {
  const loadSource = (): void =>
    useGenerationStore.setState({
      source: { imageBase64: 'IMG', maskBase64: 'MASK', width: 512, height: 768 }
    })

  it('buildMainRequest: 옵션을 주면 소스도 소스 해상도도 싣지 않고, 안 주면 예전 그대로다', async () => {
    loadSource()
    const plain = await useGenerationStore.getState().buildMainRequest()
    expect(plain.source?.imageBase64).toBe('IMG')
    expect([plain.width, plain.height]).toEqual([512, 768])

    const ignored = await useGenerationStore.getState().buildMainRequest({ ignoreSource: true })
    expect(ignored.source).toBeUndefined()
    expect([ignored.width, ignored.height]).toEqual([DEFAULT_REQUEST.width, DEFAULT_REQUEST.height])
    // 불러 둔 소스 자체는 건드리지 않는다
    expect(useGenerationStore.getState().source?.imageBase64).toBe('IMG')
  })

  it('generateMain: 폰 작업은 소스를 쓰지 않는다 (generate 는 예전 그대로 소스를 쓴다)', async () => {
    loadSource()
    await useGenerationStore.getState().generateMain(1, 'job-m')
    await useGenerationStore.getState().generate()
    const [phone, pc] = callsOf('queue:enqueue').map(
      (c) => (c.req as { request: GenerationRequest }).request
    )
    expect(phone.cloudJobId).toBe('job-m')
    expect(phone.source).toBeUndefined()
    expect([phone.width, phone.height]).toEqual([DEFAULT_REQUEST.width, DEFAULT_REQUEST.height])
    expect(pc.source?.imageBase64).toBe('IMG')
    expect([pc.width, pc.height]).toEqual([512, 768])
  })

  it('buildSceneRequest: 옵션을 주면 소스도 소스 해상도도 없고, 안 주면 예전 그대로다', () => {
    loadSource()
    const scene = makeScene(4, { width: 1024, height: 640 })
    const plain = buildSceneRequest(scene)
    expect(plain.source?.imageBase64).toBe('IMG')
    expect([plain.width, plain.height]).toEqual([512, 768])

    const ignored = buildSceneRequest(scene, null, { ignoreSource: true })
    expect(ignored.source).toBeUndefined()
    expect([ignored.width, ignored.height]).toEqual([1024, 640])
  })

  it('enqueueSceneRequests: 폰 작업은 소스를 쓰지 않고 씬 해상도로 만든다', async () => {
    loadSource()
    await enqueueSceneRequests(makeScene(4, { width: 1024, height: 640 }), 2, 'job-s')
    const { requests } = callsOf('queue:enqueueMany')[0].req as { requests: GenerationRequest[] }
    for (const r of requests) {
      expect(r.source).toBeUndefined()
      expect([r.width, r.height]).toEqual([1024, 640])
    }
  })

  it('대기 항목을 다시 만들 때도 폰 작업은 소스 해상도로 덮이지 않는다', async () => {
    responders.set('queue:updatePending', () => undefined)
    loadSource()
    useScenesStore.setState({ scenes: [makeScene(5, { width: 1024, height: 640 })] })
    const pending = (id: string, over: Partial<GenerationRequest>): never =>
      ({ id, request: { ...DEFAULT_REQUEST, sceneId: 5, seed: 1, ...over } }) as never
    responders.set('queue:pending', () => ({
      items: [pending('phone', { cloudJobId: 'job-p' }), pending('pc', {})]
    }))
    await useScenesStore.getState().resyncPendingScenes()
    const [phone, pc] = callsOf('queue:updatePending').flatMap(
      (c) => (c.req as { updates: { id: string; request: GenerationRequest }[] }).updates
    )
    expect(phone.request.cloudJobId).toBe('job-p')
    expect([phone.request.width, phone.request.height]).toEqual([1024, 640])
    expect(phone.request.source).toBeUndefined()
    // PC 항목에는 폰 작업 id 가 생기지 않는다
    expect('cloudJobId' in pc.request).toBe(false)
  })
})

describe('generation-store.cancelAll — 폰 작업 항목은 씬 예약 수로 되돌리지 않는다', () => {
  const setQueue = (
    items: { id: string; state: string; sceneId?: number; cloudJobId?: string }[]
  ): void =>
    useGenerationStore.setState({
      queue: { items, running: true, delayMs: 0 } as never
    })
  const reserveUpdates = (): { id: number; patch: { reserveCount: number } }[] =>
    callsOf('scenes:update').map((c) => c.req as never)

  it('폰 작업의 대기 항목은 취소만 하고 예약으로 되돌리지 않는다', async () => {
    setQueue([
      { id: 'pc1', state: 'pending', sceneId: 5 },
      { id: 'ph1', state: 'pending', sceneId: 5, cloudJobId: 'job-a' },
      { id: 'ph2', state: 'pending', sceneId: 5, cloudJobId: 'job-a' },
      { id: 'run', state: 'generating', sceneId: 5, cloudJobId: 'job-a' },
      { id: 'done', state: 'done', sceneId: 5 }
    ])
    await useGenerationStore.getState().cancelAll()
    // 취소는 폰 항목까지 모두 한다
    expect(callsOf('queue:cancel')[0].req).toEqual({ ids: ['pc1', 'ph1', 'ph2', 'run'] })
    // 예약으로 되돌리는 것은 PC 항목 1장뿐이다
    expect(reserveUpdates()).toEqual([{ id: 5, patch: { reserveCount: 1 } }])
  })

  it('폰 작업 항목뿐이면 예약을 읽지도 고치지도 않는다', async () => {
    setQueue([
      { id: 'ph1', state: 'pending', sceneId: 5, cloudJobId: 'job-a' },
      { id: 'ph2', state: 'pending', sceneId: 6, cloudJobId: 'job-b' }
    ])
    await useGenerationStore.getState().cancelAll()
    expect(callsOf('queue:cancel')[0].req).toEqual({ ids: ['ph1', 'ph2'] })
    expect(callsOf('scenes:get')).toHaveLength(0)
    expect(callsOf('scenes:update')).toHaveLength(0)
  })
})

describe('scenes-store.enqueueSceneRequests', () => {
  it('큐 반복·예약 없이 씬 요청 × 장수를 한 번에 등록하고 id 를 돌려준다', async () => {
    const scene = makeScene(9, { prompt: 'meadow', width: 1024, height: 768 })
    // 활성 프리셋이 아닌 씬도 된다
    useScenesStore.setState({ activePresetId: 42, scenes: [] })
    const ids = await enqueueSceneRequests(scene, 3)
    expect(ids).toEqual(['q1', 'q2', 'q3'])
    const { requests } = callsOf('queue:enqueueMany')[0].req as { requests: GenerationRequest[] }
    expect(requests).toHaveLength(3)
    for (const r of requests) {
      expect(r.sceneId).toBe(9)
      expect(r.width).toBe(1024)
      expect(r.height).toBe(768)
      expect(r.prompt).toContain('meadow')
    }
    expect(callsOf('scenes:setReserveAll')).toHaveLength(0)
  })

  it('시드 고정이면 시드가 base+i 로 이어진다', async () => {
    useGenerationStore.setState({ seedLocked: true, request: { ...DEFAULT_REQUEST, seed: 100 } })
    await enqueueSceneRequests(makeScene(1), 3)
    const { requests } = callsOf('queue:enqueueMany')[0].req as { requests: GenerationRequest[] }
    expect(requests.map((r) => r.seed)).toEqual([100, 101, 102])
  })

  it('0장이면 아무것도 하지 않는다', async () => {
    expect(await enqueueSceneRequests(makeScene(1), 0)).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('cloudJobId 를 주면 모든 요청에 달고, 안 주면 자리 자체를 만들지 않는다', async () => {
    await enqueueSceneRequests(makeScene(1), 2, 'job-scene')
    await enqueueSceneRequests(makeScene(1), 2)
    const [withJob, without] = callsOf('queue:enqueueMany').map(
      (c) => (c.req as { requests: GenerationRequest[] }).requests
    )
    expect(withJob.map((r) => r.cloudJobId)).toEqual(['job-scene', 'job-scene'])
    for (const r of without) expect('cloudJobId' in r).toBe(false)
  })
})

describe('scenes-store.resyncPendingScenes — 폰 작업 id 보존', () => {
  const pendingItem = (
    id: string,
    over: Partial<GenerationRequest>
  ): { id: string; request: GenerationRequest } => ({
    id,
    request: { ...DEFAULT_REQUEST, prompt: 'old prompt', negativePrompt: 'old neg', ...over }
  })
  const updates = (): { id: string; request: GenerationRequest }[] =>
    callsOf('queue:updatePending').flatMap(
      (c) => (c.req as { updates: { id: string; request: GenerationRequest }[] }).updates
    )

  beforeEach(() => {
    responders.set('queue:updatePending', () => undefined)
  })

  it('씬 항목을 다시 만들어도 cloudJobId·시드·i2i 소스를 잃지 않는다', async () => {
    const source = { imageBase64: 'IMG', strength: 0.6, noise: 0.1 }
    useScenesStore.setState({ scenes: [makeScene(5, { prompt: 'edited forest' })] })
    responders.set('queue:pending', () => ({
      items: [
        pendingItem('a', { sceneId: 5, seed: 1234, cloudJobId: 'job-a', source }),
        pendingItem('b', { sceneId: 5, seed: 99 })
      ]
    }))
    await useScenesStore.getState().resyncPendingScenes()
    const [a, b] = updates()
    // 프롬프트는 현재 씬 것으로 다시 만들어지고
    expect(a.request.prompt).toContain('edited forest')
    // 시드·소스·작업 id 는 원래 항목 것이다
    expect(a.request.seed).toBe(1234)
    expect(a.request.source).toEqual(source)
    expect(a.request.cloudJobId).toBe('job-a')
    // 폰 작업이 아닌 항목에는 작업 id 가 생기지 않는다
    expect(b.request.seed).toBe(99)
    expect('cloudJobId' in b.request).toBe(false)
  })

  it('메인 항목(씬 없음)도 현재 프롬프트로 바뀌되 cloudJobId 는 그대로다', async () => {
    useGenerationStore.setState({
      request: { ...DEFAULT_REQUEST, prompt: 'fresh prompt', negativePrompt: 'fresh neg' }
    })
    responders.set('queue:pending', () => ({
      items: [pendingItem('m', { seed: 7, cloudJobId: 'job-m' })]
    }))
    await useScenesStore.getState().resyncPendingScenes()
    const [m] = updates()
    expect(m.request).toMatchObject({
      prompt: 'fresh prompt',
      negativePrompt: 'fresh neg',
      seed: 7,
      cloudJobId: 'job-m'
    })
  })

  it('현재 프리셋에 없는 씬의 항목은 건드리지 않는다', async () => {
    useScenesStore.setState({ scenes: [makeScene(5)] })
    responders.set('queue:pending', () => ({
      items: [pendingItem('x', { sceneId: 777, cloudJobId: 'job-x' })]
    }))
    await useScenesStore.getState().resyncPendingScenes()
    expect(callsOf('queue:updatePending')).toHaveLength(0)
  })
})

describe('cloud-bridge', () => {
  let stop: (() => void) | null = null
  afterEach(() => {
    stop?.()
    stop = null
  })

  const work = (over: Partial<CloudWork>): CloudWork => ({ ops: [], jobs: [], ...over })
  const job = (
    id: string,
    target: CloudWork['jobs'][number]['target'],
    count = 2
  ): CloudWork['jobs'][number] => ({
    id,
    target,
    label: id,
    count,
    done: 0,
    failed: 0,
    state: 'queued',
    place: 'auto',
    runner: 'pc',
    error: null,
    createdAt: 0,
    updatedAt: 0
  })
  const workDones = (): CloudWorkResult[] =>
    callsOf('cloud:workDone').map((c) => c.req as CloudWorkResult)

  it('설정 복원이 끝나기 전에는 rendererReady 를 보내지 않고, 끝나면 한 번 보낸다', async () => {
    useGenerationStore.setState({ hydrated: false })
    stop = startCloudBridge()
    await Promise.resolve()
    await Promise.resolve()
    expect(callsOf('cloud:rendererReady')).toHaveLength(0)
    useGenerationStore.setState({ hydrated: true })
    await vi.waitFor(() => expect(callsOf('cloud:rendererReady')).toHaveLength(1))
  })

  it('편집은 id 순서로 반영하고, 씬은 IPC 후 목록에 있으면 다시 읽는다', async () => {
    useScenesStore.setState({ scenes: [makeScene(5)] })
    useCharactersStore.setState({ items: [card(3, 'old prompt', true)] })
    stop = startCloudBridge()
    emit(
      'cloud:work',
      work({
        ops: [
          {
            id: 7,
            at: 0,
            type: 'char:update',
            charId: 3,
            patch: { enabled: false, prompt: 'new' }
          },
          { id: 5, at: 0, type: 'scene:update', sceneId: 5, patch: { prompt: 'x', width: 640 } },
          { id: 6, at: 0, type: 'scene:update', sceneId: 99, patch: { name: '목록에 없음' } }
        ]
      })
    )
    await vi.waitFor(() => expect(workDones()).toHaveLength(1))

    const order = calls
      .map((c) => c.channel)
      .filter((c) => ['scenes:update', 'scenes:list', 'chars:update'].includes(c))
    // id 5 → 반영 후 목록 재조회(5가 목록에 있음) → id 6(목록에 없어 재조회 없음) → id 7
    expect(order).toEqual(['scenes:update', 'scenes:list', 'scenes:update', 'chars:update'])
    expect(callsOf('scenes:update')[0].req).toEqual({ id: 5, patch: { prompt: 'x', width: 640 } })
    expect(callsOf('chars:update')[0].req).toEqual({
      id: 3,
      patch: { enabled: false, prompt: 'new' }
    })
    expect(useCharactersStore.getState().items[0]).toMatchObject({ enabled: false, prompt: 'new' })
    expect(workDones()[0].opIds).toEqual([5, 6, 7])
    // 전부 반영됐으면 failedOpIds 자리 자체를 만들지 않는다
    expect('failedOpIds' in workDones()[0]).toBe(false)
  })

  it('메인 편집: 분할 꺼짐이면 프롬프트, 켜짐이면 칸에 반영한다', async () => {
    stop = startCloudBridge()
    emit(
      'cloud:work',
      work({
        ops: [
          {
            id: 1,
            at: 0,
            type: 'main:update',
            patch: { prompt: 'cat', negativePrompt: 'dog', promptParts: undefined }
          }
        ]
      })
    )
    await vi.waitFor(() => expect(workDones()).toHaveLength(1))
    expect(useGenerationStore.getState().request).toMatchObject({
      prompt: 'cat',
      negativePrompt: 'dog'
    })

    useGenerationStore.setState({
      promptSplitEnabled: true,
      request: {
        ...useGenerationStore.getState().request,
        promptParts: { base: 'cat', additional: '', detail: '' }
      }
    })
    emit(
      'cloud:work',
      work({
        ops: [
          {
            id: 2,
            at: 0,
            type: 'main:update',
            patch: { promptParts: { base: 'a', additional: 'b', detail: 'c' } }
          }
        ]
      })
    )
    await vi.waitFor(() => expect(workDones()).toHaveLength(2))
    const request = useGenerationStore.getState().request
    expect(request.promptParts).toEqual({ base: 'a', additional: 'b', detail: 'c' })
    expect(request.prompt).toBe('a, b, c')
  })

  it('작업: 씬은 씬을 읽어 큐에 넣고, 없으면 「씬이 PC에 없음」, 메인은 generateMain', async () => {
    responders.set('scenes:get', (req) =>
      (req as { id: number }).id === 404
        ? { scene: null }
        : { scene: makeScene((req as { id: number }).id) }
    )
    stop = startCloudBridge()
    emit(
      'cloud:work',
      work({
        jobs: [
          job('j-scene', { type: 'scene', sceneId: 8 }, 2),
          job('j-gone', { type: 'scene', sceneId: 404 }, 2),
          job('j-main', { type: 'main' }, 3)
        ]
      })
    )
    await vi.waitFor(() => expect(workDones()).toHaveLength(1))

    const [done] = workDones()
    expect(done.opIds).toEqual([])
    expect(done.jobs).toEqual([
      { id: 'j-scene', queueIds: ['q1', 'q2'] },
      { id: 'j-gone', queueIds: [], error: '씬이 PC에 없음' },
      { id: 'j-main', queueIds: ['q3', 'q4', 'q5'] }
    ])
    expect(callsOf('queue:enqueueMany')).toHaveLength(1)
    expect(callsOf('queue:enqueue')).toHaveLength(1)
  })

  it('휴지통에 있는 씬·프리셋의 작업은 「씬이 PC에 없음」으로 돌려주고 큐에 넣지 않는다', async () => {
    // scenes:get 은 휴지통 씬도 돌려준다 — 살아 있는지는 scenes:isLive 로 먼저 확인한다
    responders.set('scenes:isLive', (req) => ({ live: (req as { id: number }).id !== 12 }))
    stop = startCloudBridge()
    emit(
      'cloud:work',
      work({
        jobs: [
          job('j-trash', { type: 'scene', sceneId: 12 }, 2),
          job('j-live', { type: 'scene', sceneId: 8 }, 1)
        ]
      })
    )
    await vi.waitFor(() => expect(workDones()).toHaveLength(1))
    expect(workDones()[0].jobs).toEqual([
      { id: 'j-trash', queueIds: [], error: '씬이 PC에 없음' },
      { id: 'j-live', queueIds: ['q1'] }
    ])
    expect(callsOf('scenes:isLive').map((c) => (c.req as { id: number }).id)).toEqual([12, 8])
    expect(callsOf('scenes:get').map((c) => (c.req as { id: number }).id)).toEqual([8])
    expect(callsOf('queue:enqueueMany')).toHaveLength(1)
  })

  it('살아 있는지 확인하다 실패해도 큐에 넣지 않고 그 작업만 오류로 돌려준다', async () => {
    responders.set('scenes:isLive', () => {
      throw new Error("Error invoking remote method 'scenes:isLive': Error: 확인 실패")
    })
    stop = startCloudBridge()
    emit('cloud:work', work({ jobs: [job('j1', { type: 'scene', sceneId: 1 })] }))
    await vi.waitFor(() => expect(workDones()).toHaveLength(1))
    expect(workDones()[0].jobs).toEqual([{ id: 'j1', queueIds: [], error: '확인 실패' }])
    expect(callsOf('queue:enqueueMany')).toHaveLength(0)
  })

  it('켜 둔 캐릭터가 상한이면 폰이 켠 캐릭터를 조용히 무시하지 않고 실패로 알린다', async () => {
    setMaxCharacters(2)
    useCharactersStore.setState({
      items: [card(1, 'a', true), card(2, 'b', true), card(3, 'c', false)]
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    stop = startCloudBridge()
    emit(
      'cloud:work',
      work({ ops: [{ id: 1, at: 0, type: 'char:update', charId: 3, patch: { enabled: true } }] })
    )
    await vi.waitFor(() => expect(workDones()).toHaveLength(1))
    // 켜지 않았고, 저장 IPC 도 부르지 않았다
    expect(useCharactersStore.getState().items.find((c) => c.id === 3)?.enabled).toBe(false)
    expect(callsOf('chars:update')).toHaveLength(0)
    // 같은 편집을 다시 받지 않도록 확인(ack)은 하되, 사용자에게 이유와 함께 알린다
    expect(workDones()[0].opIds).toEqual([1])
    // 메인이 폰 사본을 PC 실제 값으로 되돌리도록 실패한 줄을 따로 알린다
    expect(workDones()[0].failedOpIds).toEqual([1])
    expect(useToastStore.getState().toasts[0]?.message).toBe(
      '폰에서 보낸 편집 1건을 반영하지 못했습니다. 캐릭터는 최대 2명까지 켤 수 있습니다'
    )
    warn.mockRestore()
  })

  it('상한 안에서는 켜지고, 이미 켜진 캐릭터를 다시 켜는 편집은 상한과 상관없다', async () => {
    setMaxCharacters(2)
    useCharactersStore.setState({
      items: [card(1, 'a', true), card(2, 'b', false), card(3, 'c', false)]
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    stop = startCloudBridge()
    emit(
      'cloud:work',
      work({
        ops: [
          { id: 1, at: 0, type: 'char:update', charId: 2, patch: { enabled: true } },
          // 이미 켜진 1번을 다시 켜는 것 — 자기 자신은 세지 않으므로 통과
          { id: 2, at: 0, type: 'char:update', charId: 1, patch: { enabled: true } },
          // 이제 2명이 켜져 있어 3번은 못 켠다
          { id: 3, at: 0, type: 'char:update', charId: 3, patch: { enabled: true } }
        ]
      })
    )
    await vi.waitFor(() => expect(workDones()).toHaveLength(1))
    const enabledIds = useCharactersStore
      .getState()
      .items.filter((c) => c.enabled)
      .map((c) => c.id)
    expect(enabledIds).toEqual([1, 2])
    expect(callsOf('chars:update')).toHaveLength(2)
    expect(workDones()[0].opIds).toEqual([1, 2, 3])
    // 못 켠 3번 줄만 실패 — 반영된 1·2번 줄은 failedOpIds 에 없다
    expect(workDones()[0].failedOpIds).toEqual([3])
    expect(useToastStore.getState().toasts).toHaveLength(1)
    warn.mockRestore()
  })

  it('작업 id 를 큐에 넣는 요청마다 cloudJobId 로 단다 (씬·메인 모두)', async () => {
    stop = startCloudBridge()
    emit(
      'cloud:work',
      work({
        jobs: [job('j-scene', { type: 'scene', sceneId: 8 }, 2), job('j-main', { type: 'main' }, 1)]
      })
    )
    await vi.waitFor(() => expect(workDones()).toHaveLength(1))
    const { requests } = callsOf('queue:enqueueMany')[0].req as { requests: GenerationRequest[] }
    expect(requests.map((r) => r.cloudJobId)).toEqual(['j-scene', 'j-scene'])
    const { request } = callsOf('queue:enqueue')[0].req as { request: GenerationRequest }
    expect(request.cloudJobId).toBe('j-main')
  })

  it('큐에 넣다 실패하면 그 작업만 한국어 오류로 돌려주고 나머지는 계속한다', async () => {
    responders.set('queue:enqueueMany', () => {
      throw new Error("Error invoking remote method 'queue:enqueueMany': Error: 큐가 가득 찼습니다")
    })
    stop = startCloudBridge()
    emit(
      'cloud:work',
      work({
        jobs: [job('j1', { type: 'scene', sceneId: 1 }), job('j2', { type: 'main' }, 1)]
      })
    )
    await vi.waitFor(() => expect(workDones()).toHaveLength(1))
    expect(workDones()[0].jobs).toEqual([
      { id: 'j1', queueIds: [], error: '큐가 가득 찼습니다' },
      { id: 'j2', queueIds: ['q1'] }
    ])
  })

  it('같은 일이 다시 와도 두 번 하지 않고 처음 결과를 돌려준다', async () => {
    stop = startCloudBridge()
    const again = work({
      ops: [{ id: 1, at: 0, type: 'scene:update', sceneId: 1, patch: { name: '새 이름' } }],
      jobs: [job('j1', { type: 'scene', sceneId: 1 }, 2)]
    })
    emit('cloud:work', again)
    emit('cloud:work', again)
    await vi.waitFor(() => expect(workDones()).toHaveLength(2))
    expect(callsOf('scenes:update')).toHaveLength(1)
    expect(callsOf('queue:enqueueMany')).toHaveLength(1)
    expect(workDones()[1]).toEqual(workDones()[0])
    expect(workDones()[0].jobs[0].queueIds).toEqual(['q1', 'q2'])
  })

  it('반영에 실패한 편집도 확인(ack)은 하고 사용자에게 알린다 — 뒤의 편집을 막지 않게', async () => {
    responders.set('scenes:update', () => {
      throw new Error('디스크 오류')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    stop = startCloudBridge()
    emit(
      'cloud:work',
      work({
        ops: [
          { id: 1, at: 0, type: 'scene:update', sceneId: 1, patch: { name: 'a' } },
          { id: 2, at: 0, type: 'job:cancel', jobId: 'x' }
        ]
      })
    )
    await vi.waitFor(() => expect(workDones()).toHaveLength(1))
    expect(workDones()[0].opIds).toEqual([1, 2])
    expect(workDones()[0].failedOpIds).toEqual([1])
    expect(useToastStore.getState().toasts[0]?.message).toBe(
      '폰에서 보낸 편집 1건을 반영하지 못했습니다'
    )
    warn.mockRestore()
  })

  it('씬 편집 IPC 가 성공한 뒤 목록을 다시 읽다 던져도 편집 실패로 세지 않는다 (콘솔 경고만)', async () => {
    useScenesStore.setState({ scenes: [makeScene(5)] })
    responders.set('scenes:list', () => {
      throw new Error("Error invoking remote method 'scenes:list': Error: 목록 읽기 실패")
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    stop = startCloudBridge()
    emit(
      'cloud:work',
      work({
        ops: [
          { id: 1, at: 0, type: 'scene:update', sceneId: 5, patch: { prompt: 'x' } },
          { id: 2, at: 0, type: 'main:update', patch: { negativePrompt: 'n' } }
        ]
      })
    )
    await vi.waitFor(() => expect(workDones()).toHaveLength(1))

    // 반영은 끝났다 — IPC 는 한 번, 목록 재조회는 시도했고 실패했다
    expect(callsOf('scenes:update')).toHaveLength(1)
    expect(callsOf('scenes:list')).toHaveLength(1)
    // 실패로 알리면 메인이 폰 사본을 옛 값으로 되돌리므로 failedOpIds 자리가 없어야 하고, 사용자 알림도 없다
    expect(workDones()[0].opIds).toEqual([1, 2])
    expect('failedOpIds' in workDones()[0]).toBe(false)
    expect(useToastStore.getState().toasts).toHaveLength(0)
    // 뒤의 편집도 막히지 않았다
    expect(useGenerationStore.getState().request.negativePrompt).toBe('n')
    expect(warn.mock.calls.some((c) => String(c[0]).includes('씬 목록 다시 읽기 실패'))).toBe(true)
    warn.mockRestore()
  })

  it('씬 편집 IPC 자체가 실패하면 목록은 읽지 않고 편집 실패로 알린다 (목록 재조회 실패와 구분)', async () => {
    useScenesStore.setState({ scenes: [makeScene(5)] })
    responders.set('scenes:update', () => {
      throw new Error('디스크 오류')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    stop = startCloudBridge()
    emit(
      'cloud:work',
      work({ ops: [{ id: 1, at: 0, type: 'scene:update', sceneId: 5, patch: { prompt: 'x' } }] })
    )
    await vi.waitFor(() => expect(workDones()).toHaveLength(1))
    expect(callsOf('scenes:list')).toHaveLength(0)
    expect(workDones()[0].failedOpIds).toEqual([1])
    warn.mockRestore()
  })

  it('실패한 편집 줄이 다시 와도 다시 반영하지 않고, 알림은 한 번만 내고, 계속 실패로 알린다', async () => {
    responders.set('scenes:update', () => {
      throw new Error('디스크 오류')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    stop = startCloudBridge()
    const same = work({
      ops: [
        { id: 1, at: 0, type: 'scene:update', sceneId: 1, patch: { name: 'a' } },
        { id: 2, at: 0, type: 'main:update', patch: { negativePrompt: 'n' } }
      ]
    })
    emit('cloud:work', same)
    emit('cloud:work', same)
    await vi.waitFor(() => expect(workDones()).toHaveLength(2))
    expect(callsOf('scenes:update')).toHaveLength(1)
    expect(workDones()[0].opIds).toEqual([1, 2])
    expect(workDones()[1].opIds).toEqual([1, 2])
    // 첫 보고가 메인에 닿지 못했어도 두 번째 보고가 같은 실패 줄을 알린다 (반영된 2번은 아님)
    expect(workDones()[0].failedOpIds).toEqual([1])
    expect(workDones()[1].failedOpIds).toEqual([1])
    expect(useToastStore.getState().toasts).toHaveLength(1)
    warn.mockRestore()
  })

  it('편집이 없고 작업만 있으면 failedOpIds 를 싣지 않는다', async () => {
    stop = startCloudBridge()
    emit('cloud:work', work({ jobs: [job('j1', { type: 'main' }, 1)] }))
    await vi.waitFor(() => expect(workDones()).toHaveLength(1))
    expect('failedOpIds' in workDones()[0]).toBe(false)
  })

  it('장수는 1~20 안으로 맞춘다', async () => {
    stop = startCloudBridge()
    emit('cloud:work', work({ jobs: [job('big', { type: 'main' }, 500)] }))
    await vi.waitFor(() => expect(workDones()).toHaveLength(1))
    expect((callsOf('queue:enqueue')[0].req as { count: number }).count).toBe(20)
  })
})

describe('cloud-prepared', () => {
  let stop: (() => void) | null = null
  let sceneList: Scene[] = []

  /** cloudGen = 클라우드 생성 스위치, over 로 동기화(enabled)·판 불일치(protocolMismatch)를 바꾼다 */
  const status = (cloudGen: boolean, over: Partial<CloudPcStatus> = {}): CloudPcStatus =>
    ({
      enabled: true,
      protocolMismatch: false,
      ...over,
      cloudGen: { enabled: cloudGen, hasToken: true, quota: null }
    }) as CloudPcStatus
  const itemCount = (): number => prepared().reduce((n, p) => n + p.items.length, 0)
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(20)
  }
  const prepared = (): {
    items: { key: string; hash: string; request: GenerationRequest }[]
    allKeys?: string[]
  }[] => callsOf('cloud:prepared').map((c) => c.req as never)

  beforeEach(() => {
    vi.useFakeTimers()
    sceneList = Array.from({ length: 450 }, (_, i) => makeScene(i + 1))
    responders.set('scenes:listAllLite', () => ({ items: sceneList }))
    responders.set('cloud:status', () => status(true))
  })
  afterEach(() => {
    stop?.()
    stop = null
    vi.useRealTimers()
  })

  it('켜져 있으면 200개씩 보내고 allKeys 는 마지막 묶음에만 싣는다', async () => {
    stop = startCloudPrepared()
    await settle()
    const sent = prepared()
    expect(sent.map((p) => p.items.length)).toEqual([200, 200, 51])
    expect(sent[0].allKeys).toBeUndefined()
    expect(sent[1].allKeys).toBeUndefined()
    expect(sent[2].allKeys).toHaveLength(451)
    expect(sent[2].allKeys).toContain('main')
    expect(sent[2].allKeys).toContain('scene:450')
    const first = sent[0].items[0]
    expect(first.key).toBe('main')
    expect(first.hash).toMatch(/^[0-9a-f]{16}$/)
    for (const item of sent.flatMap((p) => p.items)) expect(item.request.seed).toBe(-1)
    const scene = sent[0].items[1]
    expect(scene.key).toBe('scene:1')
    expect(scene.request.sceneId).toBe(1)
  })

  it('바뀐 게 없으면 다시 보내지 않고, 바뀐 씬만 보낸다', async () => {
    stop = startCloudPrepared()
    await settle()
    const before = prepared().length
    emit('cloud:needPrepared', { full: false })
    await settle()
    expect(prepared()).toHaveLength(before)

    sceneList = sceneList.map((s) => (s.id === 3 ? { ...s, prompt: 'changed' } : s))
    emit('cloud:needPrepared', { full: false })
    await settle()
    const after = prepared().slice(before)
    expect(after).toHaveLength(1)
    expect(after[0].items.map((i) => i.key)).toEqual(['scene:3'])
    expect(after[0].items[0].request.prompt).toContain('changed')
    expect(after[0].allKeys).toHaveLength(451)
  })

  it('생성할 때마다 바뀌는 시드는 해시에 영향이 없다', async () => {
    stop = startCloudPrepared()
    await settle()
    const before = prepared().length
    useGenerationStore.setState({
      request: { ...useGenerationStore.getState().request, seed: 99999 }
    })
    emit('cloud:needPrepared', { full: false })
    await settle()
    expect(prepared()).toHaveLength(before)
  })

  it('없어진 씬은 빈 items 와 allKeys 로 알린다', async () => {
    stop = startCloudPrepared()
    await settle()
    const before = prepared().length
    sceneList = sceneList.filter((s) => s.id !== 450)
    emit('cloud:needPrepared', { full: false })
    await settle()
    const after = prepared().slice(before)
    expect(after).toHaveLength(1)
    expect(after[0].items).toEqual([])
    expect(after[0].allKeys).toHaveLength(450)
    expect(after[0].allKeys).not.toContain('scene:450')
  })

  it('needPrepared full 이면 해시를 비우고 전부 다시 보낸다', async () => {
    stop = startCloudPrepared()
    await settle()
    const before = prepared().length
    emit('cloud:needPrepared', { full: true })
    await settle()
    const after = prepared().slice(before)
    expect(after.reduce((n, p) => n + p.items.length, 0)).toBe(451)
  })

  it('클라우드 생성이 꺼져 있으면 아무것도 하지 않고, 켜지는 순간 시작한다', async () => {
    responders.set('cloud:status', () => status(false))
    stop = startCloudPrepared()
    await settle()
    emit('cloud:needPrepared', { full: true })
    await settle()
    expect(callsOf('scenes:listAllLite')).toHaveLength(0)

    emit('cloud:status', status(true))
    await settle()
    expect(prepared().length).toBeGreaterThan(0)
    // 다시 끄면 멈춘다
    const count = callsOf('scenes:listAllLite').length
    emit('cloud:status', status(false))
    useGenerationStore.setState({
      request: { ...useGenerationStore.getState().request, prompt: 'edit' }
    })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(callsOf('scenes:listAllLite')).toHaveLength(count)
  })

  it('설정이 바뀌면 20초 디바운스 뒤에 다시 계산한다', async () => {
    stop = startCloudPrepared()
    await settle()
    const before = callsOf('scenes:listAllLite').length
    const sentBefore = prepared().length
    useGenerationStore.setState({
      request: { ...useGenerationStore.getState().request, prompt: '1girl, edit' }
    })
    await vi.advanceTimersByTimeAsync(19_000)
    expect(callsOf('scenes:listAllLite')).toHaveLength(before)
    // 또 바뀌면 20초가 다시 시작된다
    useGenerationStore.setState({
      request: { ...useGenerationStore.getState().request, prompt: '1girl, edit2' }
    })
    await vi.advanceTimersByTimeAsync(19_000)
    expect(callsOf('scenes:listAllLite')).toHaveLength(before)
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(callsOf('scenes:listAllLite')).toHaveLength(before + 1)
    // 씬 요청은 메인 프롬프트 뒤에 씬 프롬프트가 이어붙으므로 메인과 씬이 모두 바뀐 것으로 다시 올라간다
    const resent = prepared().slice(sentBefore)
    expect(resent.reduce((n, p) => n + p.items.length, 0)).toBe(451)
    expect(resent[0].items[0].key).toBe('main')
  })

  it('설정 복원이 끝나기 전에는 계산하지 않는다', async () => {
    useGenerationStore.setState({ hydrated: false })
    stop = startCloudPrepared()
    await settle()
    expect(callsOf('scenes:listAllLite')).toHaveLength(0)
    useGenerationStore.setState({ hydrated: true })
    await settle()
    expect(prepared().length).toBeGreaterThan(0)
  })

  it('올리기에 실패하면 간격을 두고 다시 시도한다', async () => {
    let fail = true
    responders.set('cloud:prepared', () => {
      if (fail) throw new Error('메인 준비 안 됨')
      return undefined
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    stop = startCloudPrepared()
    await settle()
    expect(callsOf('cloud:prepared')).toHaveLength(1)
    fail = false
    await vi.advanceTimersByTimeAsync(61_000)
    await settle()
    // 실패한 묶음부터 다시 — 처음에 못 보냈으니 전부 새로 보낸다
    expect(
      prepared()
        .slice(1)
        .reduce((n, p) => n + p.items.length, 0)
    ).toBe(451)
    warn.mockRestore()
  })

  describe('복장 설정 — 입은 옷 자동 젖힘·눈 감음·알몸 pink nipples (기본 꺼짐)', () => {
    const calc = (): number => callsOf('scenes:listAllLite').length
    /** 가장 나중에 올라간 scene:1 요청의 첫 캐릭터 칸 글 */
    const lastCharacterPrompt = (): string => {
      const items = prepared()
        .flatMap((p) => p.items)
        .filter((i) => i.key === 'scene:1')
      return items[items.length - 1].request.characterPrompts[0].prompt
    }
    const SYNTH_CARD = '1girl, nude, blue eyes, red hair'

    beforeEach(() => {
      sceneList = [makeScene(1, { prompt: 'bed, closed eyes' })]
      useCharactersStore.setState({ items: [card(1, SYNTH_CARD, true)] })
    })

    it('기본(셋 다 꺼짐)이면 카드 글이 그대로 올라간다', async () => {
      const initial = useOutfitsStore.getInitialState()
      expect(initial.eyesClosedStrip).toBe(false)
      expect(initial.nudePinkNipples).toBe(false)
      expect(initial.exposeWorn).toBe(false)
      stop = startCloudPrepared()
      await settle()
      expect(lastCharacterPrompt()).toBe(SYNTH_CARD)
    })

    it('설정을 켜 두면 완성 요청에 PC 와 같이 반영된다', async () => {
      useOutfitsStore.setState({ eyesClosedStrip: true, nudePinkNipples: true })
      stop = startCloudPrepared()
      await settle()
      const text = lastCharacterPrompt()
      expect(text).not.toContain('blue eyes')
      expect(text).toContain('pink nipples')
      // 올라가는 요청에는 화면용 메모(bodyNotes)가 실리지 않는다
      const sent = prepared()
        .flatMap((p) => p.items)
        .find((i) => i.key === 'scene:1')
      expect(sent?.request.bodyNotes).toBeUndefined()
    })

    it('눈이 안 보이면 눈 태그 빼기를 켜면 20초 디바운스 뒤 씬을 다시 올리고, 끄면 되돌린다', async () => {
      stop = startCloudPrepared()
      await settle()
      expect(lastCharacterPrompt()).toBe(SYNTH_CARD)
      const before = calc()
      useOutfitsStore.getState().setEyesClosedStrip(true)
      await vi.advanceTimersByTimeAsync(19_000)
      expect(calc()).toBe(before)
      await vi.advanceTimersByTimeAsync(2_000)
      await settle()
      expect(calc()).toBe(before + 1)
      expect(lastCharacterPrompt()).not.toContain('blue eyes')
      useOutfitsStore.getState().setEyesClosedStrip(false)
      await vi.advanceTimersByTimeAsync(21_000)
      await settle()
      expect(calc()).toBe(before + 2)
      expect(lastCharacterPrompt()).toBe(SYNTH_CARD)
    })

    it('잠듦·눈 가림도 PC 와 같은 조립으로 반영된다 — 켜면 눈 외형이 빠진 요청이 올라가고, 꺼 두면 카드 글 그대로', async () => {
      for (const prompt of ['bed, sleeping', 'bed, blindfold', 'bed, closed eyes']) {
        sceneList = [makeScene(1, { prompt })]
        stop = startCloudPrepared()
        await settle()
        expect(lastCharacterPrompt(), prompt).toBe(SYNTH_CARD)
        useOutfitsStore.getState().setEyesClosedStrip(true)
        await vi.advanceTimersByTimeAsync(21_000)
        await settle()
        expect(lastCharacterPrompt(), prompt).not.toContain('blue eyes')
        expect(lastCharacterPrompt(), prompt).toContain('red hair')
        useOutfitsStore.getState().setEyesClosedStrip(false)
        await vi.advanceTimersByTimeAsync(21_000)
        await settle()
        expect(lastCharacterPrompt(), prompt).toBe(SYNTH_CARD)
        stop()
        stop = null
      }
    })

    it('알몸일 때 pink nipples 를 켜면 다시 올리고, 끄면 되돌린다', async () => {
      stop = startCloudPrepared()
      await settle()
      const before = calc()
      useOutfitsStore.getState().setNudePinkNipples(true)
      await vi.advanceTimersByTimeAsync(21_000)
      await settle()
      expect(calc()).toBe(before + 1)
      expect(lastCharacterPrompt()).toContain('pink nipples')
      useOutfitsStore.getState().setNudePinkNipples(false)
      await vi.advanceTimersByTimeAsync(21_000)
      await settle()
      expect(calc()).toBe(before + 2)
      expect(lastCharacterPrompt()).toBe(SYNTH_CARD)
    })

    it('복장 설정 다섯 개가 바뀌면 모두 다시 계산한다', async () => {
      stop = startCloudPrepared()
      await settle()
      // (옷 벗기기 stripOnNude 는 켜면 카드 옷 분류 IPC 가 따로 필요해 여기서는 보지 않는다)
      for (const key of [
        'exposeWorn',
        'futaReassembly',
        'futaViewFix',
        'eyesClosedStrip',
        'nudePinkNipples'
      ] as const) {
        const before = calc()
        useOutfitsStore.setState({ [key]: !useOutfitsStore.getState()[key] })
        await vi.advanceTimersByTimeAsync(21_000)
        await settle()
        expect(calc(), key).toBe(before + 1)
      }
    })
  })

  describe('동기화·판 상태', () => {
    it('동기화가 꺼져 있으면 계산하지도 보내지도 않고, 켜지는 순간 시작한다', async () => {
      responders.set('cloud:status', () => status(true, { enabled: false }))
      stop = startCloudPrepared()
      await settle()
      emit('cloud:needPrepared', { full: true })
      useGenerationStore.setState({
        request: { ...useGenerationStore.getState().request, prompt: '1girl, edit' }
      })
      await vi.advanceTimersByTimeAsync(30_000)
      expect(callsOf('scenes:listAllLite')).toHaveLength(0)
      expect(prepared()).toHaveLength(0)

      emit('cloud:status', status(true))
      await settle()
      expect(itemCount()).toBe(451)
    })

    it('판이 달라도(protocolMismatch) 계산하지 않는다', async () => {
      responders.set('cloud:status', () => status(true, { protocolMismatch: true }))
      stop = startCloudPrepared()
      await settle()
      expect(callsOf('scenes:listAllLite')).toHaveLength(0)

      emit('cloud:status', status(true))
      await settle()
      expect(itemCount()).toBe(451)
    })

    it('꺼졌던 조건이 다시 켜지면 보낸 기록을 비우고 바뀐 게 없어도 전부 다시 보낸다', async () => {
      stop = startCloudPrepared()
      await settle()
      expect(itemCount()).toBe(451)

      // 동기화를 끄고 설정을 고친 채로 둔다 — 꺼진 동안 메인이 올리기를 조용히 무시했을 수 있다
      emit('cloud:status', status(true, { enabled: false }))
      await vi.advanceTimersByTimeAsync(30_000)
      const sentBefore = prepared().length

      emit('cloud:status', status(true))
      await settle()
      const resent = prepared().slice(sentBefore)
      expect(resent.reduce((n, p) => n + p.items.length, 0)).toBe(451)
      expect(resent[resent.length - 1].allKeys).toHaveLength(451)
    })

    it('클라우드 생성 스위치만 껐다 켜도 전부 다시 보낸다', async () => {
      stop = startCloudPrepared()
      await settle()
      const sentBefore = prepared().length
      emit('cloud:status', status(false))
      emit('cloud:status', status(true))
      await settle()
      expect(
        prepared()
          .slice(sentBefore)
          .reduce((n, p) => n + p.items.length, 0)
      ).toBe(451)
    })

    it('같은 상태가 다시 오면 아무것도 하지 않는다', async () => {
      stop = startCloudPrepared()
      await settle()
      const before = callsOf('scenes:listAllLite').length
      emit('cloud:status', status(true))
      emit('cloud:status', status(true, { connected: true, lastSyncAt: 5 }))
      await settle()
      expect(callsOf('scenes:listAllLite')).toHaveLength(before)
    })
  })

  describe('PC의 i2i 소스', () => {
    it('불러 둔 소스는 메인·씬 요청에 섞지 않고, 해상도도 소스 크기로 덮지 않는다', async () => {
      useGenerationStore.setState({
        source: { imageBase64: 'IMG', maskBase64: 'MASK', width: 512, height: 512 }
      })
      stop = startCloudPrepared()
      await settle()
      const items = prepared().flatMap((p) => p.items)
      expect(items).toHaveLength(451)
      for (const item of items) {
        expect(item.request.source).toBeUndefined()
        expect([item.request.width, item.request.height]).not.toEqual([512, 512])
      }
      expect(items[0].request.width).toBe(DEFAULT_REQUEST.width)
      expect(items[1].request.width).toBe(832)
    })

    it('소스를 불러오거나 지워도 다시 계산하지 않는다', async () => {
      stop = startCloudPrepared()
      await settle()
      const before = callsOf('scenes:listAllLite').length
      useGenerationStore.setState({ source: { imageBase64: 'IMG', width: 512, height: 512 } })
      await vi.advanceTimersByTimeAsync(25_000)
      useGenerationStore.setState({ source: null })
      await vi.advanceTimersByTimeAsync(25_000)
      await settle()
      expect(callsOf('scenes:listAllLite')).toHaveLength(before)
    })

    it('i2i 강도·노이즈는 완성 요청에 싣지 않고, 바꿔도 다시 계산하지도 올리지도 않는다', async () => {
      const setI2i = (i2iStrength: number, i2iNoise: number): void =>
        useGenerationStore.setState({
          request: { ...useGenerationStore.getState().request, i2iStrength, i2iNoise }
        })
      setI2i(0.4, 0.1)
      stop = startCloudPrepared()
      await settle()
      const items = prepared().flatMap((p) => p.items)
      expect(items).toHaveLength(451)
      for (const item of items) {
        expect('i2iStrength' in item.request).toBe(false)
        expect('i2iNoise' in item.request).toBe(false)
      }
      const hashes = new Map(items.map((i) => [i.key, i.hash]))

      // 파라미터 창에서 i2i 강도만 바꿈 → 디바운스가 지나도 계산하지 않는다
      const before = callsOf('scenes:listAllLite').length
      const uploads = prepared().length
      setI2i(0.9, 0.5)
      await vi.advanceTimersByTimeAsync(25_000)
      await settle()
      expect(callsOf('scenes:listAllLite')).toHaveLength(before)
      // 억지로 다시 계산해도 해시가 같아 한 건도 다시 올라가지 않는다
      emit('cloud:needPrepared', { full: false })
      await settle()
      expect(callsOf('scenes:listAllLite').length).toBeGreaterThan(before)
      expect(prepared()).toHaveLength(uploads)

      // 전부 다시 올려도 해시는 처음과 같다
      emit('cloud:needPrepared', { full: true })
      await settle()
      const again = prepared()
        .slice(uploads)
        .flatMap((p) => p.items)
      expect(again).toHaveLength(451)
      for (const item of again) expect(item.hash).toBe(hashes.get(item.key))
    })

    it('요청 내용이 바뀌면 여전히 다시 계산한다 (i2i 값만 무시)', async () => {
      stop = startCloudPrepared()
      await settle()
      const before = callsOf('scenes:listAllLite').length
      useGenerationStore.setState({
        request: { ...useGenerationStore.getState().request, steps: 20, i2iStrength: 0.2 }
      })
      await vi.advanceTimersByTimeAsync(25_000)
      await settle()
      expect(callsOf('scenes:listAllLite').length).toBeGreaterThan(before)
    })
  })

  describe('씬 목록 변경 감지', () => {
    const inPreset = (presetId: number, ids: number[]): Scene[] =>
      ids.map((id) => makeScene(id, { presetId }))
    const calc = (): number => callsOf('scenes:listAllLite').length

    beforeEach(() => {
      useScenesStore.setState({ activePresetId: 1, scenes: inPreset(1, [1, 2, 3]) })
    })

    it('프리셋을 바꿔 씬 목록이 통째로 달라져도 다시 계산하지 않는다 (실제 setActivePreset)', async () => {
      const byPreset: Record<number, Scene[]> = {
        1: inPreset(1, [1, 2, 3]),
        2: inPreset(2, [11, 12])
      }
      responders.set('scenes:list', (req) => ({
        items: byPreset[(req as { presetId: number }).presetId] ?? []
      }))
      stop = startCloudPrepared()
      await settle()
      const before = calc()

      // 활성 프리셋 id 가 먼저 바뀌고 씬 목록은 뒤따라 따로 바뀐다
      await useScenesStore.getState().setActivePreset(2)
      expect(useScenesStore.getState().scenes.map((s) => s.id)).toEqual([11, 12])
      await vi.advanceTimersByTimeAsync(30_000)
      await settle()
      expect(calc()).toBe(before)

      // 다시 돌아와도 마찬가지
      await useScenesStore.getState().setActivePreset(1)
      await vi.advanceTimersByTimeAsync(30_000)
      await settle()
      expect(calc()).toBe(before)
    })

    it('빈 프리셋으로 바꾸거나 빈 프리셋에서 돌아와도 다시 계산하지 않는다', async () => {
      const byPreset: Record<number, Scene[]> = { 1: inPreset(1, [1, 2, 3]), 3: [] }
      responders.set('scenes:list', (req) => ({
        items: byPreset[(req as { presetId: number }).presetId] ?? []
      }))
      stop = startCloudPrepared()
      await settle()
      const before = calc()
      await useScenesStore.getState().setActivePreset(3)
      await useScenesStore.getState().setActivePreset(1)
      await vi.advanceTimersByTimeAsync(30_000)
      await settle()
      expect(calc()).toBe(before)
    })

    it('씬↔배경 라이브러리를 바꿔도 다시 계산하지 않는다 (실제 activateLibrary)', async () => {
      responders.set('scenePresets:list', (req) => ({
        items:
          (req as { kind: string }).kind === 'background'
            ? [{ id: 7, name: '배경', kind: 'background', sortOrder: 0, sceneCount: 2 }]
            : [{ id: 1, name: '씬', kind: 'scene', sortOrder: 0, sceneCount: 3 }]
      }))
      responders.set('scenes:list', (req) => ({
        items:
          (req as { presetId: number }).presetId === 7
            ? inPreset(7, [21, 22])
            : inPreset(1, [1, 2, 3])
      }))
      useScenesStore.setState({
        presets: [{ id: 1, name: '씬', kind: 'scene', sortOrder: 0, sceneCount: 3 }] as never
      })
      stop = startCloudPrepared()
      await settle()
      const before = calc()

      await useScenesStore.getState().activateLibrary('background')
      expect(useScenesStore.getState().scenes.map((s) => s.id)).toEqual([21, 22])
      await useScenesStore.getState().activateLibrary('scene')
      expect(useScenesStore.getState().scenes.map((s) => s.id)).toEqual([1, 2, 3])
      await vi.advanceTimersByTimeAsync(30_000)
      await settle()
      expect(calc()).toBe(before)
    })

    it('같은 프리셋 안에서 씬 프롬프트를 고치면 다시 계산한다', async () => {
      stop = startCloudPrepared()
      await settle()
      const before = calc()
      useScenesStore.setState({
        scenes: useScenesStore
          .getState()
          .scenes.map((s) => (s.id === 2 ? { ...s, prompt: 'edited' } : s))
      })
      await vi.advanceTimersByTimeAsync(21_000)
      await settle()
      expect(calc()).toBe(before + 1)
    })

    it('프리셋을 바꾼 뒤에도 새 목록 안의 편집은 놓치지 않는다', async () => {
      const byPreset: Record<number, Scene[]> = {
        1: inPreset(1, [1, 2, 3]),
        2: inPreset(2, [11, 12])
      }
      responders.set('scenes:list', (req) => ({
        items: byPreset[(req as { presetId: number }).presetId] ?? []
      }))
      stop = startCloudPrepared()
      await settle()
      await useScenesStore.getState().setActivePreset(2)
      await vi.advanceTimersByTimeAsync(30_000)
      await settle()
      const before = calc()
      useScenesStore.setState({
        scenes: useScenesStore
          .getState()
          .scenes.map((s) => (s.id === 12 ? { ...s, prompt: 'edited' } : s))
      })
      await vi.advanceTimersByTimeAsync(21_000)
      await settle()
      expect(calc()).toBe(before + 1)
    })

    it('씬을 추가하거나 지우면, 빈 프리셋에 첫 씬을 넣어도 다시 계산한다', async () => {
      stop = startCloudPrepared()
      await settle()
      let before = calc()
      useScenesStore.setState({ scenes: inPreset(1, [1, 2, 3, 4]) })
      await vi.advanceTimersByTimeAsync(21_000)
      await settle()
      expect(calc()).toBe(before + 1)

      // 전부 지움 → 첫 씬 추가
      before = calc()
      useScenesStore.setState({ scenes: [] })
      await vi.advanceTimersByTimeAsync(21_000)
      await settle()
      expect(calc()).toBe(before + 1)
      useScenesStore.setState({ scenes: inPreset(1, [9]) })
      await vi.advanceTimersByTimeAsync(21_000)
      await settle()
      expect(calc()).toBe(before + 2)
    })

    it('프리셋을 추가하거나 지우면 다시 계산한다', async () => {
      const preset = (id: number): never =>
        ({ id, name: `p${id}`, kind: 'scene', sortOrder: id, sceneCount: 0 }) as never
      useScenesStore.setState({ presets: [preset(1), preset(2)] })
      stop = startCloudPrepared()
      await settle()
      const before = calc()
      useScenesStore.setState({ presets: [preset(1)] })
      await vi.advanceTimersByTimeAsync(21_000)
      await settle()
      expect(calc()).toBe(before + 1)
    })
  })

  describe('양보', () => {
    const restores: (() => void)[] = []
    afterEach(() => {
      for (const restore of restores.splice(0)) restore()
    })

    /** performance.now 를 대신한다 (양보 판단이 쓰는 시계) */
    function fakeClock(now: () => number): void {
      const spy = vi.spyOn(performance, 'now').mockImplementation(now)
      restores.push(() => spy.mockRestore())
    }

    /** MessageChannel 생성 횟수를 센다 (양보 1번 = 채널 1개) */
    function countChannels(): { count: () => number } {
      let n = 0
      const Real = globalThis.MessageChannel
      vi.stubGlobal(
        'MessageChannel',
        class extends Real {
          constructor() {
            super()
            n++
          }
        }
      )
      restores.push(() => vi.stubGlobal('MessageChannel', Real))
      return { count: () => n }
    }

    it('계산이 8ms 넘게 이어지면 MessageChannel 로 양보한다 (개수가 아니라 시간 기준)', async () => {
      vi.useRealTimers()
      sceneList = sceneList.slice(0, 40)
      // 시계가 읽을 때마다 5ms 씩 가는 것처럼 — 씬 두 개마다 8ms 를 넘긴다
      let clock = 0
      fakeClock(() => (clock += 5))
      const channels = countChannels()
      stop = startCloudPrepared()
      await vi.waitFor(() => expect(itemCount()).toBe(41), { timeout: 5000 })
      expect(channels.count()).toBeGreaterThanOrEqual(10)
      expect(channels.count()).toBeLessThanOrEqual(45)
    })

    it('시계가 안 가면(빠른 계산) 씬 수가 많아도 양보하지 않는다', async () => {
      vi.useRealTimers()
      fakeClock(() => 1)
      const channels = countChannels()
      stop = startCloudPrepared()
      await vi.waitFor(() => expect(itemCount()).toBe(451), { timeout: 5000 })
      expect(channels.count()).toBe(0)
    })

    it('양보하는 사이 꺼지면 남은 계산을 버리고 아무것도 보내지 않는다', async () => {
      vi.useRealTimers()
      let clock = 0
      fakeClock(() => (clock += 5))
      // 씬 목록을 받는 순간 꺼진다 — 계산이 시작되고 첫 양보에서 알아챈다
      responders.set('scenes:listAllLite', () => {
        emit('cloud:status', status(false))
        return { items: sceneList }
      })
      stop = startCloudPrepared()
      await vi.waitFor(() => expect(callsOf('scenes:listAllLite')).toHaveLength(1), {
        timeout: 5000
      })
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(prepared()).toHaveLength(0)
    })
  })
})

// invoke 가 쓰였는지 타입 검사용으로 참조 (vi.hoisted 밖에서 미사용 경고 방지)
void invoke
void listeners
