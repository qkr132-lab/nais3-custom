import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CharacterCard, GenerationRequest, Scene } from '../src/shared/types'

const { invoke } = vi.hoisted(() => {
  const invoke = vi.fn((channel: string): unknown => {
    throw new Error(`요청을 만들 때는 IPC 를 부르지 않는다 (${channel})`)
  })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() })
  vi.stubGlobal('window', { nais: { invoke } })
  return { invoke }
})

import { buildSceneRequest, useScenesStore } from '../src/renderer/src/stores/scenes-store'
import { DEFAULT_REQUEST, useGenerationStore } from '../src/renderer/src/stores/generation-store'
import { useCharactersStore } from '../src/renderer/src/stores/characters-store'
import { useSceneExtrasStore } from '../src/renderer/src/stores/scene-extras-store'
import { useOutfitsStore } from '../src/renderer/src/stores/outfits-store'
import { useCharRefsStore, useVibesStore } from '../src/renderer/src/stores/refs-store'
import { DEFAULT_EXPOSE_ACTS } from '../src/shared/auto-expose'
import { refreshScenePrompts } from '../src/shared/scene-request'
import { bodyNotesOfChar } from '../src/renderer/src/lib/body-notes'

/**
 * 눈 감음이면 카드의 눈 외형 태그를 뺀다 — 요청 조립 전체 경로 (합성 카드·합성 씬만. 사용자 데이터는 쓰지 않는다).
 * 씬 경로(buildSceneRequest)와 메인 탭 경로(buildMainRequest)가 같은 규칙을 쓰고, 뺀 것은 전부 bodyNotes 에 있고,
 * 실행 직전 재조립(refreshScenePrompts · resyncPendingScenes)을 거쳐도 유지된다.
 * 설정 「눈 감으면 눈 태그 빼기」(eyesClosedStrip, 기본 꺼짐)를 켜야 동작한다 — 아래 setup 은 명시적으로 켜 두고,
 * 맨 아래 describe 가 끈 경우(기본)와 저장값 읽기를 시험한다.
 */

const card = (
  id: number,
  prompt: string,
  role: CharacterCard['role'] = null,
  extra: Partial<CharacterCard> = {}
): CharacterCard =>
  ({
    id,
    name: `카드 ${id}`,
    prompt,
    negativePrompt: '',
    enabled: true,
    center: { x: 0.5, y: 0.5 },
    role,
    slotNo: null,
    charRefId: null,
    ...extra
  }) as CharacterCard

const sceneOf = (over: Partial<Scene> = {}): Scene =>
  ({
    id: 4,
    presetId: 1,
    name: '합성 씬',
    prompt: 'bed, kiss',
    negativePrompt: '',
    width: 832,
    height: 1216,
    reserveCount: 1,
    varietyPlus: false,
    sourceTags: '',
    targetTags: '',
    sourcePos: null,
    targetPos: null,
    censorKinds: [],
    ...over
  }) as Scene

const GIRL = 1
const BOY = 2
const GIRL_CARD = '1girl, blue eyes, slit pupils, red hair, tsurime, long eyelashes'
const BOY_CARD = '1boy, brown eyes, muscular, glasses'
/** 눈 색·동공을 뺀 모양 */
const GIRL_CLOSED = '1girl, red hair, tsurime, long eyelashes'
const BOY_CLOSED = '1boy, muscular, glasses'

function setup(opts: {
  cards?: CharacterCard[]
  strip?: boolean
  exposeWorn?: boolean
  reassembly?: boolean
  viewFix?: boolean
  /** 눈 감으면 눈 태그 빼기 — 이 파일은 눈 감음 시험이라 기본 켬 (실제 기본값은 꺼짐) */
  eyes?: boolean
  /** 알몸일 때 pink nipples — 기존 기대(알몸 캐릭터 글)를 그대로 두려고 기본 켬 (실제 기본값은 꺼짐) */
  pink?: boolean
}): void {
  useGenerationStore.setState({
    request: { ...DEFAULT_REQUEST, prompt: 'masterpiece', negativePrompt: '' },
    promptSplitEnabled: false,
    source: null
  })
  useOutfitsStore.setState({
    items: [],
    acts: DEFAULT_EXPOSE_ACTS,
    stripOnNude: opts.strip ?? false,
    exposeWorn: opts.exposeWorn ?? true,
    futaReassembly: opts.reassembly ?? true,
    futaViewFix: opts.viewFix ?? true,
    eyesClosedStrip: opts.eyes ?? true,
    nudePinkNipples: opts.pink ?? true,
    kinds: {},
    loaded: true
  })
  useVibesStore.setState({ loaded: true })
  useCharRefsStore.setState({ loaded: true })
  useCharactersStore.setState({
    loaded: true,
    items: opts.cards ?? [card(GIRL, GIRL_CARD, 'target'), card(BOY, BOY_CARD, 'source')]
  })
  useSceneExtrasStore.setState({
    loaded: true,
    sequenceEnabled: false,
    entries: [],
    additionsEnabled: false,
    additions: {},
    nudeStrips: {}
  })
}

