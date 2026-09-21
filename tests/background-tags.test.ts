import { describe, expect, it } from 'vitest'
import {
  normalizeBackground,
  stripBackgroundTags,
  stripSimpleBackgrounds
} from '../src/shared/background-tags'
import { scenePositivePrompt, refreshScenePrompts } from '../src/shared/scene-request'
import type { GenerationRequest } from '../src/shared/types'

describe('scene backgrounds', () => {
  it('uses background cards as background content in both preview and live queue refresh', () => {
    const card = {
      kind: 'background' as const,
      prompt: 'forest, sunlight',
      negativePrompt: '',
      background: { prompt: '', placement: 'after-scene' as const, replaceSimple: true }
    }
    const request = {
      sceneId: 99,
      sceneBasePrompt: '1girl, white background',
      prompt: '',
      negativePrompt: ''
    } as GenerationRequest
    expect(scenePositivePrompt(request.sceneBasePrompt!, card).prompt).toBe(
      '1girl, forest, sunlight'
    )
    expect(refreshScenePrompts(request, card).prompt).toBe('1girl, forest, sunlight')
  })
  const background = {
    prompt: 'forest, sunlight',
    placement: 'after-scene' as const,
    replaceSimple: true
  }
  it('keeps weighted compound groups, negative emphasis and non-background tags intact', () => {
    expect(
      stripSimpleBackgrounds(
        'smile, 1.5::white background::, simple_background, -1::pink background::, 2::white background, dress::, white hair'
      )
    ).toBe('smile, -1::pink background::, 2::white background, dress::, white hair')
    expect(stripSimpleBackgrounds('smile, {white background, dress}, blue eyes')).toBe(
      'smile, {white background, dress}, blue eyes'
    )
  })
  it('removes every NAI tag containing background, including weighted and underscore forms', () => {
    expect(
      stripBackgroundTags(
        '1girl, rural background, 1.5::white background::, transparent_background, blue eyes, smile'
      )
    ).toBe('1girl, blue eyes, smile')
  })
  it('inserts the background before detail and only cleans the generation copy', () => {
    const parts = {
      base: '1girl, white background',
      additional: 'upper body',
      detail: 'pink background, year 2025'
    }
    const scene = { prompt: 'smile, 1.5::white background::', background }
    expect(scenePositivePrompt('', scene, parts).prompt).toBe(
      '1girl, upper body, smile, forest, sunlight, year 2025'
    )
    expect(parts.base).toBe('1girl, white background')
    expect(scene.prompt).toBe('smile, 1.5::white background::')
    expect(
      scenePositivePrompt(
        '',
        { ...scene, background: { ...background, placement: 'before-scene' } },
        parts
      ).prompt
    ).toBe('1girl, upper body, forest, sunlight, smile, year 2025')
  })
  it('preserves legacy behavior and restores raw backgrounds when cleared', () => {
    expect(scenePositivePrompt('base, white background', { prompt: 'smile' }).prompt).toBe(
      'base, white background, smile'
    )
    expect(
      scenePositivePrompt('base, white background', {
        prompt: 'smile',
        background: { ...background, prompt: '' }
      }).prompt
    ).toBe('base, white background, smile')
    expect(normalizeBackground('{broken')).toEqual({
      prompt: '',
      placement: 'after-scene',
      replaceSimple: false
    })
  })
  it('refreshes pending requests without accumulating backgrounds', () => {
    const request = {
      sceneId: 1,
      sceneBasePrompt: '1girl, white background',
      sceneBaseNegativePrompt: '',
      prompt: 'stale',
      negativePrompt: ''
    } as GenerationRequest
    const latest = { prompt: 'smile', negativePrompt: '', background }
    const next = refreshScenePrompts(request, latest)
    expect(next.prompt).toBe('1girl, smile, forest, sunlight')
    expect(refreshScenePrompts(next, latest).prompt).toBe(next.prompt)
    expect(
      refreshScenePrompts(next, { ...latest, background: normalizeBackground(null) }).prompt
    ).toBe('1girl, white background, smile')
  })
})
