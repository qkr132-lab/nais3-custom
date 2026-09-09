import { describe, expect, it } from 'vitest'
import {
  CENSOR_OPTIONS,
  censorPrompt,
  changeCensors,
  normalizeCensors,
  withCensorTags,
  normalizeAnalSuppression,
  changeAnalSuppression,
  withAnalSuppression
} from '../src/shared/censor-tags'
import {
  scenePositivePrompt,
  sceneNegativePrompt,
  refreshScenePrompts
} from '../src/shared/scene-request'
import type { GenerationRequest } from '../src/shared/types'

describe('씬 검열 태그', () => {
  it('loads missing, malformed and duplicated settings safely', () => {
    expect(normalizeCensors(undefined)).toEqual([])
    expect(normalizeCensors('{bad')).toEqual([])
    expect(normalizeCensors('["vulva","vulva","unknown"]')).toEqual(['vulva'])
  })
  it('keeps untouched mixed scene options', () => {
    expect(changeCensors(['penis', 'testicles'], { anal: true })).toEqual([
      'penis',
      'anal',
      'testicles'
    ])
    expect(changeCensors(['vulva'], { anal: true })).toEqual(['vulva', 'anal'])
    expect(changeCensors(['penis', 'vulva'], { penis: false })).toEqual(['vulva'])
  })
  it('preserves supplied weight signs and does not move suppression to negative prompt', () => {
    expect(censorPrompt(['penis'])).toBe(
      '2::completely white penis censor::, -2::veiny penis, pink penis, red penis, white skin, pale skin, white nipples::'
    )
    expect(censorPrompt(['vulva'])).toBe('2::white pussy censor::, -2::white nipples::')
    expect(censorPrompt(['anal'])).toBe('2::white censored anal::')
    expect(censorPrompt(['testicles'])).toBe('2::white censored testicles::, -2::white skin::')
  })
  for (let mask = 0; mask < 16; mask++) {
    it(`deduplicates combination ${mask} and repeated application`, () => {
      const options = CENSOR_OPTIONS.filter((_, i) => mask & (1 << i)).map((o) => o.id)
      const prompt = withCensorTags('landscape, blue sky', options)
      expect(withCensorTags(prompt, options)).toBe(prompt)
      if (options.includes('penis') || options.includes('vulva'))
        expect(prompt.match(/white nipples/g)).toHaveLength(1)
      if (options.includes('penis') || options.includes('testicles'))
        expect(prompt.match(/white skin/g)).toHaveLength(1)
    })
  }
  it('selected controls override duplicates in request copies, preserving unrelated weighted tags', () => {
    const original = '5::white skin, clouds::, white nipples, target#white skin, sky'
    const result = withCensorTags(original, ['penis', 'vulva', 'testicles'])
    expect(result).toContain('5:: clouds::')
    expect(result).toContain('target#white skin')
    expect(result).not.toContain('5::white skin')
    expect(result.match(/white nipples/g)).toHaveLength(1)
    expect(withCensorTags(original, [])).toBe(original)
  })
  it('deduplicates across all split fields without changing original input', () => {
    const parts = {
      base: 'white nipples, sky',
      additional: 'flowers',
      detail: '2::white skin, clouds::'
    }
    const result = scenePositivePrompt(
      '',
      { prompt: '-2::white nipples::', censorKinds: ['penis', 'vulva'] },
      parts
    )
    expect(result.prompt.match(/white nipples/g)).toHaveLength(1)
    expect(result.prompt.match(/white skin/g)).toHaveLength(1)
    expect(parts.base).toBe('white nipples, sky')
    expect(result.promptParts?.detail).toContain('clouds')
  })
  it('refreshes pending requests and restores original split fields when controls are turned off', () => {
    const parts = {
      base: 'white skin, sky',
      additional: 'flowers',
      detail: 'white nipples, clouds'
    }
    const scene = { prompt: 'trees', negativePrompt: 'blur', censorKinds: ['penis'] as const }
    const initial = scenePositivePrompt('', { ...scene, censorKinds: ['penis'] }, parts)
    const request = {
      ...initial,
      sceneId: 3,
      sceneBasePrompt: 'base',
      sceneBasePromptParts: parts,
      sceneBaseAdditionalPrompt: parts.additional,
      sceneBaseNegativePrompt: 'low quality',
      seed: 17
    } as GenerationRequest
    const off = refreshScenePrompts(request, { ...scene, censorKinds: [] })
    expect(off.prompt).toBe('white skin, sky, flowers, trees, white nipples, clouds')
    expect(off.negativePrompt).toBe('low quality, blur')
    expect(off.seed).toBe(17)
    const on = refreshScenePrompts(off, { ...scene, censorKinds: ['vulva'] })
    expect(on.prompt.match(/white nipples/g)).toHaveLength(1)
    expect(on.prompt).not.toContain('completely white penis censor')
  })
})

