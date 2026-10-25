import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CharacterCard, Scene, SequenceEntry } from '../src/shared/types'
import { preparePromptCaptions } from '../src/shared/nai-prompts'

const { invoke } = vi.hoisted(() => {
  const invoke = vi.fn(() => {
    throw new Error('Preview must not invoke IPC')
  })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() })
  vi.stubGlobal('window', { nais: { invoke } })
  return { invoke }
})

import { buildSceneRequest, previewSceneRequests } from '../src/renderer/src/stores/scenes-store'
import {
  DEFAULT_REQUEST,
  useGenerationStore,
  withTransparentBackground
} from '../src/renderer/src/stores/generation-store'
import { useCharactersStore } from '../src/renderer/src/stores/characters-store'
import { useSceneExtrasStore } from '../src/renderer/src/stores/scene-extras-store'
import { useOutfitsStore } from '../src/renderer/src/stores/outfits-store'
import { DEFAULT_EXPOSE_ACTS } from '../src/shared/auto-expose'
import type { Outfit, OutfitChoice } from '../src/shared/outfit'

const scene = {
  id: 4,
  presetId: 1,
  name: 'scene',
  prompt: 'forest',
  negativePrompt: 'blur',
  width: 832,
  height: 1216,
  reserveCount: 99,
  varietyPlus: false,
  sourceTags: 'hug',
  targetTags: 'hug',
  sourcePos: null,
  targetPos: null,
  censorKinds: ['anal'],
  suppressAnal: true
} as Scene
const card = (id: number, prompt: string, enabled = false): CharacterCard =>
  ({
    id,
    name: `card ${id}`,
    prompt,
    negativePrompt: `negative ${id}`,
    enabled,
    center: { x: 0.5, y: 0.5 },
    role: null,
    slotNo: null,
    charRefId: null
  }) as CharacterCard
const entry = (id: string, characterIds: number[]): SequenceEntry => ({
  id,
  name: id,
  characterIds,
  enabled: true,
  charRefIds: [],
  vibeIds: []
})

beforeEach(() => {
  invoke.mockClear()
  useGenerationStore.setState({
    request: {
      ...DEFAULT_REQUEST,
      prompt: 'sky',
      negativePrompt: 'low quality',
      promptParts: { base: 'sky', additional: 'clouds', detail: 'detailed' }
    },
    promptSplitEnabled: true,
    source: null
  })
  useCharactersStore.setState({
    items: [card(1, 'blue eyes', true), card(2, 'green eyes'), card(3, 'pink hair')]
  })
  useSceneExtrasStore.setState({
    loaded: true,
    sequenceEnabled: false,
    entries: [],
    additionsEnabled: false,
    additions: {},
    nudeStrips: {}
  })
})

