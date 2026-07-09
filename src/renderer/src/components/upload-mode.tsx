import {
  CloudUpload,
  ExternalLink,
  File as FileIcon,
  FileUp,
  Folder,
  FolderPlus,
  FolderUp,
  Home,
  Image as ImageIcon,
  Loader2,
  LogOut,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  X,
  XCircle
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { R2Object, R2UploadStatus } from '@shared/types'
import { askConfirm, askText } from '../stores/dialog-store'
import { toast } from '../stores/toast-store'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

/**
 * Cloudflare R2 업로드 모드 (커스텀).
 * - S3 호환 API 직접 호출 → 대시보드의 "한 번에 100개" 제한 없음
 * - 인증 정보는 safeStorage(DPAPI)로 암호화해 로컬에만 저장 (외부 전송 없음)
 * - 폴더 탐색 / 새 폴더 / 파일·폴더 올리기 / OS 드래그 앤 드롭 / 실패 목록·재시도
 */

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif)$/i

export function UploadMode(): React.JSX.Element {
  const [checked, setChecked] = useState(false)
  const [connected, setConnected] = useState(false)
  const [accountId, setAccountId] = useState('')

  useEffect(() => {
    void window.nais.invoke('r2:authStatus', undefined).then((s) => {
      setConnected(s.connected)
      setAccountId(s.accountId)
      setChecked(true)
    })
  }, [])

  if (!checked) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center rounded-xl border border-line bg-surface">
        <Loader2 size={22} className="animate-spin text-muted" />
      </div>
    )
  }
  return connected ? (
    <R2Browser
      accountId={accountId}
      onDisconnect={() => {
        setConnected(false)
        setAccountId('')
      }}
    />
  ) : (
    <R2Setup
      onConnected={(id) => {
        setConnected(true)
        setAccountId(id)
      }}
    />
  )
}

/** 연결 전 — 계정 ID + Access Key 입력 (발급 페이지 바로가기 포함) */
function R2Setup({ onConnected }: { onConnected: (accountId: string) => void }): React.JSX.Element {
  const [accountId, setAccountId] = useState('')
  const [keyId, setKeyId] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)

  const connect = async (): Promise<void> => {
    if (!accountId.trim() || !keyId.trim() || !secret.trim()) {
      toast('세 칸을 모두 입력하세요', 'info')
      return
    }
    setBusy(true)
    const res = await window.nais.invoke('r2:setAuth', {
      accountId,
      accessKeyId: keyId,
      secretAccessKey: secret
    })
    setBusy(false)
    if (res.ok) {
      toast('R2 연결 완료', 'success')
      onConnected(accountId.trim())
    } else {
      toast(`연결 실패: ${res.error ?? '알 수 없는 오류'}`, 'error')
    }
  }

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-line bg-surface">
      <div className="w-[440px] space-y-4 p-6">
        <div className="space-y-1 text-center">
          <CloudUpload size={28} className="mx-auto text-accent" />
          <h2 className="text-[16px] font-semibold">Cloudflare R2 연결</h2>
          <p className="text-[12.5px] text-muted">
            R2 버킷에 이미지를 개수 제한 없이 바로 올릴 수 있습니다.
          </p>
        </div>

        {/* 발급 안내 */}
        <div className="rounded-lg border border-line bg-surface-2/60 p-3 text-[12px] leading-relaxed text-muted">
          <p className="font-medium text-ink">토큰 발급 방법</p>
          <ol className="ml-4 mt-1 list-decimal space-y-0.5">
            <li>아래 버튼으로 발급 페이지 열기 (R2 → API 토큰)</li>
            <li>
              [API 토큰 만들기] → 권한 <b>개체 읽기 및 쓰기</b> 선택 후 생성
            </li>
            <li>
              표시되는 <b>액세스 키 ID</b>와 <b>비밀 액세스 키</b>를 복사해 붙여넣기
            </li>
            <li>계정 ID는 대시보드 우측(또는 R2 개요)에서 복사</li>
          </ol>
          <Button
            size="sm"
            variant="default"
            className="mt-2 w-full gap-1.5"
            onClick={() => void window.nais.invoke('r2:openTokenPage', undefined)}
          >
            <ExternalLink size={13} /> R2 API 토큰 발급 페이지 열기
          </Button>
        </div>

        <div className="space-y-2">
          <Input
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            placeholder="계정 ID (Account ID)"
            className="h-9 font-mono text-[12.5px]"
          />
          <Input
            value={keyId}
            onChange={(e) => setKeyId(e.target.value)}
            placeholder="액세스 키 ID (Access Key ID)"
            className="h-9 font-mono text-[12.5px]"
          />
          <Input
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="비밀 액세스 키 (Secret Access Key)"
            type="password"
            className="h-9 font-mono text-[12.5px]"
          />
        </div>

        <Button className="w-full gap-1.5" disabled={busy} onClick={() => void connect()}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
          {busy ? '확인 중…' : '연결 (검증 후 저장)'}
        </Button>

        <p className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-faint">
          <ShieldCheck size={13} className="mt-px shrink-0" />
          인증 정보는 NAI 토큰과 동일하게 이 PC의 OS 암호화(DPAPI)로 로컬 DB에만 저장됩니다. 외부
          서버로 전송되지 않으며, Cloudflare API 호출에만 사용됩니다.
        </p>
      </div>
    </div>
  )
}

