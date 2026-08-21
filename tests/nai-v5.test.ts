import { describe, expect, it } from 'vitest'
import type { GenerationRequest } from '../src/shared/types'
import { buildGenerateImagePayload, varietySigma } from '../src/main/nai/payload'
import { MODEL_OPTIONS, effectiveNoiseSchedule, isV5, modelCaps } from '../src/shared/nai-models'

/**
 * V5 대응 명세. 근거는 두 갈래다:
 * - NAI 웹 번들의 모델 기능표 실측 (2026-08-21)
 * - 생성물 메타데이터 tests/fixtures/v5/*.params.json (webp EXIF UserComment)
 */

const v5Request: GenerationRequest = {
  prompt: '1girl, silver hair',
  negativePrompt: 'lowres',
  model: 'nai-diffusion-5-full',
  width: 1024,
  height: 1024,
  steps: 23,
  cfgScale: 6,
  cfgRescale: 0,
  sampler: 'k_euler_ancestral',
  noiseSchedule: 'karras',
  seed: 758137447,
  variety: false,
  qualityToggle: true,
  ucPreset: 2,
  characterPrompts: [],
  useCoords: false
}

const params = (req: GenerationRequest, opts = {}): Record<string, unknown> =>
  buildGenerateImagePayload(req, opts).parameters

describe('모델 기능표', () => {
  it('V5 모델 4종을 알아본다', () => {
    expect(isV5('nai-diffusion-5-full')).toBe(true)
    expect(isV5('nai-diffusion-5-curated')).toBe(true)
    expect(isV5('nai-diffusion-4-5-full')).toBe(false)
  })

  it('V4.5 → V5 차이가 웹 기능표와 일치한다', () => {
    const v45 = modelCaps('nai-diffusion-4-5-full')
    const v5 = modelCaps('nai-diffusion-5-full')

    expect(v45.maxCharacters).toBe(6)
    expect(v5.maxCharacters).toBe(32)
    expect(v45.freeformCharacterPosition).toBe(false)
    expect(v5.freeformCharacterPosition).toBe(true)
    // V5에서 빠진 것들
    expect(v5.variety).toBe(false)
    expect(v5.vibeTransfer).toBe(false)
    expect(v5.characterReferences).toBe(false)
    expect(v5.noiseSchedule).toBe(false)
    // V5에서 생긴 것들
    expect(v5.transparency).toBe(true)
    expect(v5.opusUsageLimit).toBe(true)
  })

  it('모르는 모델 id는 V4.5 기준으로 떨어진다 (구버전 예약·메타데이터 복원 대비)', () => {
    expect(modelCaps('nai-diffusion-3').maxCharacters).toBe(6)
    expect(modelCaps('').variety).toBe(true)
  })

  it('드롭다운 목록이 실제 API 모델 id를 쓴다', () => {
    expect(MODEL_OPTIONS.map((m) => m.value)).toEqual([
      'nai-diffusion-5-full',
      'nai-diffusion-5-curated',
      'nai-diffusion-4-5-full',
      'nai-diffusion-4-5-curated'
    ])
  })
})

describe('V5 payload', () => {
  it('Variety+가 켜져 있어도 V5에는 보내지 않는다 (웹 기능표 cfgDelay=false)', () => {
    expect(
      varietySigma({ model: 'nai-diffusion-5-full', variety: true, width: 1024, height: 1024 })
    ).toBeNull()
    // V4.5는 그대로 계수 58
    expect(
      varietySigma({ model: 'nai-diffusion-4-5-full', variety: true, width: 1024, height: 1024 })
    ).toBeCloseTo(59.04722600415217, 10)

    expect(params({ ...v5Request, variety: true }).skip_cfg_above_sigma).toBeNull()
  })

  it('V5는 노이즈 스케줄 선택이 없어 karras로 고정된다', () => {
    expect(effectiveNoiseSchedule('nai-diffusion-5-full', 'native')).toBe('karras')
    expect(effectiveNoiseSchedule('nai-diffusion-4-5-full', 'native')).toBe('native')
    expect(params({ ...v5Request, noiseSchedule: 'exponential' }).noise_schedule).toBe('karras')
  })

  it('V5에는 바이브·캐릭터 레퍼런스를 싣지 않는다 (미지원 — 보내면 거부)', () => {
    const opts = {
      vibes: [{ strength: 0.6, encodedVibeBase64: 'AAA' }],
      characterReferences: [
        { referenceType: 'character' as const, strength: 0.6, fidelity: 1, imageBase64: 'BBB' }
      ]
    }
    const v5 = params(v5Request, opts)
    expect(v5.reference_strength_multiple).toBeUndefined()
    expect(v5.director_reference_descriptions).toBeUndefined()

    // V4.5는 기존대로 실린다
    const v45 = params({ ...v5Request, model: 'nai-diffusion-4-5-full' }, opts)
    expect(v45.reference_strength_multiple).toEqual([0.6])
    expect(v45.director_reference_descriptions).toBeDefined()
  })

  it('V5에만 tag_hint 계열을 추가로 보낸다', () => {
    const v5 = params(v5Request)
    expect(v5.tag_hint_qt).toBe(1)
    expect(v5.tag_hint_uc_preset).toBe(2)
    expect(v5).toHaveProperty('tag_hint_transparent_background')
    // 퀄리티 태그를 끄면 0
    expect(params({ ...v5Request, qualityToggle: false }).tag_hint_qt).toBe(0)
    // V4.5에는 없다 (웹 패리티)
    expect(params({ ...v5Request, model: 'nai-diffusion-4-5-full' }).tag_hint_qt).toBeUndefined()
  })

  it('모델 id가 그대로 실린다', () => {
    expect(buildGenerateImagePayload(v5Request).model).toBe('nai-diffusion-5-full')
  })

  it('캐릭터 좌표는 연속값을 반올림 없이 그대로 보낸다 (V5 자유 배치)', () => {
    const req: GenerationRequest = {
      ...v5Request,
      useCoords: true,
      characterPrompts: [
        { prompt: 'girl', negativePrompt: '', center: { x: 0.776, y: 0.141 }, enabled: true },
        { prompt: 'boy', negativePrompt: '', center: { x: 0.177, y: 0.825 }, enabled: true }
      ]
    }
    const v4Prompt = params(req).v4_prompt as {
      caption: { char_captions: { centers: { x: number; y: number }[] }[] }
    }
    expect(v4Prompt.caption.char_captions.map((c) => c.centers[0])).toEqual([
      { x: 0.776, y: 0.141 },
      { x: 0.177, y: 0.825 }
    ])
  })
})
