import { describe, expect, it } from 'vitest'
import {
  appendPrompt,
  censorCharacterIndex,
  mergeSceneIntoPromptParts,
  prioritizeSceneCharacterIds,
  refreshScenePrompts,
  scenePositivePrompt
} from '../src/shared/scene-request'
import type { CensorKind } from '../src/shared/censor-tags'
import type { CharacterPromptInput, GenerationRequest } from '../src/shared/types'

function request(patch: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    prompt: 'base, old scene',
    negativePrompt: 'base negative, old negative',
    model: 'nai-diffusion-4-5-full',
    width: 832,
    height: 1216,
    steps: 28,
    cfgScale: 5,
    cfgRescale: 0,
    sampler: 'k_euler_ancestral',
    noiseSchedule: 'karras',
    seed: 123,
    variety: false,
    qualityToggle: true,
    ucPreset: 0,
    characterPrompts: [],
    useCoords: false,
    ...patch
  }
}

describe('대기 씬 요청 최신화', () => {
  it('콤마 경계를 정리해 프롬프트를 합친다', () => {
    expect(appendPrompt('base,', ', scene')).toBe('base, scene')
  })

  it('씬 프롬프트는 3분할의 가변 영역에만 넣는다', () => {
    expect(
      mergeSceneIntoPromptParts(
        { base: 'fixed', additional: 'variable', detail: 'quality detail' },
        'scene tag'
      )
    ).toEqual({
      base: 'fixed',
      additional: 'variable, scene tag',
      detail: 'quality detail'
    })
  })

  it('씬별 캐릭터 선택 순서를 기본 캐릭터보다 우선한다', () => {
    expect(prioritizeSceneCharacterIds([30, 10], [10, 20, 40])).toEqual([30, 10, 20, 40])
  })

  it('씬별 선택이 없으면 기본 캐릭터 순서를 유지한다', () => {
    expect(prioritizeSceneCharacterIds([], [30, 10, 20])).toEqual([30, 10, 20])
  })

  it('예약 당시 기본값은 유지하고 최신 씬 태그만 다시 합친다', () => {
    const original = request({
      sceneId: 7,
      sceneBasePrompt: 'base',
      sceneBaseNegativePrompt: 'base negative',
      sceneBaseAdditionalPrompt: 'variable',
      promptParts: { base: 'base', additional: 'variable, old scene', detail: 'base detail' }
    })
    const refreshed = refreshScenePrompts(original, {
      prompt: '6::new tag::',
      negativePrompt: 'new negative'
    })

    // 분할 사용 시 전송 프롬프트는 파츠에서 재조립 — 씬 태그가 가변 뒤·디테일 앞에 온다
    // (전체 병합문 끝에 붙이면 긴 디테일 뒤 꼬리가 되어 적용이 약해지던 버그의 회귀 방지)
    expect(refreshed.prompt).toBe('base, variable, 6::new tag::, base detail')
    expect(refreshed.negativePrompt).toBe('base negative, new negative')
    expect(refreshed.promptParts?.additional).toBe('variable, 6::new tag::')
    expect(refreshed.promptParts?.detail).toBe('base detail')
    expect(refreshed.seed).toBe(123)
    expect(refreshed.width).toBe(832)
  })

  it('일반 생성 요청이나 구버전 큐 항목은 변경하지 않는다', () => {
    const original = request({ sceneId: 7 })
    expect(refreshScenePrompts(original, { prompt: 'new', negativePrompt: 'new neg' })).toBe(
      original
    )
  })
})