const prompts = (r: GenerationRequest): string[] => r.characterPrompts.map((c) => c.prompt)

describe('씬 경로 — 어느 캐릭터에게 걸린 장면 태그인가 (옷 벗기기와 같은 범위)', () => {
  beforeEach(() => setup({}))

  it('씬 전체 글의 closed eyes 는 당하는쪽에게만 — 하는쪽 눈 색은 남는다', () => {
    const r = buildSceneRequest(sceneOf({ prompt: 'bed, closed eyes, kiss' }))
    expect(prompts(r)).toEqual([GIRL_CLOSED, BOY_CARD])
  })

  it('하는쪽 태그의 closed eyes 는 하는쪽에게만, 당하는쪽 태그의 것은 당하는쪽에게만', () => {
    const src = buildSceneRequest(sceneOf({ sourceTags: 'closed eyes' }))
    expect(prompts(src)).toEqual([GIRL_CARD, `${BOY_CLOSED}, closed eyes`])
    const tgt = buildSceneRequest(sceneOf({ targetTags: 'eyes closed' }))
    expect(prompts(tgt)).toEqual([`${GIRL_CLOSED}, eyes closed`, BOY_CARD])
  })

  it('역할이 걸린 캐릭터가 없는 씬이면 씬 전체 글을 모두가 받는다', () => {
    setup({ cards: [card(GIRL, GIRL_CARD), card(BOY, BOY_CARD)] })
    const r = buildSceneRequest(sceneOf({ prompt: 'bed, closed eyes' }))
    expect(prompts(r)).toEqual([GIRL_CLOSED, BOY_CLOSED])
  })

  it('이 씬에서만 얹는 캐릭터 태그(charTags)는 그 캐릭터에게만', () => {
    useSceneExtrasStore.setState({
      additionsEnabled: true,
      additions: {
        1: {
          4: {
            characterIds: [GIRL, BOY],
            charRefIds: [],
            vibeIds: [],
            charTags: { [BOY]: 'closed eyes' }
          }
        }
      }
    })
    const r = buildSceneRequest(sceneOf())
    expect(prompts(r)).toEqual([GIRL_CARD, `${BOY_CLOSED}, closed eyes`])
  })

  it('카드의 상대 태그: 하는쪽 카드가 당하는쪽에게 거는 closed eyes 는 당하는쪽에게만', () => {
    setup({
      cards: [
        card(GIRL, GIRL_CARD, 'target'),
        card(BOY, BOY_CARD, 'source', { partnerTags: 'closed eyes' })
      ]
    })
    const r = buildSceneRequest(sceneOf())
    expect(prompts(r)).toEqual([`${GIRL_CLOSED}, closed eyes`, BOY_CARD])
  })

  it('영어 문장도 읽는다 — 씬 글의 her eyes are closed · with eyes closed', () => {
    for (const text of ['her eyes are closed', 'with eyes closed', 'she closes her eyes']) {
      const r = buildSceneRequest(sceneOf({ prompt: `bed, ${text}, kiss` }))
      expect(prompts(r), text).toEqual([GIRL_CLOSED, BOY_CARD])
    }
  })

  it('her/his 가 다른 쪽 몸이면 읽지 않는다 — 씬 글의 his eyes are closed 는 당하는쪽(여)에게 걸리지 않는다', () => {
    const r = buildSceneRequest(sceneOf({ prompt: 'bed, his eyes are closed, kiss' }))
    expect(prompts(r)).toEqual([GIRL_CARD, BOY_CARD])
    expect(r.bodyNotes).toBeUndefined()
    // 하는쪽 칸의 his 는 하는쪽(남)에게 걸린다
    const src = buildSceneRequest(sceneOf({ sourceTags: 'his eyes are closed' }))
    expect(prompts(src)).toEqual([GIRL_CARD, `${BOY_CLOSED}, his eyes are closed`])
  })

  it('눈이 보이는 표현은 빼지 않는다 — one eye closed · half-closed eyes · wink · 부정문', () => {
    for (const text of [
      'one eye closed',
      'half-closed eyes',
      'wink',
      'her eyes are not closed',
      '-1::closed eyes::'
    ]) {
      const r = buildSceneRequest(sceneOf({ prompt: `bed, ${text}` }))
      expect(prompts(r), text).toEqual([GIRL_CARD, BOY_CARD])
      expect(r.bodyNotes, text).toBeUndefined()
    }
  })
})

