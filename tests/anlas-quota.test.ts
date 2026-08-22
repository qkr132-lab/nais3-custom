import { describe, expect, it } from 'vitest'
import { estimateAnlas } from '../src/shared/anlas'

/**
 * V5부터 Opus 무료 생성분이 한도제로 바뀌었다.
 * 해상도·스텝 조건을 만족해도 한도가 없으면 Anlas가 나가고, V4.5 이하는 종전대로 무제한.
 */

const base = {
  width: 832,
  height: 1216,
  steps: 28,
  isOpus: true,
  batchCount: 1
}

describe('Opus 한도를 반영한 Anlas 추정', () => {
  it('V4.5는 한도와 무관하게 무료 (조건만 맞으면)', () => {
    for (const quota of ['available', 'exhausted', 'unknown'] as const) {
      const e = estimateAnlas({ ...base, model: 'nai-diffusion-4-5-full', quota })
      expect(e.total, quota).toBe(0)
      expect(e.uncertain, quota).toBe(false)
    }
  })

  it('V5는 한도가 남아 있으면 무료', () => {
    const e = estimateAnlas({ ...base, model: 'nai-diffusion-5-full', quota: 'available' })
    expect(e.total).toBe(0)
    expect(e.uncertain).toBe(false)
  })

  it('V5는 한도를 넘겨 쓰는 중이면 Anlas가 나간다', () => {
    const e = estimateAnlas({ ...base, model: 'nai-diffusion-5-full', quota: 'exhausted' })
    expect(e.total).toBeGreaterThan(0)
    expect(e.total).toBe(e.perImage)
    expect(e.uncertain).toBe(false)
  })

  it('V5인데 게이지가 0%로만 보이면 무료로 잡되 불확실 표시', () => {
    const e = estimateAnlas({ ...base, model: 'nai-diffusion-5-full', quota: 'unknown' })
    expect(e.total).toBe(0)
    expect(e.uncertain).toBe(true)
  })

  it('해상도·스텝이 무료 조건을 넘으면 한도와 무관하게 유료', () => {
    const big = { ...base, width: 1024, height: 1536, model: 'nai-diffusion-5-full' as const }
    expect(estimateAnlas({ ...big, quota: 'available' }).total).toBeGreaterThan(0)
    expect(estimateAnlas({ ...big, quota: 'available' }).uncertain).toBe(false)
    expect(estimateAnlas({ ...base, steps: 40, quota: 'available' }).total).toBeGreaterThan(0)
  })

  it('Opus가 아니면 언제나 유료', () => {
    const e = estimateAnlas({ ...base, isOpus: false, model: 'nai-diffusion-5-full', quota: 'available' })
    expect(e.total).toBeGreaterThan(0)
    expect(e.uncertain).toBe(false)
  })
})
