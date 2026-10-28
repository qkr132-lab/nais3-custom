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
 *
 * 충전 아이템(Opus Usage Boost, 2026-10-29 웹 번들 실측): 쓰면 일반 한도와 따로 「추가분」이
 * 쌓인다(최대 400%). 일반분을 먼저 쓰고 다 쓴 뒤 추가분을 쓰며, 추가분도 무료 생성이다.
 */

export interface OpusUsage {
  /** 일반 한도의 남은 비율 (보통 0~100 — 웹은 100 을 넘어도 자르지 않는다) */
  percent: number
  /** 충전 아이템으로 더한 추가분(%). 서버가 안 보내면 0 */
  purchasedPercent: number
  /** 한도를 넘겨 쓴 상태 (Anlas 차감 중) — 일반분·추가분을 다 쓴 뒤에야 켜진다 */
  isNegative: boolean
  /** 1% 회복까지 남은 초 */
  timeUntilNextPercent: number
}

/** 1%당 대략 몇 장인지 — 웹 하드코딩 계수 */
const IMAGES_PER_PERCENT = 17.3

/** 추가분 상한(%) — 웹 MaxPurchasedPercent */
export const MAX_PURCHASED_PERCENT = 400

/** 게이지에 그릴 일반분(%). 초과 사용 중이면 0. 웹과 같이 100 에서 자르지 않는다 */
export function usagePercent(usage: OpusUsage): number {
  return usage.isNegative ? 0 : Math.max(0, usage.percent)
}

/** 충전 아이템으로 더한 추가분(%) — 없거나 음수면 0 */
export function usagePurchasedPercent(usage: OpusUsage): number {
  return Math.max(0, usage.purchasedPercent ?? 0)
}

/** 경고 표시 여부 — 일반분이 바닥(초과 사용 중이거나 5% 미만)이고 추가분도 5% 미만 */
export function usageIsLow(usage: OpusUsage): boolean {
  return (usage.isNegative || usage.percent < 5) && usagePurchasedPercent(usage) < 5
}

/** 일반분+추가분으로 대략 몇 장 남았는지 */
export function usageTotalImages(usage: OpusUsage): number {
  return usageImages(usagePercent(usage) + usagePurchasedPercent(usage))
}

/** 회복 중인가 — 일반분이 100% 이상이면 회복이 멈춘다 (웹과 같다) */
export function usageRefilling(usage: OpusUsage): boolean {
  return usagePercent(usage) < 100
}

/** 게이지 막대 비율 — 웹과 같은 식 */
export interface UsageBar {
  /** 막대 전체 중 채운 비율 (0~1). 전체 눈금은 max(100, 일반분+추가분) */
  fill: number
  /** 채운 부분 중 일반분 비율 (0~1) — 나머지가 추가분 */
  base: number
  /** 100%마다 파는 홈의 위치 (막대 전체 기준 0~1) */
  notches: number[]
}

export function usageBar(usage: OpusUsage): UsageBar {
  const base = usagePercent(usage)
  const total = base + usagePurchasedPercent(usage)
  const scale = Math.max(100, total)
  return {
    fill: total / scale,
    base: total > 0 ? base / total : 0,
    notches: Array.from(
      { length: Math.max(0, Math.ceil(total / 100) - 1) },
      (_, i) => ((i + 1) * 100) / scale
    )
  }
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

/**
 * 지금 무료 생성분이 남아 있는가.
 *
 * 세 갈래다: 남음 / 소진 / 불확실. 게이지가 0%로 보여도 서버는 소수점 이하를
 * 들고 있을 수 있어(하루 11% 회복 = 1%당 두 시간 남짓, 그 사이 값이 조금씩 찬다)
 * 0%면서 초과 사용도 아닌 구간은 "장담 못 함"으로 둔다.
 * 충전 아이템 추가분이 있으면 일반분이 0%여도 남음이다 (추가분도 무료로 쓰인다).
 */
export function quotaState(usage: OpusUsage | null): 'available' | 'exhausted' | 'unknown' {
  if (!usage) return 'unknown'
  if (usage.isNegative) return 'exhausted'
  if (usage.percent > 0 || usagePurchasedPercent(usage) > 0) return 'available'
  return 'unknown'
}

/** 다음 1% 회복까지 남은 시간 (사람이 읽는 형태). 회복이 멈춰 있으면 null */
export function refillEta(usage: OpusUsage): string | null {
  const sec = usage.timeUntilNextPercent
  if (!Number.isFinite(sec) || sec <= 0) return null
  if (sec < 60) return `${Math.round(sec)}초`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}분`
  const hour = Math.floor(min / 60)
  const rest = min % 60
  return rest ? `${hour}시간 ${rest}분` : `${hour}시간`
}

/** 게이지 옆 비율 — 10% 미만은 소수 첫째 자리까지 */
export function formatUsagePercent(percent: number): string {
  return percent < 10 ? percent.toFixed(1) : String(Math.round(percent))
}

/** 「73% 남음 · +100% 추가분 · 약 2993장」 — 추가분이 없으면 그 칸은 뺀다 (웹과 같다) */
export function usageSummary(usage: OpusUsage): string {
  const extra = usagePurchasedPercent(usage)
  return [
    `${formatUsagePercent(usagePercent(usage))}% 남음`,
    extra > 0 ? `+${formatUsagePercent(extra)}% 추가분` : '',
    `약 ${usageTotalImages(usage).toLocaleString()}장`
  ]
    .filter(Boolean)
    .join(' · ')
}

/** 회복 안내 한 줄 — 일반분이 100% 이상이면 회복이 멈춘다 */
export function usageRefillLine(usage: OpusUsage): string {
  if (!usageRefilling(usage)) return '100% 이상이라 회복 멈춤'
  const perDay = refillPercentPerDay(usage)
  const eta = refillEta(usage)
  return [
    perDay > 0 ? `하루 ${perDay}%씩 회복 (약 ${usageImages(perDay).toLocaleString()}장)` : '',
    eta ? `다음 1%까지 ${eta}` : ''
  ]
    .filter(Boolean)
    .join(' · ')
}

/** 응답의 usage 필드를 신뢰할 수 있을 때만 통과시킨다 */
export function parseOpusUsage(value: unknown): OpusUsage | null {
  if (!value || typeof value !== 'object') return null
  const u = value as Record<string, unknown>
  if (typeof u.percent !== 'number' || !Number.isFinite(u.percent)) return null
  return {
    percent: u.percent,
    purchasedPercent:
      typeof u.purchasedPercent === 'number' && Number.isFinite(u.purchasedPercent)
        ? Math.max(0, u.purchasedPercent)
        : 0,
    isNegative: u.isNegative === true,
    timeUntilNextPercent:
      typeof u.timeUntilNextPercent === 'number' && Number.isFinite(u.timeUntilNextPercent)
        ? u.timeUntilNextPercent
        : 0
  }
}
