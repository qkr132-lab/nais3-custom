import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import type { GenerationRequest } from '../src/shared/types'
import { CHARREF_BUCKETS } from '../src/shared/char-ref-buckets'
import {
  charRefBucket,
  charRefFamily,
  charRefRule,
  countSentCharRefs,
  prefersSameOutfit,
  sentCharRefType,
  withSameOutfit
} from '../src/shared/char-refs'
import { buildGenerateImagePayload, type BuildOptions } from '../src/main/nai/payload'
import { processCharRefImage } from '../src/main/refs/charref-image'

/**
 * 캐릭터 레퍼런스의 모델별 규칙. 근거는 NAI 웹 번들 2026-11-25 (b2fe159-production):
 * 모델 기능표의 레퍼런스 키 6개, 생성 직전에 레퍼런스 목록을 거르는 함수, 그림 버킷 계산 함수.
 * 서버 응답으로 확인한 것이 아니라 웹이 보내는 모양을 옮긴 것이다.
 */

const V45 = 'nai-diffusion-4-5-full'
const V5 = 'nai-diffusion-5-full'

const base: GenerationRequest = {
  prompt: '1girl',
  negativePrompt: '',
  model: V5,
  width: 832,
  height: 1216,
  steps: 23,
  cfgScale: 6,
  cfgRescale: 0,
  sampler: 'k_euler_ancestral',
  noiseSchedule: 'karras',
  seed: 1,
  variety: false,
  qualityToggle: false,
  ucPreset: 3,
  characterPrompts: [],
  useCoords: false
}

const params = (model: string, opts: BuildOptions): Record<string, unknown> =>
  buildGenerateImagePayload({ ...base, model }, opts).parameters

const captions = (p: Record<string, unknown>): string[] =>
  (p.director_reference_descriptions as { caption: { base_caption: string } }[]).map(
    (d) => d.caption.base_caption
  )

const mask = {
  strength: 0.7,
  noise: 0,
  extraNoiseSeed: 0,
  colorCorrect: false,
  imageBase64: 'IMG',
  maskBase64: 'MASK'
}

describe('모델별 레퍼런스 규칙', () => {
  it('V4.5 — 충실도 있음·강도 1까지·의상 없음·캔버스 맞춤·인페인트에도 실림', () => {
    expect(charRefRule(V45)).toEqual({
      send: true,
      outfit: false,
      fidelity: true,
      strengthMax: 1,
      image: 'canvas'
    })
    expect(charRefRule(V45, true).send).toBe(true)
  })

  it('V5 — 충실도 없음·강도 5까지·의상 있음·버킷 맞춤·인페인트에는 안 실림', () => {
    expect(charRefRule(V5)).toEqual({
      send: true,
      outfit: true,
      fidelity: false,
      strengthMax: 5,
      image: 'bucket'
    })
    expect(charRefRule('nai-diffusion-5-curated')).toEqual(charRefRule(V5))
    expect(charRefRule(V5, true).send).toBe(false)
    // 이미 짝 모델로 바꾼 뒤에 물어도 같다
    expect(charRefRule('nai-diffusion-5-full-inpainting', true).send).toBe(false)
  })

  it('V5 Curated 인페인트는 V4.5 Curated 짝 모델로 가므로 V4.5 규칙을 따른다', () => {
    expect(charRefRule('nai-diffusion-5-curated', true)).toEqual(charRefRule(V45, true))
  })

  it('보낼 유형: V5 는 그대로, V4.5 는 의상을 빼고 같은 옷 유형을 기본 유형으로 내린다', () => {
    const v5 = charRefRule(V5)
    const v45 = charRefRule(V45)
    for (const t of [
      'character',
      'style',
      'character&style',
      'costume',
      'delta',
      'character_mainoutfit',
      'character&style_anyoutfit'
    ]) {
      expect(sentCharRefType(v5, t)).toBe(t)
    }
    expect(sentCharRefType(v45, 'costume')).toBeNull()
    expect(sentCharRefType(v45, 'character_mainoutfit')).toBe('character')
    expect(sentCharRefType(v45, 'character&style_anyoutfit')).toBe('character&style')
    expect(sentCharRefType(v45, 'character')).toBe('character')
    expect(sentCharRefType(v45, 'style')).toBe('style')
    expect(sentCharRefType(v45, 'delta')).toBe('delta')
    // 인페인트라 통째로 빠지는 경우
    expect(sentCharRefType(charRefRule(V5, true), 'character')).toBeNull()
  })

  it('실제로 실리는 수만 센다 (사용료 추정)', () => {
    const refs = [{ refType: 'character' }, { refType: 'costume' }, { refType: 'style' }]
    expect(countSentCharRefs(V5, refs)).toBe(3)
    expect(countSentCharRefs(V45, refs)).toBe(2)
    expect(countSentCharRefs(V5, refs, true)).toBe(0)
    expect(countSentCharRefs(V45, refs, true)).toBe(2)
  })
})

