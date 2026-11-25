import { Check } from 'lucide-react'
import { useState } from 'react'
import type { CardFitChoice } from '../lib/card-fit-choice'
import { cn } from '../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

const CHOICES: { value: CardFitChoice; label: string }[] = [
  { value: undefined, label: '따름' },
  { value: true, label: '켬' },
  { value: false, label: '끔' }
]

/**
 * 카드 태그 씬 맞춤 켬/끔을 고르는 메뉴 (커스텀) — 감싼 버튼을 누르면 「따름 / 켬 / 끔」.
 * level = 씬(따름 = 세트 → 전체 설정) · 세트(따름 = 전체 설정).
 * current = 지금 값(체크 표시). null 이면 체크를 달지 않는다 — 여러 씬을 한꺼번에 고를 때 값이 제각각이라서.
 * inherited = 따름을 골랐을 때 실제로 켜지는지 (설명에 보인다).
 */
export function CardFitMenu({
  current,
  level,
  inherited,
  onPick,
  align = 'start',
  children
}: {
  current: CardFitChoice | null
  level: 'scene' | 'preset'
  inherited: boolean
  onPick: (value: CardFitChoice) => void
  align?: 'start' | 'center' | 'end'
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const hint = (value: CardFitChoice): string => {
    if (value === undefined)
      return `${level === 'scene' ? '세트 → 설정 창' : '설정 창'} 따름 · 지금 ${inherited ? '켬' : '끔'}`
    return value
      ? '장면에 맞게 카드 태그를 빼고 보냄'
      : '카드 글 그대로 보냄 (이 기능이 없을 때와 같음)'
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} className="w-64 p-1">
        <div role="radiogroup" aria-label="카드 태그 씬 맞춤">
          {CHOICES.map((choice) => {
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
                    {hint(choice.value)}
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
