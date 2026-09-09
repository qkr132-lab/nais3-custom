import { Loader2, X } from 'lucide-react'
import { TAG_MATCH_LABEL } from '@shared/tag-search'
import type { useTagCompletion } from '../lib/use-tag-completion'
import { cn } from '../lib/utils'
import { PopoverContent } from './ui/popover'

const TYPE_COLORS: Record<string, string> = {
  artist: 'text-[#e05c50]',
  character: 'text-[#5c9e6e]',
  copyright: 'text-[#b07fd8]',
  meta: 'text-[#c9a34f]'
}

export function TagSuggestions({
  completion: c,
  listId
}: {
  completion: ReturnType<typeof useTagCompletion>
  listId: string
}): React.JSX.Element {
  const selected = c.suggestions[c.selected]
  return (
    <PopoverContent
      ref={(node) => c.setPopupNode(node)}
      role="presentation"
      data-tag-popup
      align="start"
      side="bottom"
      sideOffset={6}
      collisionPadding={8}
      className="z-50 flex max-h-[var(--radix-popover-content-available-height)] w-[360px] max-w-[calc(100vw-16px)] flex-col overflow-hidden p-0"
      onOpenAutoFocus={(e) => e.preventDefault()}
      onCloseAutoFocus={(e) => e.preventDefault()}
      onFocusOutside={(e) => {
        if (e.target instanceof HTMLTextAreaElement) e.preventDefault()
      }}
      onEscapeKeyDown={(e) => {
        e.preventDefault()
        c.close()
      }}
      onPointerDown={(e) => {
        e.preventDefault()
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2 text-[12px]">
        <span className="px-1 font-medium text-ink">태그 추천</span>
        <button
          type="button"
          tabIndex={-1}
          className="ml-auto rounded p-1 text-muted hover:bg-surface-2"
          aria-label="태그 제안 닫기"
          onClick={c.close}
        >
          <X size={14} />
        </button>
      </div>
      <div
        className="flex h-7 shrink-0 items-center gap-1.5 px-3 text-[11px] text-muted"
        aria-live="polite"
      >
        {c.status === 'loading' ? (
          <>
            <Loader2 size={12} className="animate-spin motion-reduce:animate-none" /> 찾는 중…
          </>
        ) : (
          <span className="truncate">
            {c.query ? `“${c.query}” 일치·연관 우선 · 최근·자주 사용` : '최근·자주 사용한 태그'}
          </span>
        )}
      </div>
      <div
        id={listId}
        role="listbox"
        aria-label="태그 추천"
        aria-busy={c.status === 'loading'}
        className="h-60 min-h-0 max-h-72 overflow-y-auto overscroll-contain"
      >
        {c.suggestions.map((s, i) => {
          const key = s.kind === 'tag' ? s.tag : s.path
          return (
            <button
              key={`${s.kind}:${key}`}
              id={`${listId}-${i}`}
              type="button"
              role="option"
              aria-selected={c.selected === i}
              tabIndex={-1}
              data-suggestion-index={i}
              disabled={c.status !== 'ready'}
              className={cn(
                'flex h-12 w-full flex-col justify-center gap-0.5 px-2.5 text-left text-[12px] hover:bg-accent-soft disabled:pointer-events-none disabled:opacity-40',
                c.selected === i ? 'bg-surface-2 text-ink' : 'text-muted'
              )}
              onPointerDown={(e) => c.pointerDownSuggestion(s, e)}
              onClick={(e) => c.clickSuggestion(s, e)}
            >
              <span className="flex w-full items-center gap-2">
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate font-mono',
                    s.kind === 'tag' ? TYPE_COLORS[s.type] : 'text-[#5cbe7d]'
                  )}
                >
                  {s.kind === 'tag' ? s.tag : `<${s.path}>`}
                </span>
                <span className="shrink-0 text-[11px] text-muted">
                  {s.kind === 'tag' &&
                    (s.usageCount
                      ? `${s.match === 'history' ? '최근·자주 ' : ''}사용 ${s.usageCount}회`
                      : s.match
                        ? `${TAG_MATCH_LABEL[s.match]}${s.legacy ? ' · 이전 태그' : ''}`
                        : '')}
                </span>
              </span>
              <span
                className="w-full truncate text-[12px] text-muted"
                title={
                  s.kind === 'tag' ? [s.ko, s.matchedAlias].filter(Boolean).join(' · ') : s.path
                }
              >
                {s.kind === 'frag' ? (
                  '프롬프트 조각'
                ) : (
                  <>
                    {s.ko || '한글 뜻을 직접 추가할 수 있어요'}
                    {s.matchedAlias && s.matchedAlias !== s.tag ? ` · ${s.matchedAlias}` : ''}
                  </>
                )}
              </span>
            </button>
          )
        })}
        {c.status !== 'loading' && !c.suggestions.length && (
          <p className="p-4 text-[12px] leading-relaxed text-muted">
            {c.status === 'error'
              ? '검색하지 못했어요. 잠시 후 다시 시도해 주세요.'
              : c.query
                ? '일치하는 태그가 없어요. 짧은 한글·초성이나 영어로 찾아보세요. 예: 전신, ㅈㅅ, full body'
                : '아직 사용 기록이 없어요. 추천에서 고른 태그가 여기에 쌓여요.'}
          </p>
        )}
      </div>
      <div className="shrink-0 border-t border-line px-3 py-2 text-[11px] text-muted">
        <p
          className="h-8 overflow-hidden leading-4"
          title={selected?.kind === 'tag' ? selected.desc : ''}
        >
          {c.status === 'loading'
            ? '입력이 바뀌면 이전 후보는 선택되지 않아요.'
            : selected?.kind === 'tag' && selected.desc
              ? selected.desc
              : '↑↓ 선택 · Enter/Tab 삽입 · Shift+Enter 줄바꿈'}
        </p>
        <div className="mt-1 flex items-center justify-between gap-2">
          <span>Enter 삽입 · Shift+Enter 줄바꿈</span>
          <button
            type="button"
            tabIndex={-1}
            className="shrink-0 rounded px-1 text-accent hover:bg-accent-soft disabled:text-faint"
            disabled={selected?.kind !== 'tag' || c.status !== 'ready'}
            onClick={() => void c.editMeaning()}
          >
            한글 뜻 편집
          </button>
        </div>
      </div>
    </PopoverContent>
  )
}