describe('같은 옷 선호', () => {
  it('웹과 같은 값 — 캐릭터는 character_mainoutfit 이 켬, 캐릭터+스타일은 character&style 이 켬', () => {
    expect(prefersSameOutfit('character')).toBe(false)
    expect(prefersSameOutfit('character_mainoutfit')).toBe(true)
    expect(prefersSameOutfit('character&style')).toBe(true)
    expect(prefersSameOutfit('character&style_anyoutfit')).toBe(false)
    expect(prefersSameOutfit('style')).toBeNull()
    expect(prefersSameOutfit('costume')).toBeNull()
    expect(prefersSameOutfit('delta')).toBeNull()
  })

  it('켜고 끄면 같은 묶음 안에서만 바뀐다', () => {
    expect(withSameOutfit('character', true)).toBe('character_mainoutfit')
    expect(withSameOutfit('character_mainoutfit', false)).toBe('character')
    expect(withSameOutfit('character&style', false)).toBe('character&style_anyoutfit')
    expect(withSameOutfit('character&style_anyoutfit', true)).toBe('character&style')
    expect(withSameOutfit('costume', true)).toBe('costume')
    expect(withSameOutfit('style', false)).toBe('style')
  })

  it('유형 고르기 칸에는 묶음의 기본 유형이 보인다', () => {
    expect(charRefFamily('character_mainoutfit')).toBe('character')
    expect(charRefFamily('character&style_anyoutfit')).toBe('character&style')
    expect(charRefFamily('costume')).toBe('costume')
  })
})

describe('전송 payload', () => {
  const refs: BuildOptions['characterReferences'] = [
    { referenceType: 'character_mainoutfit', strength: 2.5, fidelity: 0.4, imageBase64: 'A' },
    { referenceType: 'costume', strength: 1, fidelity: 1, imageBase64: 'B' },
    { referenceType: 'character&style_anyoutfit', strength: 0.6, fidelity: 0.8, imageBase64: 'C' }
  ]

  it('V5 — 유형·강도 그대로, 충실도는 1로 고정(secondary 0)', () => {
    const p = params(V5, { characterReferences: refs })
    expect(captions(p)).toEqual(['character_mainoutfit', 'costume', 'character&style_anyoutfit'])
    expect(p.director_reference_strength_values).toEqual([2.5, 1, 0.6])
    expect(p.director_reference_secondary_strength_values).toEqual([0, 0, 0])
    expect(p.director_reference_information_extracted).toEqual([1, 1, 1])
    expect(p.director_reference_images).toEqual(['A', 'B', 'C'])
  })

  it('V4.5 — 의상은 빠지고 같은 옷 유형은 기본 유형으로, 충실도는 그대로', () => {
    const p = params(V45, { characterReferences: refs })
    expect(captions(p)).toEqual(['character', 'character&style'])
    expect(p.director_reference_strength_values).toEqual([2.5, 0.6])
    const secondary = p.director_reference_secondary_strength_values as number[]
    expect(secondary[0]).toBeCloseTo(0.6, 10)
    expect(secondary[1]).toBeCloseTo(0.2, 10)
    expect(p.director_reference_images).toEqual(['A', 'C'])
  })

  it('V4.5 에 의상 레퍼런스만 있으면 레퍼런스 필드를 아예 싣지 않는다', () => {
    const p = params(V45, {
      characterReferences: [
        { referenceType: 'costume', strength: 1, fidelity: 1, imageBase64: 'B' }
      ]
    })
    expect(p).not.toHaveProperty('director_reference_descriptions')
    expect(p).not.toHaveProperty('director_reference_images')
  })

  it('V5 인페인트에는 싣지 않고, V4.5 인페인트에는 싣는다', () => {
    const v5 = params('nai-diffusion-5-full-inpainting', { characterReferences: refs, i2i: mask })
    expect(v5).not.toHaveProperty('director_reference_descriptions')
    expect(v5).not.toHaveProperty('director_reference_images')
    const v45 = params('nai-diffusion-4-5-full-inpainting', {
      characterReferences: refs,
      i2i: mask
    })
    expect(captions(v45)).toEqual(['character', 'character&style'])
    // V5 Curated 는 인페인트가 V4.5 Curated 짝 모델로 간다
    const curated = params('nai-diffusion-4-5-curated-inpainting', {
      characterReferences: refs,
      i2i: mask
    })
    expect(captions(curated)).toEqual(['character', 'character&style'])
  })

  it('V5 i2i(마스크 없음)에는 싣는다', () => {
    const p = params(V5, {
      characterReferences: refs,
      i2i: { ...mask, maskBase64: undefined }
    })
    expect(captions(p)).toHaveLength(3)
  })
})

