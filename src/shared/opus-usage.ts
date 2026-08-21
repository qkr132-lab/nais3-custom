/**
 * Opus 무료 생성 한도 (V5부터 신설).
 *
 * Opus 구독은 통상 해상도·28스텝 이하 V5 생성을 Anlas 없이 쓸 수 있는데,
 * 그 허용량이 한도제이고 시간이 지나면 자동으로 회복된다. 소진하면 Anlas가 나간다.
 *
 * 확정 소스: NAI 웹 번들 실측 (2026-08-21). 값은 `/user/subscription` 응답의
 * `usage` 객체로 내려오고(별도 `/ai/trial-status`는 체험 계정용), 웹은 아래 식을
 * 그대로 쓴다. 사용자 스샷("73% remaining (~1263 images)", "11% per day (~190 images)")과
 * 검산 일치.
 */

export interface OpusUsage {
  /** 남은 비율 0~100 */
  percent: number
  /** 한도를 넘겨 쓴 상태 (Anlas 차감 중) */
  isNegative: boolean
  /** 1% 회복까지 남은 초 */
  timeUntilNextPercent: number
}

/** 1%당 대략 몇 장인지 — 웹 하드코딩 계수 */
const IMAGES_PER_PERCENT = 17.3

/** 게이지에 그릴 비율 (0~100). 초과 사용 중이면 0 */
export function usagePercent(usage: OpusUsage): number {
  return usage.isNegative ? 0 : Math.min(100, Math.max(0, usage.percent))
}

/** 경고 표시 여부 — 초과 사용 중이거나 5% 미만 */
export function usageIsLow(usage: OpusUsage): boolean {
  return usage.isNegative || usage.percent < 5
}

/** 하루당 회복 비율(%). 소수 첫째 자리까지 */
export function refillPercentPerDay(usage: OpusUsage): number {
  if (usage.timeUntilNextPercent <= 0) return 0
  return Math.round((86400 / usage.timeUntilNextPercent) * 10) / 10
}

/** 비율 → 대략적인 장수 */
export function usageImages(percent: number): number {
  return Math.round(IMAGES_PER_PERCENT * percent)
}

/** 응답의 usage 필드를 신뢰할 수 있을 때만 통과시킨다 */
export function parseOpusUsage(value: unknown): OpusUsage | null {
  if (!value || typeof value !== 'object') return null
  const u = value as Record<string, unknown>
  if (typeof u.percent !== 'number' || !Number.isFinite(u.percent)) return null
  return {
    percent: u.percent,
    isNegative: u.isNegative === true,
    timeUntilNextPercent:
      typeof u.timeUntilNextPercent === 'number' && Number.isFinite(u.timeUntilNextPercent)
        ? u.timeUntilNextPercent
        : 0
  }
}