describe('씬 경로 — 얼굴 인셋 자리는 그 자리 태그 기준', () => {
  const inset = (slotTags: Record<number, string>): void =>
    useSceneExtrasStore.setState({
      additionsEnabled: true,
      additions: {
        1: {
          4: {
            characterIds: [GIRL, BOY],
            charRefIds: [],
            vibeIds: [],
            slots: [
              { x: 0.3, y: 0.5 },
              { x: 0.7, y: 0.5 },
              { x: 0.7, y: 0.1 }
            ],
            slotChars: { 0: BOY, 1: GIRL, 2: GIRL },
            slotRoles: { 0: 'source', 1: 'target', 2: 'target' },
            slotTags
          }
        }
      }
    })
  beforeEach(() => setup({}))

  it('씬 글의 closed eyes 는 몸 자리에만 걸리고, 얼굴 인셋 자리는 눈 색이 남는다', () => {
    inset({ 2: 'close-up, portrait' })
    const r = buildSceneRequest(sceneOf({ prompt: 'bed, closed eyes' }))
    // 캐릭터 순서대로 — 같은 카드가 앉은 자리 둘이 이어지고 하는쪽이 뒤에 온다
    expect(prompts(r)).toEqual([
      GIRL_CLOSED,
      // 얼굴 인셋: 자리 태그만 본다
      `${GIRL_CARD}, close-up, portrait`,
      BOY_CARD
    ])
  })

  it('인셋 자리에 closed eyes 를 적으면 그 자리만 뺀다', () => {
    inset({ 2: 'close-up, portrait, closed eyes' })
    const r = buildSceneRequest(sceneOf())
    expect(prompts(r)).toEqual([
      GIRL_CARD,
      `${GIRL_CLOSED}, close-up, portrait, closed eyes`,
      BOY_CARD
    ])
    // 같은 카드의 두 자리 — 메모는 자리(순서)마다 따로 남는다
    const notes = r.bodyNotes ?? []
    expect(new Set(notes.map((n) => n.charIndex))).toEqual(new Set([1]))
    expect(notes.every((n) => n.charId === GIRL)).toBe(true)
  })

  it('자리 태그의 closed eyes 는 몸 자리에서도 그 자리에만 걸린다', () => {
    inset({ 1: 'closed eyes' })
    const r = buildSceneRequest(sceneOf())
    expect(prompts(r)).toEqual([`${GIRL_CLOSED}, closed eyes`, GIRL_CARD, BOY_CARD])
  })
})