describe('씬 검열 태그 자리 — 첫 캐릭터 맨 끝', () => {
  const char = (prompt: string, enabled = true): CharacterPromptInput => ({
    prompt,
    negativePrompt: `${prompt} negative`,
    enabled
  })
  const scene = { prompt: 'forest', censorKinds: ['penis', 'vulva'] as CensorKind[] }
  const TAGS = 'completely white censored penis, completely white censored pussy'

  it('캐릭터 1 프롬프트 맨 끝에 가중치 없이 붙이고 기본 프롬프트에는 넣지 않는다', () => {
    const characters = [char('1girl, smile'), char('1boy')]
    const result = scenePositivePrompt('sky', scene, undefined, characters)
    expect(result.prompt).toBe('sky, forest')
    expect(result.characterPrompts?.map((c) => c.prompt)).toEqual([`1girl, smile, ${TAGS}`, '1boy'])
    expect(result.characterPrompts?.[0].negativePrompt).toBe('1girl, smile negative')
    // 원본 캐릭터는 그대로
    expect(characters[0].prompt).toBe('1girl, smile')
  })

  it('분할 프롬프트에서도 가변 칸이 아니라 캐릭터 1에 붙는다', () => {
    const result = scenePositivePrompt(
      '',
      scene,
      { base: 'sky', additional: 'clouds', detail: 'detailed' },
      [char('1girl')]
    )
    expect(result.prompt).toBe('sky, clouds, forest, detailed')
    expect(result.promptParts?.additional).toBe('clouds, forest')
    expect(result.characterPrompts?.[0].prompt).toBe(`1girl, ${TAGS}`)
  })

  it('캐릭터가 없으면 예전처럼 기본 프롬프트 끝에 붙인다', () => {
    expect(scenePositivePrompt('sky', scene, undefined, [])).toEqual({
      prompt: `sky, forest, ${TAGS}`,
      characterPrompts: []
    })
    // 캐릭터를 넘기지 않은 호출도 같은 자리
    expect(scenePositivePrompt('sky', scene).prompt).toBe(`sky, forest, ${TAGS}`)
    const split = scenePositivePrompt('', scene, { base: 'sky', additional: '', detail: 'hd' }, [])
    expect(split.promptParts?.additional).toBe(`forest, ${TAGS}`)
  })

  it('꺼진 캐릭터·빈 칸·주석뿐인 칸은 건너뛰고 실제로 보내는 첫 캐릭터에 붙인다', () => {
    const characters = [
      char('1girl', false),
      char('   '),
      char('# memo only'),
      char('1boy'),
      char('1other')
    ]
    expect(censorCharacterIndex(characters)).toBe(3)
    const result = scenePositivePrompt('sky', scene, undefined, characters)
    expect(result.characterPrompts?.map((c) => c.prompt)).toEqual([
      '1girl',
      '   ',
      '# memo only',
      `1boy, ${TAGS}`,
      '1other'
    ])
    // 보낼 캐릭터가 하나도 없으면 기본 프롬프트로
    const none = scenePositivePrompt('sky', scene, undefined, characters.slice(0, 3))
    expect(none.prompt).toBe(`sky, forest, ${TAGS}`)
    expect(none.characterPrompts?.map((c) => c.prompt)).toEqual(['1girl', '   ', '# memo only'])
  })

  it('캐릭터 프롬프트 끝이 주석이면 줄을 바꿔 붙인다', () => {
    const result = scenePositivePrompt('sky', scene, undefined, [char('1girl # note')])
    expect(result.characterPrompts?.[0].prompt).toBe(`1girl # note\n${TAGS}`)
  })

  it('기본·캐릭터 1에 적어 둔 예전·지금 표기는 요청 사본에서만 걷어낸다', () => {
    const base = 'sky, white penis censor, 2::completely white pussy censor::'
    const first = '1girl, completely white penis censor, completely white censored pussy'
    const second = '1boy, white penis censor'
    const characters = [char(first), char(second)]
    const result = scenePositivePrompt(
      base,
      { prompt: 'forest, white censored penis', censorKinds: scene.censorKinds },
      undefined,
      characters
    )
    expect(result.prompt).toBe('sky, forest')
    expect(result.characterPrompts?.[0].prompt).toBe(`1girl, ${TAGS}`)
    // 다른 캐릭터에 적은 태그는 그 캐릭터 몫이라 건드리지 않는다
    expect(result.characterPrompts?.[1].prompt).toBe(second)
    expect(characters[0].prompt).toBe(first)
    // 검열을 끄면 적어 둔 그대로 보낸다
    const off = scenePositivePrompt(base, { prompt: 'forest', censorKinds: [] }, undefined, [
      char(first)
    ])
    expect(off.prompt).toBe(`${base}, forest`)
    expect(off.characterPrompts?.[0].prompt).toBe(first)
  })

  it('예약 뒤 검열 설정을 바꾸면 실행 직전 캐릭터 1을 원문에서 다시 만든다', () => {
    const built = scenePositivePrompt('sky', scene, undefined, [char('1girl'), char('1boy')])
    const queued = request({
      prompt: built.prompt,
      characterPrompts: built.characterPrompts,
      sceneId: 7,
      sceneBasePrompt: 'sky',
      sceneBaseNegativePrompt: 'low quality',
      sceneBaseCharacterPrompts: ['1girl', '1boy']
    })
    const off = refreshScenePrompts(queued, { ...scene, negativePrompt: '', censorKinds: [] })
    expect(off.prompt).toBe('sky, forest')
    expect(off.characterPrompts.map((c) => c.prompt)).toEqual(['1girl', '1boy'])
    const anal = refreshScenePrompts(queued, {
      ...scene,
      negativePrompt: '',
      censorKinds: ['anal']
    })
    expect(anal.characterPrompts.map((c) => c.prompt)).toEqual([
      '1girl, completely white censored anal',
      '1boy'
    ])
    const same = refreshScenePrompts(queued, { ...scene, negativePrompt: '' })
    expect(same.characterPrompts).toEqual(queued.characterPrompts)
    expect(refreshScenePrompts(same, { ...scene, negativePrompt: '' })).toEqual(same)
    expect(queued.characterPrompts[0].prompt).toBe(`1girl, ${TAGS}`)
  })

  it('원문이 없는 예약 항목은 지금 캐릭터 프롬프트에 붙인다', () => {
    const queued = request({
      characterPrompts: [char('1girl')],
      sceneId: 7,
      sceneBasePrompt: 'sky'
    })
    const refreshed = refreshScenePrompts(queued, { ...scene, negativePrompt: '' })
    expect(refreshed.prompt).toBe('sky, forest')
    expect(refreshed.characterPrompts[0].prompt).toBe(`1girl, ${TAGS}`)
    expect(refreshed.sceneBaseCharacterPrompts).toEqual(['1girl'])
  })
})
