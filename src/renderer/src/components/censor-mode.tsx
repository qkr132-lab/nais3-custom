import { useEffect, useRef, useState } from 'react'
import { EyeOff, FolderOpen, Loader2, Play, ScanEye, Square, Sparkles } from 'lucide-react'
import {
  CENSOR_PARTS,
  DEFAULT_CENSOR_OPTIONS,
  mosaicBlockSize,
  type CensorFileResult,
  type CensorMethod,
  type CensorOptions,
  type CensorPart,
  type CensorProgress
} from '@shared/censor'
import type { IpcInvokeMap } from '@shared/types'
import { cn } from '../lib/utils'
import { askConfirm } from '../stores/dialog-store'
import { toast } from '../stores/toast-store'
import { Button } from './ui/button'
import { Slider } from './ui/slider'
import { Switch } from './ui/switch'

type Status = IpcInvokeMap['censor:status']['res']
type Preview = IpcInvokeMap['censor:preview']['res']

const PART_LABEL: Record<CensorPart, string> = Object.fromEntries(
  CENSOR_PARTS.map((p) => [p.id, p.label])
) as Record<CensorPart, string>

const METHODS: { id: CensorMethod; label: string; hint: string }[] = [
  { id: 'mosaic', label: '모자이크', hint: '긴 변의 1/100 칸 (판매처 기준), 이 PC에서 바로' },
  { id: 'black', label: '검은 막대', hint: '검은색으로 덮기' },
  { id: 'white', label: '흰 가림', hint: '흰색으로 덮기' },
  { id: 'nai', label: 'NAI 인페인팅', hint: '검열 태그를 NAI가 그림 — Opus 무료 조건만, 시험 기능' }
]

const NAI_TAGS: CensorOptions['naiTag'][] = [
  'mosaic censoring',
  'bar censor',
  'blank censor',
  'heart censor'
]

const PHASE_LABEL: Record<CensorProgress['phase'], string> = {
  idle: '',
  model: '모델 받는 중',
  gemma: 'Gemma 켜는 중',
  scan: '준비 중',
  work: '검열 중',
  done: '끝',
  cancelled: '중단됨',
  error: '오류'
}

/**
 * 자동 검열 탭 (커스텀).
 * 폴더를 고르면 그림마다 성기·유두·항문을 찾아 넓게 잡은 뒤 모자이크(또는 가림·NAI 인페인팅)한다.
 * 원본은 건드리지 않고 저장 폴더에 같은 구조로 쓴다.
 */
