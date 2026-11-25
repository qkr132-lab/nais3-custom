/** 연결 화면 — 연결 코드(8자리)와 기기 이름으로 이 폰을 등록한다 */
import { useEffect, useRef, useState } from 'preact/hooks'
import { errorMessage, pairDevice } from '../actions'
import {
  PAIR_CODE_LENGTH,
  containsHangul,
  normalizePairCode,
  pairCodeFromHash
} from '../lib/format'
import { useStore } from '../lib/store'
import { app } from '../stores'
import { Spinner } from '../ui/primitives'

const NAME_MAX = 40

export function ConnectScreen() {
  const notice = useStore(app, (s) => s.notice)
  const [code, setCode] = useState(() => pairCodeFromHash(location.hash))
  const [name, setName] = useState('내 폰')
  const [focused, setFocused] = useState(false)
  /** 한글 자판으로 친 글자가 지워졌다 — 영문 자판으로 바꾸라고 알린다 */
  const [hangul, setHangul] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const codeRef = useRef<HTMLInputElement>(null)
  /** 한글 조합 중인가 — 조합 중에 입력칸 값을 덮어쓰면 자판이 꼬인다 */
  const composing = useRef(false)

  // 입력칸 값은 코드 상태를 따라간다 (주소로 들어온 코드·붙여 넣기 정리). 조합 중에는 건드리지 않는다
  useEffect(() => {
    const el = codeRef.current
    if (el && !composing.current && el.value !== code) el.value = code
  }, [code])

  // 한글 조합 시작·끝 — Preact 의 onCompositionStart/End 는 실제 compositionstart/end 에 붙지 않는다
  // (브라우저에 oncompositionstart 속성이 없어 'CompositionStart' 라는 엉뚱한 이름으로 등록됨). 직접 붙인다
  useEffect(() => {
    const el = codeRef.current
    if (!el) return
    const onStart = (): void => {
      composing.current = true
    }
    const onEnd = (): void => {
      composing.current = false
      // 조합이 끝났으니 입력칸을 영문·숫자만 남긴 값으로 정리한다
      const next = normalizePairCode(el.value)
      el.value = next
      setCode(next)
    }
    el.addEventListener('compositionstart', onStart)
    el.addEventListener('compositionend', onEnd)
    return () => {
      el.removeEventListener('compositionstart', onStart)
      el.removeEventListener('compositionend', onEnd)
    }
  }, [])

  // 이미 열려 있는 화면에서 연결 주소가 들어오는 경우 (QR 을 다시 읽음)
  useEffect(() => {
    const onHash = (): void => {
      const fromHash = pairCodeFromHash(location.hash)
      if (fromHash) setCode(fromHash)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const trimmed = name.trim()
  const ready = code.length === PAIR_CODE_LENGTH && trimmed.length >= 1 && !busy

  async function submit(e: Event): Promise<void> {
    e.preventDefault()
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      await pairDevice(code, trimmed)
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  const cells = Array.from({ length: PAIR_CODE_LENGTH }, (_, i) => code[i] ?? '')

  return (
    <div class="connect-wrap">
      <main class="connect">
        <div class="brand">
          <img class="brand__mark" src="/icon.svg" alt="" width="44" height="44" />
          <div>
            <h1 class="brand__name">NAIS3</h1>
            <p class="brand__sub">PC의 NAIS3에서 만든 연결 코드로 이 폰을 연결합니다.</p>
          </div>
        </div>

        {notice && (
          <p class="callout callout--warn" role="status">
            {notice}
          </p>
        )}

        <form class="stack" onSubmit={submit}>
          <div class="field">
            <label class="field__label" for="pair-code">
              연결 코드
            </label>
            <div class="code" onClick={() => codeRef.current?.focus()}>
              {cells.map((ch, i) => (
                <div
                  key={i}
                  class={
                    focused && i === Math.min(code.length, PAIR_CODE_LENGTH - 1)
                      ? 'code__cell is-active'
                      : 'code__cell'
                  }
                  aria-hidden="true"
                >
                  {ch}
                </div>
              ))}
              <input
                id="pair-code"
                ref={codeRef}
                class="code__input"
                type="text"
                inputMode="text"
                autocomplete="off"
                autocapitalize="characters"
                autocorrect="off"
                spellcheck={false}
                enterkeyhint="next"
                aria-label="연결 코드 8자리"
                lang="en"
                onInput={(e) => {
                  const input = e.currentTarget as HTMLInputElement
                  const next = normalizePairCode(input.value)
                  setHangul(containsHangul(input.value))
                  setCode(next)
                  // 주소를 통째로 붙여 넣어도 코드만 남긴다 (조합이 끝난 뒤에 정리)
                  if (!composing.current) input.value = next
                }}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
              />
            </div>
            {hangul && (
              <p class="field__error" role="alert">
                한글 자판이 켜져 있습니다. 영문 자판으로 바꿔 입력하세요.
              </p>
            )}
            <p class="field__hint">
              PC NAIS3 → 설정 → 모바일 → 연결 코드 만들기 · 영문 자판으로 입력
            </p>
          </div>

          <div class="field">
            <label class="field__label" for="device-name">
              기기 이름
            </label>
            <input
              id="device-name"
              class="input"
              type="text"
              value={name}
              maxLength={NAME_MAX}
              autocomplete="off"
              onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
            />
          </div>

          {error && (
            <p class="callout callout--error" role="alert">
              {error}
            </p>
          )}

          <button type="submit" class="btn btn--primary btn--block" disabled={!ready}>
            {busy ? <Spinner size={18} /> : null}
            {busy ? '연결 중' : '연결'}
          </button>
        </form>
      </main>
    </div>
  )
}
