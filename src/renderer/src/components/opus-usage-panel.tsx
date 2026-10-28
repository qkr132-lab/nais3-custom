import { useCallback, useEffect, useState } from 'react'
import type { OpusUsage, RefillStatus } from '@shared/types'
import { usageBar, usageIsLow, usageRefillLine, usageSummary } from '@shared/opus-usage'
import { refillBlockText } from '@shared/usage-refill'
import { cn } from '../lib/utils'
import { useGenerationStore } from '../stores/generation-store'
import { openRefillShop, refillShopGuide, useRefillStore } from '../stores/refill-store'
import { Button } from './ui/button'

/**
 * Opus 한도 게이지와 충전 아이템 작은 창 (커스텀). 계산식은 웹과 같다 — shared/opus-usage.ts 참조.
 * 게이지는 일반분·추가분(충전 아이템)을 두 색으로 나누고 100%마다 홈을 판다.
 */

/** 두 색 게이지 막대 */
export function UsageGauge({
  usage,
  className
}: {
  usage: OpusUsage
  className?: string
}): React.JSX.Element {
  const bar = usageBar(usage)
  const low = usageIsLow(usage)
  return (
    <div className={cn('relative overflow-hidden rounded-full bg-surface-2', className)}>
      <div
        className="absolute inset-y-0 left-0 flex transition-[width]"
        style={{ width: `${bar.fill * 100}%` }}
      >
        <div
          className={cn('h-full', low ? 'bg-danger' : 'bg-accent')}
          style={{ width: `${bar.base * 100}%` }}
        />
        <div className="h-full flex-1 bg-sky-500 dark:bg-sky-400" />
      </div>
      {bar.notches.map((at) => (
        <div
          key={at}
          className="absolute inset-y-0 w-px bg-paper"
          style={{ left: `${at * 100}%` }}
        />
      ))}
    </div>
  )
}

function expiryText(iso: string | null): string {
  if (!iso) return ''
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleDateString('ko-KR')
}

/** 게이지 칩을 누르면 뜨는 작은 창의 내용 — 지금 쓰는(활성) 계정 기준. 열릴 때마다 새로 읽는다 */
export function OpusUsagePanel({ usage }: { usage: OpusUsage }): React.JSX.Element {
  const [status, setStatus] = useState<RefillStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [guide, setGuide] = useState(false)
  const busy = useRefillStore((s) => s.busy)
  const confirmAndUse = useRefillStore((s) => s.confirmAndUse)
  const refreshAnlas = useGenerationStore((s) => s.refreshAnlas)

  const load = useCallback((): Promise<void> => {
    return window.nais
      .invoke('refill:status', {})
      .then(setStatus, () => setStatus(null))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    void load()
    void refreshAnlas().catch(() => undefined)
  }, [load, refreshAnlas])

  const read = !loading && !!status?.ok
  const canUse = read && status?.blocked === null && !busy
  const itemsLine = loading
    ? '확인 중…'
    : !status?.ok
      ? '인벤토리를 읽지 못했습니다'
      : status.count > 0
        ? `보유 ${status.count}개 · 가장 가까운 만료 ${expiryText(status.nearestExpiry)}`
        : '보유 없음'
  // 보유 없음은 위 줄이 이미 말한다
  const blockedLine =
    read && status?.blocked && status.blocked !== 'none'
      ? refillBlockText(status.blocked, status.amount || 100)
      : ''
  const refill = usageRefillLine(usage)

  const onUse = async (): Promise<void> => {
    if (!status?.ok || status.blocked !== null) return
    const result = await confirmAndUse({ accountId: status.accountId, amount: status.amount })
    if (result === 'cancel') return
    setLoading(true)
    void load()
  }

  return (
    <div className="flex flex-col">
      <p className="text-[12.5px] font-semibold text-ink">Opus 무료 V5 생성</p>
      <UsageGauge usage={usage} className="mt-2 h-2 w-full" />
      <p className="mt-1.5 text-[12px] text-ink">{usageSummary(usage)}</p>
      {refill && <p className="text-[11px] text-muted">{refill}</p>}

      <div className="my-2.5 h-px bg-line" />

      <p className="text-[12px] font-medium text-ink">충전 아이템</p>
      <p className="text-[11.5px] text-muted">{itemsLine}</p>
      <div className="mt-2 flex gap-1.5">
        <Button
          size="sm"
          variant="accent"
          className="flex-1"
          disabled={!canUse}
          onClick={() => void onUse()}
        >
          {busy ? '처리 중…' : '사용'}
        </Button>
        <Button
          size="sm"
          className="flex-1"
          onClick={() => {
            openRefillShop()
            setGuide(true)
          }}
        >
          구매
        </Button>
      </div>
      {blockedLine && <p className="mt-1.5 text-[11px] text-faint">{blockedLine}</p>}
      {guide && (
        <p className="mt-1.5 text-[11px] leading-snug text-muted">
          {refillShopGuide(status?.label ?? '')}
        </p>
      )}
    </div>
  )
}