/** 연결 후 — 버킷/폴더 탐색 + 업로드 */
function R2Browser({
  accountId,
  onDisconnect
}: {
  accountId: string
  onDisconnect: () => void
}): React.JSX.Element {
  const [buckets, setBuckets] = useState<string[]>([])
  const [bucket, setBucket] = useState('')
  const [prefix, setPrefix] = useState('')
  const [folders, setFolders] = useState<string[]>([])
  const [objects, setObjects] = useState<R2Object[]>([])
  const [loading, setLoading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [status, setStatus] = useState<R2UploadStatus | null>(null)

  // 업로드 진행 이벤트 구독 + 초기 상태
  useEffect(() => {
    void window.nais.invoke('r2:uploadStatus', undefined).then(setStatus)
    return window.nais.on('r2:progress', setStatus)
  }, [])

  const loadBuckets = useCallback(async (): Promise<void> => {
    try {
      const { buckets } = await window.nais.invoke('r2:listBuckets', undefined)
      setBuckets(buckets)
      if (buckets.length > 0) setBucket((b) => (b && buckets.includes(b) ? b : buckets[0]))
    } catch (e) {
      toast(`버킷 목록 실패: ${e instanceof Error ? e.message : e}`, 'error')
    }
  }, [])

  useEffect(() => {
    // 마운트 시 버킷 목록 로드 — setState는 비동기 응답 후에만
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadBuckets()
  }, [loadBuckets])

  const refresh = useCallback(async (): Promise<void> => {
    if (!bucket) return
    setLoading(true)
    try {
      const res = await window.nais.invoke('r2:list', { bucket, prefix })
      setFolders(res.folders)
      setObjects(res.objects)
    } catch (e) {
      toast(`목록 실패: ${e instanceof Error ? e.message : e}`, 'error')
    } finally {
      setLoading(false)
    }
  }, [bucket, prefix])

  useEffect(() => {
    // 데이터 페칭 — setLoading은 비동기 흐름 안에서만 쓰인다
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
  }, [refresh])

  // 업로드가 끝나면 현재 위치 새로고침 (방금 올린 게 보이게) — ref로 이전 실행 상태 추적
  const prevRunning = useRef(false)
  useEffect(() => {
    const running = !!status?.running

    if (prevRunning.current && !running) void refresh()
    prevRunning.current = running
  }, [status?.running, refresh])

  const newFolder = async (): Promise<void> => {
    const name = await askText('새 폴더 이름', '')
    if (!name) return
    try {
      await window.nais.invoke('r2:createFolder', { bucket, prefix, name })
      void refresh()
    } catch (e) {
      toast(`폴더 생성 실패: ${e instanceof Error ? e.message : e}`, 'error')
    }
  }

  const pickUpload = async (kind: 'files' | 'folder'): Promise<void> => {
    const { queued } = await window.nais.invoke('r2:pickUpload', { bucket, prefix, kind })
    if (queued > 0) toast(`${queued}개 업로드 시작`, 'success')
  }

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setDragOver(false)
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.nais.pathForFile(f))
      .filter(Boolean)
    if (paths.length === 0) return
    void window.nais.invoke('r2:uploadPaths', { bucket, prefix, paths }).then(({ queued }) => {
      if (queued > 0) toast(`${queued}개 업로드 시작`, 'success')
    })
  }

  const disconnect = async (): Promise<void> => {
    if (
      await askConfirm('R2 연결 해제', {
        message: '저장된 인증 정보를 삭제합니다. 다시 연결하려면 토큰을 재입력해야 합니다.',
        confirmLabel: '해제',
        danger: true
      })
    ) {
      await window.nais.invoke('r2:deleteAuth', undefined)
      onDisconnect()
    }
  }

  // 경로 브레드크럼 (루트 + 세그먼트)
  const segments = prefix.split('/').filter(Boolean)

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col rounded-xl border border-line bg-surface"
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false)
      }}
      onDrop={onDrop}
    >
      {/* 툴바 */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-2 py-1.5">
        <Select
          value={bucket}
          onValueChange={(v) => {
            setBucket(v)
            setPrefix('')
          }}
        >
          <SelectTrigger className="h-8 w-44">
            <SelectValue placeholder="버킷 선택" />
          </SelectTrigger>
          <SelectContent>
            {buckets.map((b) => (
              <SelectItem key={b} value={b}>
                {b}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* 브레드크럼 */}
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto whitespace-nowrap px-1 text-[12.5px]">
          <button
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-muted hover:bg-surface-2 hover:text-ink"
            onClick={() => setPrefix('')}
          >
            <Home size={12} /> {bucket || '—'}
          </button>
          {segments.map((seg, i) => (
            <span key={i} className="flex items-center gap-0.5">
              <span className="text-faint">/</span>
              <button
                className="rounded px-1 py-0.5 text-muted hover:bg-surface-2 hover:text-ink"
                onClick={() => setPrefix(segments.slice(0, i + 1).join('/') + '/')}
              >
                {seg}
              </button>
            </span>
          ))}
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              disabled={!bucket || loading}
              onClick={() => void refresh()}
            >
              <RefreshCw size={14} className={cn(loading && 'animate-spin')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>새로고침</TooltipContent>
        </Tooltip>
        <Button size="sm" variant="ghost" disabled={!bucket} onClick={() => void newFolder()}>
          <FolderPlus size={14} /> 새 폴더
        </Button>
        <Button size="sm" disabled={!bucket} onClick={() => void pickUpload('files')}>
          <FileUp size={14} /> 파일 올리기
        </Button>
        <Button
          size="sm"
          variant="default"
          disabled={!bucket}
          onClick={() => void pickUpload('folder')}
        >
          <FolderUp size={14} /> 폴더 올리기
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" onClick={() => void disconnect()}>
              <LogOut size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>연결 해제 ({accountId.slice(0, 8)}…)</TooltipContent>
        </Tooltip>
      </div>

      {/* 목록 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {buckets.length === 0 && (
          <p className="mt-8 text-center text-[13px] text-faint">
            버킷이 없습니다. Cloudflare 대시보드에서 R2 버킷을 먼저 만드세요.
          </p>
        )}
        {bucket && folders.length === 0 && objects.length === 0 && !loading && (
          <p className="mt-8 text-center text-[13px] text-faint">
            비어 있습니다 — 파일을 여기로 드래그하거나 [파일 올리기]를 누르세요.
          </p>
        )}
        <div className="space-y-px">
          {folders.map((f) => {
            const name = f.slice(prefix.length).replace(/\/$/, '')
            return (
              <button
                key={f}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-surface-2"
                onDoubleClick={() => setPrefix(f)}
                onClick={() => setPrefix(f)}
              >
                <Folder size={15} className="shrink-0 text-[#c9a34f]" />
                <span className="min-w-0 flex-1 truncate">{name}</span>
              </button>
            )
          })}
          {objects.map((o) => {
            const name = o.key.slice(prefix.length)
            const isImg = IMAGE_EXT.test(name)
            return (
              <div
                key={o.key}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-surface-2"
              >
                {isImg ? (
                  <ImageIcon size={15} className="shrink-0 text-accent/80" />
                ) : (
                  <FileIcon size={15} className="shrink-0 text-muted" />
                )}
                <span className="min-w-0 flex-1 truncate">{name}</span>
                <span className="shrink-0 font-mono text-[11.5px] text-faint">
                  {formatBytes(o.size)}
                </span>
                <span className="w-36 shrink-0 text-right font-mono text-[11px] text-faint">
                  {o.lastModified.slice(0, 19).replace('T', ' ')}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {/* 업로드 상태 바 */}
      {status && status.total > 0 && <UploadStatusBar status={status} />}

      {/* 드래그 오버레이 */}
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-xl border-2 border-dashed border-accent bg-accent/10">
          <div className="flex items-center gap-2 rounded-lg bg-surface px-4 py-2 text-[14px] font-medium shadow-lg">
            <CloudUpload size={18} className="text-accent" />
            여기에 놓으면 {bucket}/{prefix} 에 업로드
          </div>
        </div>
      )}
    </div>
  )
}

