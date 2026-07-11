import { describe, expect, it } from 'vitest'
import { appendPrompt, refreshScenePrompts } from '../src/shared/scene-request'
import type { GenerationRequest } from '../src/shared/types'

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

  it('예약 당시 기본값은 유지하고 최신 씬 태그만 다시 합친다', () => {
    const original = request({
      sceneId: 7,
      sceneBasePrompt: 'base',
      sceneBaseNegativePrompt: 'base negative',
      sceneBaseDetailPrompt: 'base detail',
      promptParts: { base: 'base', additional: 'extra', detail: 'base detail, old scene' }
    })
    const refreshed = refreshScenePrompts(original, {
      prompt: '6::new tag::',
      negativePrompt: 'new negative'
    })

    expect(refreshed.prompt).toBe('base, 6::new tag::')
    expect(refreshed.negativePrompt).toBe('base negative, new negative')
    expect(refreshed.promptParts?.detail).toBe('base detail, 6::new tag::')
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
