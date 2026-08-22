import { describe, expect, it } from 'vitest'
import {
  parseOpusUsage,
  quotaState,
  refillEta,
  refillPercentPerDay,
  usageImages,
  usageIsLow,
  usagePercent
} from '../src/shared/opus-usage'

/**
 * 계산식은 NAI 웹 번들 실측 그대로 (2026-08-21).
 * 검산 기준: 사용자 화면 캡처 "73% remaining (~1263 images)",
 * "Currently refills at 11% per day (~190 images)".
 */

const usage = (
  percent: number,
  timeUntilNextPercent = 7854,
  isNegative = false
): {
  percent: number
  isNegative: boolean
  timeUntilNextPercent: number
} => ({ percent, isNegative, timeUntilNextPercent })

describe('Opus 생성 한도', () => {
  it('웹 화면의 숫자와 일치한다 (73% → 약 1263장, 11%/일 → 약 190장)', () => {
    expect(usageImages(73)).toBe(1263)
    expect(usageImages(11)).toBe(190)
  })

  it('비율은 0~100으로 자르고, 초과 사용 중이면 0', () => {
    expect(usagePercent(usage(73))).toBe(73)
    expect(usagePercent(usage(120))).toBe(100)
    expect(usagePercent(usage(-5))).toBe(0)
    expect(usagePercent(usage(50, 7854, true))).toBe(0)
  })

  it('5% 미만이거나 초과 사용 중이면 경고', () => {
    expect(usageIsLow(usage(73))).toBe(false)
    expect(usageIsLow(usage(4.9))).toBe(true)
    expect(usageIsLow(usage(80, 7854, true))).toBe(true)
  })

  it('회복 속도는 하루 기준 비율 (1% 회복까지 남은 초에서 역산)', () => {
    // 하루 11% = 1%당 86400/11 ≈ 7854초
    expect(refillPercentPerDay(usage(73, 7854))).toBe(11)
    expect(refillPercentPerDay(usage(73, 0))).toBe(0)
    expect(refillPercentPerDay(usage(73, -1))).toBe(0)
  })

  it('응답 파싱 — percent가 없으면 게이지를 그리지 않는다', () => {
    expect(parseOpusUsage({ percent: 73, isNegative: false, timeUntilNextPercent: 7854 })).toEqual({
      percent: 73,
      isNegative: false,
      timeUntilNextPercent: 7854
    })
    expect(parseOpusUsage({ percent: 12 })).toEqual({
      percent: 12,
      isNegative: false,
      timeUntilNextPercent: 0
    })
    expect(parseOpusUsage(undefined)).toBeNull()
    expect(parseOpusUsage(null)).toBeNull()
    expect(parseOpusUsage({})).toBeNull()
    expect(parseOpusUsage({ percent: 'many' })).toBeNull()
  })
})

describe('한도 상태 판정', () => {
  it('남음 / 소진 / 불확실 세 갈래', () => {
    expect(quotaState({ percent: 73, isNegative: false, timeUntilNextPercent: 7854 })).toBe(
      'available'
    )
    expect(quotaState({ percent: 0.4, isNegative: false, timeUntilNextPercent: 7854 })).toBe(
      'available'
    )
    expect(quotaState({ percent: 12, isNegative: true, timeUntilNextPercent: 0 })).toBe('exhausted')
    // 0%인데 초과 사용도 아니면 서버가 소수점 이하를 들고 있을 수 있다 — 단정하지 않는다
    expect(quotaState({ percent: 0, isNegative: false, timeUntilNextPercent: 7854 })).toBe('unknown')
    expect(quotaState(null)).toBe('unknown')
  })

  it('회복 시간을 사람이 읽는 형태로', () => {
    expect(refillEta({ percent: 0, isNegative: false, timeUntilNextPercent: 30 })).toBe('30초')
    expect(refillEta({ percent: 0, isNegative: false, timeUntilNextPercent: 720 })).toBe('12분')
    expect(refillEta({ percent: 0, isNegative: false, timeUntilNextPercent: 7854 })).toBe(
      '2시간 11분'
    )
    expect(refillEta({ percent: 0, isNegative: false, timeUntilNextPercent: 0 })).toBeNull()
  })
})