describe('independent negative-prompt suppression', () => {
  it('defaults off and preserves untouched settings in mixed batches', () => {
    for (const value of [undefined, null, false, 0, 'false', 'true', {}, []])
      expect(normalizeAnalSuppression(value)).toBe(false)
    expect(normalizeAnalSuppression(1)).toBe(true)
    expect(changeAnalSuppression(true, { anal: false })).toBe(true)
    expect(changeAnalSuppression(false, { anal: true })).toBe(false)
    expect(changeAnalSuppression(true, { suppressAnal: false })).toBe(false)
  })
  it('adds one negative tag, recognizing plain or weighted user tags without rewriting them', () => {
    for (const authored of ['blur, anal', '2::anal, blur::', '{{anal}}, blur', 'ANAL, blur']) {
      expect(withAnalSuppression(authored, true)).toBe(authored)
      expect(withAnalSuppression(authored, false)).toBe(authored)
    }
    const once = withAnalSuppression('blur', true)
    expect(once).toBe('blur, anal')
    expect(withAnalSuppression(once, true)).toBe(once)
    expect(withAnalSuppression('', true)).toBe('anal')
  })
  it('does not confuse comments, substrings or role-qualified tags with a global negative', () => {
    expect(withAnalSuppression('blur # anal', true)).toBe('blur # anal\nanal')
    expect(withAnalSuppression('analog, target#anal', true)).toBe('analog, target#anal, anal')
  })
  it('applies independently from white censor styling and leaves raw fields intact', () => {
    const scene = { prompt: 'landscape', negativePrompt: 'blur', suppressAnal: true }
    expect(sceneNegativePrompt('low quality', scene)).toBe('low quality, blur, anal')
    expect(scenePositivePrompt('sky', scene).prompt).toBe('sky, landscape')
    expect(scene.negativePrompt).toBe('blur')
  })
  it('rebuilds queued negatives on toggle, removing only the generated contribution', () => {
    const scene = { prompt: 'landscape', negativePrompt: 'blur', suppressAnal: true }
    const queued = {
      sceneId: 1,
      sceneBasePrompt: 'sky',
      sceneBaseNegativePrompt: 'low quality',
      prompt: '',
      negativePrompt: '',
      seed: 7
    } as GenerationRequest
    const on = refreshScenePrompts(queued, scene)
    expect(on.negativePrompt).toBe('low quality, blur, anal')
    expect(refreshScenePrompts(on, scene).negativePrompt).toBe(on.negativePrompt)
    expect(refreshScenePrompts(on, { ...scene, suppressAnal: false }).negativePrompt).toBe(
      'low quality, blur'
    )
    const userAuthored = { ...on, sceneBaseNegativePrompt: 'anal, low quality' }
    expect(
      refreshScenePrompts(userAuthored, { ...scene, suppressAnal: false }).negativePrompt
    ).toBe('anal, low quality, blur')
    expect(queued.negativePrompt).toBe('')
  })
})
import { normalizeCensorWeights, changeCensorWeights } from '../src/shared/censor-tags'

describe('adjustable censor weights', () => {
  it('normalizes legacy defaults, limits and non-finite data', () => {
    expect(normalizeCensorWeights(undefined)).toEqual({
      penis: 2,
      vulva: 2,
      anal: 2,
      testicles: 2,
      suppress: 2
    })
    expect(normalizeCensorWeights({ penis: 99, vulva: -1, anal: NaN, suppress: -5 })).toMatchObject(
      { penis: 5, vulva: 0.1, anal: 2, suppress: 0 }
    )
  })
  it('preserves untouched per-scene weights during batch edits', () => {
    expect(changeCensorWeights({ penis: 1.2, vulva: 2.3 }, { weights: { anal: 1 } })).toMatchObject(
      { penis: 1.2, vulva: 2.3, anal: 1 }
    )
  })
  it('applies positive and suppression weights once across duplicate controls', () => {
    const prompt = censorPrompt(['penis', 'vulva', 'testicles'], {
      penis: 1.2,
      vulva: 1.4,
      testicles: 0.8,
      suppress: 0.5
    })
    expect(prompt).toContain('1.2::completely white penis censor::')
    expect(prompt).toContain('-0.5::')
    expect(prompt.match(/white skin/g)).toHaveLength(1)
    expect(censorPrompt(['penis'], { suppress: 0 })).not.toContain('white skin')
  })
  it('updates weights for queued split prompts without changing raw fields', () => {
    const original = { base: 'sky', additional: 'smile', detail: 'clouds' }
    const result = refreshScenePrompts(
      {
        prompt: '',
        promptParts: original,
        sceneBasePromptParts: original,
        sceneBaseAdditionalPrompt: 'smile',
        sceneBasePrompt: '',
        sceneId: 1
      } as GenerationRequest,
      {
        prompt: '',
        negativePrompt: '',
        censorKinds: ['anal'],
        censorWeights: normalizeCensorWeights({ anal: 0.7 })
      }
    )
    expect(result.prompt).toContain('0.7::white censored anal::')
    expect(original.additional).toBe('smile')
  })
})
