import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useId,
  type KeyboardEvent,
  type RefObject,
  type PointerEvent,
  type MouseEvent,
  type FocusEvent
} from 'react'
import type { TagSuggestion } from '@shared/tag-search'
import { fragmentPaths } from '../stores/fragments-store'
import { askText } from '../stores/dialog-store'
import { toast, toastUndo, useToastStore } from '../stores/toast-store'
import {
  completionEdit,
  completionRange,
  completionAnchor,
  anchoredCompletionRange,
  type CompletionAnchor,
  type CompletionRange
} from './prompt-completion'

export type Suggestion = { kind: 'frag'; path: string } | ({ kind: 'tag' } & TagSuggestion)
let dismissActive: { owner: string; close: () => void } | null = null
let lastCompletionToast: number | null = null
export interface TagCompletion {
  open: boolean
  suggestions: Suggestion[]
  selected: number
  status: 'ready' | 'loading' | 'error'
  query: string
  setPopupNode: (node: HTMLDivElement | null) => void
  close: () => void
  refresh: (text: string, cursor: number, explicit?: boolean) => void
  show: () => void
  complete: (suggestion: Suggestion) => void
  choose: (index: number) => void
  editMeaning: () => Promise<void>
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  onKeyUp: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  onBlur: (event: FocusEvent<HTMLTextAreaElement>) => void
  compositionStart: () => void
  compositionEnd: (text: string, cursor: number) => void
  pointerDownSuggestion: (suggestion: Suggestion, event: PointerEvent<HTMLButtonElement>) => void
  clickSuggestion: (suggestion: Suggestion, event: MouseEvent<HTMLButtonElement>) => void
}