describe('씬 경로 — 화면에 보이는 메모 (몰래 빼기 금지)', () => {
  beforeEach(() => setup({}))

  it('뺀 태그마다 bodyNotes 에 removed 메모가 있다 — 이유·근거·캐릭터 순서와 카드 id', () => {
    const r = buildSceneRequest(sceneOf({ prompt: 'bed, her eyes are closed, kiss' }))
    expect(r.bodyNotes).toEqual([
      {
        kind: 'removed',
        where: 'char',
        topic: 'eyes',
        charIndex: 0,
        name: '카드 1',
        charId: GIRL,
        before: 'blue eyes',
        evidence: 'her eyes are closed',
        reason: '눈 감음 — 눈 색 뺌'
      },
      {
        kind: 'removed',
        where: 'char',
        topic: 'eyes',
        charIndex: 0,
        name: '카드 1',
        charId: GIRL,
        before: 'slit pupils',
        evidence: 'her eyes are closed',
        reason: '눈 감음 — 동공 뺌'
      }
    ])
    // 화면(배치 창)은 카드 id 로 그 카드의 메모만 찾는다
    const mine = bodyNotesOfChar(r.bodyNotes, { id: GIRL, name: '카드 1' })
    expect(mine).toHaveLength(2)
    expect(bodyNotesOfChar(r.bodyNotes, { id: BOY, name: '카드 2' })).toHaveLength(0)
    // 씬에 적힌 원본과 카드 원본은 그대로다
    expect(useCharactersStore.getState().items[0].prompt).toBe(GIRL_CARD)
  })

  it('빼지 않았으면 메모도 요청의 bodyNotes 도 없다', () => {
    const r = buildSceneRequest(sceneOf({ prompt: 'bed, kiss' }))
    expect('bodyNotes' in r).toBe(false)
    expect(prompts(r)).toEqual([GIRL_CARD, BOY_CARD])
  })

  it('가중치 묶음·음수 가중치가 섞인 카드도 안전하다', () => {
    setup({
      cards: [
        card(GIRL, '1girl, 1.2::blue eyes, red hair::, -1::green eyes::, slit pupils', 'target')
      ]
    })
    const r = buildSceneRequest(sceneOf({ prompt: 'closed eyes' }))
    expect(prompts(r)).toEqual(['1girl, 1.2::red hair::, -1::green eyes::'])
    expect((r.bodyNotes ?? []).map((n) => n.before)).toEqual(['blue eyes', 'slit pupils'])
  })
})

describe('씬 경로 — 옷 벗기기·젖힘·후타 재조립 설정과 상관없이 따로 켠다', () => {
  it('옷 벗기기·입은 옷 자동 젖힘·후타 재조립을 모두 꺼도 뺀다', () => {
    setup({ strip: false, exposeWorn: false, reassembly: false, pink: false })
    const r = buildSceneRequest(sceneOf({ prompt: 'bed, closed eyes' }))
    expect(prompts(r)).toEqual([GIRL_CLOSED, BOY_CARD])
    expect(r.bodyNotes?.every((n) => n.topic === 'eyes')).toBe(true)
  })

  it('옷 벗기기가 켜져 알몸이 돼도 눈만 따로 뺀다', () => {
    setup({ strip: true })
    useSceneExtrasStore.setState({ nudeStrips: { 1: { 4: true } } })
    const r = buildSceneRequest(sceneOf({ prompt: 'bed, closed eyes' }))
    expect(r.characterPrompts[0].prompt).toBe(`${GIRL_CLOSED}, nude, completely nude, pink nipples`)
    expect(r.characterPrompts[0].prompt).not.toContain('blue eyes')
  })

  it('후타 카드: 하는쪽 후타의 her/his 문장은 성별로 거르지 않는다', () => {
    setup({
      cards: [
        card(GIRL, '1girl, futanari, blue eyes, no testicles', 'source'),
        card(BOY, '1girl, red eyes, red hair', 'target')
      ]
    })
    const a = buildSceneRequest(sceneOf({ sourceTags: 'his eyes are closed' }))
    // (하는쪽 칸의 his 는 후타 재조립이 the futanari's 로 바꾼다 — 눈 색은 그래도 빠진다)
    expect(a.characterPrompts[0].prompt).toBe(
      "1girl, futanari, no testicles, the futanari's eyes are closed"
    )
    // 후타가 아닌 하는쪽은 her/his 로 거른다
    setup({
      cards: [card(GIRL, '1boy, blue eyes', 'source'), card(BOY, '1girl, red eyes', 'target')]
    })
    const b = buildSceneRequest(sceneOf({ sourceTags: 'her eyes are closed' }))
    expect(b.characterPrompts[0].prompt).toBe('1boy, blue eyes, her eyes are closed')
  })
})

