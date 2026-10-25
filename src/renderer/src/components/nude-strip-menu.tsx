import { Check } from 'lucide-react'
import { useState } from 'react'
import { NUDE_STRIP_CHOICES, type NudeStripSetting } from '@shared/nude-strip'
import { cn } from '../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

/** 선택지마다 곁들이는 짧은 설명 — 「남캐 = 하는쪽, 여캐 = 당하는쪽」이라는 기준을 메뉴에서 바로 보이게 */
function choiceHint(value: NudeStripSetting | undefined, globalOn: boolean): string {
  if (value === undefined) return `설정 창 따름 · 지금 ${globalOn ? '켬' : '끔'}`
  if (value === false) return '이 씬은 옷을 입은 채'
  if (value === true) return '누드 태그가 없어도 모두 알몸'
  if (value === 'male') return '하는쪽 · 역할 없으면 boy·male 태그'
  return '당하는쪽 · 역할 없으면 그 밖의 캐릭터'
}

/**
 * 옷 벗기기 값을 고르는 메뉴 (커스텀) — 감싼 버튼을 누르면 「전체 설정 따름 / 안 벗김 / 둘 다 / 남캐만 / 여캐만」.
 * current = 지금 값(체크 표시). null 이면 체크를 달지 않는다 — 여러 씬을 한꺼번에 고를 때 값이 제각각이라서.
 */
export function NudeStripMenu({
  current,
  globalOn,
  onPick,
  align = 'start',
  children
}: {
  current: NudeStripSetting | undefined | null
  /** 설정 창의 전체 설정이 지금 켜져 있는지 — 「전체 설정 따름」 설명에 보인다 */
  globalOn: boolean
  onPick: (value: NudeStripSetting | undefined) => void
  align?: 'start' | 'center' | 'end'
  /** 메뉴를 여는 버튼 */
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} className="w-64 p-1">
        <div role="radiogroup" aria-label="옷 벗기기">
          {NUDE_STRIP_CHOICES.map((choice) => {
            const checked = current !== null && current === choice.value
            return (
              <button
                key={String(choice.value)}
                role="radio"
                aria-checked={checked}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-2',
                  checked && 'bg-surface-2'
                )}
                onClick={() => {
                  onPick(choice.value)
                  setOpen(false)
                }}
              >
                <span className="grid size-4 shrink-0 place-items-center">
                  {checked && <Check size={13} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px]">{choice.label}</span>
                  <span className="block truncate text-[11px] text-faint">
                    {choiceHint(choice.value, globalOn)}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