describe('scene token preview uses the actual generation request builder', () => {
  it('uses one default preview without consuming reservations, seeds, or performing IPC', () => {
    const originalScene = structuredClone(scene)
    const originalRequest = structuredClone(useGenerationStore.getState().request)
    const preview = previewSceneRequests(scene)
    expect(preview).toHaveLength(1)
    expect(preview[0].entryId).toBeNull()
    expect(preview[0].request).toEqual(buildSceneRequest(scene))
    expect(preview[0].request.prompt).toContain('sky, clouds, detailed, forest')
    // 검열 태그는 기본 프롬프트가 아니라 캐릭터 1 맨 끝 — 토큰 미리보기도 같은 요청을 센다
    expect(preview[0].request.prompt).not.toContain('censored')
    expect(preview[0].request.characterPrompts[0].prompt).toBe(
      'blue eyes, completely white censored anal'
    )
    expect(preparePromptCaptions(preview[0].request).positive.characters).toEqual([
      'blue eyes, completely white censored anal'
    ])
    expect(preview[0].request.sceneBaseCharacterPrompts).toEqual(['blue eyes'])
    expect(preview[0].request.negativePrompt).toBe('low quality, blur, anal')
    expect(scene).toEqual(originalScene)
    expect(useGenerationStore.getState().request).toEqual(originalRequest)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('uses a scene Transparent BG override independently of the global toggle', () => {
    useGenerationStore.setState({ transparentBackground: false })
    useGenerationStore.setState({
      request: {
        ...useGenerationStore.getState().request,
        prompt: 'sky, rural background, white background',
        promptParts: {
          base: 'sky, rural background, white background',
          additional: 'clouds',
          detail: 'detailed'
        }
      }
    })
    useSceneExtrasStore.setState({
      transparentBackgrounds: { 1: { 4: true } }
    })
    const request = buildSceneRequest(scene)
    expect(request.transparentBackground).toBe(true)
    expect(request.prompt).toContain('transparent background')
    expect(request.prompt).not.toMatch(/\b(?:rural|white) background\b/i)

    useSceneExtrasStore.setState({
      transparentBackgrounds: { 1: { 4: false } }
    })
    expect(buildSceneRequest(scene).transparentBackground).toBe(false)
  })

  it('reapplies the scene tag after the main-process scene refresh rebuilds prompt text', async () => {
    const request = buildSceneRequest(scene)
    const { refreshScenePrompts } = await import('../src/shared/scene-request')
    const refreshed = refreshScenePrompts(request, scene)
    expect(refreshed.prompt).not.toContain('transparent background')
    const queued = withTransparentBackground(refreshed, true)
    expect(queued.prompt).toContain('transparent background')
  })

  it('puts the censor tags on the first character that is actually sent', () => {
    useCharactersStore.setState({
      items: [card(1, '# memo only', true), card(2, 'green eyes', true)]
    })
    const request = buildSceneRequest(scene)
    expect(request.characterPrompts.map((c) => c.prompt)).toEqual([
      '# memo only',
      'green eyes, completely white censored anal'
    ])
    expect(request.prompt).not.toContain('censored')
  })

  it('씬 검열 가중치가 1이 아닌 부위는 캐릭터 1 끝에 묶음으로 붙는다', () => {
    const request = buildSceneRequest({ ...scene, censorTagWeights: { anal: 1.4 } })
    expect(request.characterPrompts[0].prompt).toBe(
      'blue eyes, 1.4::completely white censored anal::'
    )
    expect(request.sceneBaseCharacterPrompts).toEqual(['blue eyes'])
    // 캐릭터가 없으면 기본 프롬프트 끝에
    useCharactersStore.setState({ items: [] })
    expect(buildSceneRequest({ ...scene, censorTagWeights: { anal: 0.7 } }).prompt).toContain(
      '0.7::completely white censored anal::'
    )
  })

  it('falls back to the end of the base prompt when no character is sent', () => {
    useCharactersStore.setState({ items: [card(1, 'blue eyes', false)] })
    const request = buildSceneRequest(scene)
    expect(request.characterPrompts).toEqual([])
    expect(request.prompt).toBe('sky, clouds, detailed, forest, completely white censored anal')
    expect(request.promptParts?.additional).toBe('clouds')
    expect(request.promptParts?.detail).toBe('detailed, forest, completely white censored anal')
  })

  it('rebuilds character 1 from the saved original when the queue refreshes the scene', async () => {
    const request = buildSceneRequest(scene)
    const { refreshScenePrompts } = await import('../src/shared/scene-request')
    const off = refreshScenePrompts(request, { ...scene, censorKinds: [] })
    expect(off.characterPrompts[0].prompt).toBe('blue eyes')
    const on = refreshScenePrompts(off, { ...scene, censorKinds: ['penis', 'anal'] })
    expect(on.characterPrompts[0].prompt).toBe(
      'blue eyes, completely white censored penis, completely white censored anal'
    )
    expect(on.prompt).toBe(request.prompt)
  })

  it('includes each active queue entry, scene additions, duplicate seats and their role/tag overrides', () => {
    const entries = [
      entry('round A', [2]),
      { ...entry('disabled round', [1]), enabled: false },
      entry('round B', [1])
    ]
    const additions = {
      1: {
        4: {
          characterIds: [3],
          charRefIds: [],
          vibeIds: [],
          charTags: { 2: 'blush' },
          slots: [
            { x: 0.2, y: 0.4 },
            { x: 0.8, y: 0.4 }
          ],
          slotChars: { 0: 2, 1: 2 },
          slotTags: { 0: 'sitting', 1: 'standing' },
          slotRoles: { 0: 'source' as const, 1: 'target' as const }
        }
      }
    }
    useSceneExtrasStore.setState({
      sequenceEnabled: true,
      entries,
      additionsEnabled: true,
      additions
    })
    const originals = structuredClone({ entries, additions })
    const preview = previewSceneRequests(scene)
    expect(preview.map((item) => item.entryId)).toEqual(['round A', 'round B'])
    expect(preview[0].request).toEqual(buildSceneRequest(scene, entries[0]))
    expect(preview[0].request.characterPrompts.map((character) => character.prompt)).toEqual([
      'pink hair, completely white censored anal',
      'green eyes, blush, sitting, source#hug',
      'green eyes, blush, standing, target#hug'
    ])
    expect(preparePromptCaptions(preview[0].request).negative.characters).toEqual([
      'negative 3',
      'negative 2',
      'negative 2'
    ])
    expect({ entries, additions }).toEqual(originals)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('applies the same model character limits to previewed duplicated placements', () => {
    const slots = Array.from({ length: 40 }, () => ({ x: 0.5, y: 0.5 }))
    useSceneExtrasStore.setState({
      additionsEnabled: true,
      additions: {
        1: {
          4: {
            characterIds: [],
            charRefIds: [],
            vibeIds: [],
            slots,
            slotChars: Object.fromEntries(slots.map((_, index) => [index, 1]))
          }
        }
      }
    })
    expect(previewSceneRequests(scene)[0].request.characterPrompts).toHaveLength(32)
    useGenerationStore.setState({
      request: { ...useGenerationStore.getState().request, model: 'nai-diffusion-4-5-full' }
    })
    expect(previewSceneRequests(scene)[0].request.characterPrompts).toHaveLength(6)
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('outfit nsfw pieces turn on from the scene tags', () => {
  const school: Outfit = {
    id: 9,
    name: '치마 교복',
    negative: '',
    pieces: [
      { id: 'skirt', name: '치마', tags: 'pleated skirt, white panties', on: true },
      {
        id: 'lift',
        name: '젖히기(아래)',
        tags: 'skirt lift, panties aside',
        on: false,
        when: 'nsfw-lower'
      },
      { id: 'open', name: '젖히기(가슴)', tags: 'shirt lift', on: false, when: 'nsfw-chest' }
    ]
  }
  // 복장 조각만 보려고 검열 태그는 끈다
  const charPrompt = (prompt: string): string =>
    buildSceneRequest({ ...scene, prompt, censorKinds: [] }).characterPrompts[0].prompt
  const withChoice = (choice: OutfitChoice): void =>
    useSceneExtrasStore.setState({
      additionsEnabled: true,
      additions: {
        1: { 4: { characterIds: [], charRefIds: [], vibeIds: [], outfits: { 1: choice } } }
      }
    })

  beforeEach(() => {
    useOutfitsStore.setState({
      items: [school],
      acts: DEFAULT_EXPOSE_ACTS,
      stripOnNude: false,
      kinds: {}
    })
    useCharactersStore.setState({ items: [{ ...card(1, 'blue eyes', true), outfitId: 9 }] })
  })

  it('turns on only the piece whose area the scene needs', () => {
    expect(charPrompt('bed, vaginal')).toBe(
      'blue eyes, pleated skirt, white panties, skirt lift, panties aside'
    )
    expect(charPrompt('bed, paizuri')).toBe('blue eyes, pleated skirt, white panties, shirt lift')
    expect(charPrompt('forest')).toBe('blue eyes, pleated skirt, white panties')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('no longer appends expose tags on its own', () => {
    useOutfitsStore.setState({ items: [{ ...school, pieces: [school.pieces[0]] }] })
    expect(charPrompt('bed, vaginal, paizuri')).toBe('blue eyes, pleated skirt, white panties')
  })

  it('lets the scene choice override the trigger, and auto=false turns the triggers off', () => {
    withChoice({ outfitId: 9, off: ['lift'], on: ['open'] })
    expect(charPrompt('bed, vaginal')).toBe('blue eyes, pleated skirt, white panties, shirt lift')
    withChoice({ outfitId: 9, auto: false })
    expect(charPrompt('bed, vaginal, paizuri')).toBe('blue eyes, pleated skirt, white panties')
  })

  it('누드면 옷 벗기기: 씬에서 정한 값이 전체 설정보다 먼저다', () => {
    // 전체 끔 — 이 씬만 켜면 기본 복장이 빠진다
    expect(charPrompt('bath, nude')).toBe('blue eyes, pleated skirt, white panties')
    useSceneExtrasStore.setState({ nudeStrips: { 1: { 4: true } } })
    expect(charPrompt('bath, nude')).toBe('blue eyes, nude, completely nude')
    // 다른 씬은 그대로 전체 설정
    expect(
      buildSceneRequest({ ...scene, id: 5, prompt: 'bath, nude', censorKinds: [] })
        .characterPrompts[0].prompt
    ).toBe('blue eyes, pleated skirt, white panties')
    // 전체 켬 — 이 씬만 끄면 옷을 입힌 채
    useOutfitsStore.setState({ stripOnNude: true })
    useSceneExtrasStore.setState({ nudeStrips: { 1: { 4: false } } })
    expect(charPrompt('bath, nude')).toBe('blue eyes, pleated skirt, white panties')
    // 전체 설정 따름으로 되돌리면 켜짐
    useSceneExtrasStore.setState({ nudeStrips: { 1: {} } })
    expect(charPrompt('bath, nude')).toBe('blue eyes, nude, completely nude')
  })

  it('씬에서 옷 벗기기를 켜면 누드 태그가 없어도 벗기고 캐릭터 태그에 누드를 붙인다', () => {
    useOutfitsStore.setState({ kinds: { 'school swimsuit': 'cloth' } })
    useCharactersStore.setState({
      items: [{ ...card(1, 'blue eyes, school swimsuit', true), outfitId: 9 }]
    })
    // 켜지 않았으면 그대로
    expect(charPrompt('onsen, bathing')).toBe(
      'blue eyes, school swimsuit, pleated skirt, white panties'
    )
    useSceneExtrasStore.setState({ nudeStrips: { 1: { 4: true } } })
    expect(charPrompt('onsen, bathing')).toBe('blue eyes, nude, completely nude')
    // 이 씬만 끄면 누드 태그가 있어도 안 벗긴다
    useOutfitsStore.setState({ stripOnNude: true })
    useSceneExtrasStore.setState({ nudeStrips: { 1: { 4: false } } })
    expect(charPrompt('onsen, nude')).toBe(
      'blue eyes, school swimsuit, pleated skirt, white panties'
    )
  })

  it('씬의 옷 벗기기 버튼은 하는쪽까지 둘 다 벗긴다 (장면 태그의 nude 는 당하는쪽만)', () => {
    useOutfitsStore.setState({ kinds: { 'school swimsuit': 'cloth', suit: 'cloth' } })
    useCharactersStore.setState({
      items: [
        { ...card(1, 'blue eyes, school swimsuit', true), outfitId: 9, role: 'target' },
        { ...card(2, 'green eyes, suit', true), role: 'source' }
      ]
    })
    const prompts = (prompt: string): string[] =>
      buildSceneRequest({ ...scene, prompt, censorKinds: [] }).characterPrompts.map((c) => c.prompt)
    // 장면 태그의 nude — 전체 설정이 켜져 있으면 당하는쪽만 벗긴다
    useOutfitsStore.setState({ stripOnNude: true })
    const [target, source] = prompts('bath, nude')
    expect(target).toContain('completely nude')
    expect(source).toContain('suit')
    expect(source).not.toContain('nude')
    // 버튼 — 누드 태그가 없어도 둘 다 벗긴다
    useSceneExtrasStore.setState({ nudeStrips: { 1: { 4: true } } })
    const [t2, s2] = prompts('onsen, bathing')
    expect(t2).not.toContain('school swimsuit')
    expect(t2).toContain('completely nude')
    expect(s2).not.toContain('suit')
    expect(s2).toContain('nude, completely nude')
  })

  describe('옷 벗기기 — 남캐만·여캐만 (남녀는 역할 기준)', () => {
    const KINDS = {
      'school swimsuit': 'cloth',
      suit: 'cloth',
      'white shirt': 'cloth',
      'black dress': 'cloth'
    } as const
    const draw = (prompt: string, setting?: boolean | 'male' | 'female'): string[] => {
      useSceneExtrasStore.setState({
        nudeStrips: setting === undefined ? {} : { 1: { 4: setting } }
      })
      const drawn = buildSceneRequest({ ...scene, prompt, censorKinds: [] }).characterPrompts
      return drawn.map((c) => c.prompt)
    }
    const nude = (prompt: string): boolean => /\bcompletely nude\b/.test(prompt)

    describe('역할이 있는 두 명 — 당하는쪽 = 여캐, 하는쪽 = 남캐', () => {
      beforeEach(() => {
        useOutfitsStore.setState({ kinds: { ...KINDS }, stripOnNude: false })
        // 카드 태그에 boy 가 없어도 하는쪽이면 남캐 — 역할이 남녀를 가른다
        useCharactersStore.setState({
          items: [
            { ...card(1, 'blue eyes, school swimsuit', true), outfitId: 9, role: 'target' },
            { ...card(2, 'green eyes, suit', true), role: 'source' }
          ]
        })
      })

      it('둘 다(true)는 전원을 벗긴다 — 옛 true 값 그대로', () => {
        const [target, source] = draw('onsen, bathing', true)
        expect(nude(target)).toBe(true)
        expect(target).not.toContain('school swimsuit')
        expect(nude(source)).toBe(true)
        expect(source).not.toContain('suit')
      })

      it('남캐만은 하는쪽만 벗기고 여캐(당하는쪽)는 옷을 입은 채', () => {
        const [target, source] = draw('onsen, bathing', 'male')
        expect(nude(source)).toBe(true)
        expect(source).not.toContain('suit')
        expect(nude(target)).toBe(false)
        expect(target).toContain('school swimsuit')
        expect(target).toContain('pleated skirt')
      })

      it('여캐만은 당하는쪽만 벗기고 남캐(하는쪽)는 옷을 입은 채', () => {
        const [target, source] = draw('onsen, bathing', 'female')
        expect(nude(target)).toBe(true)
        expect(target).not.toContain('school swimsuit')
        expect(nude(source)).toBe(false)
        expect(source).toContain('suit')
      })

      it('남캐만을 골랐으면 여캐는 장면 태그에 nude 가 있어도 벗기지 않는다 (태그 판정도 끔)', () => {
        useOutfitsStore.setState({ stripOnNude: true })
        // 전체 설정만 켜진 상태 — 장면 태그의 nude 는 당하는쪽을 벗긴다
        const base = draw('bath, nude')
        expect(nude(base[0])).toBe(true)
        expect(base[1]).toContain('suit')
        // 남캐만 — 여캐는 그대로, 남캐는 태그가 없어도 벗는다
        const male = draw('bath, nude', 'male')
        expect(nude(male[0])).toBe(false)
        expect(male[0]).toContain('school swimsuit')
        expect(nude(male[1])).toBe(true)
        // 여캐만 — 여캐는 벗고 남캐는 그대로
        const female = draw('bath, nude', 'female')
        expect(nude(female[0])).toBe(true)
        expect(female[1]).toContain('suit')
        expect(nude(female[1])).toBe(false)
      })

      it('안 벗김(false)은 전체 설정이 켜져 있어도 아무도 안 벗긴다', () => {
        useOutfitsStore.setState({ stripOnNude: true })
        const prompts = draw('bath, nude', false)
        expect(prompts[0]).toContain('school swimsuit')
        expect(prompts[1]).toContain('suit')
        expect(prompts.some(nude)).toBe(false)
      })

      it('값이 없으면(전체 설정 따름) 전체 설정대로 — 끄면 안 벗기고, 켜면 당하는쪽만', () => {
        expect(draw('bath, nude').some(nude)).toBe(false)
        useOutfitsStore.setState({ stripOnNude: true })
        const [target, source] = draw('bath, nude')
        expect(nude(target)).toBe(true)
        expect(nude(source)).toBe(false)
      })

      it('남캐만·여캐만도 벗는 쪽의 복장 조각은 같은 규칙으로 걷는다', () => {
        const male = draw('onsen, bathing', 'male')
        // 안 벗긴 여캐는 복장 조각 그대로 · 벗은 남캐는 입은 것이 없다
        expect(male[0]).toContain('white panties')
        expect(male[1]).not.toContain('white panties')
        const female = draw('onsen, bathing', 'female')
        expect(female[0]).not.toContain('white panties')
      })
    })

    describe('역할이 없는 캐릭터 — 카드 프롬프트의 boy·male 태그로 가른다', () => {
      beforeEach(() => {
        useOutfitsStore.setState({ kinds: { ...KINDS }, stripOnNude: false })
      })
      const withCards = (...prompts: string[]): void =>
        useCharactersStore.setState({
          items: prompts.map((p, i) => card(i + 1, p, true))
        })

      it('boy 태그가 있으면 남캐, 없으면 여캐', () => {
        withCards('1boy, short hair, suit', '1girl, long hair, school swimsuit')
        const male = draw('onsen, bathing', 'male')
        expect(nude(male[0])).toBe(true)
        expect(nude(male[1])).toBe(false)
        expect(male[1]).toContain('school swimsuit')
        const female = draw('onsen, bathing', 'female')
        expect(nude(female[0])).toBe(false)
        expect(female[0]).toContain('suit')
        expect(nude(female[1])).toBe(true)
      })

      it('가중치 표기(N::태그::) 안의 male 계열 태그도 남캐로 본다', () => {
        withCards(
          '1.2::mature male::, suit',
          '0.9::male focus, muscular::, white shirt',
          'black dress'
        )
        expect(draw('onsen, bathing', 'male').map(nude)).toEqual([true, true, false])
        expect(draw('onsen, bathing', 'female').map(nude)).toEqual([false, false, true])
      })

      it('빼달라는 음수 가중치·주석·랜덤 선택지의 boy 는 남캐의 근거가 아니다', () => {
        withCards(
          '-1::1boy::, black dress',
          '# 1boy\n1girl, white shirt',
          '(1boy/1girl), school swimsuit',
          'tomboy, man bun, suit'
        )
        // 넷 다 여캐 — 남캐만이면 아무도 안 벗는다
        expect(draw('onsen, bathing', 'male').some(nude)).toBe(false)
        expect(draw('onsen, bathing', 'female').map(nude)).toEqual([true, true, true, true])
      })

      it('역할이 있으면 카드 태그보다 역할이 먼저다', () => {
        useCharactersStore.setState({
          items: [
            { ...card(1, '1boy, suit', true), role: 'target' },
            { ...card(2, '1girl, black dress', true), role: 'source' }
          ]
        })
        // 1boy 카드지만 당하는쪽 = 여캐, 1girl 카드지만 하는쪽 = 남캐
        expect(draw('onsen, bathing', 'male').map(nude)).toEqual([false, true])
        expect(draw('onsen, bathing', 'female').map(nude)).toEqual([true, false])
      })

      it('역할이 있는 캐릭터와 없는 캐릭터가 섞여도 각자 기준대로', () => {
        useCharactersStore.setState({
          items: [
            { ...card(1, 'blue eyes, school swimsuit', true), role: 'target' },
            { ...card(2, '1boy, suit', true) },
            { ...card(3, 'long hair, black dress', true) }
          ]
        })
        expect(draw('onsen, bathing', 'male').map(nude)).toEqual([false, true, false])
        expect(draw('onsen, bathing', 'female').map(nude)).toEqual([true, false, true])
      })
    })

    describe('자리 역할·씬별 역할이 카드 역할·태그보다 먼저다', () => {
      beforeEach(() => {
        useOutfitsStore.setState({ kinds: { ...KINDS }, stripOnNude: false })
      })

      it('같은 카드가 하는쪽 자리와 당하는쪽 자리에 앉으면 자리마다 따로 가른다', () => {
        useCharactersStore.setState({
          items: [card(1, '1girl, school swimsuit', true)]
        })
        useSceneExtrasStore.setState({
          additionsEnabled: true,
          additions: {
            1: {
              4: {
                characterIds: [1],
                charRefIds: [],
                vibeIds: [],
                slots: [
                  { x: 0.3, y: 0.5 },
                  { x: 0.7, y: 0.5 }
                ],
                slotChars: { 0: 1, 1: 1 },
                slotRoles: { 0: 'source' as const, 1: 'target' as const }
              }
            }
          }
        })
        // 0번 자리 = 하는쪽 = 남캐, 1번 자리 = 당하는쪽 = 여캐 — 카드는 1girl 하나뿐이다
        expect(draw('onsen, bathing', 'male').map(nude)).toEqual([true, false])
        expect(draw('onsen, bathing', 'female').map(nude)).toEqual([false, true])
        expect(draw('onsen, bathing', true).map(nude)).toEqual([true, true])
      })

      it('씬별 추가의 역할이 카드 역할을 뒤집으면 뒤집힌 대로 따른다', () => {
        useCharactersStore.setState({
          items: [
            { ...card(1, 'blue eyes, school swimsuit', true), role: 'target' },
            { ...card(2, '1boy, suit', true), role: 'source' }
          ]
        })
        // 카드 역할대로면 1번 = 여캐, 2번 = 남캐
        expect(draw('onsen, bathing', 'male').map(nude)).toEqual([false, true])
        useSceneExtrasStore.setState({
          additionsEnabled: true,
          additions: {
            1: {
              4: {
                characterIds: [1, 2],
                charRefIds: [],
                vibeIds: [],
                roles: { 1: 'source' as const, 2: 'target' as const }
              }
            }
          }
        })
        // 이 씬에서는 1번이 하는쪽(남캐), 2번이 당하는쪽(여캐) — 2번 카드의 1boy 태그는 상관없다
        expect(draw('onsen, bathing', 'male').map(nude)).toEqual([true, false])
        expect(draw('onsen, bathing', 'female').map(nude)).toEqual([false, true])
      })
    })
  })

  it('하는쪽 태그의 행위(breast punch)로 당하는쪽 가슴 조각이 켜진다', () => {
    useCharactersStore.setState({
      items: [
        { ...card(1, 'blue eyes', true), outfitId: 9, role: 'target' },
        { ...card(2, 'green eyes', true), role: 'source' }
      ]
    })
    const [target] = buildSceneRequest({
      ...scene,
      prompt: 'standing',
      sourceTags: 'breast punch',
      targetTags: 'orgasm',
      censorKinds: []
    }).characterPrompts
    expect(target.prompt).toContain('shirt lift')
    expect(target.prompt).not.toContain('skirt lift')
  })

  it('얼굴 인셋 자리는 씬 전체 태그로 조각을 켜지 않고, 몸 자리는 켠다', () => {
    useCharactersStore.setState({
      items: [{ ...card(1, 'blue eyes', true), outfitId: 9, role: 'target' }]
    })
    useSceneExtrasStore.setState({
      additionsEnabled: true,
      additions: {
        1: {
          4: {
            characterIds: [],
            charRefIds: [],
            vibeIds: [],
            slots: [
              { x: 0.5, y: 0.5 },
              { x: 0.8, y: 0.2 }
            ],
            slotChars: { 0: 1, 1: 1 },
            slotRoles: { 0: 'target', 1: 'target' },
            slotTags: { 0: 'ass focus', 1: 'pink inset, close-up, ahegao' }
          }
        }
      }
    })
    const [body, face] = buildSceneRequest({
      ...scene,
      prompt: 'bed, vaginal',
      censorKinds: []
    }).characterPrompts
    expect(body.prompt).toContain('skirt lift, panties aside')
    expect(face.prompt).not.toContain('skirt lift')
  })

  it('reads the tags given to this character only (scene-wide tags go to the target)', () => {
    useCharactersStore.setState({
      items: [
        { ...card(1, 'blue eyes', true), outfitId: 9, role: 'target' },
        { ...card(2, 'green eyes', true), outfitId: 9, role: 'source' }
      ]
    })
    const [target, source] = buildSceneRequest({
      ...scene,
      prompt: 'bed, vaginal'
    }).characterPrompts
    expect(target.prompt).toContain('skirt lift, panties aside')
    expect(source.prompt).not.toContain('skirt lift')
  })
})