describe('실행 직전 재조립에서도 유지된다', () => {
  beforeEach(() => setup({}))

  it('refreshScenePrompts 를 거쳐도, 직렬화해서 다시 읽어도 같은 캐릭터 글과 메모', () => {
    const scene = sceneOf({ prompt: 'bed, closed eyes, kiss' })
    const r = buildSceneRequest(scene)
    const refreshed = refreshScenePrompts(r, scene)
    expect(refreshed.characterPrompts).toEqual(r.characterPrompts)
    expect(refreshed.bodyNotes).toEqual(r.bodyNotes)
    const wire = JSON.parse(JSON.stringify(r)) as GenerationRequest
    const again = refreshScenePrompts(wire, scene)
    expect(prompts(again)).toEqual([GIRL_CLOSED, BOY_CARD])
    expect(again.bodyNotes).toEqual(r.bodyNotes)
    // 씬 글을 고쳐도(실행 직전 재합성) 조립 때 정한 캐릭터 글은 그대로 — 새로 만들려면 대기 항목 다시 만들기가 한다
    const edited = refreshScenePrompts(r, { ...scene, prompt: 'bed, kiss' })
    expect(prompts(edited)).toEqual([GIRL_CLOSED, BOY_CARD])
  })

  it('후타 재조립 계획이 있는 요청도 캐릭터 칸 메모(눈 감음)는 남는다', () => {
    setup({
      cards: [card(GIRL, '1girl, futanari, blue eyes', 'source'), card(BOY, GIRL_CARD, 'target')]
    })
    const scene = sceneOf({ prompt: '1girl, 1boy, hetero, kiss, closed eyes' })
    const r = buildSceneRequest(scene)
    expect(r.futaPlan).toBeDefined()
    expect(r.characterPrompts[1].prompt).toBe(`${GIRL_CLOSED}`)
    const refreshed = refreshScenePrompts(JSON.parse(JSON.stringify(r)) as GenerationRequest, scene)
    expect(refreshed.characterPrompts).toEqual(r.characterPrompts)
    expect((refreshed.bodyNotes ?? []).filter((n) => n.topic === 'eyes')).toHaveLength(2)
  })

  describe('대기 항목 다시 만들기 (resyncPendingScenes)', () => {
    // (mockReset 의 반환값을 돌려주면 vitest 가 정리 함수로 불러 버린다 — 중괄호로 막는다)
    beforeEach(() => {
      invoke.mockReset()
    })

    const run = async (
      pending: GenerationRequest[],
      scenes: Scene[]
    ): Promise<{ id: string; request: GenerationRequest }[]> => {
      let updates: { id: string; request: GenerationRequest }[] = []
      invoke.mockImplementation((channel: string, arg?: unknown): unknown => {
        if (channel === 'queue:pending')
          return { items: pending.map((request, i) => ({ id: `q${i}`, request })) }
        if (channel === 'queue:updatePending') {
          updates = (arg as { updates: typeof updates }).updates
          return undefined
        }
        throw new Error(`예상하지 못한 IPC: ${channel}`)
      })
      useScenesStore.setState({ scenes })
      await useScenesStore.getState().resyncPendingScenes()
      return updates
    }

    it('씬 항목: 고친 씬 글을 다시 읽어 뺐다 되살렸다 한다', async () => {
      const scene = sceneOf({ prompt: 'bed, closed eyes, kiss' })
      const queued = buildSceneRequest(scene)
      expect(prompts(queued)).toEqual([GIRL_CLOSED, BOY_CARD])
      // closed eyes 를 그대로 둔 채 다른 글만 고침 → 계속 빠져 있다
      const [same] = await run([queued], [{ ...scene, prompt: 'bed, closed eyes, hug' }])
      expect(prompts(same.request)).toEqual([GIRL_CLOSED, BOY_CARD])
      expect(same.request.bodyNotes?.filter((n) => n.topic === 'eyes')).toHaveLength(2)
      // closed eyes 를 지움 → 눈 색이 되살아나고 메모도 사라진다
      const [gone] = await run([queued], [{ ...scene, prompt: 'bed, kiss' }])
      expect(prompts(gone.request)).toEqual([GIRL_CARD, BOY_CARD])
      expect('bodyNotes' in gone.request).toBe(false)
      // 대기 중에 closed eyes 를 새로 적음 → 이제 빠진다
      const plain = buildSceneRequest(sceneOf({ prompt: 'bed, kiss' }))
      const [added] = await run([plain], [{ ...scene, prompt: 'bed, eyes closed' }])
      expect(prompts(added.request)).toEqual([GIRL_CLOSED, BOY_CARD])
    })

    it('메인 항목: 대기열에 넣을 때 정한 캐릭터 글(눈 색 뺌)과 메모가 그대로 남는다', async () => {
      useGenerationStore.setState({
        request: { ...DEFAULT_REQUEST, prompt: 'bed, closed eyes, kiss' },
        promptSplitEnabled: false
      })
      const main = await useGenerationStore.getState().buildMainRequest()
      expect(prompts(main)).toEqual([GIRL_CLOSED, BOY_CARD])
      useGenerationStore.setState({
        request: { ...DEFAULT_REQUEST, prompt: 'bed, hug' },
        promptSplitEnabled: false
      })
      const [u] = await run([main], [])
      expect(u.request.prompt).toBe('bed, hug')
      expect(prompts(u.request)).toEqual([GIRL_CLOSED, BOY_CARD])
      expect(u.request.bodyNotes?.filter((n) => n.topic === 'eyes')).toHaveLength(2)
    })
  })
})