describe('V5 레퍼런스 그림 버킷', () => {
  it('크기표가 웹 번들 그대로다 (97개, 64 배수, 양 끝)', () => {
    expect(CHARREF_BUCKETS).toHaveLength(97)
    expect(CHARREF_BUCKETS[0]).toEqual([256, 4096])
    expect(CHARREF_BUCKETS[96]).toEqual([4096, 256])
    expect(CHARREF_BUCKETS[48]).toEqual([1024, 1024])
    for (const [w, h] of CHARREF_BUCKETS) {
      expect(w % 64).toBe(0)
      expect(h % 64).toBe(0)
      expect(w * h).toBeLessThanOrEqual(1048576)
    }
  })

  it('이미 버킷 크기면 손대지 않는다', () => {
    expect(charRefBucket(832, 1216)).toMatchObject({ width: 832, height: 1216, unchanged: true })
    expect(charRefBucket(1024, 1024).unchanged).toBe(true)
  })

  it('비율이 가장 가까운 버킷을 덮도록 줄이고 가운데를 자른다', () => {
    // 16:9 → 1344×768 (1.75). 세로를 768 에 맞추면 가로 1365 → 양옆 10px 씩 잘림
    expect(charRefBucket(1920, 1080)).toEqual({
      width: 1344,
      height: 768,
      resizeWidth: 1365,
      resizeHeight: 768,
      left: 10,
      top: 0,
      unchanged: false
    })
    // 작은 정사각형은 1024×1024 로 키운다
    expect(charRefBucket(500, 500)).toEqual({
      width: 1024,
      height: 1024,
      resizeWidth: 1024,
      resizeHeight: 1024,
      left: 0,
      top: 0,
      unchanged: false
    })
    // 세로로 긴 그림
    const tall = charRefBucket(1000, 3000)
    expect([tall.width, tall.height]).toEqual([576, 1728])
    expect(tall.resizeWidth).toBeGreaterThanOrEqual(tall.width)
    expect(tall.resizeHeight).toBeGreaterThanOrEqual(tall.height)
  })

  it('자를 영역이 늘 줄인 그림 안에 있다', () => {
    for (const [w, h] of [
      [1, 1],
      [7, 4999],
      [4999, 7],
      [1919, 1081],
      [333, 777],
      [2048, 2048],
      [640, 6400]
    ]) {
      const b = charRefBucket(w, h)
      expect(b.left).toBeGreaterThanOrEqual(0)
      expect(b.top).toBeGreaterThanOrEqual(0)
      expect(b.left + b.width).toBeLessThanOrEqual(b.resizeWidth)
      expect(b.top + b.height).toBeLessThanOrEqual(b.resizeHeight)
    }
  })
})

describe('레퍼런스 그림 다듬기 (실제 그림)', () => {
  const solid = (width: number, height: number): Promise<Buffer> =>
    sharp({ create: { width, height, channels: 3, background: { r: 200, g: 60, b: 60 } } })
      .png()
      .toBuffer()

  it('V5(bucket) — 버킷 크기 PNG 로 나가고 여백 없이 그림으로 꽉 찬다', async () => {
    const out = await processCharRefImage(await solid(1920, 1080), 'bucket')
    const meta = await sharp(out).metadata()
    expect([meta.format, meta.width, meta.height]).toEqual(['png', 1344, 768])
    // 가운데를 잘랐으니 네 귀퉁이도 원래 그림 색이다 (검은 여백이 없다)
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true })
    const at = (x: number, y: number): number[] => {
      const i = (y * info.width + x) * info.channels
      return [data[i], data[i + 1], data[i + 2]]
    }
    expect(at(0, 0)).toEqual([200, 60, 60])
    expect(at(info.width - 1, info.height - 1)).toEqual([200, 60, 60])
  })

  it('V5(bucket) — 한쪽으로 치우치지 않고 가운데를 자른다', async () => {
    // 왼쪽 끝이 0, 오른쪽 끝이 255 인 가로 그라디언트. 1920×1080 → 1365×768 로 줄여 양옆 10px 씩 자른다
    const width = 1920
    const height = 1080
    const raw = Buffer.alloc(width * height * 3)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        raw[(y * width + x) * 3] = Math.round((x * 255) / (width - 1))
      }
    }
    const src = await sharp(raw, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer()
    const out = await processCharRefImage(src, 'bucket')
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true })
    const red = (x: number): number => data[(384 * info.width + x) * info.channels]
    const left = red(0)
    const right = red(info.width - 1)
    // 찌그러뜨려 맞췄다면 양 끝이 0 과 255 그대로다. 잘랐으면 양 끝이 같은 만큼 안쪽 값이다
    expect(left).toBeGreaterThanOrEqual(1)
    expect(left).toBeLessThanOrEqual(4)
    expect(right).toBeGreaterThanOrEqual(251)
    expect(right).toBeLessThanOrEqual(254)
    expect(Math.abs(left - (255 - right))).toBeLessThanOrEqual(1)
  })

  it('V5(bucket) — 이미 버킷 크기면 크기를 바꾸지 않는다', async () => {
    const out = await processCharRefImage(await solid(832, 1216), 'bucket')
    const meta = await sharp(out).metadata()
    expect([meta.width, meta.height]).toEqual([832, 1216])
  })

  it('V4.5(canvas) — 예전처럼 정해진 캔버스에 검은 여백으로 맞춘다', async () => {
    const out = await processCharRefImage(await solid(1920, 1080), 'canvas')
    const meta = await sharp(out).metadata()
    expect([meta.width, meta.height]).toEqual([1536, 1024])
    const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true })
    expect([data[0], data[1], data[2]]).toEqual([0, 0, 0])
  })
})
