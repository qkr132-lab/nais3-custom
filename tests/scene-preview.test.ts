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
    expect(preview[0].request.prompt).toContain('sky, clouds, forest')
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

  it('falls back to the end of the base prompt when no character is sent', () => {
    useCharactersStore.setState({ items: [card(1, 'blue eyes', false)] })
    const request = buildSceneRequest(scene)
    expect(request.characterPrompts).toEqual([])
    expect(request.prompt).toBe('sky, clouds, forest, completely white censored anal, detailed')
    expect(request.promptParts?.additional).toBe('clouds, forest, completely white censored anal')
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
