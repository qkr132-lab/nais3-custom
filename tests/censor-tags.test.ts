import { describe, expect, it } from 'vitest'
import {
  CENSOR_OPTIONS,
  censorPrompt,
  changeCensors,
  normalizeCensors,
  withCensorTags,
  withoutCensorDuplicates,
  normalizeAnalSuppression,
  changeAnalSuppression,
  withAnalSuppression,
  changeCensorWeights,
  normalizeCensorWeight,
  normalizeCensorWeights
} from '../src/shared/censor-tags'
import {
  scenePositivePrompt,
  sceneNegativePrompt,
  refreshScenePrompts
} from '../src/shared/scene-request'
import type { CharacterPromptInput, GenerationRequest } from '../src/shared/types'

const ALL = ['penis', 'vulva', 'anal', 'testicles'] as const
const TAGS =
  'completely white censored penis, completely white censored pussy, completely white censored anal, completely white censored testicles'
const char = (prompt: string, enabled = true): CharacterPromptInput => ({
  prompt,
  negativePrompt: '',
  enabled
})

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
  it('부위별 가중치 — 1인 부위는 그대로, 아닌 부위만 따로 묶고, 깨진 값은 바로잡는다', () => {
    expect(censorPrompt(['penis'], {})).toBe('completely white censored penis')
    expect(censorPrompt(['penis'], { penis: 1.3 })).toBe('1.3::completely white censored penis::')
    expect(censorPrompt(['penis', 'vulva'], { vulva: 0.8 })).toBe(
      'completely white censored penis, 0.8::completely white censored pussy::'
    )
    expect(censorPrompt(['penis', 'vulva'], { penis: 1.2, vulva: 1.5 })).toBe(
      '1.2::completely white censored penis::, 1.5::completely white censored pussy::'
    )
    // 안 고른 부위의 가중치는 아무것도 안 붙인다
    expect(censorPrompt(['penis'], { anal: 2 })).toBe('completely white censored penis')
    expect(censorPrompt([], { penis: 1.3 })).toBe('')
    expect(normalizeCensorWeight(undefined)).toBe(1)
    expect(normalizeCensorWeight('1.25')).toBe(1.25)
    expect(normalizeCensorWeight(99)).toBe(5)
    expect(normalizeCensorWeight(0)).toBe(0.1)
    // JSON 글자열·모르는 부위·1인 값 정리
    expect(normalizeCensorWeights('{"penis":1.3,"vulva":1,"suppress":0.4,"x":2}')).toEqual({
      penis: 1.3
    })
    expect(normalizeCensorWeights('깨짐')).toEqual({})
    expect(changeCensorWeights({ penis: 1.2 }, {})).toEqual({ penis: 1.2 })
    expect(changeCensorWeights({ penis: 1.2 }, { weights: { penis: 1, anal: 0.9 } })).toEqual({
      anal: 0.9
    })
    // 프롬프트 끝에 붙일 때도 묶음으로, 이미 적힌 것은 걷어낸다
    expect(
      withCensorTags('1girl, completely white censored penis', ['penis'], { penis: 1.5 })
    ).toBe('1girl, 1.5::completely white censored penis::')
  })

  it('uses the plain tags without weights or suppress tags, in option order', () => {
    expect(censorPrompt(['penis'])).toBe('completely white censored penis')
    expect(censorPrompt(['vulva'])).toBe('completely white censored pussy')
    expect(censorPrompt(['anal'])).toBe('completely white censored anal')
    expect(censorPrompt(['testicles'])).toBe('completely white censored testicles')
    expect(censorPrompt(['testicles', 'anal', 'vulva', 'penis'])).toBe(TAGS)
    expect(censorPrompt([])).toBe('')
    for (const word of ['::', 'veiny', 'pink penis', 'white skin', 'pale skin', 'white nipples'])
      expect(censorPrompt(ALL)).not.toContain(word)
  })
  it('replaces older selected censor spellings without changing unselected or scoped tags', () => {
    const original =
      '3::white pussy censor, clouds::, white censored anal, target#white pussy censor'
    const result = withCensorTags(original, ['vulva'])
    expect(result).toBe(
      '3:: clouds::, white censored anal, target#white pussy censor, completely white censored pussy'
    )
    expect(withCensorTags(result, ['vulva'])).toBe(result)
    expect(withCensorTags(original, [])).toBe(original)
  })
  it('removes old and new spellings of every selected kind so none is sent twice', () => {
    const typed = [
      'completely white penis censor',
      'white penis censor',
      'white censored penis',
      'completely white censored penis',
      '2::completely white pussy censor::',
      'white pussy censor',
      'white censored pussy',
      'white censored anal',
      'white censored testicles',
      'sky'
    ].join(', ')
    expect(withoutCensorDuplicates(typed, ALL)).toBe('sky')
    expect(withCensorTags(typed, ALL)).toBe(`sky, ${TAGS}`)
    // 고르지 않은 부위의 표기는 그대로 둔다
    expect(withoutCensorDuplicates(typed, ['anal'])).toContain('white penis censor')
  })
  it('no longer removes the former suppress tags the user typed', () => {
    const typed = 'white skin, white nipples, pale skin, veiny penis'
    expect(withCensorTags(typed, ['penis', 'vulva', 'testicles'])).toBe(
      `${typed}, completely white censored penis, completely white censored pussy, completely white censored testicles`
    )
  })
  it('puts the tags on a new line after a trailing comment and stays stable', () => {
    const once = withCensorTags('blue eyes # note', ['penis'])
    expect(once).toBe('blue eyes # note\ncompletely white censored penis')
    expect(withCensorTags(once, ['penis'])).toBe(once)
    expect(withoutCensorDuplicates('forest\nwhite penis censor\nsky', ['penis'])).not.toContain(
      'censor'
    )
  })
  for (let mask = 0; mask < 16; mask++) {
    it(`deduplicates combination ${mask} and repeated application`, () => {
      const options = CENSOR_OPTIONS.filter((_, i) => mask & (1 << i)).map((o) => o.id)
      const prompt = withCensorTags('landscape, blue sky', options)
      expect(withCensorTags(prompt, options)).toBe(prompt)
      expect(prompt).not.toContain('::')
      expect(prompt.endsWith(censorPrompt(options))).toBe(true)
      for (const o of CENSOR_OPTIONS)
        expect(prompt.split(o.tag).length - 1).toBe(options.includes(o.id) ? 1 : 0)
    })
  }
  it('deduplicates across all split fields without changing original input', () => {
    const parts = {
      base: 'white penis censor, sky',
      additional: 'flowers',
      detail: '2::completely white pussy censor, clouds::'
    }
    const result = scenePositivePrompt(
      '',
      { prompt: 'completely white censored penis', censorKinds: ['penis', 'vulva'] },
      parts
    )
    // 씬·검열 태그는 디테일 뒤(맨 끝)에 (2026-10-11)
    expect(result.prompt).toBe(
      'sky, flowers, 2:: clouds::, completely white censored penis, completely white censored pussy'
    )
    expect(parts.base).toBe('white penis censor, sky')
    expect(result.promptParts?.detail).toBe(
      '2:: clouds::, completely white censored penis, completely white censored pussy'
    )
  })
  it('ignores censor weights saved by older versions', () => {
    const legacy = {
      prompt: 'forest',
      negativePrompt: '',
      censorKinds: ['penis' as const],
      censorWeights: { penis: 0.7, suppress: 3 }
    }
    expect(scenePositivePrompt('sky', legacy).prompt).toBe(
      'sky, forest, completely white censored penis'
    )
    const refreshed = refreshScenePrompts(
      {
        prompt: '',
        sceneId: 1,
        sceneBasePrompt: 'sky',
        characterPrompts: [char('1girl')]
      } as GenerationRequest,
      legacy
    )
    expect(refreshed.prompt).toBe('sky, forest')
    expect(refreshed.characterPrompts[0].prompt).toBe('1girl, completely white censored penis')
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
  it('stays a negative-only option when the censor tags go to character 1', () => {
    const scene = {
      prompt: 'landscape',
      negativePrompt: 'blur',
      censorKinds: ['anal' as const],
      suppressAnal: true
    }
    const queued = {
      sceneId: 1,
      sceneBasePrompt: 'sky',
      sceneBaseNegativePrompt: 'low quality',
      prompt: '',
      negativePrompt: '',
      characterPrompts: [char('1girl')],
      seed: 7
    } as GenerationRequest
    const on = refreshScenePrompts(queued, scene)
    expect(on.negativePrompt).toBe('low quality, blur, anal')
    expect(on.prompt).toBe('sky, landscape')
    expect(on.characterPrompts).toEqual([char('1girl, completely white censored anal')])
    const off = refreshScenePrompts(on, { ...scene, suppressAnal: false })
    expect(off.negativePrompt).toBe('low quality, blur')
    expect(off.characterPrompts[0].prompt).toBe('1girl, completely white censored anal')
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
