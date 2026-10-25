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
import { DEFAULT_EXPOSE_ACTS, engineTagsOf } from '../src/shared/auto-expose'
import { refreshScenePrompts } from '../src/shared/scene-request'
import type { Outfit } from '../src/shared/outfit'

/**
 * 후타 자동 재조립 — 요청 조립 전체 경로 (합성 카드·합성 씬만. 사용자 데이터는 쓰지 않는다).
 * 씬 경로(buildSceneRequest)와 메인 탭 경로(buildMainRequest)가 같은 규칙을 쓰고,
 * 바꾼 것은 전부 bodyNotes 에 있고, 설정을 끄면 예전과 글자 단위로 같다.
 */

const card = (
  id: number,
  prompt: string,
  role: CharacterCard['role'] = null,
  enabled = true
): CharacterCard =>
  ({
    id,
    name: `카드 ${id}`,
    prompt,
    negativePrompt: '',
    enabled,
    center: { x: 0.5, y: 0.5 },
    role,
    slotNo: null,
    charRefId: null
  }) as CharacterCard

const sceneOf = (over: Partial<Scene> = {}): Scene =>
  ({
    id: 4,
    presetId: 1,
    name: '합성 씬',
    prompt: '1girl, 1boy, hetero, pov, kiss',
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

const FUTA = 1
const GIRL = 2
const MAN = 3

function setup(opts: {
  futaRole?: CharacterCard['role']
  girlRole?: CharacterCard['role']
  cards?: CharacterCard[]
  outfits?: Outfit[]
  strip?: boolean
  reassembly?: boolean
  viewFix?: boolean
  /** 알몸일 때 pink nipples — 기존 기대를 그대로 두려고 기본 켬 (실제 기본값은 꺼짐) */
  pink?: boolean
}): void {
  useGenerationStore.setState({
    request: { ...DEFAULT_REQUEST, prompt: 'masterpiece', negativePrompt: '' },
    promptSplitEnabled: false,
    source: null
  })
  useOutfitsStore.setState({
    items: opts.outfits ?? [],
    acts: DEFAULT_EXPOSE_ACTS,
    stripOnNude: opts.strip ?? false,
    exposeWorn: true,
    futaReassembly: opts.reassembly ?? true,
    futaViewFix: opts.viewFix ?? true,
    nudePinkNipples: opts.pink ?? true,
    kinds: {},
    loaded: true
  })
  useVibesStore.setState({ loaded: true })
  useCharRefsStore.setState({ loaded: true })
  useCharactersStore.setState({
    loaded: true,
    items: opts.cards ?? [
      card(FUTA, '1girl, futanari, blue eyes', opts.futaRole ?? 'source'),
      card(GIRL, '1girl, red hair, pleated skirt', opts.girlRole ?? 'target')
    ]
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

const tags = (text: string): string[] => engineTagsOf(text)

describe('씬 경로 — 후타(하는쪽) + 여(당하는쪽)', () => {
  beforeEach(() => setup({}))

  const scene = sceneOf({
    sourceTags: '1boy, male, faceless male, head out of frame, smile',
    targetTags: 'looking at male, blush'
  })

  it('메인·씬 글과 캐릭터 칸 글을 후타 구성에 맞게 바꾸고 계획을 싣는다', () => {
    const r = buildSceneRequest(scene)
    expect(r.prompt).toBe('masterpiece, 2girls, futa with female, from side, kiss')
    expect(r.characterPrompts[0].prompt).toBe(
      '1girl, futanari, blue eyes, no testicles, faceless female, smile'
    )
    expect(r.characterPrompts[1].prompt).toBe(
      '1girl, red hair, pleated skirt, looking at another, blush'
    )
    expect(r.futaPlan).toEqual({
      counts: { futa: 1, female: 1, male: 0 },
      viewFix: true,
      dedupePenis: false,
      // 하는쪽 역할의 후타가 그려진다 — 씬 전체 글의 head out of frame 도 뺀다
      sourceFuta: true,
      // 어느 카드가 후타로 읽혔는지 — 화면이 「후타」 표시를 그 카드에만 달게
      chars: [{ index: 0, id: FUTA, name: '카드 1' }]
    })
    // 씬에 적힌 원본은 그대로다
    expect(scene.prompt).toBe('1girl, 1boy, hetero, pov, kiss')
    expect(scene.sourceTags).toBe('1boy, male, faceless male, head out of frame, smile')
  })

  it('바뀐 것·더한 것은 전부 bodyNotes 에 있다 (몰래 바꾸기 금지)', () => {
    const r = buildSceneRequest(scene)
    const notes = r.bodyNotes ?? []
    expect(notes.length).toBeGreaterThan(0)
    for (const n of notes) expect(n.reason).toMatch(/[가-힣]/)
    const has = (where: string, before: string, after?: string): boolean =>
      notes.some(
        (n) => n.where === where && n.before === before && (n.after ?? '') === (after ?? '')
      )
    expect(has('scene', 'hetero', 'futa with female')).toBe(true)
    expect(has('scene', '1boy')).toBe(true)
    expect(has('scene', '1girl', '2girls')).toBe(true)
    expect(has('scene', 'pov', 'from side')).toBe(true)
    expect(has('source', '1boy')).toBe(true)
    expect(has('source', 'male')).toBe(true)
    expect(has('source', 'faceless male', 'faceless female')).toBe(true)
    expect(has('source', 'head out of frame')).toBe(true)
    expect(has('target', 'looking at male', 'looking at another')).toBe(true)
    // 후타 칸에 더한 태그는 캐릭터 순서·이름과 함께
    expect(notes).toContainEqual(
      expect.objectContaining({
        kind: 'added',
        where: 'char',
        charIndex: 0,
        name: '카드 1',
        after: 'no testicles'
      })
    )
    // 캐릭터 칸의 메모는 그 캐릭터의 순서를 갖는다
    for (const n of notes.filter((x) => x.where === 'source')) expect(n.charIndex).toBe(0)
    for (const n of notes.filter((x) => x.where === 'target')) expect(n.charIndex).toBe(1)
  })

  it('실행 직전 refreshScenePrompts 를 거쳐도 같은 메인 프롬프트가 나온다 (치환이 사라지지 않는다)', () => {
    const r = buildSceneRequest(scene)
    const refreshed = refreshScenePrompts(r, scene)
    expect(refreshed.prompt).toBe(r.prompt)
    expect(refreshed.characterPrompts).toEqual(r.characterPrompts)
    expect(refreshed.bodyNotes).toEqual(r.bodyNotes)
    // 직렬화해서 다시 읽어도(큐·클라우드 전송) 같다
    const wire = JSON.parse(JSON.stringify(r)) as GenerationRequest
    expect(refreshScenePrompts(wire, scene).prompt).toBe(r.prompt)
    // 씬 글을 고치면 고친 글에 적용된다
    expect(refreshScenePrompts(r, { ...scene, prompt: '1girl, hetero, fellatio' }).prompt).toBe(
      'masterpiece, 2girls, futa with female, fellatio'
    )
  })

  it('후타 재조립을 끄면 예전과 글자 단위로 같다 — 계획도 메모도 없다', () => {
    setup({ reassembly: false })
    const r = buildSceneRequest(scene)
    expect(r.prompt).toBe('masterpiece, 1girl, 1boy, hetero, pov, kiss')
    expect(r.characterPrompts[0].prompt).toBe(
      '1girl, futanari, blue eyes, 1boy, male, faceless male, head out of frame, smile'
    )
    expect(r.characterPrompts[1].prompt).toBe(
      '1girl, red hair, pleated skirt, looking at male, blush'
    )
    expect('futaPlan' in r).toBe(false)
    expect('bodyNotes' in r).toBe(false)
  })

  it('남자 선언도 음경 행위도 없는 후타 씬(입맞춤)의 pov 는 그대로다', () => {
    setup({})
    const r = buildSceneRequest(sceneOf({ prompt: '1girl, pov, imminent kiss' }))
    expect(r.prompt).toBe('masterpiece, 1girl, pov, imminent kiss')
  })

  it('시점·구도 정리만 끄면 pov·head out of frame 은 남고 나머지는 바뀐다', () => {
    setup({ viewFix: false })
    const r = buildSceneRequest(scene)
    expect(r.prompt).toBe('masterpiece, 2girls, futa with female, pov, kiss')
    expect(tags(r.characterPrompts[0].prompt)).toContain('head out of frame')
    expect(r.futaPlan?.viewFix).toBe(false)
  })

  it('후타가 안 그려지면 아무것도 바꾸지 않고 계획도 없다', () => {
    setup({
      cards: [
        card(MAN, '1boy, muscular', 'source'),
        card(GIRL, '1girl, red hair', 'target'),
        card(FUTA, '1girl, futanari', 'source', false)
      ]
    })
    const r = buildSceneRequest(scene)
    expect(r.prompt).toBe('masterpiece, 1girl, 1boy, hetero, pov, kiss')
    expect('futaPlan' in r).toBe(false)
    expect('bodyNotes' in r).toBe(false)
  })

  it('카드가 와일드카드뿐이면 못 읽었다고 알린다', () => {
    setup({ cards: [card(GIRL, '1girl, <outfit>', 'target')] })
    const r = buildSceneRequest(scene)
    expect(r.bodyNotes).toEqual([
      expect.objectContaining({ kind: 'unreadable', where: 'char', charIndex: 0 })
    ])
    expect(r.prompt).toBe('masterpiece, 1girl, 1boy, hetero, pov, kiss')
  })

  it('1boy 와 futanari 가 같이 있는 카드는 충돌 — 바꾸지 않고 표시만', () => {
    setup({ cards: [card(FUTA, '1boy, futanari', 'source'), card(GIRL, '1girl', 'target')] })
    const r = buildSceneRequest(scene)
    expect(r.prompt).toBe('masterpiece, 1girl, 1boy, hetero, pov, kiss')
    expect(r.bodyNotes?.map((n) => n.kind)).toEqual(['conflict'])
  })

  it('large penis 가 카드에 이미 있으면 씬 글의 large penis 를 뺀다', () => {
    setup({
      cards: [
        card(FUTA, '1girl, futanari, large penis, no testicles', 'source'),
        card(GIRL, '1girl', 'target')
      ]
    })
    const r = buildSceneRequest(sceneOf({ prompt: '1girl, hetero, large penis, kiss' }))
    expect(r.prompt).toBe('masterpiece, 2girls, futa with female, kiss')
    // 카드에 고환 유형이 이미 있어 no testicles 는 더하지 않는다
    expect(r.characterPrompts[0].prompt).toBe('1girl, futanari, large penis, no testicles')
  })
})

describe('씬 경로 — 사람 수와 가슴은 카드로 본다 (역할이 아니라)', () => {
  it('당하는쪽 후타 + 하는쪽 역할의 여성 카드(1girl): 남자가 아니라 여자로 세어 2girls, futa with female', () => {
    setup({
      cards: [card(FUTA, '1girl, futanari', 'target'), card(GIRL, '1girl, red hair', 'source')]
    })
    const r = buildSceneRequest(
      sceneOf({
        sourceTags: '1boy, male, faceless male, smile',
        prompt: '1girl, 1boy, hetero, kiss'
      })
    )
    expect(r.futaPlan?.counts).toEqual({ futa: 1, female: 1, male: 0 })
    expect(r.prompt).toBe('masterpiece, 2girls, futa with female, kiss')
    // 하는쪽 칸의 남자 낱말은 그 여성 카드에서도 정리된다 (모순된 1girl + 1boy 를 두지 않는다)
    expect(r.characterPrompts[1].prompt).toBe('1girl, red hair, faceless female, smile')
    // 후타는 계획에 카드 정보와 함께 실린다
    expect(r.futaPlan?.chars).toEqual([{ index: 0, id: FUTA, name: '카드 1' }])
  })

  it('후타가 전혀 없는 yuri 씬에서도 하는쪽 역할의 여성 카드는 알몸이면 pink nipples 를 받는다', () => {
    setup({
      cards: [card(GIRL, '1girl, red hair', 'source'), card(MAN, '1girl, blue hair', 'target')],
      strip: true
    })
    const r = buildSceneRequest(sceneOf({ prompt: 'bath', sourceTags: 'nude', targetTags: 'nude' }))
    expect(r.characterPrompts[0].prompt).toContain('pink nipples')
    expect(r.characterPrompts[1].prompt).toContain('pink nipples')
    expect('futaPlan' in r).toBe(false)
  })
})

describe('씬 경로 — 남자가 같이 그려지는 구성', () => {
  it('후타(하는쪽) + 남(당하는쪽): 후타가 받은 하는쪽 칸의 남자 낱말은 정리되고, 남이 받은 당하는쪽 칸은 그대로', () => {
    setup({
      cards: [card(FUTA, '1girl, futanari', 'source'), card(MAN, '1boy, muscular', 'target')]
    })
    const r = buildSceneRequest(
      sceneOf({
        sourceTags: '1boy, male, faceless male, smile',
        targetTags: 'looking at male, 1boy',
        prompt: '1girl, 1boy, hetero, pov, fellatio'
      })
    )
    expect(r.futaPlan?.counts).toEqual({ futa: 1, female: 0, male: 1 })
    // 씬 글: hetero 만 바뀐다 (남자 선언·시점은 남자 몫)
    expect(r.prompt).toBe('masterpiece, 1girl, 1boy, futa with male, pov, fellatio')
    // 후타 칸: 모순된 1girl + 1boy, male 이 남지 않는다
    expect(r.characterPrompts[0].prompt).toBe(
      '1girl, futanari, no testicles, faceless female, smile'
    )
    // 남 칸: 그대로
    expect(r.characterPrompts[1].prompt).toBe('1boy, muscular, looking at male, 1boy')
    for (const n of (r.bodyNotes ?? []).filter((x) => x.where === 'source'))
      expect(n.charId).toBe(FUTA)
  })
})

describe('씬 경로 — 남자가 같이 그려지는 구성 (hetero)', () => {
  it('후타(당하는쪽) + 남(하는쪽): hetero 만 futa with male 로, 남자 선언은 그대로', () => {
    setup({
      cards: [card(MAN, '1boy, muscular', 'source'), card(FUTA, '1girl, futanari', 'target')]
    })
    const r = buildSceneRequest(
      sceneOf({ sourceTags: '1boy, male, faceless male', prompt: '1girl, 1boy, hetero, kiss' })
    )
    expect(r.prompt).toBe('masterpiece, 1girl, 1boy, futa with male, kiss')
    expect(r.characterPrompts[0].prompt).toBe('1boy, muscular, 1boy, male, faceless male')
    expect(r.futaPlan?.counts).toEqual({ futa: 1, female: 0, male: 1 })
    // 후타 칸에는 그래도 no testicles
    expect(r.characterPrompts[1].prompt).toBe('1girl, futanari, no testicles')
  })

  it('후타+후타: 2girls, futa with futa', () => {
    setup({
      cards: [card(FUTA, '1girl, futanari', 'source'), card(GIRL, '1girl, futanari', 'target')]
    })
    const r = buildSceneRequest(sceneOf({ prompt: '1girl, 1boy, hetero' }))
    expect(r.prompt).toBe('masterpiece, 2girls, futa with futa')
  })
})

describe('씬 경로 — 그 밖의 모양', () => {
  it('3분할 메인 프롬프트를 쓰는 설정도 조립과 실행 직전 재합성이 같다', () => {
    setup({})
    useGenerationStore.setState({
      request: {
        ...DEFAULT_REQUEST,
        prompt: 'x',
        promptParts: { base: '1girl, masterpiece', additional: '', detail: 'best quality' }
      },
      promptSplitEnabled: true
    })
    const scene = sceneOf({ prompt: '1boy, hetero, pov, kiss' })
    const r = buildSceneRequest(scene)
    expect(r.promptParts).toEqual({
      base: '2girls, masterpiece',
      additional: '',
      detail: 'best quality, futa with female, from side, kiss'
    })
    // 예약 당시 원문은 바뀌기 전 글 그대로다
    expect(r.sceneBasePromptParts).toEqual({
      base: '1girl, masterpiece',
      additional: '',
      detail: 'best quality'
    })
    const refreshed = refreshScenePrompts(JSON.parse(JSON.stringify(r)) as GenerationRequest, scene)
    expect(refreshed.promptParts).toEqual(r.promptParts)
    expect(refreshed.prompt).toBe(r.prompt)
  })

  it('역할이 없어도 후타 카드 글로 읽고 메인·씬 글을 바꾼다', () => {
    setup({ futaRole: null, girlRole: null })
    const r = buildSceneRequest(sceneOf({ prompt: '1girl, 1boy, hetero, kiss' }))
    expect(r.prompt).toBe('masterpiece, 2girls, futa with female, kiss')
    expect(r.futaPlan?.counts).toEqual({ futa: 1, female: 1, male: 0 })
  })

  it('남(하는쪽) + 후타 + 여 3인: 남자가 있으니 hetero 만 바꾼다', () => {
    setup({
      cards: [
        card(MAN, '1boy', 'source'),
        card(FUTA, '1girl, futanari', 'target'),
        card(GIRL, '1girl, red hair', 'target')
      ]
    })
    const r = buildSceneRequest(sceneOf({ prompt: '1girl, 1boy, hetero, kiss' }))
    expect(r.prompt).toBe('masterpiece, 1girl, 1boy, futa with male, kiss')
  })

  it('씬 카드(배경)는 건드리지 않는다', () => {
    setup({})
    const r = buildSceneRequest(sceneOf({ kind: 'background', prompt: 'forest, sunlight' }))
    expect('futaPlan' in r).toBe(false)
    expect(r.prompt).toContain('forest, sunlight')
  })
})

describe('얼굴 인셋 자리는 사람 수에 넣지 않는다', () => {
  it('같은 카드가 몸 자리와 인셋 자리에 앉아도 후타 1명으로 센다', () => {
    setup({})
    useSceneExtrasStore.setState({
      loaded: true,
      sequenceEnabled: false,
      entries: [],
      additionsEnabled: true,
      additions: {
        1: {
          4: {
            characterIds: [FUTA, GIRL],
            charRefIds: [],
            vibeIds: [],
            slots: [
              { x: 0.3, y: 0.5 },
              { x: 0.7, y: 0.5 },
              { x: 0.7, y: 0.1 }
            ],
            slotChars: { 0: FUTA, 1: GIRL, 2: GIRL },
            slotRoles: { 0: 'source', 1: 'target', 2: 'target' },
            slotTags: { 2: 'close-up, portrait' }
          }
        }
      }
    })
    const r = buildSceneRequest(sceneOf())
    expect(r.futaPlan?.counts).toEqual({ futa: 1, female: 1, male: 0 })
    expect(r.characterPrompts).toHaveLength(3)
  })
})

describe('pink nipples — 알몸이 되는 모든 경우', () => {
  const nudeScene = sceneOf({ prompt: 'bath, nude' })

  it('장면 태그 nude 로 옷이 벗겨진 여캐(당하는쪽)에 붙는다', () => {
    setup({ strip: true })
    const r = buildSceneRequest(nudeScene)
    expect(r.characterPrompts[1].prompt).toContain('nude, completely nude, pink nipples')
    expect(r.bodyNotes).toContainEqual(
      expect.objectContaining({ kind: 'added', where: 'char', charIndex: 1, after: 'pink nipples' })
    )
    // 옷을 입은 채 두면(옷 벗기기 끔) 붙지 않는다
    setup({ strip: false })
    expect(buildSceneRequest(nudeScene).characterPrompts[1].prompt).not.toContain('pink nipples')
  })

  it('옷 벗기기 버튼(둘 다)으로 벗긴 하는쪽 후타에도 붙고, 남캐는 제외', () => {
    setup({})
    useSceneExtrasStore.setState({ nudeStrips: { 1: { 4: true } } })
    const r = buildSceneRequest(sceneOf({ prompt: 'kiss' }))
    // 후타(하는쪽): 벗긴 뒤 알몸 태그 다음에 no testicles → pink nipples 순
    expect(r.characterPrompts[0].prompt).toBe(
      '1girl, futanari, blue eyes, nude, completely nude, no testicles, pink nipples'
    )
    // (옷 분류를 받아 두지 않은 테스트 환경이라 치마 태그는 남는다)
    expect(r.characterPrompts[1].prompt).toBe(
      '1girl, red hair, pleated skirt, nude, completely nude, pink nipples'
    )
    setup({
      cards: [card(MAN, '1boy, muscular', 'source'), card(GIRL, '1girl, red hair', 'target')]
    })
    useSceneExtrasStore.setState({ nudeStrips: { 1: { 4: true } } })
    const withMan = buildSceneRequest(sceneOf({ prompt: 'kiss' }))
    expect(withMan.characterPrompts[0].prompt).not.toContain('pink nipples')
    expect(withMan.characterPrompts[1].prompt).toContain('pink nipples')
  })

  it('알몸 카드(nude 가 적힌 카드)에도 붙고, 유두 색 태그가 있으면 존중하고, 중복하지 않는다', () => {
    setup({
      cards: [
        card(GIRL, '1girl, nude, completely nude', 'target'),
        card(MAN, '1girl, nude, dark nipples', 'target'),
        card(FUTA, '1girl, nude, pink nipples', 'target')
      ]
    })
    const r = buildSceneRequest(sceneOf({ prompt: 'kiss' }))
    expect(r.characterPrompts[0].prompt).toBe('1girl, nude, completely nude, pink nipples')
    expect(r.characterPrompts[1].prompt).toBe('1girl, nude, dark nipples')
    expect(r.characterPrompts[2].prompt).toBe('1girl, nude, pink nipples')
  })

  it('후타 재조립을 꺼도 pink nipples 는 자기 설정을 따른다 (후타를 읽지 않으니 하는쪽 후타는 남캐 몸)', () => {
    setup({ strip: true, reassembly: false })
    const r = buildSceneRequest(nudeScene)
    expect(r.characterPrompts[1].prompt).toContain('pink nipples')
    expect(r.characterPrompts[0].prompt).not.toContain('pink nipples')
    expect(r.characterPrompts[0].prompt).not.toContain('no testicles')
  })

  it('설정 「알몸일 때 pink nipples」를 끄면(기본) 알몸이어도 더하지 않고 메모도 없다 — 이 기능이 없을 때와 같다', () => {
    setup({ strip: true, pink: false })
    const off = buildSceneRequest(nudeScene)
    expect(off.characterPrompts[1].prompt).toBe(
      '1girl, red hair, pleated skirt, nude, completely nude'
    )
    // 하는쪽 후타의 no testicles 는 후타 재조립 몫이라 그대로
    expect(off.characterPrompts[0].prompt).toBe('1girl, futanari, blue eyes, no testicles')
    expect(JSON.stringify(off)).not.toContain('pink nipples')
    expect((off.bodyNotes ?? []).some((n) => n.after === 'pink nipples')).toBe(false)
    // 옷 벗기기 버튼으로 둘 다 벗겨도 같다
    setup({ pink: false })
    useSceneExtrasStore.setState({ nudeStrips: { 1: { 4: true } } })
    const both = buildSceneRequest(sceneOf({ prompt: 'kiss' }))
    expect(both.characterPrompts[0].prompt).toBe(
      '1girl, futanari, blue eyes, nude, completely nude, no testicles'
    )
    expect(both.characterPrompts[1].prompt).toBe(
      '1girl, red hair, pleated skirt, nude, completely nude'
    )
    // 알몸 카드도 더하지 않는다
    setup({ pink: false, cards: [card(GIRL, '1girl, nude, completely nude', 'target')] })
    expect(buildSceneRequest(sceneOf({ prompt: 'kiss' })).characterPrompts[0].prompt).toBe(
      '1girl, nude, completely nude'
    )
    // 켜면 지금과 똑같이 붙는다
    setup({ pink: true, cards: [card(GIRL, '1girl, nude, completely nude', 'target')] })
    expect(buildSceneRequest(sceneOf({ prompt: 'kiss' })).characterPrompts[0].prompt).toBe(
      '1girl, nude, completely nude, pink nipples'
    )
  })
})

describe('메인 탭 경로', () => {
  beforeEach(() => setup({}))

  it('메인 프롬프트와 상대 태그를 같은 규칙으로 바꾼다', async () => {
    useGenerationStore.setState({
      request: { ...DEFAULT_REQUEST, prompt: '1girl, 1boy, hetero, pov, kiss' },
      promptSplitEnabled: false
    })
    useCharactersStore.setState({
      items: [
        { ...card(FUTA, '1girl, futanari', 'source'), partnerTags: 'looking at male' },
        { ...card(GIRL, '1girl, red hair', 'target'), partnerTags: 'blush, looking at male' }
      ] as CharacterCard[]
    })
    const r = await useGenerationStore.getState().buildMainRequest()
    expect(r.prompt).toBe('2girls, futa with female, from side, kiss')
    // 후타 카드가 받는 상대 태그는 상대(당하는쪽) 카드가 준 것 — 바뀐 글이 붙는다
    expect(r.characterPrompts[0].prompt).toBe(
      '1girl, futanari, no testicles, blush, looking at another'
    )
    expect(r.characterPrompts[1].prompt).toBe('1girl, red hair, looking at another')
    expect(r.bodyNotes?.some((n) => n.where === 'main' && n.before === 'hetero')).toBe(true)
    // 대기 중인 메인 항목을 다시 만들 때 같은 치환을 되살릴 계획이 실린다
    expect(r.futaPlan?.counts).toEqual({ futa: 1, female: 1, male: 0 })
  })

  it('3분할 메인 프롬프트도 같다', async () => {
    useGenerationStore.setState({
      request: {
        ...DEFAULT_REQUEST,
        prompt: 'x',
        promptParts: { base: '1girl', additional: 'hetero', detail: '1boy, kiss' }
      },
      promptSplitEnabled: true
    })
    const r = await useGenerationStore.getState().buildMainRequest()
    expect(r.promptParts).toEqual({
      base: '2girls',
      additional: 'futa with female',
      detail: 'kiss'
    })
    expect(r.prompt).toBe('2girls, futa with female, kiss')
  })

  it('설정을 끄면 예전과 같고, 후타가 없으면 요청 객체가 그대로다', async () => {
    useGenerationStore.setState({
      request: { ...DEFAULT_REQUEST, prompt: '1girl, 1boy, hetero, pov, kiss' },
      promptSplitEnabled: false
    })
    useOutfitsStore.setState({ futaReassembly: false })
    const off = await useGenerationStore.getState().buildMainRequest()
    expect(off.prompt).toBe('1girl, 1boy, hetero, pov, kiss')
    expect(off.characterPrompts[0].prompt).toBe('1girl, futanari, blue eyes')
    expect('bodyNotes' in off).toBe(false)
  })

  it('알몸이면 pink nipples — 메인 탭도 같다', async () => {
    useGenerationStore.setState({
      request: { ...DEFAULT_REQUEST, prompt: 'bath, nude' },
      promptSplitEnabled: false
    })
    // 옷 분류는 메인 프로세스에 묻는 값이라 미리 채워 둔다 (요청 조립은 IPC 를 부르지 않는다)
    useOutfitsStore.setState({
      stripOnNude: true,
      kinds: new Proxy({}, { has: () => true, get: () => 'body' }) as never
    })
    const r = await useGenerationStore.getState().buildMainRequest()
    expect(r.characterPrompts[1].prompt).toContain('nude, completely nude, pink nipples')
    // 장면 태그의 nude 는 당하는쪽에게만 걸린다 — 하는쪽 후타는 벗지 않으니 pink nipples 도 없다 (no testicles 는 후타 몸 규칙)
    expect(r.characterPrompts[0].prompt).toBe('1girl, futanari, blue eyes, no testicles')
  })

  it('설정 「알몸일 때 pink nipples」를 끄면 메인 탭도 더하지 않고 메모도 없다', async () => {
    setup({ pink: false })
    useGenerationStore.setState({
      request: { ...DEFAULT_REQUEST, prompt: 'bath, nude' },
      promptSplitEnabled: false
    })
    useOutfitsStore.setState({
      stripOnNude: true,
      kinds: new Proxy({}, { has: () => true, get: () => 'body' }) as never
    })
    const r = await useGenerationStore.getState().buildMainRequest()
    expect(r.characterPrompts[1].prompt).toBe(
      '1girl, red hair, pleated skirt, nude, completely nude'
    )
    expect(JSON.stringify(r)).not.toContain('pink nipples')
  })
})

describe('대기 항목 다시 만들기 (resyncPendingScenes)', () => {
  beforeEach(() => {
    setup({})
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

  it('씬 항목은 후타 재조립을 거친 새 요청으로 바뀐다 (치환이 되살아난다)', async () => {
    const scene = sceneOf({ sourceTags: '1boy, smile' })
    const queued = buildSceneRequest(scene)
    // 씬 글을 고친 뒤에도 고친 글에 적용된다
    const edited = { ...scene, prompt: '1girl, hetero, fellatio' }
    const [u] = await run([queued], [edited])
    expect(u.request.prompt).toBe('masterpiece, 2girls, futa with female, fellatio')
    expect(u.request.futaPlan).toEqual(queued.futaPlan)
  })

  it('메인 항목은 최신 메인 프롬프트에 같은 치환을 다시 적용하고 메인 메모만 새로 한다', async () => {
    useGenerationStore.setState({
      request: { ...DEFAULT_REQUEST, prompt: '1girl, 1boy, hetero, kiss' },
      promptSplitEnabled: false
    })
    const main = await useGenerationStore.getState().buildMainRequest()
    expect(main.prompt).toBe('2girls, futa with female, kiss')
    // 대기 중에 메인 프롬프트를 고친다
    useGenerationStore.setState({
      request: { ...DEFAULT_REQUEST, prompt: '1girl, hetero, pov, fellatio' },
      promptSplitEnabled: false
    })
    const [u] = await run([main], [])
    expect(u.request.prompt).toBe('2girls, futa with female, from side, fellatio')
    const notes = u.request.bodyNotes ?? []
    expect(notes.some((n) => n.where === 'main' && n.before === 'pov')).toBe(true)
    // 캐릭터 칸 메모(no testicles)는 조립 때 것 그대로
    expect(notes).toContainEqual(expect.objectContaining({ where: 'char', after: 'no testicles' }))
  })

  it('대기 중에 후타 재조립을 끄면 메인 글은 최신 원문 그대로가 되고 계획과 메인 메모는 사라진다', async () => {
    useGenerationStore.setState({
      request: { ...DEFAULT_REQUEST, prompt: '1girl, 1boy, hetero, pov, fellatio' },
      promptSplitEnabled: false
    })
    const main = await useGenerationStore.getState().buildMainRequest()
    expect(main.prompt).toBe('2girls, futa with female, from side, fellatio')
    useOutfitsStore.setState({ futaReassembly: false })
    const [u] = await run([main], [])
    expect(u.request.prompt).toBe('1girl, 1boy, hetero, pov, fellatio')
    expect('futaPlan' in u.request).toBe(false)
    expect((u.request.bodyNotes ?? []).some((n) => n.where === 'main' || n.where === 'scene')).toBe(
      false
    )
  })

  it('대기 중에 시점·구도 정리만 끄면 계획에 반영돼 pov 가 그대로 남는다', async () => {
    useGenerationStore.setState({
      request: { ...DEFAULT_REQUEST, prompt: '1girl, 1boy, hetero, pov, fellatio' },
      promptSplitEnabled: false
    })
    const main = await useGenerationStore.getState().buildMainRequest()
    useOutfitsStore.setState({ futaViewFix: false })
    const [u] = await run([main], [])
    expect(u.request.prompt).toBe('2girls, futa with female, pov, fellatio')
    expect(u.request.futaPlan?.viewFix).toBe(false)
  })
})

describe('씬 전체 글의 head out of frame — 하는쪽 후타가 그려질 때만 뺀다 (시점·구도 정리)', () => {
  const HEAD = '1girl, 1boy, hetero, head out of frame, pov, kiss'
  const headScene = sceneOf({ prompt: HEAD })
  const HEAD_NOTE = {
    kind: 'removed',
    where: 'scene',
    before: 'head out of frame',
    reason: '하는쪽 후타의 얼굴이 보이게 씬 전체 글의 head out of frame 을 뺌'
  }
  beforeEach(() => setup({}))

  it('하는쪽 후타 + 여: 씬 글의 head out of frame 을 빼고 메모와 계획에 남긴다', () => {
    const r = buildSceneRequest(headScene)
    expect(r.prompt).toBe('masterpiece, 2girls, futa with female, from side, kiss')
    expect(r.futaPlan?.sourceFuta).toBe(true)
    expect(r.bodyNotes).toContainEqual(HEAD_NOTE)
    // 씬에 적힌 원본은 그대로다
    expect(headScene.prompt).toBe(HEAD)
  })

  it('역할은 자리 역할이 이긴다 — 카드에 역할이 없어도 하는쪽 자리에 앉은 후타', () => {
    setup({ cards: [card(FUTA, '1girl, futanari', null), card(GIRL, '1girl, red hair', null)] })
    useSceneExtrasStore.setState({
      additionsEnabled: true,
      additions: {
        1: {
          4: {
            characterIds: [FUTA, GIRL],
            charRefIds: [],
            vibeIds: [],
            slots: [
              { x: 0.3, y: 0.5 },
              { x: 0.7, y: 0.5 }
            ],
            slotChars: { 0: FUTA, 1: GIRL },
            slotRoles: { 0: 'source', 1: 'target' }
          }
        }
      }
    })
    const r = buildSceneRequest(headScene)
    expect(r.futaPlan?.sourceFuta).toBe(true)
    expect(r.prompt).toBe('masterpiece, 2girls, futa with female, from side, kiss')
  })

  it('후타가 당하는쪽이거나 역할이 없으면 씬 글은 그대로 (하는쪽 칸 규칙은 예전과 같다)', () => {
    setup({ futaRole: 'target', girlRole: 'source' })
    const a = buildSceneRequest(headScene)
    expect(a.prompt).toBe(
      'masterpiece, 2girls, futa with female, head out of frame, from side, kiss'
    )
    expect(a.futaPlan).not.toHaveProperty('sourceFuta')
    setup({ cards: [card(FUTA, '1girl, futanari', null), card(GIRL, '1girl, red hair', null)] })
    const b = buildSceneRequest(headScene)
    expect(b.prompt).toBe(
      'masterpiece, 2girls, futa with female, head out of frame, from side, kiss'
    )
    expect(b.futaPlan).not.toHaveProperty('sourceFuta')
  })

  it('남자가 같이 그려지면(후타 + 남) 씬 글은 그대로 — 누구의 얼굴인지 모른다', () => {
    setup({
      cards: [card(FUTA, '1girl, futanari', 'source'), card(MAN, '1boy, muscular', 'target')]
    })
    const r = buildSceneRequest(headScene)
    expect(r.prompt).toBe('masterpiece, 1girl, 1boy, futa with male, head out of frame, pov, kiss')
  })

  it('시점·구도 정리를 끄면 그대로, 후타 재조립을 끄면 계획도 없다', () => {
    setup({ viewFix: false })
    expect(buildSceneRequest(headScene).prompt).toBe(
      'masterpiece, 2girls, futa with female, head out of frame, pov, kiss'
    )
    setup({ reassembly: false })
    const off = buildSceneRequest(headScene)
    expect(off.prompt).toBe(`masterpiece, ${HEAD}`)
    expect('futaPlan' in off).toBe(false)
  })

  it('하는쪽 칸의 head out of frame 은 예전처럼 뺀다 (하는쪽 후타가 아니어도)', () => {
    setup({ futaRole: 'target', girlRole: 'source' })
    const r = buildSceneRequest(
      sceneOf({ prompt: HEAD, sourceTags: '1boy, male, head out of frame, smile' })
    )
    expect(r.characterPrompts[1].prompt).toBe('1girl, red hair, pleated skirt, smile')
  })

  it('실행 직전 refreshScenePrompts 를 거쳐도 유지되고, 고친 씬 글에도 적용된다', () => {
    const r = buildSceneRequest(headScene)
    const wire = JSON.parse(JSON.stringify(r)) as GenerationRequest
    expect(refreshScenePrompts(wire, headScene).prompt).toBe(r.prompt)
    expect(refreshScenePrompts(wire, headScene).bodyNotes).toEqual(r.bodyNotes)
    expect(
      refreshScenePrompts(wire, {
        ...headScene,
        prompt: '1girl, hetero, head out of frame, fellatio'
      }).prompt
    ).toBe('masterpiece, 2girls, futa with female, fellatio')
    // 이 값이 없던 옛 계획으로 만든 대기 항목은 예전처럼 씬 글을 건드리지 않는다
    const old = JSON.parse(JSON.stringify(r)) as GenerationRequest
    delete old.futaPlan?.sourceFuta
    expect(refreshScenePrompts(old, headScene).prompt).toBe(
      'masterpiece, 2girls, futa with female, head out of frame, from side, kiss'
    )
  })
})

describe('메인 탭 — 하는쪽 후타가 그려지면 메인 프롬프트의 head out of frame 도 뺀다', () => {
  beforeEach(() => setup({}))

  it('메인 프롬프트(한 줄·3분할)의 head out of frame 을 빼고 메모를 남긴다', async () => {
    useGenerationStore.setState({
      request: { ...DEFAULT_REQUEST, prompt: '1girl, 1boy, hetero, head out of frame, pov, kiss' },
      promptSplitEnabled: false
    })
    const r = await useGenerationStore.getState().buildMainRequest()
    expect(r.prompt).toBe('2girls, futa with female, from side, kiss')
    expect(r.futaPlan?.sourceFuta).toBe(true)
    expect(r.bodyNotes).toContainEqual(
      expect.objectContaining({ kind: 'removed', where: 'main', before: 'head out of frame' })
    )
    useGenerationStore.setState({
      request: {
        ...DEFAULT_REQUEST,
        prompt: '1girl, hetero, head out of frame, 1boy, kiss',
        promptParts: {
          base: '1girl, hetero',
          additional: 'head out of frame',
          detail: '1boy, kiss'
        }
      },
      promptSplitEnabled: true
    })
    const split = await useGenerationStore.getState().buildMainRequest()
    // 가변 칸의 head out of frame 이 빠져 칸이 비고, hetero 는 기본 칸에서 관계 태그로 바뀐다
    expect(split.promptParts).toEqual({
      base: '2girls, futa with female',
      additional: '',
      detail: 'kiss'
    })
  })

  it('후타가 당하는쪽이면 그대로', async () => {
    setup({ futaRole: 'target', girlRole: 'source' })
    useGenerationStore.setState({
      request: { ...DEFAULT_REQUEST, prompt: '1girl, 1boy, hetero, head out of frame, kiss' },
      promptSplitEnabled: false
    })
    const r = await useGenerationStore.getState().buildMainRequest()
    expect(r.prompt).toBe('2girls, futa with female, head out of frame, kiss')
    expect(r.futaPlan).not.toHaveProperty('sourceFuta')
  })

  it('대기 중인 메인 항목을 다시 만들 때도 최신 메인 글에 같은 규칙을 적용한다', async () => {
    invoke.mockReset()
    useGenerationStore.setState({
      request: { ...DEFAULT_REQUEST, prompt: '1girl, 1boy, hetero, kiss' },
      promptSplitEnabled: false
    })
    const main = await useGenerationStore.getState().buildMainRequest()
    // 대기 중에 메인 프롬프트를 고친다
    useGenerationStore.setState({
      request: { ...DEFAULT_REQUEST, prompt: '1girl, hetero, head out of frame, pov, fellatio' },
      promptSplitEnabled: false
    })
    let updates: { id: string; request: GenerationRequest }[] = []
    invoke.mockImplementation((channel: string, arg?: unknown): unknown => {
      if (channel === 'queue:pending') return { items: [{ id: 'q0', request: main }] }
      if (channel === 'queue:updatePending') {
        updates = (arg as { updates: typeof updates }).updates
        return undefined
      }
      throw new Error(`예상하지 못한 IPC: ${channel}`)
    })
    useScenesStore.setState({ scenes: [] })
    await useScenesStore.getState().resyncPendingScenes()
    expect(updates[0].request.prompt).toBe('2girls, futa with female, from side, fellatio')
    // 시점·구도 정리만 끄면 계획에 반영돼 그대로 남는다
    useOutfitsStore.setState({ futaViewFix: false })
    await useScenesStore.getState().resyncPendingScenes()
    expect(updates[0].request.prompt).toBe(
      '2girls, futa with female, head out of frame, pov, fellatio'
    )
  })
})
