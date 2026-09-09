import { Loader2, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import type { Scene } from '@shared/types'
import {
  CENSOR_OPTIONS,
  censorLabel,
  censorPrompt,
  changeCensors,
  changeCensorWeights,
  changeAnalSuppression,
  normalizeAnalSuppression,
  DEFAULT_CENSOR_WEIGHTS,
  type CensorWeights,
  type CensorChanges
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
  const summary = censorLabel(scene.censorKinds)
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
          changeCensorWeights(s.censorWeights, changes)
        )
      )
    )
  ]
  const setAll = (value: boolean): void =>
    setChanges((prev) => ({
      ...prev,
      ...Object.fromEntries(CENSOR_OPTIONS.map((o) => [o.id, value]))
    }))

  const weightControl = (
    key: keyof CensorWeights,
    label: string,
    disabled = false
  ): React.JSX.Element => {
    const values = scenes.map((s) => changeCensorWeights(s.censorWeights, changes)[key])
    const mixed = new Set(values).size > 1
    const value = mixed ? DEFAULT_CENSOR_WEIGHTS[key] : (values[0] ?? DEFAULT_CENSOR_WEIGHTS[key])
    const suppress = key === 'suppress'
    return (
      <div className="space-y-1.5">
        <label
          className="flex items-center justify-between gap-2 text-[12px]"
          htmlFor={`censor-weight-${key}`}
        >
          <span className="text-muted">{label}</span>
          <span className="font-mono text-accent">
            {mixed ? '서로 다름' : `${suppress && value ? '−' : ''}${value.toFixed(1)}`}
          </span>
        </label>
        <input
          id={`censor-weight-${key}`}
          type="range"
          min={suppress ? 0 : 0.1}
          max={suppress ? 3 : 5}
          step={0.1}
          aria-label={label}
          aria-valuetext={
            mixed ? '씬마다 다름, 조절하면 같은 값으로 적용' : `${suppress ? -value : value}`
          }
          value={value}
          disabled={disabled || saving || !n}
          className="h-6 w-full cursor-pointer accent-accent disabled:cursor-default disabled:opacity-40"
          onChange={(e) =>
            setChanges((prev) => ({
              ...prev,
              weights: { ...prev.weights, [key]: Number(e.target.value) }
            }))
          }
        />
        <div className="flex justify-between text-[11px] text-muted">
          <span>{suppress ? '억제 없음' : '약하게'}</span>
          <span>{suppress ? '강하게 억제' : '강하게'}</span>
        </div>
      </div>
    )
  }

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
                    'space-y-3 rounded-lg border p-3 text-[13px] focus-within:ring-2 focus-within:ring-accent',
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
                  {count > 0 && weightControl(o.id, `${o.label} 검열 강도`)}
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
          <div className="space-y-3 rounded-lg border border-line p-3">
            {weightControl('suppress', '보정 태그 억제 강도')}
            <p className="text-[11px] leading-relaxed text-muted">
              색상·혈관 등 함께 넣는 보정 태그의 음수 가중치예요. 0이면 보정 태그를 추가하지 않아요.
            </p>
            <Button
              size="sm"
              variant="ghost"
              disabled={saving || !n}
              onClick={() =>
                setChanges((prev) => ({ ...prev, weights: { ...DEFAULT_CENSOR_WEIGHTS } }))
              }
            >
              가중치 기본값 복원
            </Button>
          </div>
          <p className="text-[12px] leading-relaxed text-muted">
            {n > 1 && '바꾸지 않은 항목은 씬별 설정을 유지해요. '}
            생성할 때 태그를 추가하며, 기존 이미지는 바뀌지 않아요.
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
