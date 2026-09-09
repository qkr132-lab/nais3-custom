import { describe, expect, it } from 'vitest'
import { preparePromptCaptions } from '../src/shared/nai-prompts'
import { QUALITY_TAGS_SUFFIX, UC_PRESETS_V45_FULL } from '../src/shared/nai-presets'
import { buildGenerateImagePayload } from '../src/main/nai/payload'
import type { GenerationRequest } from '../src/shared/types'

const request: GenerationRequest = {
  prompt: 'landscape # memo',
  negativePrompt: 'blur # memo',
  model: 'nai-diffusion-5-full',
  width: 832,
  height: 1216,
  steps: 28,
  cfgScale: 5,
  cfgRescale: 0,
  sampler: 'k_euler_ancestral',
  noiseSchedule: 'karras',
  seed: 7,
  variety: false,
  qualityToggle: true,
  ucPreset: 0,
  useCoords: true,
  characterPrompts: [
    {
      prompt: 'unused',
      negativePrompt: 'unused negative',
      enabled: false,
      center: { x: 0.1, y: 0.2 }
    },
    {
      prompt: '# only a memo',
      negativePrompt: 'unused negative',
      enabled: true,
      center: { x: 0.3, y: 0.4 }
    },
    {
      prompt: 'hero, source#hug # memo',
      negativePrompt: 'closed eyes # memo',
      enabled: true,
      center: { x: 0.7, y: 0.8 }
    },
    { prompt: 'companion', negativePrompt: '', enabled: true, center: { x: 0.4, y: 0.6 } }
  ]
}

describe('shared final prompt captions', () => {
  it('includes quality and UC only in base captions, including otherwise empty base fields', () => {
    const prepared = preparePromptCaptions({
      ...request,
      prompt: '',
      negativePrompt: '',
      characterPrompts: []
    })
    expect(prepared.positive).toEqual({ base: QUALITY_TAGS_SUFFIX, characters: [] })
    expect(prepared.negative).toEqual({ base: UC_PRESETS_V45_FULL[0], characters: [] })
    const none = preparePromptCaptions({
      ...request,
      prompt: '',
      negativePrompt: '',
      qualityToggle: false,
      ucPreset: 4,
      characterPrompts: []
    })
    expect(none.positive.base).toBe('')
    expect(none.negative.base).toBe('')
  })

  it('removes comments and inactive cards, preserving order and empty negative captions', () => {
    const original = structuredClone(request)
    const prepared = preparePromptCaptions(request)
    expect(prepared.positive.characters).toEqual(['hero, source#hug ', 'companion'])
    expect(prepared.negative.characters).toEqual(['closed eyes ', ''])
    expect(prepared.activeCharacters.map((character) => character.center)).toEqual([
      { x: 0.7, y: 0.8 },
      { x: 0.4, y: 0.6 }
    ])
    expect(request).toEqual(original)
    expect(prepared.activeCharacters[0]).not.toBe(request.characterPrompts[2])
  })

  for (const model of ['nai-diffusion-4-5-full', 'nai-diffusion-5-full']) {
    it(`prepares exactly the captions and card alignment sent by ${model}`, () => {
      const prepared = preparePromptCaptions(request)
      const payload = buildGenerateImagePayload({ ...request, model })
      expect(payload.input).toBe(prepared.positive.base)
      expect(payload.parameters.negative_prompt).toBe(prepared.negative.base)
      expect(payload.parameters.v4_prompt).toMatchObject({
        caption: {
          base_caption: prepared.positive.base,
          char_captions: [
            { char_caption: prepared.positive.characters[0], centers: [{ x: 0.7, y: 0.8 }] },
            { char_caption: prepared.positive.characters[1], centers: [{ x: 0.4, y: 0.6 }] }
          ]
        }
      })
      expect(payload.parameters.v4_negative_prompt).toMatchObject({
        caption: {
          base_caption: prepared.negative.base,
          char_captions: prepared.negative.characters.map((char_caption) => ({ char_caption }))
        }
      })
      expect(payload.parameters.characterPrompts).toEqual(
        prepared.activeCharacters.map((character) => ({
          prompt: character.prompt,
          uc: character.negativePrompt,
          center: character.center,
          enabled: true
        }))
      )
    })
  }
})