describe('메인 탭 경로', () => {
  beforeEach(() => setup({}))

  const main = async (prompt: string, cards?: CharacterCard[]): Promise<GenerationRequest> => {
    if (cards) useCharactersStore.setState({ items: cards })
    useGenerationStore.setState({
      request: { ...DEFAULT_REQUEST, prompt },
      promptSplitEnabled: false
    })
    return useGenerationStore.getState().buildMainRequest()
  }

  it('메인 프롬프트의 closed eyes 는 당하는쪽에게만 (역할이 없으면 전원)', async () => {
    const r = await main('bed, closed eyes')
    expect(prompts(r)).toEqual([GIRL_CLOSED, BOY_CARD])
    const none = await main('bed, closed eyes', [card(GIRL, GIRL_CARD), card(BOY, BOY_CARD)])
    expect(prompts(none)).toEqual([GIRL_CLOSED, BOY_CLOSED])
  })

  it('상대 태그로 걸린 closed eyes 는 받는 쪽에게만', async () => {
    const r = await main('bed', [
      card(GIRL, GIRL_CARD, 'target'),
      card(BOY, BOY_CARD, 'source', { partnerTags: 'closed eyes' })
    ])
    expect(prompts(r)).toEqual([`${GIRL_CLOSED}, closed eyes`, BOY_CARD])
  })

  it('메모는 bodyNotes 에 있고, 영어 문장도 읽고, 눈이 보이는 표현은 건드리지 않는다', async () => {
    const r = await main('bed, with her eyes closed')
    expect(prompts(r)).toEqual([GIRL_CLOSED, BOY_CARD])
    expect(
      (r.bodyNotes ?? []).map((n) => [n.topic, n.kind, n.where, n.before, n.evidence])
    ).toEqual([
      ['eyes', 'removed', 'char', 'blue eyes', 'with her eyes closed'],
      ['eyes', 'removed', 'char', 'slit pupils', 'with her eyes closed']
    ])
    const open = await main('bed, half-closed eyes, wink')
    expect(prompts(open)).toEqual([GIRL_CARD, BOY_CARD])
    expect('bodyNotes' in open).toBe(false)
  })

  it('3분할 메인 프롬프트도 같다', async () => {
    useGenerationStore.setState({
      request: {
        ...DEFAULT_REQUEST,
        // 화면 상태에서 prompt 는 3분할을 합친 글과 늘 같다
        prompt: 'bed, closed eyes, kiss',
        promptParts: { base: 'bed', additional: 'closed eyes', detail: 'kiss' }
      },
      promptSplitEnabled: true
    })
    const r = await useGenerationStore.getState().buildMainRequest()
    expect(prompts(r)).toEqual([GIRL_CLOSED, BOY_CARD])
  })

  it('설정(옷 벗기기·젖힘·후타 재조립·pink nipples)을 꺼도 뺀다', async () => {
    setup({ exposeWorn: false, reassembly: false, pink: false })
    const r = await main('bed, closed eyes')
    expect(prompts(r)).toEqual([GIRL_CLOSED, BOY_CARD])
  })
})

