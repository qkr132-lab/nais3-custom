import { Loader2, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import type { Scene } from '@shared/types'
import {
  CENSOR_OPTIONS,
  CENSOR_WEIGHT_DEFAULT,
  CENSOR_WEIGHT_MAX,
  CENSOR_WEIGHT_MIN,
  censorPrompt,
  changeCensors,
  changeCensorWeights,
  changeAnalSuppression,
  normalizeAnalSuppression,
  normalizeCensors,
  normalizeCensorWeight,
  normalizeCensorWeights,
  type CensorChanges,
  type CensorKind
} from '@shared/censor-tags'
import { useScenesStore } from '../stores/scenes-store'
import { toast } from '../stores/toast-store'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'

export function CensorStatus({
  scene,
  onEdit
}: {
  scene: Scene
  onEdit: () => void
}): React.JSX.Element {
  const active = new Set(normalizeCensors(scene.censorKinds))
  const weights = normalizeCensorWeights(scene.censorTagWeights)
  // 부위 이름 뒤에 1이 아닌 가중치만 ×1.3 식으로
  const summary = CENSOR_OPTIONS.filter((o) => active.has(o.id))
    .map((o) => `${o.label}${weights[o.id] !== undefined ? ` ×${weights[o.id]}` : ''}`)
    .join(' · ')
  const suppressAnal = normalizeAnalSuppression(scene.suppressAnal)
  const text = [
    summary ? `검열 태그: ${summary}` : '검열 태그 없음',
    suppressAnal ? '항문 성행위 억제' : ''
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <button
      type="button"
      className={cn(
        'flex h-7 w-full min-w-0 items-center gap-1.5 border-t border-line px-2 text-left text-[11px] font-medium outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
        summary || suppressAnal ? 'bg-accent-soft text-accent' : 'bg-surface text-muted'
      )}
      aria-label={`${scene.name}: ${text}, 수정`}
      title={`${text} · 클릭해서 수정`}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        onEdit()
      }}
    >
      <ShieldCheck size={12} className="shrink-0" />
      <span className="truncate">{text}</span>
    </button>
  )
}