/** 하단 진행/실패 표시줄 */
function UploadStatusBar({ status }: { status: R2UploadStatus }): React.JSX.Element {
  const [showFailed, setShowFailed] = useState(false)
  const pct =
    status.total > 0 ? Math.round(((status.done + status.failedCount) / status.total) * 100) : 0
  const finished = !status.running

  return (
    <div className="border-t border-line bg-surface-2/70 px-3 py-2 text-[12.5px]">
      <div className="flex items-center gap-2">
        {status.running ? (
          <Loader2 size={14} className="shrink-0 animate-spin text-accent" />
        ) : status.failedCount > 0 ? (
          <XCircle size={14} className="shrink-0 text-danger" />
        ) : (
          <CloudUpload size={14} className="shrink-0 text-accent" />
        )}
        <span className="shrink-0 font-medium">
          {status.running
            ? `업로드 중 ${status.done + status.failedCount}/${status.total}`
            : `완료 ${status.done}/${status.total}`}
        </span>
        {status.running && status.currentName && (
          <span className="min-w-0 flex-1 truncate text-faint">{status.currentName}</span>
        )}
        {!status.running && <span className="flex-1" />}
        {status.failedCount > 0 && (
          <button
            className="shrink-0 rounded px-1.5 py-0.5 font-medium text-danger hover:bg-danger/10"
            onClick={() => setShowFailed(!showFailed)}
          >
            실패 {status.failedCount}개 {showFailed ? '접기' : '보기'}
          </button>
        )}
        {status.failedCount > 0 && !status.running && (
          <Button
            size="sm"
            variant="default"
            className="h-6 gap-1 px-2 text-[11.5px]"
            onClick={() =>
              void window.nais.invoke('r2:retryFailed', undefined).then(({ queued }) => {
                if (queued > 0) toast(`${queued}개 재시도`, 'info')
              })
            }
          >
            <RotateCcw size={11} /> 재시도
          </Button>
        )}
        {status.running ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-2 text-[11.5px] text-danger"
            onClick={() => void window.nais.invoke('r2:cancelUpload', undefined)}
          >
            <X size={11} /> 취소
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-2 text-[11.5px]"
            onClick={() => void window.nais.invoke('r2:clearUploadHistory', undefined)}
          >
            <X size={11} /> 닫기
          </Button>
        )}
      </div>
      {/* 진행 바 */}
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line">
        <div
          className={cn(
            'h-full transition-all',
            finished && status.failedCount > 0 ? 'bg-danger' : 'bg-accent'
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      {/* 실패 목록 */}
      {showFailed && status.failed.length > 0 && (
        <div className="mt-2 max-h-36 space-y-0.5 overflow-y-auto rounded-md border border-line bg-paper p-1.5">
          {status.failed.map((f, i) => (
            <div key={i} className="flex items-center gap-2 text-[11.5px]">
              <XCircle size={11} className="shrink-0 text-danger" />
              <span className="min-w-0 flex-1 truncate">{f.key}</span>
              <span className="max-w-64 shrink-0 truncate text-faint">{f.error}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
