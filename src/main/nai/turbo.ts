import { accountToken, activeAccountId, listAccounts } from '../db/accounts'
import { getSetting } from '../db/settings'
import { isV5, modelCaps } from '../../shared/nai-models'
import { quotaState } from '../../shared/opus-usage'
import type { GenerationRequest } from '../../shared/types'
import type { TurboHooks, TurboVerdict } from '../queue/generation-queue'
import { probeAccount } from './account-switch'

/**
 * 고속 모드(번개 버튼) — 등록한 NAI 계정마다 작업자 하나씩 큐를 나눠 뽑는다 (커스텀).
 * 저장값 `turbo_mode` 가 '1' 일 때만 켜진다. 기본은 꺼짐.
 *
 * Anlas 는 절대 나가지 않게: V5 는 계정마다 보내기 직전에 무료 한도가 '남음' 으로 확인된
 * 계정만 보낸다. '소진' 과 '모름'(0% 구간·조회 실패·Opus 가 아닌 계정)은 그 계정을 뺀다.
 * V4.5 이하는 한도와 무관해 모든 계정이 쓴다.
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

export async function turboVerdict(
  accountId: string,
  request: GenerationRequest
): Promise<TurboVerdict> {
  if (!isV5(sentModel(request))) return { ok: true, checked: false }
  const token = accountToken(accountId)
  if (!token) return { ok: false, reason: 'unknown' }
  const state = quotaState(await probeAccount(accountId, token))
  if (state === 'available') return { ok: true, checked: true }
  return { ok: false, reason: state === 'exhausted' ? 'exhausted' : 'unknown' }
}

/**
 * 작업자로 쓸 계정 — 토큰을 풀 수 있는 것만. 같은 토큰을 두 계정으로 넣어 두었으면 하나로 본다
 * (한 NAI 계정으로 동시에 두 장이 나가면 안 되므로).
 */
function usableAccounts(): { id: string; label: string; token: string }[] {
  const seen = new Set<string>()
  const out: { id: string; label: string; token: string }[] = []
  for (const a of listAccounts()) {
    const token = accountToken(a.id)
    if (!token || seen.has(token)) continue
    seen.add(token)
    out.push({ id: a.id, label: a.label, token })
  }
  return out
}

export function turboHooks(): TurboHooks {
  return {
    enabled: turboEnabled,
    accounts: () => usableAccounts().map(({ id, label }) => ({ id, label })),
    activeId: () => {
      const active = activeAccountId()
      if (!active) return null
      // 활성 계정이 같은 토큰의 다른 항목이라 빠졌다면 남은 쪽을 활성으로 본다
      const token = accountToken(active)
      return usableAccounts().find((a) => a.token === token)?.id ?? active
    },
    admit: turboVerdict
  }
}
