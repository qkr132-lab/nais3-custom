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
import { DEFAULT_REQUEST, useGenerationStore } from '../src/renderer/src/stores/generation-store'
import { useCharactersStore } from '../src/renderer/src/stores/characters-store'
import { useSceneExtrasStore } from '../src/renderer/src/stores/scene-extras-store'

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
    additions: {}
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
    expect(preview[0].request.prompt).toContain('white censored anal')
    expect(preview[0].request.negativePrompt).toBe('low quality, blur, anal')
    expect(scene).toEqual(originalScene)
    expect(useGenerationStore.getState().request).toEqual(originalRequest)
    expect(invoke).not.toHaveBeenCalled()
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
      'pink hair',
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
