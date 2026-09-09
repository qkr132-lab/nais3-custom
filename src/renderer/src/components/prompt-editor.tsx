import { Search } from 'lucide-react'
import { useTagCompletion } from '../lib/use-tag-completion'
import { TagSuggestions } from './tag-suggestions'
import { Popover, PopoverAnchor } from './ui/popover'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useId } from 'react'
import { cn } from '../lib/utils'
import { highlightRanges } from '../lib/prompt-weights'
import { promptTokenLimit } from '@shared/nai-tokens'
import { useGenerationStore } from '../stores/generation-store'
import { usePromptTokens } from '../lib/use-prompt-tokens'

/**
 * 프롬프트 에디터.
 *
 * 하이라이트 구조 (NAIS2의 커서/드래그 어긋남 문제를 피하는 설계):
 * - 글자는 textarea가 "단독으로" 그린다 — 선택·커서·IME 전부 네이티브 동작
 * - 미러(div)는 동일 타이포로 투명 글자를 깔고 배경색만 칠한다
 * - 테두리는 컨테이너가 가진다 (textarea/미러 metrics 완전 동일 보장)
 *
 * 색: 강조({}·양수 가중치)=붉은색, 약화([]·1 미만·음수)=파란색, <조각>=녹색
 * 자동완성: 입력창 가장자리에 고정한 팝업. `<`는 조각, 그 외 토큰은 단부루 태그(IPC 검색)
 */

// 폰트 크기는 설정값(--prompt-size)을 따름. mirror/textarea가 동일해야 배경 정렬이 맞는다.
// scrollbar-gutter:stable — 스크롤바 자리를 미리 배정(mirror도 동일해야 정렬 유지)
const TYPO =
  'whitespace-pre-wrap break-words p-2.5 pr-9 font-mono text-[length:var(--prompt-size,15px)] leading-relaxed [scrollbar-gutter:stable]'

