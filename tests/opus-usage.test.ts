import { describe, expect, it } from 'vitest'
import {
  formatUsagePercent,
  parseOpusUsage,
  quotaState,
  refillEta,
  refillPercentPerDay,
  usageBar,
  usageImages,
  usageIsLow,
  usagePercent,
  usagePurchasedPercent,
  usageRefilling,
  usageRefillLine,
  usageSummary,
  usageTotalImages,
  type OpusUsage
} from '../src/shared/opus-usage'

/**
 * 계산식은 NAI 웹 번들 실측 그대로 (2026-08-21).
 * 검산 기준: 사용자 화면 캡처 "73% remaining (~1263 images)",
 * "Currently refills at 11% per day (~190 images)".
 */

const usage = (
  percent: number,
  timeUntilNextPercent = 7854,
  isNegative = false,
  purchasedPercent = 0
): OpusUsage => ({ percent, purchasedPercent, isNegative, timeUntilNextPercent })

describe('Opus 생성 한도', () => {
  it('웹 화면의 숫자와 일치한다 (73% → 약 1263장, 11%/일 → 약 190장)', () => {
    expect(usageImages(73)).toBe(1263)
    expect(usageImages(11)).toBe(190)
  })

  it('일반분은 음수면 0, 초과 사용 중이면 0 — 웹과 같이 100 에서 자르지 않는다', () => {
    expect(usagePercent(usage(73))).toBe(73)
    expect(usagePercent(usage(120))).toBe(120)
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
      purchasedPercent: 0,
      isNegative: false,
      timeUntilNextPercent: 7854
    })
    expect(parseOpusUsage({ percent: 12 })).toEqual({
      percent: 12,
      purchasedPercent: 0,
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

/**
 * 충전 아이템(Opus Usage Boost) 추가분 — 웹 번들 실측 (2026-10-29). 서버는 usage.purchasedPercent 로
 * 추가분을 따로 보내고, 웹은 일반분 V·추가분 G 로 경고·장수·막대를 그린다.
 */
describe('충전 아이템 추가분 — 응답 파싱', () => {
  it('키가 있으면 그대로 받는다', () => {
    const raw = { percent: 0, purchasedPercent: 100, isNegative: false, timeUntilNextPercent: 60 }
    expect(parseOpusUsage(raw)).toEqual(raw)
  })

  it('키가 없으면 0 — 예전 응답과 같게 읽힌다', () => {
    expect(parseOpusUsage({ percent: 73, isNegative: false, timeUntilNextPercent: 7854 })).toEqual({
      percent: 73,
      purchasedPercent: 0,
      isNegative: false,
      timeUntilNextPercent: 7854
    })
  })

  it('숫자가 아니거나 유한하지 않으면 0, 음수도 0', () => {
    for (const bad of ['100', null, true, NaN, Infinity, { n: 1 }, -40]) {
      const parsed = parseOpusUsage({ percent: 10, purchasedPercent: bad })
      expect(parsed?.purchasedPercent, String(bad)).toBe(0)
    }
    // percent 가 없으면 추가분이 있어도 게이지를 그리지 않는다 (예전 규칙 그대로)
    expect(parseOpusUsage({ purchasedPercent: 100 })).toBeNull()
  })

  it('추가분을 읽는 함수도 없거나 음수면 0 (키가 빠진 객체를 받아도)', () => {
    expect(usagePurchasedPercent(usage(10, 60, false, 250))).toBe(250)
    expect(usagePurchasedPercent(usage(10, 60, false, -5))).toBe(0)
    const old = { percent: 10, isNegative: false, timeUntilNextPercent: 60 } as OpusUsage
    expect(usagePurchasedPercent(old)).toBe(0)
  })
})

describe('충전 아이템 추가분 — 한도 판정', () => {
  it('일반분 0% + 추가분 100% + 초과 사용 아님 = 남음', () => {
    expect(quotaState(usage(0, 7854, false, 100))).toBe('available')
  })

  it('초과 사용 중이면 추가분 값과 무관하게 소진', () => {
    expect(quotaState(usage(0, 7854, true, 0))).toBe('exhausted')
    expect(quotaState(usage(0, 7854, true, 100))).toBe('exhausted')
  })

  it('추가분이 없으면 예전과 똑같다 — 0% 구간은 모름', () => {
    expect(quotaState(usage(0))).toBe('unknown')
    expect(quotaState(usage(40))).toBe('available')
    // 서버가 키를 안 보낸 응답을 파싱한 결과도 같다
    expect(quotaState(parseOpusUsage({ percent: 0, isNegative: false }))).toBe('unknown')
    expect(quotaState(parseOpusUsage({ percent: 0, isNegative: true }))).toBe('exhausted')
  })
})

describe('충전 아이템 추가분 — 웹 계산식', () => {
  it('경고 = (초과 사용 || 일반분 5% 미만) && 추가분 5% 미만', () => {
    expect(usageIsLow(usage(3))).toBe(true)
    expect(usageIsLow(usage(3, 7854, false, 4))).toBe(true)
    expect(usageIsLow(usage(3, 7854, false, 5))).toBe(false)
    expect(usageIsLow(usage(0, 7854, true, 100))).toBe(false)
    expect(usageIsLow(usage(50, 7854, false, 0))).toBe(false)
  })

  it('장수 = round(17.3 × (일반분 + 추가분))', () => {
    expect(usageTotalImages(usage(73))).toBe(1263)
    expect(usageTotalImages(usage(73, 7854, false, 100))).toBe(Math.round(17.3 * 173))
    // 초과 사용 중이면 일반분은 0 으로 센다
    expect(usageTotalImages(usage(20, 7854, true, 100))).toBe(1730)
  })

  it('100 을 넘는 일반분은 자르지 않는다', () => {
    expect(usagePercent(usage(130))).toBe(130)
    expect(usageTotalImages(usage(130))).toBe(Math.round(17.3 * 130))
  })

  it('막대 — 전체 눈금 max(100, V+G), 채움 (V+G)/눈금, 채움 안 일반분 V/(V+G), 100%마다 홈', () => {
    expect(usageBar(usage(73))).toEqual({ fill: 0.73, base: 1, notches: [] })
    expect(usageBar(usage(0))).toEqual({ fill: 0, base: 0, notches: [] })
    expect(usageBar(usage(50, 7854, false, 100))).toEqual({
      fill: 1,
      base: 50 / 150,
      notches: [100 / 150]
    })
    expect(usageBar(usage(100, 7854, false, 400))).toEqual({
      fill: 1,
      base: 0.2,
      notches: [0.2, 0.4, 0.6, 0.8]
    })
    // 딱 100 이면 홈이 없다 (ceil(100/100)-1 = 0)
    expect(usageBar(usage(100)).notches).toEqual([])
    // 초과 사용 중이면 일반분 칸은 비고 추가분만
    expect(usageBar(usage(30, 7854, true, 50))).toEqual({ fill: 0.5, base: 0, notches: [] })
  })

  it('회복은 일반분이 100% 미만일 때만 — 넘으면 회복 멈춤', () => {
    expect(usageRefilling(usage(99.9))).toBe(true)
    expect(usageRefilling(usage(100))).toBe(false)
    expect(usageRefilling(usage(0, 7854, true))).toBe(true)
    expect(usageRefillLine(usage(120))).toBe('100% 이상이라 회복 멈춤')
    expect(usageRefillLine(usage(73, 7854))).toBe(
      '하루 11%씩 회복 (약 190장) · 다음 1%까지 2시간 11분'
    )
  })

  it('문구 — 추가분이 있을 때만 그 칸을 넣는다', () => {
    expect(usageSummary(usage(73))).toBe('73% 남음 · 약 1,263장')
    expect(usageSummary(usage(0, 7854, false, 100))).toBe('0.0% 남음 · +100% 추가분 · 약 1,730장')
    expect(formatUsagePercent(4.25)).toBe('4.3')
    expect(formatUsagePercent(130)).toBe('130')
  })
})
