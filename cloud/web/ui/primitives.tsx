/** 작은 공용 조각들 — 스위치·스테퍼·빈 화면·그림 */
import type { ComponentChildren, RefObject } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { useAutoHeight, useBlobUrl, useInView } from '../hooks'
import { Icon } from './icons'

export function Spinner({ size = 20 }: { size?: number }) {
  return <Icon name="loader" size={size} class="spin" />
}

/** 가운데 놓이는 불러오는 중 표시 */
export function Loading({ text = '불러오는 중' }: { text?: string }) {
  return (
    <div class="state" role="status">
      <Spinner size={24} />
      <p class="state__text">{text}</p>
    </div>
  )
}

export function EmptyState({
  title,
  body,
  children
}: {
  title: string
  body?: string
  children?: ComponentChildren
}) {
  return (
    <div class="state">
      <p class="state__title">{title}</p>
      {body && <p class="state__text">{body}</p>}
      {children}
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div class="state" role="alert">
      <p class="state__title">불러오지 못했습니다</p>
      <p class="state__text">{message}</p>
      {onRetry && (
        <button type="button" class="btn" onClick={onRetry}>
          <Icon name="refresh" size={18} />
          다시 시도
        </button>
      )}
    </div>
  )
}

export function Switch({
  checked,
  onChange,
  label,
  disabled
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      class="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span class="switch__knob" />
    </button>
  )
}

/** 숫자 − [값] + (직접 입력도 됨) */
export function Stepper({
  value,
  min,
  max,
  onChange,
  label
}: {
  value: number
  min: number
  max: number
  onChange: (next: number) => void
  label: string
}) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const clamp = (n: number): number =>
    Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : min
  const commit = (): void => {
    const n = clamp(parseInt(text, 10))
    setText(String(n))
    if (n !== value) onChange(n)
  }
  return (
    <div class="stepper" role="group" aria-label={label}>
      <button
        type="button"
        class="stepper__btn"
        aria-label={`${label} 줄이기`}
        disabled={value <= min}
        onClick={() => onChange(clamp(value - 1))}
      >
        <Icon name="minus" size={18} />
      </button>
      <input
        class="stepper__input"
        type="text"
        inputMode="numeric"
        aria-label={label}
        value={text}
        onInput={(e) => setText((e.currentTarget as HTMLInputElement).value.replace(/[^0-9]/g, ''))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
        }}
      />
      <button
        type="button"
        class="stepper__btn"
        aria-label={`${label} 늘리기`}
        disabled={value >= max}
        onClick={() => onChange(clamp(value + 1))}
      >
        <Icon name="plus" size={18} />
      </button>
    </div>
  )
}

/** 여러 보기 중 하나 고르기 (칩 모양) */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label
}: {
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (next: T) => void
  label: string
}) {
  return (
    <div class="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          class={o.value === value ? 'segmented__item is-on' : 'segmented__item'}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** 글 길이에 맞춰 자라는 입력칸 */
export function AutoTextarea({
  value,
  onChange,
  label,
  placeholder,
  disabled
}: {
  value: string
  onChange: (next: string) => void
  label: string
  placeholder?: string
  disabled?: boolean
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useAutoHeight(ref as RefObject<HTMLTextAreaElement>, value)
  return (
    <textarea
      ref={ref}
      class="input input--area"
      rows={2}
      aria-label={label}
      placeholder={placeholder}
      disabled={disabled}
      value={value}
      spellcheck={false}
      autocapitalize="off"
      onInput={(e) => onChange((e.currentTarget as HTMLTextAreaElement).value)}
    />
  )
}

/**
 * 인증이 필요한 그림. 화면 근처에 있을 때만 가져오고, 멀어지면 놓아서 캐시가 정리할 수 있게 한다.
 * load 는 blob 을 돌려주는 함수, cacheKey 는 같은 그림을 한 번만 받기 위한 키.
 */
export function AuthImage({
  cacheKey,
  load,
  alt = '',
  class: cls,
  margin
}: {
  cacheKey: string
  load: () => Promise<Blob>
  alt?: string
  class?: string
  margin?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const near = useInView(ref, margin)
  const { url, error } = useBlobUrl(near ? cacheKey : null, load)
  return (
    <div ref={ref} class={cls ? `pic ${cls}` : 'pic'}>
      {url ? (
        <img src={url} alt={alt} draggable={false} decoding="async" />
      ) : error ? (
        <span class="pic__fail" title={error}>
          <Icon name="image" size={22} />
        </span>
      ) : null}
    </div>
  )
}
