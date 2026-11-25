/** 화면 문구·검증 — DOM 없이 쓰는 순수 함수 */
import {
  CLOUD_FREE_MAX_PIXELS,
  CLOUD_JOB_MAX_COUNT,
  type CloudAccountInfo,
  type CloudJob,
  type CloudJobPlace,
  type CloudNaiInfo,
  type CloudPhoneState,
  type CloudQueueSummary,
  type CloudQuota
} from '@shared/cloud-contract'
import {
  type OpusUsage,
  refillEta,
  usageBar,
  usageImages,
  usageIsLow,
  usagePercent,
  usagePurchasedPercent,
  usageRefilling
} from '@shared/opus-usage'
import { relativeTime } from './time'

// ── 연결 코드 ───────────────────────────────────────────────────────

export const PAIR_CODE_LENGTH = 8

/**
 * 입력·붙여넣기를 연결 코드 모양으로 정리한다.
 * 연결 주소(`…/#pair=코드`)를 통째로 붙여 넣어도 코드만 꺼낸다.
 * 글자 종류는 서버가 판단하므로 영문 대문자·숫자만 남긴다.
 */
export function normalizePairCode(raw: string): string {
  const at = raw.lastIndexOf('pair=')
  const body = at >= 0 ? raw.slice(at + 5) : raw
  return body
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, PAIR_CODE_LENGTH)
}

/** 한글 자모·음절이 들어 있는가 — 한글 자판으로 연결 코드를 치면 글자가 말없이 지워지므로 알리는 데 쓴다 */
export function containsHangul(raw: string): boolean {
  return /[ᄀ-ᇿ㄰-㆏가-힯]/.test(raw)
}

