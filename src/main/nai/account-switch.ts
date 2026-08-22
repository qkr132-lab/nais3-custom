import { accountToken, activeAccountId, listAccounts, setActiveAccount } from '../db/accounts'
import { getSetting } from '../db/settings'
import { isV5 } from '../../shared/nai-models'
import { quotaState } from '../../shared/opus-usage'
import { fetchAnlasBalance } from './client'

/**
 * 한도가 바닥난 계정에서 남아 있는 계정으로 갈아타기 (커스텀).
 *
 * V5부터 Opus 무료 생성분이 한도제라, 한도를 다 쓰면 그다음 생성부터 Anlas가 나간다.
 * 계정을 둘 이상 등록해 두면 생성 직전에 활성 계정의 한도를 보고, 소진됐으면 여유가
 * 있는 계정으로 바꿔 끼운다.
 *
 * 원칙 두 가지:
 * - V5에서만 동작한다. V4.5 이하는 한도와 무관하게 무료라 갈아탈 이유가 없다.
 * - 확실히 소진된 경우에만 옮긴다. 게이지가 0%로만 보이는 구간(소수점 이하가 남아
 *   있을 수 있는 상태)에서는 옮기지 않는다 — 남은 무료분을 버리게 되므로.
 */

const ENABLED_KEY = 'auto_switch_account'
/** 같은 계정을 연달아 조회하지 않도록 하는 최소 간격 */
const PROBE_COOLDOWN_MS = 20_000

const lastProbe = new Map<string, number>()

export function autoSwitchEnabled(): boolean {
  return getSetting(ENABLED_KEY) === '1'
}

export interface SwitchResult {
  switched: boolean
  /** 갈아탄 뒤(또는 그대로인) 계정 이름 */
  label?: string
  /** 옮기려 했지만 여유 있는 계정이 없었다 */
  allExhausted?: boolean
}

/**
 * 생성 직전 호출. 필요하면 계정을 바꾸고 결과를 알려준다.
 * 조회 실패는 조용히 무시한다 — 계정 전환 때문에 생성이 막히면 안 된다.
 */
export async function ensureQuotaAccount(model: string, now = Date.now()): Promise<SwitchResult> {
  if (!autoSwitchEnabled() || !isV5(model)) return { switched: false }

  const accounts = listAccounts()
  if (accounts.length < 2) return { switched: false }

  const activeId = activeAccountId()
  const active = accounts.find((a) => a.id === activeId)
  if (!active) return { switched: false }

  const activeToken = accountToken(active.id)
  if (!activeToken) return { switched: false }

  const activeUsage = await probe(active.id, activeToken, now)
  if (quotaState(activeUsage) !== 'exhausted') return { switched: false }

  // 소진 확인 — 여유 있는 계정을 찾는다
  for (const candidate of accounts) {
    if (candidate.id === active.id) continue
    const token = accountToken(candidate.id)
    if (!token) continue
    const usage = await probe(candidate.id, token, now)
    if (quotaState(usage) === 'available' && setActiveAccount(candidate.id)) {
      return { switched: true, label: candidate.label }
    }
  }
  return { switched: false, allExhausted: true }
}

async function probe(
  id: string,
  token: string,
  now: number
): Promise<Awaited<ReturnType<typeof fetchAnlasBalance>>['opusUsage']> {
  const last = lastProbe.get(id)
  if (last && now - last < PROBE_COOLDOWN_MS) return cached.get(id) ?? null
  lastProbe.set(id, now)
  try {
    const { opusUsage } = await fetchAnlasBalance(token)
    cached.set(id, opusUsage)
    return opusUsage
  } catch {
    return cached.get(id) ?? null
  }
}

const cached = new Map<string, Awaited<ReturnType<typeof fetchAnlasBalance>>['opusUsage']>()

/** 테스트·설정 변경 시 캐시 비우기 */
export function resetProbeCache(): void {
  lastProbe.clear()
  cached.clear()
}