/** Mount per editing session: cancel discards all draft changes. */
export function SceneCensorDialog({
  scenes,
  onClose
}: {
  scenes: Scene[]
  onClose: () => void
}): React.JSX.Element {
  const [changes, setChanges] = useState<CensorChanges>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const save = useScenesStore((s) => s.setCensors)
  const n = scenes.length
  const dirty = Object.keys(changes).length > 0
  const suppressionCount = scenes.filter((s) =>
    changeAnalSuppression(s.suppressAnal, changes)
  ).length
  const suppressionMixed = suppressionCount > 0 && suppressionCount < n
  const previews = [
    ...new Set(
      scenes.map((s) =>
        censorPrompt(
          changeCensors(s.censorKinds, changes),
          changeCensorWeights(s.censorTagWeights, changes)
        )
      )
    )
  ]
  // 부위별 가중치 (커스텀) — 씬마다 다르면 "여러 값", 바꾸면 그 값으로 통일. 입력 중 글자는 따로
  const [weightText, setWeightText] = useState<Partial<Record<CensorKind, string>>>({})
  const weightsOf = (kind: CensorKind): number[] => [
    ...new Set(
      scenes.map(
        (s) => changeCensorWeights(s.censorTagWeights, changes)[kind] ?? CENSOR_WEIGHT_DEFAULT
      )
    )
  ]
  const setWeight = (kind: CensorKind, raw: string): void => {
    setWeightText((prev) => ({ ...prev, [kind]: raw }))
    const n = Number(raw)
    if (raw.trim() && Number.isFinite(n))
      setChanges((prev) => ({
        ...prev,
        weights: { ...(prev.weights ?? {}), [kind]: normalizeCensorWeight(n) }
      }))
  }
  const stepWeight = (kind: CensorKind, delta: number): void => {
    const ws = weightsOf(kind)
    setWeight(kind, String(normalizeCensorWeight((ws.length === 1 ? ws[0] : 1) + delta)))
  }
  const setAll = (value: boolean): void =>
    setChanges((prev) => ({
      ...prev,
      ...Object.fromEntries(CENSOR_OPTIONS.map((o) => [o.id, value]))
    }))

  async function apply(): Promise<void> {
    setSaving(true)
    setError('')
    try {
      await save(
        scenes.map((s) => s.id),
        changes
      )
      toast(`${n}개 씬의 검열 태그 설정을 저장했어요.`, 'success')
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : '저장하지 못했어요. 다시 시도해 주세요.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose()
      }}
    >
      <DialogContent
        className="flex max-h-[85dvh] flex-col"
        onEscapeKeyDown={(e) => {
          e.preventDefault()
          if (!saving) onClose()
        }}
      >
        <div className="border-b border-line p-4 pr-10">
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck size={16} /> 검열 태그
          </DialogTitle>
          <DialogDescription className="mt-1 break-words">
            {n === 1 ? scenes[0].name : `선택한 ${n}개 씬`}에 적용할 항목을 골라 주세요.
          </DialogDescription>
        </div>
        <div className="min-h-0 space-y-3 overflow-y-auto p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
            <span className="text-muted">흰색 검열 표현</span>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                disabled={saving || !n}
                onClick={() => setAll(true)}
              >
                모두 켜기
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={saving || !n}
                onClick={() => setAll(false)}
              >
                모두 끄기
              </Button>
            </div>
          </div>
          <fieldset disabled={saving || !n} className="space-y-2">
            <legend className="sr-only">검열 부위</legend>
            {CENSOR_OPTIONS.map((o) => {
              const count = scenes.filter((s) =>
                changeCensors(s.censorKinds, changes).includes(o.id)
              ).length
              const mixed = count > 0 && count < n
              const checked = n > 0 && count === n
              return (
                <div
                  key={o.id}
                  className={cn(
                    'rounded-lg border p-3 text-[13px] focus-within:ring-2 focus-within:ring-accent',
                    count ? 'border-accent/40 bg-accent-soft' : 'border-line bg-paper',
                    saving && 'pointer-events-none opacity-50'
                  )}
                >
                  <label className="flex cursor-pointer items-center gap-3">
                    <input
                      type="checkbox"
                      aria-label={`${o.label} 검열`}
                      checked={checked}
                      aria-checked={mixed ? 'mixed' : checked}
                      ref={(el) => {
                        if (el) el.indeterminate = mixed
                      }}
                      className="size-4 shrink-0 accent-accent"
                      onChange={(e) =>
                        setChanges((prev) => ({ ...prev, [o.id]: e.target.checked }))
                      }
                    />
                    <span className="flex-1 font-medium">{o.label}</span>
                    <span className="text-[12px] text-muted">
                      {mixed ? `일부 적용 ${count}/${n}` : checked ? '적용' : '미적용'}
                    </span>
                  </label>
                  {/* 부위별 가중치 — 1.0이면 그대로, 아니면 이 부위 태그만 1.3::…::로 묶는다 */}
                  {count > 0 &&
                    (() => {
                      const ws = weightsOf(o.id)
                      const wMixed = ws.length > 1
                      const value = weightText[o.id] ?? (wMixed ? '' : String(ws[0]))
                      return (
                        <div className="mt-2 flex flex-wrap items-center gap-1 pl-7 text-[12px]">
                          <span className="mr-1 text-muted">가중치</span>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`${o.label} 가중치 0.1 줄이기`}
                            onClick={() => stepWeight(o.id, -0.1)}
                          >
                            −
                          </Button>
                          <input
                            type="number"
                            inputMode="decimal"
                            step={0.1}
                            min={CENSOR_WEIGHT_MIN}
                            max={CENSOR_WEIGHT_MAX}
                            aria-label={`${o.label} 가중치`}
                            placeholder={wMixed ? '여러 값' : String(CENSOR_WEIGHT_DEFAULT)}
                            value={value}
                            className="h-7 w-16 rounded-md border border-line bg-surface px-1.5 text-center tabular-nums outline-none focus:ring-2 focus:ring-accent"
                            onChange={(e) => setWeight(o.id, e.target.value)}
                            onBlur={() => setWeightText((prev) => ({ ...prev, [o.id]: undefined }))}
                          />
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`${o.label} 가중치 0.1 늘리기`}
                            onClick={() => stepWeight(o.id, 0.1)}
                          >
                            +
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!wMixed && ws[0] === CENSOR_WEIGHT_DEFAULT}
                            onClick={() => setWeight(o.id, String(CENSOR_WEIGHT_DEFAULT))}
                          >
                            기본 1.0
                          </Button>
                          {wMixed && (
                            <span className="text-[11px] text-muted">
                              씬마다 다름 ({ws.join(' · ')})
                            </span>
                          )}
                        </div>
                      )
                    })()}
                </div>
              )
            })}
          </fieldset>
          <div className="space-y-2 rounded-lg border border-line bg-paper p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p id="anal-suppression-label" className="text-[13px] font-medium">
                  항문 성행위 억제
                </p>
                <p className="mt-1 text-[11px] text-muted">
                  {suppressionMixed
                    ? `일부 켜짐 ${suppressionCount}/${n}`
                    : suppressionCount > 0
                      ? '켜짐'
                      : '꺼짐'}
                </p>
              </div>
              <div role="group" aria-labelledby="anal-suppression-label" className="flex gap-1">
                {[true, false].map((enabled) => (
                  <Button
                    key={String(enabled)}
                    size="sm"
                    variant={
                      !suppressionMixed && suppressionCount > 0 === enabled ? 'accent' : 'default'
                    }
                    disabled={saving || !n}
                    aria-label={`항문 성행위 억제 ${enabled ? 'ON' : 'OFF'}`}
                    aria-pressed={!suppressionMixed && suppressionCount > 0 === enabled}
                    onClick={() => setChanges((prev) => ({ ...prev, suppressAnal: enabled }))}
                  >
                    {enabled ? 'ON' : 'OFF'}
                  </Button>
                ))}
              </div>
            </div>
            <p className="text-[11px] leading-relaxed text-muted">
              켜면 네거티브에 억제 태그를 추가해요. 항문 검열과 별도로 설정하며, 생성 결과는 달라질
              수 있어요.
            </p>
          </div>
          <p className="text-[12px] leading-relaxed text-muted">
            {n > 1 && '바꾸지 않은 항목은 씬별 설정을 유지해요. '}
            생성할 때 첫 캐릭터 프롬프트 끝에 태그를 붙여요. 캐릭터가 없으면 기본 프롬프트 끝에
            붙여요. 가중치가 1.0이 아닌 부위는 그 태그만 1.3::…::처럼 묶어요. 기존 이미지는 바뀌지
            않아요.
          </p>
          <details className="rounded-md border border-line p-3 text-[12px]">
            <summary className="cursor-pointer text-muted">
              적용 태그 미리보기{previews.length > 1 ? ` (${previews.length}가지 조합)` : ''}
            </summary>
            <div className="mt-2 space-y-2">
              {previews.map((p) => (
                <p key={p} className="select-text break-words font-mono text-[12px]">
                  {p || '추가할 검열 태그 없음'}
                </p>
              ))}
              {suppressionCount > 0 && (
                <p className="select-text break-words text-[12px]">
                  네거티브: <span className="font-mono">anal</span>
                  {suppressionMixed && ` (${suppressionCount}/${n}개 씬)`}
                </p>
              )}
            </div>
          </details>
          <p className="text-[12px] text-muted">
            중복 태그는 한 번만 넣어요. 실제 검열 여부는 생성 결과에서 확인해 주세요.
          </p>
          {error && (
            <p role="alert" className="break-words text-[12px] text-danger">
              {error}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-line p-4">
          <Button disabled={saving} onClick={onClose}>
            취소
          </Button>
          <Button variant="accent" disabled={!n || !dirty || saving} onClick={() => void apply()}>
            {saving && <Loader2 size={14} className="animate-spin" />}
            {saving ? '저장 중…' : `${n}개 씬에 적용`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