export function CensorMode(): React.JSX.Element {
  const [options, setOptions] = useState<CensorOptions>(DEFAULT_CENSOR_OPTIONS)
  const [status, setStatus] = useState<Status | null>(null)
  const [progress, setProgress] = useState<CensorProgress | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState<'' | 'preview' | 'nai'>('')
  const [results, setResults] = useState<CensorFileResult[]>([])
  const loaded = useRef(false)

  const refresh = async (): Promise<void> => {
    const s = await window.nais.invoke('censor:status', undefined)
    setStatus(s)
    setProgress(s.progress)
    if (!s.progress.running && s.progress.phase !== 'idle') {
      const r = await window.nais.invoke('censor:results', undefined)
      setResults(r.items)
    }
  }

  useEffect(() => {
    void (async () => {
      const { options } = await window.nais.invoke('censor:getOptions', undefined)
      setOptions(options)
      loaded.current = true
      await refresh()
    })()
    return window.nais.on('censor:progress', (p) => {
      setProgress(p)
      if (!p.running && (p.phase === 'done' || p.phase === 'cancelled' || p.phase === 'error')) {
        void refresh()
      }
    })
  }, [])

  // 바꿀 때마다 저장 (다음에 열어도 그대로)
  const update = (patch: Partial<CensorOptions>): void => {
    setOptions((prev) => {
      const next = { ...prev, ...patch }
      if (loaded.current) {
        void window.nais.invoke('censor:setOptions', { options: next }).then(refresh)
      }
      return next
    })
  }

  const pickFolder = async (key: 'folder' | 'outputFolder'): Promise<void> => {
    const { path } = await window.nais.invoke('censor:pickFolder', {
      title: key === 'folder' ? '검열할 그림 폴더' : '검열본을 저장할 폴더'
    })
    if (path) update({ [key]: path })
  }

  const togglePart = (part: CensorPart): void => {
    const parts = options.parts.includes(part)
      ? options.parts.filter((p) => p !== part)
      : [...options.parts, part]
    update({ parts })
  }

  const runPreview = async (nai = false): Promise<void> => {
    if (!options.folder) return toast('원본 폴더를 먼저 고르세요', 'info')
    if (nai) {
      const ok = await askConfirm('NAI로 1장 시험', {
        message:
          '폴더의 첫 그림 한 장을 NAI 인페인팅으로 보냅니다. Opus 무료 조건만 보내고, 잔액이 줄면 바로 멈춥니다. V5 무료 한도는 1장만큼 줄어듭니다.',
        confirmLabel: '보내기',
        important: true
      })
      if (!ok) return
    }
    setBusy(nai ? 'nai' : 'preview')
    try {
      setPreview(await window.nais.invoke('censor:preview', { options, nai }))
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setBusy('')
      void refresh()
    }
  }

  const start = async (): Promise<void> => {
    if (!options.folder) return toast('원본 폴더를 먼저 고르세요', 'info')
    if (!options.parts.length) return toast('가릴 부위를 하나 이상 고르세요', 'info')
    if (options.method === 'nai') {
      const ok = await askConfirm('NAI 인페인팅으로 검열', {
        message:
          '찾은 그림마다 NAI 인페인팅을 한 번씩 보냅니다. Opus 무료 조건(1024×1024 이하·64 배수·28스텝)만 보내고, 한 번이라도 Anlas가 줄거나 V5 무료 한도가 바닥나면 그 자리에서 멈춥니다. 그래도 무료 한도는 장수만큼 줄어듭니다. 먼저 「NAI로 1장 시험」을 해보길 권합니다.',
        confirmLabel: '시작',
        important: true
      })
      if (!ok) return
    }
    setResults([])
    try {
      await window.nais.invoke('censor:start', { options })
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const running = !!progress?.running
  const outputFolder = status?.outputFolder || ''
  const notInstalled = (status?.models ?? []).filter(
    (m, i) => !m.installed && (i === 0 || options.extraModel)
  )
  const failed = results.filter((r) => r.status === 'failed')

  return (
    <div className="flex min-h-0 min-w-0 flex-1 gap-4 overflow-hidden p-4">
      {/* 설정 */}
      <div className="flex w-[380px] min-w-[260px] max-w-[45%] shrink flex-col gap-3 overflow-auto pr-1">
        {status?.runtime && (
          <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">
            {status.runtime}
          </div>
        )}

        <Section title="원본 폴더">
          <FolderRow
            path={options.folder}
            empty="고르지 않음"
            onPick={() => void pickFolder('folder')}
            onOpen={
              options.folder
                ? () => void window.nais.invoke('censor:openFolder', { path: options.folder })
                : undefined
            }
          />
          <Toggle
            label="하위 폴더까지"
            checked={options.recursive}
            onChange={(v) => update({ recursive: v })}
          />
        </Section>

        <Section title="저장 폴더">
          <FolderRow
            path={options.outputFolder || outputFolder}
            empty="원본 폴더 옆 「이름_검열」"
            muted={!options.outputFolder}
            onPick={() => void pickFolder('outputFolder')}
            onOpen={
              outputFolder && status?.outputExists
                ? () => void window.nais.invoke('censor:openFolder', { path: outputFolder })
                : undefined
            }
          />
          {options.outputFolder && (
            <button
              className="self-start text-[11.5px] text-muted underline-offset-2 hover:underline"
              onClick={() => update({ outputFolder: '' })}
            >
              기본 위치
            </button>
          )}
          <p className="text-[11px] text-faint">원본은 그대로 두고 같은 폴더 구조로 저장합니다.</p>
        </Section>

        <Section title="가릴 부위">
          <div className="flex flex-wrap gap-1.5">
            {CENSOR_PARTS.map((p) => (
              <Chip
                key={p.id}
                active={options.parts.includes(p.id)}
                onClick={() => togglePart(p.id)}
              >
                {p.label}
              </Chip>
            ))}
          </div>
        </Section>

        <Section title="방식">
          <div className="grid grid-cols-2 gap-1.5">
            {METHODS.map((m) => (
              <button
                key={m.id}
                title={m.hint}
                className={cn(
                  'rounded-md border px-2 py-1.5 text-[12.5px] transition-colors',
                  options.method === m.id
                    ? 'border-accent bg-accent-soft text-ink'
                    : 'border-line bg-surface-2 text-muted hover:border-accent/50'
                )}
                onClick={() => update({ method: m.id })}
              >
                {m.label}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-faint">
            {METHODS.find((m) => m.id === options.method)?.hint}
          </p>
          {options.method === 'mosaic' && (
            <SliderRow
              label={(v) => `모자이크 칸 — 1024px 그림 기준 ${mosaicBlockSize(1024, 1024, v)}px`}
              value={options.mosaicScale}
              min={1}
              max={3}
              step={0.25}
              onChange={(v) => update({ mosaicScale: v })}
            />
          )}
          {options.method === 'nai' && (
            <div className="flex flex-wrap gap-1.5">
              {NAI_TAGS.map((t) => (
                <Chip key={t} active={options.naiTag === t} onClick={() => update({ naiTag: t })}>
                  {t}
                </Chip>
              ))}
            </div>
          )}
        </Section>

        <Section title="찾기">
          <SliderRow
            label={(v) => `가리는 범위 ×${v.toFixed(2)}`}
            value={options.expandScale}
            min={0.8}
            max={2}
            step={0.05}
            onChange={(v) => update({ expandScale: v })}
          />
          <Toggle
            label="민감하게 (더 잡고, 엉뚱한 곳도 더 가림)"
            checked={options.sensitivity === 'high'}
            onChange={(v) => update({ sensitivity: v ? 'high' : 'normal' })}
          />
          <Toggle
            label="보강 모델 — 항문·남성 성기를 더 잡음"
            checked={options.extraModel}
            onChange={(v) => update({ extraModel: v })}
          />
          <Toggle
            label={
              status?.gemma.model
                ? 'Gemma로 한 번 더 확인 — 여성 성기를 더 찾음 (장당 2초)'
                : 'Gemma로 한 번 더 확인 (없음)'
            }
            checked={options.gemma}
            disabled={!status?.gemma.model && !options.gemma}
            onChange={(v) => update({ gemma: v })}
          />
          {!status?.gemma.model && (
            <p className="text-[11px] text-faint">
              {status?.gemma.dir} 에 llama-server와 Gemma GGUF(모델·mmproj)를 두면 켤 수 있습니다.
            </p>
          )}
          {notInstalled.length > 0 && (
            <p className="text-[11px] text-faint">
              처음 쓸 때 탐지 모델을 받습니다 (
              {notInstalled.map((m) => `${m.name} ${(m.bytes / 1048576).toFixed(0)}MB`).join(', ')})
            </p>
          )}
        </Section>

        <Section title="저장">
          <Toggle
            label="아무것도 못 찾은 그림도 그대로 복사"
            checked={options.copyClean}
            onChange={(v) => update({ copyClean: v })}
          />
          <Toggle
            label="같은 이름이 있으면 덮어쓰기 (끄면 건너뜀)"
            checked={options.overwrite}
            onChange={(v) => update({ overwrite: v })}
          />
        </Section>
      </div>

      {/* 미리보기 · 진행 */}
      <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-hidden">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="gap-1.5"
            disabled={running || !!busy}
            onClick={() => void runPreview(false)}
          >
            {busy === 'preview' ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <ScanEye size={14} />
            )}
            미리보기
          </Button>
          {options.method === 'nai' && (
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5"
              disabled={running || !!busy}
              onClick={() => void runPreview(true)}
            >
              {busy === 'nai' ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Sparkles size={14} />
              )}
              NAI로 1장 시험
            </Button>
          )}
          <div className="flex-1" />
          {running ? (
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5"
              onClick={() => void window.nais.invoke('censor:cancel', undefined)}
            >
              <Square size={13} /> 중단
            </Button>
          ) : (
            <Button
              size="sm"
              className="gap-1.5"
              disabled={!!busy || !!status?.runtime}
              onClick={() => void start()}
            >
              <Play size={13} /> 시작
            </Button>
          )}
        </div>

        {progress && progress.phase !== 'idle' && <ProgressPanel p={progress} />}

        <div className="grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-hidden">
          <Pane title="원본">
            {preview ? (
              <img src={preview.before} className="max-h-full max-w-full object-contain" />
            ) : (
              <Empty />
            )}
          </Pane>
          <Pane
            title={
              preview
                ? `검열본 — ${preview.boxes ? `${preview.boxes}곳` : '찾은 곳 없음'}${
                    preview.parts.length
                      ? ` · ${preview.parts.map((p) => PART_LABEL[p]).join(', ')}`
                      : ''
                  }`
                : '검열본'
            }
          >
            {preview ? (
              <img src={preview.after} className="max-h-full max-w-full object-contain" />
            ) : (
              <Empty />
            )}
          </Pane>
        </div>

        {failed.length > 0 && (
          <div className="max-h-40 shrink-0 overflow-auto rounded-md border border-line bg-surface-2 p-2 text-[11.5px]">
            <div className="mb-1 font-medium text-danger">실패 {failed.length}장</div>
            {failed.slice(0, 200).map((r) => (
              <div key={r.file} className="truncate text-faint">
                {r.file} — {r.error}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  // ipc 오류는 "Error invoking remote method '...': Error: 실제 문구" 모양
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

function ProgressPanel({ p }: { p: CensorProgress }): React.JSX.Element {
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0
  return (
    <div className="shrink-0 rounded-md border border-line bg-surface-2 p-3 text-[12px]">
      <div className="flex items-center gap-2">
        {p.running && <Loader2 size={13} className="animate-spin text-accent" />}
        <span className="font-medium">{PHASE_LABEL[p.phase]}</span>
        {p.phase === 'work' && (
          <span className="font-mono text-muted">
            {p.done}/{p.total} ({pct}%)
          </span>
        )}
        {p.download != null && (
          <span className="font-mono text-muted">{Math.round(p.download * 100)}%</span>
        )}
        <span className="min-w-0 flex-1 truncate text-faint">
          {p.current || (p.phase === 'error' ? '' : p.message)}
        </span>
      </div>
      {p.phase === 'work' || p.phase === 'done' || p.phase === 'cancelled' ? (
        <>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line">
            <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 text-muted">
            <span>검열 {p.censored}</span>
            <span>없음 {p.clean}</span>
            <span>건너뜀 {p.skipped}</span>
            {p.failed > 0 && <span className="text-danger">실패 {p.failed}</span>}
            {!p.running && p.outputFolder && (
              <button
                className="ml-auto flex items-center gap-1 text-accent hover:underline"
                onClick={() =>
                  void window.nais.invoke('censor:openFolder', { path: p.outputFolder })
                }
              >
                <FolderOpen size={12} /> 저장 폴더 열기
              </button>
            )}
          </div>
        </>
      ) : (
        p.phase === 'error' && <div className="mt-1 text-danger">{p.message}</div>
      )}
    </div>
  )
}

function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-surface-2 p-3">
      <div className="text-[12px] font-medium text-muted">{title}</div>
      {children}
    </div>
  )
}

function FolderRow({
  path,
  empty,
  muted,
  onPick,
  onOpen
}: {
  path: string
  empty: string
  muted?: boolean
  onPick: () => void
  onOpen?: () => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      <button
        className={cn(
          'min-w-0 flex-1 truncate rounded-md border border-line bg-paper px-2 py-1.5 text-left text-[12px]',
          path && !muted ? 'text-ink' : 'text-faint'
        )}
        title={path || empty}
        onClick={onOpen ?? onPick}
      >
        {path || empty}
      </button>
      <Button size="sm" variant="ghost" className="shrink-0 gap-1" onClick={onPick}>
        <FolderOpen size={13} /> 고르기
      </Button>
    </div>
  )
}

function Toggle({
  label,
  checked,
  disabled,
  onChange
}: {
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}): React.JSX.Element {
  return (
    <label className={cn('flex items-center gap-2 text-[12.5px]', disabled && 'opacity-50')}>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
      <span className="min-w-0 flex-1">{label}</span>
    </label>
  )
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  onChange
}: {
  label: (value: number) => string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}): React.JSX.Element {
  // 끄는 동안만 따로 들고, 놓으면 저장 (끌 때마다 저장하지 않게)
  const [dragging, setDragging] = useState<number | null>(null)
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12px] text-muted">{label(dragging ?? value)}</span>
      <Slider
        min={min}
        max={max}
        step={step}
        value={[dragging ?? value]}
        onValueChange={([v]) => setDragging(v)}
        onValueCommit={([v]) => {
          setDragging(null)
          onChange(v)
        }}
      />
    </div>
  )
}

function Chip({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      className={cn(
        'rounded-full border px-2.5 py-1 text-[12px] transition-colors',
        active
          ? 'border-accent bg-accent-soft text-ink'
          : 'border-line bg-paper text-muted hover:border-accent/50'
      )}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function Pane({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-md border border-line bg-surface-2">
      <div className="truncate border-b border-line px-3 py-1.5 text-[12px] text-muted">
        {title}
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-2">{children}</div>
    </div>
  )
}

function Empty(): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2 text-[12px] text-faint">
      <EyeOff size={22} />
      「미리보기」로 첫 그림을 확인하세요
    </div>
  )
}
