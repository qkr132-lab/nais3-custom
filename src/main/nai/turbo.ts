import { createHash } from 'crypto'
import { accountToken, listAccounts } from '../db/accounts'
import { getNaiToken, getSetting } from '../db/settings'
import { isV5, modelCaps } from '../../shared/nai-models'
import { quotaState } from '../../shared/opus-usage'
import type { GenerationRequest } from '../../shared/types'
import type { TurboHooks, TurboVerdict } from '../queue/generation-queue'
import { forgetProbe, probeAccount, probeTier } from './account-switch'

/**
 * 고속 모드(번개 버튼) — 등록한 NAI 계정마다 작업자 하나씩 큐를 나눠 뽑는다 (커스텀).
 * 저장값 `turbo_mode` 가 '1' 일 때만 켜진다. 기본은 꺼짐.
 *
 * Anlas 는 절대 나가지 않게: V5 는 계정마다 보내기 직전에 무료 한도가 '남음' 으로 확인된
 * 계정만 보낸다. '소진' 과 '모름'(0% 구간·조회 실패·Opus 가 아닌 계정)은 그 계정을 뺀다.
 * V4.5 이하는 한도와 무관하지만 무료 생성은 Opus 등급에만 있어, Opus 로 확인된 계정만 쓴다.
 */

export const TURBO_KEY = 'turbo_mode'

export function turboEnabled(): boolean {
  return getSetting(TURBO_KEY) === '1'
}

/** 큐가 실제로 보낼 모델 — 인페인트는 짝 모델(V4.5)로 가므로 V5 한도와 무관하다 (생성 파이프라인과 같은 규칙) */
function sentModel(request: GenerationRequest): string {
  return request.source?.maskBase64 && !request.model.includes('inpainting')
    ? modelCaps(request.model).inpaintModel
    : request.model
}

/** 이 요청이 V5 무료 한도를 쓰는가 */
export function needsQuota(request: GenerationRequest): boolean {
  return isV5(sentModel(request))
}

export async function turboVerdict(
  accountId: string,
  request: GenerationRequest
): Promise<TurboVerdict> {
  const token = accountToken(accountId)
  if (!token) return { ok: false, reason: 'unknown' }
  if (!needsQuota(request)) {
    // 등급만 본 것이라 V5 한도를 확인한 것은 아니다 (checked: false — 빠짐 기록을 건드리지 않는다)
    return (await probeTier(accountId, token)) === 'opus'
      ? { ok: true, checked: false }
      : { ok: false, reason: 'unknown' }
  }
  const state = quotaState(await probeAccount(accountId, token))
  if (state === 'available') return { ok: true, checked: true }
  return { ok: false, reason: state === 'exhausted' ? 'exhausted' : 'unknown' }
}

/** 작업자 이름 — 같은 토큰이면 같은 값. 메인 안에서만 쓰고 저장·출력하지 않는다 */
function tokenKey(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16)
}

/**
 * 작업자로 쓸 계정 — 토큰을 풀 수 있는 것만. 같은 토큰을 두 계정으로 넣어 두었으면 하나로 본다
 * (한 NAI 계정으로 동시에 두 장이 나가면 안 되므로).
 */
function usableAccounts(): { id: string; label: string; key: string }[] {
  const seen = new Set<string>()
  const out: { id: string; label: string; key: string }[] = []
  for (const a of listAccounts()) {
    const token = accountToken(a.id)
    if (!token) continue
    const key = tokenKey(token)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ id: a.id, label: a.label, key })
  }
  return out
}

export function turboHooks(): TurboHooks {
  return {
    enabled: turboEnabled,
    accounts: usableAccounts,
    // 활성 토큰 그대로 — 활성 계정이 같은 토큰의 다른 항목이라 목록에서 빠졌어도 남은 쪽 작업자와 맞는다
    activeKey: () => {
      const token = getNaiToken()
      return token ? tokenKey(token) : null
    },
    admit: turboVerdict,
    needsQuota,
    forget: forgetProbe
  }
}
