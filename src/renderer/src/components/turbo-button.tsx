import { Zap } from 'lucide-react'
import { cn } from '../lib/utils'
import { turboActiveCount, turboOn, turboUsable, useTurboStore } from '../stores/turbo-store'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

/**
 * 고속 모드 번개 버튼 (커스텀). 켜면 등록한 계정을 모두 써서 한 계정에 한 장씩 동시에 뽑는다.
 * 메인 탭 생성 버튼 옆과 씬 화면 위쪽 막대에 같은 스위치로 놓이며, 상태는 하나를 공유한다.
 * 켜면 노란색으로 빛나고 「×2」처럼 참여 중인 계정 수를 보인다.
 */
export function TurboButton({
  size = 'bar',
  className
}: {
  size?: 'panel' | 'bar'
  className?: string
}): React.JSX.Element {
  const status = useTurboStore((s) => s.status)
  const setEnabled = useTurboStore((s) => s.setEnabled)
  const usable = turboUsable(status)
  const on = turboOn(status)
  const count = turboActiveCount(status)
  const dropped = status?.accounts.filter((a) => a.excluded).map((a) => a.label) ?? []

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* 비활성 버튼은 마우스 이벤트를 받지 못해 툴팁이 안 뜬다 — 바깥 span 이 대신 받는다 */}
        <span className={cn('inline-flex shrink-0', className)}>
          <button
            type="button"
            aria-label="고속 모드"
            aria-pressed={on}
            disabled={!usable}
            onClick={() => void setEnabled(!on)}
            className={cn(
              'inline-flex shrink-0 items-center justify-center gap-1 rounded-md border outline-none transition-all focus-visible:ring-2 focus-visible:ring-accent/40 disabled:pointer-events-none disabled:opacity-40',
              size === 'panel' ? 'h-10 min-w-10 px-2.5' : 'h-8 min-w-8 px-2',
              on
                ? 'border-amber-400/70 bg-amber-400/15 text-amber-500 shadow-[0_0_12px_rgba(245,158,11,0.5)] dark:text-yellow-300'
                : 'border-line text-muted hover:bg-surface-2 hover:text-ink'
            )}
          >
            <Zap size={size === 'panel' ? 16 : 15} className={cn(on && 'fill-current')} />
            {on && <span className="font-mono text-[11px] font-semibold">×{count}</span>}
          </button>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 px-2 py-1.5 text-[12px] leading-snug">
        {!usable ? (
          <p>NAI 계정을 둘 이상 등록하면 쓸 수 있습니다</p>
        ) : (
          <>
            <p>
              {on
                ? '고속 모드 켜짐 — 계정마다 한 장씩 동시에 생성'
                : '고속 모드 — 등록한 계정으로 동시에 생성'}
            </p>
            {on && dropped.length > 0 && (
              <p className="mt-0.5 text-muted">뺀 계정: {dropped.join(', ')}</p>
            )}
          </>
        )}
      </TooltipContent>
    </Tooltip>
  )
}