export function useTagCompletion(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  value: string,
  onValueChange: (value: string) => void
): TagCompletion {
  const owner = useId()
  const [open, setOpen] = useState(false)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [selected, setSelected] = useState(-1)
  const [status, setStatus] = useState<'ready' | 'loading' | 'error'>('ready')
  const [query, setQuery] = useState('')
  const popupRef = useRef<HTMLDivElement>(null)
  const setPopupNode = useCallback((node: HTMLDivElement | null) => {
    popupRef.current = node
  }, [])
  const seq = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const context = useRef<CompletionRange | null>(null)
  const insertionAnchor = useRef<CompletionAnchor | null>(null)
  const beforeEdit = useRef<{ text: string; start: number; end: number } | null>(null)
  const composing = useRef(false)
  const mounted = useRef(true)
  const pointerChoice = useRef<{
    key: string
    seq: number
    x: number
    y: number
    range: CompletionRange
  } | null>(null)
  const ready = useRef<{
    range: CompletionRange
    items: Suggestion[]
    selected: number
    chosen: boolean
  } | null>(null)
  const pendingEnter = useRef<{
    text: string
    cursor: number
    waitingForComposition: boolean
  } | null>(null)
  const enterHeld = useRef(false)

  const close = useCallback(() => {
    ++seq.current
    clearTimeout(timer.current)
    context.current = null
    insertionAnchor.current = null
    beforeEdit.current = null
    ready.current = null
    pendingEnter.current = null
    pointerChoice.current = null
    setOpen(false)
    setSuggestions([])
    setSelected(-1)
    if (dismissActive?.owner === owner) dismissActive = null
  }, [owner])

  useEffect(() => {
    mounted.current = true
    const sequence = seq
    const ta = textareaRef.current
    const beforeInput = (e: InputEvent): void => {
      if (
        pendingEnter.current &&
        (e.inputType === 'insertLineBreak' ||
          e.inputType === 'insertParagraph' ||
          (e.inputType === 'insertText' && (e.data === '\n' || e.data === '\r')))
      ) {
        // Some IMEs emit the line break separately from the committing keydown.
        e.preventDefault()
        return
      }
      if (ta)
        beforeEdit.current = {
          text: ta.value,
          start: ta.selectionStart,
          end: ta.selectionEnd
        }
    }
    ta?.addEventListener('beforeinput', beforeInput)
    const scroll = (e: Event): void => {
      if (e.target instanceof Node && popupRef.current?.contains(e.target)) return
      close()
    }
    document.addEventListener('scroll', scroll, true)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    return () => {
      mounted.current = false
      ++sequence.current
      clearTimeout(timer.current)
      pendingEnter.current = null
      ta?.removeEventListener('beforeinput', beforeInput)
      document.removeEventListener('scroll', scroll, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      if (dismissActive?.owner === owner) dismissActive = null
    }
  }, [close, owner, textareaRef])

  useEffect(() => {
    if (!context.current || context.current.text === value) return
    const frame = requestAnimationFrame(close)
    return () => cancelAnimationFrame(frame)
  }, [value, close])

  function refresh(text: string, cursor: number, explicit = false): void {
    const ta = textareaRef.current
    if (beforeEdit.current) {
      insertionAnchor.current = completionAnchor(
        insertionAnchor.current,
        beforeEdit.current,
        text,
        cursor
      )
      beforeEdit.current = null
    }
    const pending = pendingEnter.current
    if (
      pending &&
      !pending.waitingForComposition &&
      (pending.text !== text || pending.cursor !== cursor)
    )
      pendingEnter.current = null
    const range = insertionAnchor.current
      ? anchoredCompletionRange(insertionAnchor.current, text, cursor, ta?.selectionEnd ?? cursor)
      : completionRange(text, cursor, ta?.selectionEnd ?? cursor)
    if (
      !range ||
      (!explicit &&
        (range.query.trim().length < (/[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(range.query) ? 1 : 2) ||
          /\s$/.test(range.query)))
    ) {
      const anchor = insertionAnchor.current
      close()
      insertionAnchor.current = anchor
      return
    }
    if (dismissActive && dismissActive.owner !== owner) dismissActive.close()
    dismissActive = { owner, close }
    clearTimeout(timer.current)
    const generation = ++seq.current
    context.current = range
    ready.current = null
    setQuery(range.query.trim())
    setOpen(true)
    setSelected(-1)
    setStatus('loading')
    pointerChoice.current = null
    const current = (): boolean =>
      mounted.current &&
      seq.current === generation &&
      document.activeElement === ta &&
      ta?.value === text &&
      ta.selectionStart === cursor &&
      ta.selectionEnd === cursor
    timer.current = setTimeout(
      async () => {
        try {
          let items: Suggestion[]
          if (range.kind === 'frag') {
            items = fragmentPaths(range.query).map((path) => ({ kind: 'frag', path }))
          } else {
            const response = await window.nais.invoke('tags:search', {
              query: range.query.trim(),
              limit: 10
            })
            items = response.items.map((t) => ({ kind: 'tag' as const, ...t }))
          }
          if (!current()) return
          setSuggestions(items)
          setSelected(items.length ? 0 : -1)
          setStatus('ready')
          ready.current = { range, items, selected: items.length ? 0 : -1, chosen: false }
          const enter = pendingEnter.current
          if (
            enter &&
            !enter.waitingForComposition &&
            enter.text === text &&
            enter.cursor === cursor
          ) {
            pendingEnter.current = null
            // A query with no matching tags may still show unrelated usage history.
            // An early Enter must never accept one of those fallback rows.
            const first = items.find((item) => item.kind === 'frag' || item.match !== 'history')
            if (first) insertSuggestion(first, range)
          }
        } catch {
          if (current()) {
            setSuggestions([])
            setStatus('error')
            ready.current = null
            pendingEnter.current = null
          }
        }
      },
      explicit || (pendingEnter.current && !pendingEnter.current.waitingForComposition) ? 0 : 120
    )
  }

  function show(): void {
    const ta = textareaRef.current
    if (!ta) return
    ta.focus()
    refresh(ta.value, ta.selectionStart, true)
  }

  function complete(s: Suggestion): void {
    const latest = ready.current
    if (status !== 'ready' || !latest || !latest.items.includes(s)) return
    if (!finishComposition()) return
    insertSuggestion(s, latest.range)
  }

  function finishComposition(): boolean {
    if (!composing.current) return true
    const latest = ready.current
    const ta = textareaRef.current
    if (latest && ta && document.activeElement === ta) {
      const range = latest.range
      if (
        ta.value !== range.text ||
        ta.selectionStart !== range.cursor ||
        ta.selectionEnd !== range.cursor
      ) {
        close()
        return false
      }
      // Commit the native IME before replacing its text. Keep the clicked
      // candidate locally because blur/compositionend can dismiss the popup.
      const anchor = insertionAnchor.current
      ta.blur()
      composing.current = false
      ta.focus()
      if (
        ta.value !== range.text ||
        ta.selectionStart !== range.cursor ||
        ta.selectionEnd !== range.cursor
      ) {
        close()
        return false
      }
      context.current = range
      insertionAnchor.current = anchor
      ready.current = latest
      setOpen(true)
      setSuggestions(latest.items)
      setSelected(latest.selected)
      setStatus('ready')
      dismissActive = { owner, close }
      return true
    }
    return false
  }

  function insertSuggestion(s: Suggestion, range: CompletionRange): void {
    const ta = textareaRef.current
    if (
      !ta ||
      !context.current ||
      document.activeElement !== ta ||
      composing.current ||
      ta.value !== range.text ||
      ta.selectionStart !== range.cursor ||
      ta.selectionEnd !== range.cursor
    ) {
      close()
      return
    }
    const edit = completionEdit(range, s.kind === 'frag' ? s.path : s.tag)
    close()
    ta.focus()
    ta.setSelectionRange(range.start, range.end)
    if (!document.execCommand('insertText', false, edit.insert)) {
      onValueChange(edit.next)
      requestAnimationFrame(() => ta.setSelectionRange(edit.cursor, edit.cursor))
    }
    // The completion's input event may have scheduled another search.
    close()
    if (s.kind === 'tag') {
      void window.nais
        .invoke('tags:recordUse', { tag: s.tag })
        .catch(() => toast('태그는 입력했지만 사용 기록은 저장하지 못했어요.', 'info'))
    }
    if (lastCompletionToast !== null) useToastStore.getState().dismiss(lastCompletionToast)
    toastUndo(`태그 삽입: ${s.kind === 'frag' ? s.path : s.tag}`, () => {
      const target = textareaRef.current
      if (!target || target.value !== edit.next) {
        toast('이후 입력이 있어요. 입력창에서 Ctrl+Z로 순서대로 되돌려 주세요.', 'info')
        return
      }
      close()
      target.focus()
      target.setSelectionRange(range.start, edit.cursor)
      if (!document.execCommand('insertText', false, range.text.slice(range.start, range.end)))
        onValueChange(range.text)
      close()
    })
    lastCompletionToast = useToastStore.getState().toasts.at(-1)?.id ?? null
  }

  function choose(index: number): void {
    setSelected(index)
    if (ready.current) {
      ready.current.selected = index
      ready.current.chosen = true
    }
    popupRef.current
      ?.querySelector(`[data-suggestion-index="${index}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }

  async function editMeaning(): Promise<void> {
    const item = suggestions[selected]
    if (item?.kind !== 'tag') return
    close()
    const meaning = await askText(
      `"${item.tag}" 한글 뜻 / 별칭 (쉼표로 구분)`,
      item.userKo ? (item.ko ?? '') : ''
    )
    if (meaning === null) return
    try {
      await window.nais.invoke('tags:setKo', { tag: item.tag, ko: meaning })
      toast(
        meaning.trim() ? '한글 뜻과 검색 별칭을 저장했어요.' : '직접 추가한 뜻을 지웠어요.',
        'success'
      )
    } catch {
      toast('한글 뜻을 저장하지 못했어요.', 'error')
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    const isEnter = e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter'
    if (isEnter && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (enterHeld.current) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      const ta = textareaRef.current
      const range =
        ta &&
        (insertionAnchor.current
          ? anchoredCompletionRange(
              insertionAnchor.current,
              ta.value,
              ta.selectionStart,
              ta.selectionEnd
            )
          : completionRange(ta.value, ta.selectionStart, ta.selectionEnd))
      if (ta && range && context.current && range.query.trim()) {
        const latest = ready.current
        const selectedItem = latest?.items[latest.selected]
        const sameRange =
          latest?.range.text === ta.value && latest.range.cursor === ta.selectionStart
        if (!composing.current && sameRange && !selectedItem) {
          close()
          return
        }
        if (
          !composing.current &&
          sameRange &&
          selectedItem?.kind === 'tag' &&
          selectedItem.match === 'history' &&
          !latest?.chosen
        ) {
          close()
          return
        }
        e.preventDefault()
        e.stopPropagation()
        enterHeld.current = true
        if (!composing.current && sameRange && selectedItem) {
          insertSuggestion(selectedItem, range)
        } else {
          pendingEnter.current = {
            text: ta.value,
            cursor: ta.selectionStart,
            waitingForComposition: composing.current
          }
          if (!composing.current) refresh(ta.value, ta.selectionStart, true)
        }
        return
      }
    }
    // Any subsequent editing/navigation cancels an outstanding Enter request.
    if (!isEnter && !['Shift', 'Control', 'Alt', 'Meta'].includes(e.key))
      pendingEnter.current = null
    if (isEnter && e.shiftKey) pendingEnter.current = null
    const arrow =
      e.key === 'ArrowDown' || e.code === 'ArrowDown'
        ? 'down'
        : e.key === 'ArrowUp' || e.code === 'ArrowUp'
          ? 'up'
          : null
    const latest = ready.current
    if (arrow && latest?.items.length && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault()
      e.stopPropagation()
      if (!finishComposition()) return
      choose(
        arrow === 'down'
          ? (latest.selected + 1) % latest.items.length
          : latest.selected <= 0
            ? latest.items.length - 1
            : latest.selected - 1
      )
      return
    }
    if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return
    if ((e.ctrlKey || e.metaKey) && e.code === 'Space') {
      e.preventDefault()
      e.stopPropagation()
      show()
      return
    }
    if (!open) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && selected >= 0) {
      e.preventDefault()
      e.stopPropagation()
      void editMeaning()
      return
    }
    if (
      (e.key === 'Tab' || e.key === 'Enter') &&
      !e.shiftKey &&
      selected >= 0 &&
      status === 'ready'
    ) {
      e.preventDefault()
      e.stopPropagation()
      complete(suggestions[selected])
    } else if (['Enter', 'Tab', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) close()
  }

  return {
    open,
    suggestions,
    selected,
    status,
    query,
    setPopupNode,
    close,
    refresh,
    show,
    complete,
    choose,
    editMeaning,
    onKeyDown,
    onKeyUp: (e) => {
      if (e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter')
        enterHeld.current = false
    },
    onBlur: (e) => {
      enterHeld.current = false
      if (!(e.relatedTarget instanceof Node) || !popupRef.current?.contains(e.relatedTarget))
        close()
    },
    compositionStart: () => {
      composing.current = true
      const anchor = insertionAnchor.current
      close()
      insertionAnchor.current = anchor
      // Show suggestions while typing, but insert only after IME commit finishes.
    },
    compositionEnd: (text, cursor) => {
      if (!composing.current) return
      composing.current = false
      const down = pointerChoice.current
      if (down?.range.text === text && down.range.cursor === cursor) return
      if (pendingEnter.current?.waitingForComposition) {
        pendingEnter.current = { text, cursor, waitingForComposition: false }
      }
      refresh(text, cursor, true)
    },
    pointerDownSuggestion: (suggestion, e) => {
      e.preventDefault()
      pendingEnter.current = null
      const key = suggestion.kind === 'tag' ? suggestion.tag : suggestion.path
      const latest = ready.current
      pointerChoice.current = latest?.items.includes(suggestion)
        ? { key, seq: seq.current, x: e.clientX, y: e.clientY, range: latest.range }
        : null
    },
    clickSuggestion: (suggestion, e) => {
      const key = suggestion.kind === 'tag' ? suggestion.tag : suggestion.path
      const down = pointerChoice.current
      if (
        e.detail === 0 ||
        (down?.key === key &&
          down.seq === seq.current &&
          Math.hypot(e.clientX - down.x, e.clientY - down.y) < 8)
      )
        complete(suggestion)
      pointerChoice.current = null
    }
  }
}