export function PromptEditor({
  value,
  onValueChange,
  placeholder,
  className,
  negative = false,
  autoGrow = false,
  tokensOverride,
  model: explicitModel,
  tokensEstimated = false,
  tokensTitle
}: {
  value: string
  onValueChange: (value: string) => void
  placeholder?: string
  className?: string
  negative?: boolean
  /** 내용만큼 세로로 늘어난다 (className의 min-h/max-h 안에서). 긴 자연어 프롬프트용 */
  autoGrow?: boolean
  /** 외부에서 합산한 토큰 수 (기본+캐릭터 합산 등). undefined면 자체 카운트, null이면 숨김 */
  tokensOverride?: number | null
  /** Defaults to the currently selected generation model. */
  model?: string
  tokensEstimated?: boolean
  tokensTitle?: string
}): React.JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)
  const completion = useTagCompletion(textareaRef, value, onValueChange)
  const listId = useId()

  const ranges = useMemo(() => highlightRanges(value), [value])

  // 내용 높이 측정 — textarea를 잠깐 0으로 눌러 scrollHeight를 읽는다.
  // 최소·최대는 className의 min-h/max-h가 잡으므로 여기서는 순수 내용 높이만 준다.
  const [contentHeight, setContentHeight] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (!autoGrow) return
    const ta = textareaRef.current
    if (!ta) return
    const prev = ta.style.height
    ta.style.height = '0px'
    const next = ta.scrollHeight
    ta.style.height = prev
    setContentHeight((h) => (h === next ? h : next))
  }, [autoGrow, value])

  const currentModel = useGenerationStore((s) => s.request.model)
  const model = explicitModel ?? currentModel
  const external = tokensOverride !== undefined
  const ownCount = usePromptTokens(
    'tokens:count',
    external || !value.trim() ? null : { model, texts: [value] }
  )
  const tokens = external ? tokensOverride : (ownCount.data?.counts[0] ?? null)
  const tokenLimit = ownCount.data?.limit ?? promptTokenLimit(model)
  const estimated = external ? tokensEstimated : (ownCount.data?.estimated ?? false)
  const tokenDescription =
    tokensTitle ??
    (external
      ? '기본 프롬프트와 활성 캐릭터를 포함한 최종 합계'
      : '이 입력칸만의 부분 계산. 기본 프롬프트·다른 캐릭터와 토큰 한도를 공유합니다.')
  const tokenTooltip = `${tokenDescription}\n${estimated ? '선택·무작위 구문을 포함한 예상값. ' : ''}${tokens}/${tokenLimit} 토큰${tokens !== null && tokens > tokenLimit ? ' — 모델 한도 초과' : ''}`

  // 세로 스크롤바가 생기면 textarea 콘텐츠 폭이 줄어 줄바꿈이 달라진다 —
  // 미러의 오른쪽을 스크롤바 폭만큼 좁혀 두 레이어의 줄바꿈을 항상 일치시킨다
  // 스크롤바 폭 보정은 하지 않는다 — mirror·textarea 둘 다 scrollbar-gutter:stable(TYPO)이라
  // 콘텐츠 폭이 항상 동일. 수동 right 보정을 더하면 이중 인셋으로 줄바꿈이 어긋난다(배경 오정렬).
  const syncScroll = (): void => {
    const ta = textareaRef.current
    const mirror = mirrorRef.current
    if (ta && mirror) {
      mirror.scrollTop = ta.scrollTop
      mirror.scrollLeft = ta.scrollLeft
    }
  }
  useEffect(syncScroll, [value])
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    const observer = new ResizeObserver(syncScroll)
    observer.observe(ta)
    return () => observer.disconnect()
  }, [])

  return (
    <Popover
      open={completion.open}
      onOpenChange={(open) => {
        if (!open) completion.close()
      }}
    >
      <PopoverAnchor asChild>
        <div
          className={cn(
            'relative overflow-hidden rounded-md border border-line bg-paper transition-colors',
            negative && 'border-danger/25',
            autoGrow && 'overflow-y-auto',
            className
          )}
          style={autoGrow && contentHeight !== null ? { height: contentHeight } : undefined}
        >
          <div
            ref={mirrorRef}
            aria-hidden
            className={cn(
              TYPO,
              'pointer-events-none absolute inset-0 overflow-hidden text-transparent'
            )}
          >
            {ranges.map((r) =>
              r.bg ? (
                <span key={r.start} style={{ background: r.bg, borderRadius: 3 }}>
                  {value.slice(r.start, r.end)}
                </span>
              ) : (
                <span key={r.start}>{value.slice(r.start, r.end)}</span>
              )
            )}
            {value.endsWith('\n') && '​'}
          </div>

          <textarea
            ref={textareaRef}
            className={cn(
              TYPO,
              'relative block h-full w-full resize-none bg-transparent text-ink outline-none placeholder:text-faint'
            )}
            style={{ caretColor: 'var(--ink)' }}
            spellCheck={false}
            value={value}
            placeholder={placeholder}
            onChange={(e) => {
              onValueChange(e.target.value)
              completion.refresh(e.target.value, e.target.selectionStart)
            }}
            onScroll={syncScroll}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={completion.open}
            aria-controls={completion.open ? listId : undefined}
            aria-activedescendant={
              completion.open && completion.selected >= 0
                ? `${listId}-${completion.selected}`
                : undefined
            }
            onClick={completion.close}
            onKeyDown={completion.onKeyDown}
            onKeyUp={completion.onKeyUp}
            onCompositionStart={completion.compositionStart}
            onCompositionEnd={(e) =>
              completion.compositionEnd(e.currentTarget.value, e.currentTarget.selectionStart)
            }
            onBlur={completion.onBlur}
          />

          <button
            type="button"
            className="absolute right-1 top-1 rounded p-1 text-muted hover:bg-surface-2 hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
            aria-label="태그 추천 및 사용 기록"
            title="태그 추천 / 최근·자주 사용 (Ctrl+Space)"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => (completion.open ? completion.close() : completion.show())}
          >
            <Search size={14} />
          </button>
          {tokens !== null && (
            <span
              className={cn(
                'absolute bottom-1 right-1.5 cursor-help select-none rounded bg-paper/85 px-1 font-mono text-[10.5px] backdrop-blur-sm',
                tokens > tokenLimit ? 'text-danger' : 'text-faint'
              )}
              title={tokenTooltip}
              aria-label={tokenTooltip}
              onPointerDown={(event) => event.preventDefault()}
            >
              {estimated ? '약 ' : ''}
              {tokens}/{tokenLimit}
            </span>
          )}
        </div>
      </PopoverAnchor>
      {completion.open && <TagSuggestions completion={completion} listId={listId} />}
    </Popover>
  )
}