describe('설정 「눈 감으면 눈 태그 빼기」 — 기본 꺼짐, 끄면 이 기능이 없을 때와 글자 단위로 같다', () => {
  it('씬 경로: 끄면 closed eyes 가 있어도 카드 글 그대로 · bodyNotes 에 눈 감음 메모가 없다', () => {
    setup({ eyes: false })
    const scene = sceneOf({ prompt: 'bed, closed eyes, kiss' })
    const r = buildSceneRequest(scene)
    expect(prompts(r)).toEqual([GIRL_CARD, BOY_CARD])
    expect((r.bodyNotes ?? []).filter((n) => n.topic === 'eyes')).toEqual([])
    // 같은 씬을 켜면 뺀다 — 끈 것과 켠 것이 갈린다
    setup({ eyes: true })
    expect(prompts(buildSceneRequest(scene))).toEqual([GIRL_CLOSED, BOY_CARD])
  })

  it('씬 경로: 끄면 상대 태그·캐릭터 태그·자리 태그의 closed eyes 도 읽지 않는다', () => {
    setup({
      eyes: false,
      cards: [
        card(GIRL, GIRL_CARD, 'target'),
        card(BOY, BOY_CARD, 'source', { partnerTags: 'closed eyes' })
      ]
    })
    expect(prompts(buildSceneRequest(sceneOf({ prompt: 'bed' })))).toEqual([
      `${GIRL_CARD}, closed eyes`,
      BOY_CARD
    ])
    expect(
      prompts(buildSceneRequest(sceneOf({ prompt: 'bed', sourceTags: 'eyes closed' })))
    ).toEqual([`${GIRL_CARD}, closed eyes`, `${BOY_CARD}, eyes closed`])
  })

  it('메인 탭 경로: 끄면 눈 태그를 빼지 않고 메모도 없다', async () => {
    setup({ eyes: false })
    useGenerationStore.setState({
      request: { ...DEFAULT_REQUEST, prompt: 'bed, with her eyes closed' },
      promptSplitEnabled: false
    })
    const r = await useGenerationStore.getState().buildMainRequest()
    expect(prompts(r)).toEqual([GIRL_CARD, BOY_CARD])
    expect('bodyNotes' in r).toBe(false)
  })

  it('끄면 대기 항목 다시 만들기도 눈 태그를 빼지 않는다 (설정을 끄면 대기 중 씬이 되돌아온다)', async () => {
    setup({ eyes: true })
    const scene = sceneOf({ prompt: 'bed, closed eyes, kiss' })
    const queued = buildSceneRequest(scene)
    expect(prompts(queued)).toEqual([GIRL_CLOSED, BOY_CARD])
    invoke.mockReset()
    let updates: { id: string; request: GenerationRequest }[] = []
    invoke.mockImplementation((channel: string, arg?: unknown): unknown => {
      if (channel === 'queue:pending') return { items: [{ id: 'q0', request: queued }] }
      if (channel === 'queue:updatePending') {
        updates = (arg as { updates: typeof updates }).updates
        return undefined
      }
      throw new Error(`예상하지 못한 IPC: ${channel}`)
    })
    useScenesStore.setState({ scenes: [scene] })
    useOutfitsStore.setState({ eyesClosedStrip: false })
    await useScenesStore.getState().resyncPendingScenes()
    expect(prompts(updates[0].request)).toEqual([GIRL_CARD, BOY_CARD])
    expect('bodyNotes' in updates[0].request).toBe(false)
  })
})

describe('저장값 읽기 — eyes_closed_strip (저장값 없음 → 꺼짐, 1 → 켬, 0 → 꺼짐)', () => {
  const loadWith = async (value: string | null): Promise<boolean> => {
    invoke.mockReset()
    invoke.mockImplementation((channel: string, arg?: unknown): unknown => {
      if (channel === 'outfits:list') return { items: [] }
      if (channel === 'settings:get') {
        return { value: (arg as { key: string }).key === 'eyes_closed_strip' ? value : null }
      }
      throw new Error(`예상하지 못한 IPC: ${channel}`)
    })
    await useOutfitsStore.getState().load()
    return useOutfitsStore.getState().eyesClosedStrip
  }

  it('저장값이 없으면 꺼짐, 1 일 때만 켜짐, 0 이나 다른 값은 꺼짐', async () => {
    expect(await loadWith(null)).toBe(false)
    expect(await loadWith('1')).toBe(true)
    expect(await loadWith('0')).toBe(false)
    expect(await loadWith('')).toBe(false)
    expect(await loadWith('true')).toBe(false)
  })

  it('스토어 처음 값은 꺼짐이고, 켜고 끄면 저장값 1·0 을 보낸다', () => {
    expect(useOutfitsStore.getInitialState().eyesClosedStrip).toBe(false)
    invoke.mockReset()
    const sent: { key: string; value: string }[] = []
    invoke.mockImplementation((channel: string, arg?: unknown): unknown => {
      if (channel === 'settings:set') {
        sent.push(arg as { key: string; value: string })
        return undefined
      }
      throw new Error(`예상하지 못한 IPC: ${channel}`)
    })
    useOutfitsStore.getState().setEyesClosedStrip(true)
    useOutfitsStore.getState().setEyesClosedStrip(false)
    expect(sent).toEqual([
      { key: 'eyes_closed_strip', value: '1' },
      { key: 'eyes_closed_strip', value: '0' }
    ])
  })
})
