import { Check, Copy, ImageOff, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ImageMetadata } from '@shared/types'
import { useMetadataStore } from '../stores/metadata-store'
import { toast } from '../stores/toast-store'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'

const UC_LABELS: Record<number, string> = { 0: 'Heavy', 1: 'Light', 3: 'Human Focus', 4: 'None' }

/**
 * 이미지 메타데이터 팝업 — 좌: 이미지+파라미터 / 우: 프롬프트. 체크한 요소만 적용.
 * 가독성 개조 (커스텀): 고정 높이 대신 내용만큼 늘어나는 블록 + 컬럼별 스크롤이라
 * 긴 프롬프트도 겹치지 않고, 모든 항목에 복사 버튼(파라미터는 호버 시)이 붙는다.
 */
export function MetadataDialog(): React.JSX.Element {
  const open = useMetadataStore((s) => s.open)
  const loading = useMetadataStore((s) => s.loading)
  const meta = useMetadataStore((s) => s.meta)
  const error = useMetadataStore((s) => s.error)
  const imageSrc = useMetadataStore((s) => s.imageSrc)
  const close = useMetadataStore((s) => s.close)
  const applyToMain = useMetadataStore((s) => s.applyToMain)

  // 기본 전부 체크, 시드만 해제
  const [sel, setSel] = useState<Record<string, boolean>>({})
  useEffect(() => {
    if (!meta) return
    const timer = setTimeout(() => {
      setSel({
        prompt: true,
        negativePrompt: true,
        characters: true,
        quality: true,
        ucPreset: true,
        seed: false,
        steps: true,
        cfgScale: true,
        cfgRescale: true,
        sampler: true,
        noiseSchedule: true,
        resolution: true,
        variety: true
      })
    })
    return () => clearTimeout(timer)
  }, [meta])
  const toggle = (k: string): void => setSel((s) => ({ ...s, [k]: !s[k] }))

  /** 전체 복사 — 프롬프트/네거티브/캐릭터/파라미터를 읽기 좋은 텍스트로 */
  const copyAll = (): void => {
    if (!meta) return
    const lines: string[] = []
    lines.push(`[프롬프트]\n${meta.prompt}`)
    if (meta.negativePrompt) lines.push(`[네거티브]\n${meta.negativePrompt}`)
    meta.characterPrompts?.forEach((c, i) => {
      lines.push(`[캐릭터 ${i + 1}]\n${c.prompt}${c.negativePrompt ? `\nuc: ${c.negativePrompt}` : ''}`)
    })
    const params: string[] = []
    if (meta.seed != null) params.push(`시드 ${meta.seed}`)
    if (meta.steps != null) params.push(`스텝 ${meta.steps}`)
    if (meta.cfgScale != null) params.push(`CFG ${meta.cfgScale}`)
    if (meta.sampler) params.push(`샘플러 ${meta.sampler}`)
    if (meta.width && meta.height) params.push(`${meta.width}×${meta.height}`)
    if (params.length) lines.push(`[파라미터] ${params.join(' · ')}`)
    void navigator.clipboard.writeText(lines.join('\n\n'))
    toast('전체 메타데이터 복사됨', 'success')
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      {/* 고정 높이 + 컬럼별 스크롤 — 긴 프롬프트도 겹침 없이 읽힌다 */}
      <DialogContent className="flex h-[85vh] max-h-[85vh] max-w-[920px] flex-col p-0">
        <div className="flex items-center gap-2 border-b border-line px-5 py-3.5">
          <DialogTitle className="text-[15px]">
            이미지 메타데이터{' '}
            <span className="text-[12px] font-normal text-faint">— 체크한 항목만 적용</span>
          </DialogTitle>
          <div className="flex-1" />
          <Button size="sm" variant="ghost" className="mr-6 gap-1.5" disabled={!meta} onClick={copyAll}>
            <Copy size={13} /> 전체 복사
          </Button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-muted">
            <Loader2 size={18} className="animate-spin" /> 읽는 중…
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-3 py-14 text-danger">
            <ImageOff size={30} strokeWidth={1.4} />
            <p className="text-[13px]">{error}</p>
          </div>
        ) : meta ? (
          <div className="flex min-h-0 flex-1">
            {/* 좌: 이미지(상) + 파라미터(하) — 독립 스크롤 */}
            <div className="flex w-[40%] shrink-0 flex-col gap-3 overflow-y-auto border-r border-line p-4">
              <div className="flex items-center justify-center overflow-hidden rounded-lg border border-line bg-surface-2/40">
                {imageSrc ? (
                  <img src={imageSrc} className="max-h-[300px] w-full object-contain" alt="" />
                ) : (
                  <div className="flex h-40 items-center justify-center text-faint">
                    <ImageOff size={28} strokeWidth={1.3} />
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <Stat k="seed" label="시드" value={meta.seed} sel={sel} toggle={toggle} />
                <Stat k="steps" label="스텝" value={meta.steps} sel={sel} toggle={toggle} />
                <Stat k="cfgScale" label="CFG" value={meta.cfgScale} sel={sel} toggle={toggle} />
                <Stat
                  k="cfgRescale"
                  label="CFG Rescale"
                  value={meta.cfgRescale}
                  sel={sel}
                  toggle={toggle}
                />
                <Stat k="sampler" label="샘플러" value={meta.sampler} sel={sel} toggle={toggle} />
                <Stat
                  k="noiseSchedule"
                  label="스케줄"
                  value={meta.noiseSchedule}
                  sel={sel}
                  toggle={toggle}
                />
                <Stat
                  k="resolution"
                  label="해상도"
                  value={meta.width && meta.height ? `${meta.width}×${meta.height}` : undefined}
                  sel={sel}
                  toggle={toggle}
                />
                <Stat
                  k="variety"
                  label="Variety+"
                  value={meta.variety ? 'ON' : undefined}
                  sel={sel}
                  toggle={toggle}
                />
                <Stat
                  k="quality"
                  label="퀄리티 태그"
                  value={
                    meta.qualityToggle ? 'ON' : meta.qualityToggle === false ? 'OFF' : undefined
                  }
                  sel={sel}
                  toggle={toggle}
                />
                <Stat
                  k="ucPreset"
                  label="UC 프리셋"
                  value={
                    meta.ucPreset != null
                      ? (UC_LABELS[meta.ucPreset] ?? `#${meta.ucPreset}`)
                      : undefined
                  }
                  sel={sel}
                  toggle={toggle}
                />
                {/* 모델은 표시만 (적용 대상 아님) */}
                {meta.model && (
                  <div className="col-span-2 rounded-md border border-line bg-surface-2/40 px-2.5 py-1.5">
                    <p className="text-[10.5px] text-faint">모델</p>
                    <p className="break-all font-mono text-[12px] leading-snug text-ink">
                      {meta.model}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* 우: 프롬프트 — 내용만큼 늘어나는 블록 + 컬럼 스크롤 (겹침 없음) */}
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              {meta.promptParts ? (
                <SplitPreview meta={meta} sel={sel} toggle={toggle} />
              ) : (
                <Field
                  k="prompt"
                  label="프롬프트"
                  value={meta.prompt}
                  sel={sel}
                  toggle={toggle}
                />
              )}
              <Field
                k="negativePrompt"
                label="네거티브"
                value={meta.negativePrompt}
                sel={sel}
                toggle={toggle}
              />
              {meta.characterPrompts && meta.characterPrompts.length > 0 && (
                <div>
                  <CheckLabel
                    checked={sel.characters}
                    onClick={() => toggle('characters')}
                    label={`캐릭터 ${meta.characterPrompts.length}`}
                  />
                  <div className={cn('mt-1.5 space-y-2', !sel.characters && 'opacity-40')}>
                    {meta.characterPrompts.map((c, i) => (
                      <div key={i} className="rounded-md border border-line bg-surface-2/40 p-2.5">
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <p className="text-[10.5px] font-medium text-faint">캐릭터 {i + 1}</p>
                          <CopyButton value={c.prompt} label={`캐릭터 ${i + 1} 복사`} />
                        </div>
                        <PromptText value={c.prompt} className="text-[12px]" />
                        {c.negativePrompt && (
                          <>
                            <div className="mt-2 flex items-center justify-between gap-2 border-t border-line/50 pt-1.5">
                              <p className="text-[10.5px] text-faint">네거티브</p>
                              <CopyButton value={c.negativePrompt} label="캐릭터 네거티브 복사" />
                            </div>
                            <PromptText value={c.negativePrompt} className="text-[11.5px] text-muted" />
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : null}

        <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <Button variant="ghost" onClick={close}>
            닫기
          </Button>
          <Button variant="accent" disabled={!meta} onClick={() => applyToMain(sel)}>
            메인에 적용
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SplitPreview({
  meta,
  sel,
  toggle
}: {
  meta: ImageMetadata
  sel: Record<string, boolean>
  toggle: (k: string) => void
}): React.JSX.Element {
  const parts = meta.promptParts
  return (
    <div>
      <div className="mb-1.5">
        <CheckLabel checked={sel.prompt} onClick={() => toggle('prompt')} label="프롬프트 3분할" />
      </div>
      <div className={cn('space-y-2', !sel.prompt && 'opacity-40')}>
        <Part label="고정" value={parts?.base ?? ''} />
        <Part label="가변" value={parts?.additional ?? ''} />
        <Part label="디테일" value={parts?.detail ?? ''} />
      </div>
    </div>
  )
}

function Part({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-md border border-line bg-surface-2/40 p-2.5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-[10.5px] font-medium text-faint">{label}</p>
        <CopyButton value={value} label={`${label} 복사`} />
      </div>
      <PromptText value={value} className="text-[12px]" />
    </div>
  )
}

/** 체크 표시 + 라벨 (클릭 토글) */
function CheckLabel({
  checked,
  onClick,
  label
}: {
  checked?: boolean
  onClick: () => void
  label: string
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 text-[12px] font-medium text-muted hover:text-ink"
    >
      <span
        className={cn(
          'grid size-4 place-items-center rounded border transition-colors',
          checked ? 'border-accent bg-accent text-white' : 'border-line bg-surface'
        )}
      >
        {checked && <Check size={11} strokeWidth={3} />}
      </span>
      {label}
    </button>
  )
}

function Field({
  k,
  label,
  value,
  sel,
  toggle
}: {
  k: string
  label: string
  value: string
  sel: Record<string, boolean>
  toggle: (k: string) => void
}): React.JSX.Element {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <CheckLabel checked={sel[k]} onClick={() => toggle(k)} label={label} />
        <CopyButton value={value} label={`${label} 복사`} />
      </div>
      <div
        className={cn(
          'rounded-md border border-line bg-surface-2/40 p-2.5',
          !sel[k] && 'opacity-40'
        )}
      >
        <PromptText value={value} className="text-[12.5px]" />
      </div>
    </div>
  )
}

/** 프롬프트 표시 — 내용만큼 늘어나고(겹침 없음), 드래그 선택 가능. 아주 길면 자체 스크롤 */
function PromptText({ value, className }: { value: string; className?: string }): React.JSX.Element {
  return (
    <div
      className={cn(
        'max-h-[45vh] select-text overflow-y-auto whitespace-pre-wrap break-words font-mono leading-relaxed text-ink',
        !value && 'font-sans text-faint',
        className
      )}
    >
      {value || '(없음)'}
    </div>
  )
}

/** 복사 버튼 — 누르면 1초간 체크 표시 + 토스트로 피드백 */
function CopyButton({ value, label }: { value: string; label: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className={cn(
        'grid size-6 shrink-0 place-items-center rounded-md transition-colors disabled:opacity-35',
        copied ? 'text-emerald-500' : 'text-faint hover:bg-surface-2 hover:text-ink'
      )}
      title={label}
      disabled={!value}
      onClick={() => {
        if (!value) return
        void navigator.clipboard.writeText(value)
        toast('복사됨', 'success')
        setCopied(true)
        setTimeout(() => setCopied(false), 1000)
      }}
    >
      {copied ? <Check size={13} strokeWidth={3} /> : <Copy size={13} />}
    </button>
  )
}

function Stat({
  k,
  label,
  value,
  sel,
  toggle
}: {
  k: string
  label: string
  value?: string | number
  sel: Record<string, boolean>
  toggle: (k: string) => void
}): React.JSX.Element | null {
  if (value == null || value === '') return null
  const checked = sel[k]
  return (
    <div
      className={cn(
        'group flex items-center gap-2 rounded-md border bg-surface-2/40 px-2 py-1.5 transition-colors',
        checked ? 'border-accent/50' : 'border-line opacity-50'
      )}
    >
      <button onClick={() => toggle(k)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <span
          className={cn(
            'grid size-4 shrink-0 place-items-center rounded border transition-colors',
            checked ? 'border-accent bg-accent text-white' : 'border-line bg-surface'
          )}
        >
          {checked && <Check size={11} strokeWidth={3} />}
        </span>
        <span className="min-w-0">
          <span className="block text-[10.5px] text-faint">{label}</span>
          <span className="block truncate font-mono text-[12.5px] text-ink">{value}</span>
        </span>
      </button>
      {/* 값 복사 — 호버 시 표시 (시드 등 개별 복사) */}
      <span className="opacity-0 transition-opacity group-hover:opacity-100">
        <CopyButton value={String(value)} label={`${label} 복사`} />
      </span>
    </div>
  )
}
