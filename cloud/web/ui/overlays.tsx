/** 겹침 화면 틀 — 아래에서 올라오는 시트, 확인 대화상자, 토스트 */
import type { ComponentChildren } from 'preact'
import { useRef } from 'preact/hooks'
import { answerConfirm, dismissToast } from '../actions'
import { useDialogFocus, useOverlayHistory } from '../hooks'
import { useStore } from '../lib/store'
import { confirms, toasts, type ConfirmRequest } from '../stores'
import { Icon } from './icons'

export function Sheet({
  title,
  onClose,
  children,
  footer
}: {
  title: string
  onClose: () => void
  children: ComponentChildren
  footer?: ComponentChildren
}) {
  const ref = useRef<HTMLDivElement>(null)
  useOverlayHistory(onClose)
  useDialogFocus(ref, onClose)
  return (
    <div class="layer">
      <div class="scrim" onClick={onClose} aria-hidden="true" />
      <div class="sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <header class="sheet__head">
          <h2 class="sheet__title">{title}</h2>
          <button type="button" class="icon-btn" aria-label="닫기" onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>
        <div class="sheet__body">{children}</div>
        {footer && <div class="sheet__foot">{footer}</div>}
      </div>
    </div>
  )
}

function ConfirmDialog({ req }: { req: ConfirmRequest }) {
  const ref = useRef<HTMLDivElement>(null)
  const cancel = (): void => answerConfirm(false)
  useOverlayHistory(cancel)
  useDialogFocus(ref, cancel)
  return (
    <div class="layer layer--center">
      <div class="scrim" onClick={cancel} aria-hidden="true" />
      <div
        class="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={req.title}
        tabIndex={-1}
        ref={ref}
      >
        <h2 class="dialog__title">{req.title}</h2>
        {req.body && <p class="dialog__body">{req.body}</p>}
        <div class="dialog__actions">
          <button type="button" class="btn" onClick={cancel}>
            취소
          </button>
          <button
            type="button"
            class={req.danger ? 'btn btn--danger' : 'btn btn--primary'}
            onClick={() => answerConfirm(true)}
          >
            {req.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

export function ConfirmHost() {
  const req = useStore(confirms, (s) => s.request)
  return req ? <ConfirmDialog req={req} /> : null
}

export function ToastHost() {
  const items = useStore(toasts, (s) => s.items)
  return (
    <div class="toasts" aria-live="polite">
      {items.map((t) => (
        <div
          key={t.id}
          class={t.kind === 'error' ? 'toast toast--error' : 'toast'}
          role={t.kind === 'error' ? 'alert' : 'status'}
          onClick={() => dismissToast(t.id)}
        >
          {t.text}
        </div>
      ))}
    </div>
  )
}