/** 주소 해시(`#pair=코드`)에서 코드를 꺼낸다. 없으면 빈 문자열 */
export function pairCodeFromHash(hash: string): string {
  const m = /[#&]pair=([^&]*)/.exec(hash)
  return m ? normalizePairCode(decodeURIComponentSafe(m[1])) : ''
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

// ── 생성 위치 안내 ──────────────────────────────────────────────────

export interface GenerationRoute {
  kind: 'pc' | 'cloud' | 'blocked'
  /** 상태줄·생성 막대에 보이는 문장 */
  text: string
  /** 생성 시작 버튼을 막아야 하는가 */
  blocked: boolean
}

/** 클라우드 생성을 못 하는 이유 (서버가 준 이유가 없으면 상태로 추정) */
export function cloudNotReadyReason(phone: CloudPhoneState): string {
  const { reason, enabled, hasNaiToken, quota } = phone.cloudGen
  if (reason) return reason
  if (!enabled) return '클라우드 생성이 꺼져 있음'
  if (!hasNaiToken) return 'NAI 토큰이 없음'
  if (quota?.state === 'exhausted') return '이번 달 무료 사용량을 모두 썼습니다'
  return '이유를 알 수 없음'
}

/** 생성하면 어디서 만들어지는가. place 는 사용자가 고른 위치(기본 자동), now 는 서버 시각 보정을 거친 값 */
export function generationRoute(
  phone: CloudPhoneState | null,
  place: CloudJobPlace = 'auto',
  now: number = Date.now()
): GenerationRoute {
  if (!phone) return { kind: 'blocked', text: '상태를 불러오는 중', blocked: true }
  const pcOnline = phone.pc.online
  if (place === 'pc') {
    return pcOnline
      ? { kind: 'pc', text: 'PC가 생성', blocked: false }
      : { kind: 'pc', text: 'PC가 꺼져 있음 · 켜지면 생성', blocked: false }
  }
  if (place === 'auto' && pcOnline) return { kind: 'pc', text: 'PC가 생성', blocked: false }
  // 서버가 「가능」이라도 방금 소진으로 확인된 상태면 막는다 (서버가 곧 같은 이유로 작업을 실패시킨다)
  if (phone.cloudGen.ready && !isQuotaBlocking(phone.cloudGen.quota, now)) {
    return { kind: 'cloud', text: '클라우드가 생성 (무료 범위)', blocked: false }
  }
  return {
    kind: 'blocked',
    text: `지금은 생성 불가: ${cloudNotReadyReason(phone)}`,
    blocked: true
  }
}

export interface JobToast {
  text: string
  /** 비우면 기본 시간 */
  durationMs?: number
}

/** 서버가 준 안내(notice)는 문장이 길어 조금 더 오래 보인다 */
export const NOTICE_TOAST_MS = 6500

/**
 * 작업을 만든 직후 띄울 안내들.
 * 서버가 notice(PC가 꺼져 있음, 캐릭터 편집은 PC가 켜져 반영된 뒤부터 쓰임 등)를 주면 그 문장을 그대로 따로 보인다.
 * PC가 꺼져서 기다리는 작업은 notice 가 같은 사실을 말하므로 기본 안내를 생략한다
 */
export function createJobToasts(input: {
  count: number
  job: Pick<CloudJob, 'state'>
  notice?: string
  pcOnline: boolean
}): JobToast[] {
  const notice = input.notice?.trim()
  const waiting = input.job.state === 'queued' && !input.pcOnline
  const out: JobToast[] = []
  if (!(waiting && notice)) {
    out.push({
      text: waiting
        ? 'PC가 꺼져 있어 켜질 때까지 기다립니다'
        : `${input.count}장 생성을 시작했습니다`
    })
  }
  if (notice) out.push({ text: notice, durationMs: NOTICE_TOAST_MS })
  return out
}

/** PC 큐 진행 문구. 할 일이 없으면 null */
export function queueText(q: CloudQueueSummary | null | undefined): string | null {
  if (!q || (q.generating <= 0 && q.pending <= 0)) return null
  return `생성 중 ${q.generating} · 대기 ${q.pending}`
}

// ── 작업 ────────────────────────────────────────────────────────────

export function isJobActive(job: CloudJob): boolean {
  return job.state === 'queued' || job.state === 'pc' || job.state === 'cloud'
}

export function jobStateLabel(job: CloudJob): string {
  switch (job.state) {
    case 'queued':
      return '대기 중'
    case 'pc':
      return 'PC에서 생성 중'
    case 'cloud':
      return '클라우드에서 생성 중'
    case 'done':
      return job.failed > 0 ? '일부 실패' : '완료'
    case 'failed':
      return '실패'
    case 'cancelled':
      return '취소됨'
  }
}

/** 상태 라벨 옆에 붙이는 보충 설명 */
export function jobNote(job: CloudJob, pcOnline: boolean): string | null {
  if (job.state === 'queued' && !pcOnline) return 'PC가 꺼져 있어 켜지면 시작합니다'
  return null
}

export function runnerLabel(job: CloudJob): string | null {
  if (job.runner === 'pc') return 'PC가 생성'
  if (job.runner === 'cloud') return '클라우드가 생성'
  return null
}

/** 성공한 장수 비율(0~1) */
export function jobDoneRatio(job: CloudJob): number {
  if (job.count <= 0) return 0
  return Math.min(1, Math.max(0, job.done / job.count))
}

/** 실패한 장수 비율(0~1) */
export function jobFailedRatio(job: CloudJob): number {
  if (job.count <= 0) return 0
  return Math.min(1 - jobDoneRatio(job), Math.max(0, job.failed / job.count))
}

// ── 그림 삭제 ───────────────────────────────────────────────────────

/**
 * 삭제 확인 본문. PC가 아직 가져가지 않은 클라우드 생성분(pcPending)은 이 사본이 유일해서
 * 지우면 되돌릴 수 없으므로 다른 문구를 쓴다
 */
export function deleteConfirmBody(pcPending: boolean): string {
  return pcPending
    ? 'PC로 아직 옮기지 않은 그림입니다. 지우면 다시 받을 수 없습니다.'
    : '클라우드 사본만 지웁니다. PC에 있는 원본은 그대로 남습니다.'
}

// ── 장수·크기·이름 ──────────────────────────────────────────────────

export function clampCount(n: number): number {
  if (!Number.isFinite(n)) return 1
  return Math.min(CLOUD_JOB_MAX_COUNT, Math.max(1, Math.round(n)))
}

export const SIZE_MIN = 64
export const SIZE_MAX = 2048
export const SIZE_STEP = 64

export const RESOLUTION_PRESETS: readonly { label: string; width: number; height: number }[] = [
  { label: '세로', width: 832, height: 1216 },
  { label: '가로', width: 1216, height: 832 },
  { label: '정사각', width: 1024, height: 1024 }
]

/** 서버 규칙(64배수·64~2048)에 맞는지. 맞으면 null, 아니면 오류 문장 */
export function validateSize(width: number, height: number): string | null {
  for (const [label, v] of [
    ['가로', width],
    ['세로', height]
  ] as const) {
    if (!Number.isInteger(v)) return `${label} 크기는 정수여야 합니다`
    if (v < SIZE_MIN || v > SIZE_MAX)
      return `${label} 크기는 ${SIZE_MIN}~${SIZE_MAX} 사이여야 합니다`
    if (v % SIZE_STEP !== 0) return `${label} 크기는 ${SIZE_STEP}의 배수여야 합니다`
  }
  return null
}

/** 클라우드 무료 생성 범위(1024×1024 픽셀 수)를 넘는가 */
export function exceedsFreePixels(width: number, height: number): boolean {
  return width * height > CLOUD_FREE_MAX_PIXELS
}

export function formatSize(width: number, height: number): string {
  return `${width}×${height}`
}

/** 씬 이름 규칙(1~100자, 앞뒤 공백 제외). 맞으면 null */
export function validateSceneName(name: string): string | null {
  const len = name.trim().length
  if (len < 1) return '이름을 입력하세요'
  if (len > 100) return '이름은 100자까지입니다'
  return null
}

// ── 무료 사용량: 클라우드가 확인한 상태 ──────────────────────────────

/** 워커가 확인 결과를 「지금 불가」로 쓰는 유효 시간 — cloud/src/core/routes-phone.ts 의 QUOTA_FRESH_MS 와 같은 값 */
export const QUOTA_FRESH_MS = 30 * 60 * 1000

const QUOTA_STATE_LABEL: Record<CloudQuota['state'], string> = {
  available: '남음',
  exhausted: '소진',
  unknown: '확인 안 됨'
}

export interface CloudQuotaView {
  state: CloudQuota['state']
  /** 「남음」「소진」「확인 안 됨」 */
  label: string
  /** 「3분 전 확인」. 확인한 적이 없으면 null */
  checked: string | null
  /** 「무료 사용량: 남음 · 3분 전 확인」 — 한 줄로 보일 때 */
  text: string
}

/** 클라우드가 마지막으로 확인한 무료 사용량 상태 표시. 확인한 적이 없으면(null) 「확인 안 됨」 */
export function cloudQuotaView(
  quota: CloudQuota | null | undefined,
  now: number = Date.now()
): CloudQuotaView {
  // 서버가 모르는 값을 주면 「확인 안 됨」으로 본다
  const state = quota && quota.state in QUOTA_STATE_LABEL ? quota.state : 'unknown'
  const label = QUOTA_STATE_LABEL[state]
  const checked =
    quota && Number.isFinite(quota.checkedAt) && quota.checkedAt > 0
      ? `${relativeTime(quota.checkedAt, now)} 확인`
      : null
  return { state, label, checked, text: `무료 사용량: ${label}${checked ? ` · ${checked}` : ''}` }
}

/** 방금(30분 안) 소진으로 확인됐는가 — 서버가 클라우드 생성을 막는 기준과 같다 */
export function isQuotaBlocking(
  quota: CloudQuota | null | undefined,
  now: number = Date.now()
): boolean {
  return quota?.state === 'exhausted' && now - quota.checkedAt < QUOTA_FRESH_MS
}

/**
 * 상태줄·생성 막대에 무료 사용량을 보일 상황인가 — 클라우드가 생성하거나(하려다 막힌) 때만.
 * PC 가 생성하거나 클라우드 생성이 꺼져 있으면 보이지 않는다
 */
export function showsCloudQuota(phone: CloudPhoneState | null, route: GenerationRoute): boolean {
  if (!phone) return false
  if (route.kind === 'cloud') return true
  return route.kind === 'blocked' && phone.cloudGen.enabled && phone.cloudGen.hasNaiToken
}

export interface QuotaNotice {
  text: string
  /** true 면 생성 버튼이 막혀 있는 상태 (빨강), false 면 주의만 (주황) */
  blocking: boolean
}

/**
 * 클라우드가 만들 상황에서 무료 사용량이 소진으로 확인됐을 때 생성 버튼 가까이에 띄울 안내.
 * 해당 없으면 null
 */
export function quotaExhaustedNotice(
  phone: CloudPhoneState | null,
  route: GenerationRoute,
  now: number = Date.now()
): QuotaNotice | null {
  if (!phone || !showsCloudQuota(phone, route)) return null
  const quota = phone.cloudGen.quota
  if (quota?.state !== 'exhausted') return null
  const when = cloudQuotaView(quota, now).checked
  const tail = when ? ` (${when})` : ''
  if (isQuotaBlocking(quota, now)) {
    return {
      blocking: true,
      text: `클라우드 생성 불가: 무료 사용량 소진${tail}. PC로 생성하려면 고급에서 생성 위치를 PC로 바꾸세요.`
    }
  }
  return {
    blocking: false,
    text: `무료 사용량이 소진으로 확인됐습니다${tail}. 생성할 때 다시 확인하며, 여전히 소진이면 작업이 실패합니다.`
  }
}

// ── 무료 사용량: PC 가 올린 잔량 ─────────────────────────────────────

export interface QuotaView {
  /** 게이지에 채울 전체 비율 0~100 — 눈금은 max(100, 일반분+추가분) */
  percent: number
  /** 일반분만 차지하는 막대 비율 0~100 */
  basePercent: number
  /** 추가 게이지(충전분) 막대 비율 0~100 */
  extraPercent: number
  /** 일반분 % 숫자 */
  rawPercent: number
  /** 추가분 % 숫자 */
  rawExtra: number
  /** 100% 단위 눈금 위치 0~100 */
  notches: number[]
  text: string
  low: boolean
  /** 다음 1% 회복까지 (일반분이 100% 이상이면 회복이 멈춰 null) */
  refill: string | null
}

/** 단일 계정의 Opus 사용량(일반분 + 추가 게이지) 표시 계산 */
export function opusQuotaView(usage: OpusUsage | null | undefined): QuotaView | null {
  if (!usage) return null
  const percent = Math.round(usagePercent(usage))
  const extra = Math.round(usagePurchasedPercent(usage))
  const bar = usageBar(usage)
  const fillPct = Math.round(bar.fill * 100)
  const basePct = Math.round(bar.base * 100)
  const extraPct = Math.max(0, fillPct - basePct)
  const images = usageImages(percent + extra).toLocaleString('ko-KR')
  return {
    percent: fillPct,
    basePercent: basePct,
    extraPercent: extraPct,
    rawPercent: percent,
    rawExtra: extra,
    notches: bar.notches.map((n) => Math.round(n * 100)),
    low: usageIsLow(usage),
    refill: usageRefilling(usage) ? refillEta(usage) : null,
    text: usage.isNegative
      ? '무료 사용량을 모두 썼습니다'
      : extra > 0
        ? `${percent}% 남음 · +${extra}% 추가 게이지 (약 ${images}장)`
        : `${percent}% 남음 (약 ${images}장)`
  }
}

/** NAI 무료(Opus) 사용량 표시용. 정보가 없으면 null */
export function quotaView(info: CloudNaiInfo | null | undefined): QuotaView | null {
  return opusQuotaView(info?.opusUsage)
}

/** 연결된 다중 계정을 한 줄 요약으로 표시 (상단 상태바용) */
export function multiAccountSummary(info: CloudNaiInfo | null | undefined): string | null {
  if (!info) return null
  const accounts: CloudAccountInfo[] = info.accounts ?? []
  if (accounts.length > 0) {
    const parts = accounts.map((a) => {
      const q = opusQuotaView(a.opusUsage)
      if (!q) return `${a.label} -`
      return q.rawExtra > 0
        ? `${a.label} ${q.rawPercent}%+${q.rawExtra}%`
        : `${a.label} ${q.rawPercent}%`
    })
    return parts.join(' · ')
  }
  const q = quotaView(info)
  if (!q) return null
  return q.rawExtra > 0 ? `Opus ${q.rawPercent}% (+${q.rawExtra}% 추가)` : `Opus ${q.rawPercent}%`
}

// ── 프리셋 폴더 카테고리 분류 ────────────────────────────────────────

export type PresetFolderCategory = '전체' | '단독' | '남캐' | '여캐' | '후타×후타' | '배경·기타'

export const PRESET_FOLDER_CATEGORIES: readonly PresetFolderCategory[] = [
  '전체',
  '단독',
  '남캐',
  '여캐',
  '후타×후타',
  '배경·기타'
]

export function classifyPresetFolder(
  name: string,
  kind: 'scene' | 'background' | string
): Exclude<PresetFolderCategory, '전체'> {
  if (kind === 'background') return '배경·기타'
  const n = name.trim()
  if (n.startsWith('단독')) return '단독'
  if (n.includes('남캐')) return '남캐'
  if (n.startsWith('[공]여캐')) return '여캐'
  if (n.startsWith('[공]후타')) return '후타×후타'
  return '배경·기타'
}
