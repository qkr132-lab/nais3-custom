import type { R2SyncConfig, R2SyncStatus } from '@shared/types'
import {
  Check,
  Cloud,
  FlaskConical,
  Folder,
  FolderPlus,
  Home,
  Loader2,
  RefreshCw,
  Star
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '../lib/utils'
import { askText } from '../stores/dialog-store'
import { toast } from '../stores/toast-store'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Switch } from './ui/switch'

interface R2Favorite {
  name: string
  bucket: string
  prefix: string
}

function normalizePrefix(prefix: string): string {
  const clean = prefix.trim().replace(/^\/+/, '').replace(/\/+/g, '/')
  return clean && !clean.endsWith('/') ? `${clean}/` : clean
}

function parseFavorites(value: string): R2Favorite[] {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (item): item is R2Favorite =>
          item != null &&
          typeof item === 'object' &&
          typeof (item as R2Favorite).name === 'string' &&
          typeof (item as R2Favorite).bucket === 'string' &&
          typeof (item as R2Favorite).prefix === 'string'
      )
      .map((item) => ({ ...item, prefix: normalizePrefix(item.prefix) }))
  } catch {
    return []
  }
}

export function R2SyncDialog({
  presetId,
  presetName,
  open,
  onOpenChange
}: {
  presetId: number
  presetName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const [config, setConfig] = useState<R2SyncConfig | null>(null)
  const [status, setStatus] = useState<R2SyncStatus | null>(null)
  const [connected, setConnected] = useState(true)
  const [buckets, setBuckets] = useState<string[]>([])
  const [favorites, setFavorites] = useState<R2Favorite[]>([])
  const [browseBucket, setBrowseBucket] = useState('')
  const [browsePrefix, setBrowsePrefix] = useState('')
  const [folders, setFolders] = useState<string[]>([])
  const [objectCount, setObjectCount] = useState(0)
  const [browserLoading, setBrowserLoading] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      try {
        const [loadedConfig, loadedStatus, auth, favoriteSetting] = await Promise.all([
          window.nais.invoke('r2sync:getConfig', { presetId }),
          window.nais.invoke('r2sync:status', { presetId }),
          window.nais.invoke('r2:authStatus', undefined),
          window.nais.invoke('settings:get', { key: 'r2_favorites' })
        ])
        if (cancelled) return
        setConfig(loadedConfig)
        setStatus(loadedStatus)
        setConnected(auth.connected)
        const loadedFavorites = parseFavorites(favoriteSetting.value ?? '')
        setFavorites(loadedFavorites)
        if (!auth.connected) return
        const bucketResult = await window.nais.invoke('r2:listBuckets', undefined)
        if (cancelled) return
        setBuckets(bucketResult.buckets)
        const initialBucket =
          loadedConfig.bucket || loadedFavorites[0]?.bucket || bucketResult.buckets[0] || ''
        const initialPrefix = loadedConfig.bucket
          ? normalizePrefix(loadedConfig.prefix)
          : initialBucket === loadedFavorites[0]?.bucket
            ? loadedFavorites[0].prefix
            : ''
        setBrowseBucket(initialBucket)
        setBrowsePrefix(initialPrefix)
      } catch (error) {
        if (!cancelled)
          toast(
            `클플 설정 불러오기 실패: ${error instanceof Error ? error.message : error}`,
            'error'
          )
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, presetId])

  useEffect(() => {
    if (!open) return
    return window.nais.on('r2sync:status', (next) => {
      if (next.presetId === presetId) setStatus(next)
    })
  }, [open, presetId])

  useEffect(() => {
    if (!open || !connected || !browseBucket) return
    let cancelled = false
    // Loading mirrors an external R2 request initiated by this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBrowserLoading(true)
    void window.nais
      .invoke('r2:list', { bucket: browseBucket, prefix: browsePrefix })
      .then((result) => {
        if (cancelled) return
        setFolders(result.folders)
        setObjectCount(result.objects.length)
      })
      .catch((error) => {
        if (!cancelled) {
          setFolders([])
          setObjectCount(0)
          toast(
            `폴더 목록 불러오기 실패: ${error instanceof Error ? error.message : error}`,
            'error'
          )
        }
      })
      .finally(() => {
        if (!cancelled) setBrowserLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, connected, browseBucket, browsePrefix, refreshKey])

  const save = useCallback(
    (patch: Partial<R2SyncConfig>): void => {
      setConfig((current) => {
        if (!current) return current
        const next = {
          ...current,
          ...patch,
          prefix: normalizePrefix(patch.prefix ?? current.prefix)
        }
        void window.nais.invoke('r2sync:setConfig', { presetId, config: next })
        return next
      })
    },
    [presetId]
  )

  const chooseTarget = (bucket: string, prefix: string): void => {
    const normalized = normalizePrefix(prefix)
    setBrowseBucket(bucket)
    setBrowsePrefix(normalized)
    save({ bucket, prefix: normalized })
  }

  const createFolder = async (): Promise<void> => {
    if (!browseBucket) return
    const name = await askText('새 클플 폴더', '')
    if (!name?.trim()) return
    try {
      await window.nais.invoke('r2:createFolder', {
        bucket: browseBucket,
        prefix: browsePrefix,
        name: name.trim()
      })
      setRefreshKey((key) => key + 1)
    } catch (error) {
      toast(`폴더 생성 실패: ${error instanceof Error ? error.message : error}`, 'error')
    }
  }

  const segments = browsePrefix.split('/').filter(Boolean)
  const targetLabel = config?.bucket
    ? `${config.bucket}/${normalizePrefix(config.prefix)}`
    : '아직 선택하지 않음'
  const last = status?.last

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[600px] p-0">
        <div className="border-b border-line px-5 py-4">
          <DialogTitle className="flex items-center gap-2 pr-8">
            <Cloud size={16} className="text-accent" /> 클플 자동 동기화 — {presetName}
            <span className="flex items-center gap-1 rounded-full bg-amber-400/15 px-2 py-0.5 text-[10.5px] font-bold text-amber-500">
              <FlaskConical size={10} /> 실험 기능
            </span>
          </DialogTitle>
          <DialogDescription className="mt-1">
            이 모듈의 즐겨찾기 이미지를 선택한 R2 폴더에 맞춥니다.
          </DialogDescription>
        </div>

        {!connected ? (
          <p className="px-5 py-8 text-[13px] text-muted">먼저 업로드 탭에서 R2를 연결하세요.</p>
        ) : !config ? (
          <div className="grid place-items-center py-10">
            <Loader2 size={18} className="animate-spin text-muted" />
          </div>
        ) : (
          <div className="space-y-4 px-5 py-4 text-[13px]">
            <div className="flex items-center justify-between rounded-lg border border-line bg-paper px-3 py-2">
              <div className="min-w-0">
                <p className="font-medium">동기화 대상</p>
                <p className="truncate font-mono text-[11.5px] text-muted" title={targetLabel}>
                  {targetLabel}
                </p>
              </div>
              <Switch checked={config.enabled} onCheckedChange={(enabled) => save({ enabled })} />
            </div>

            {favorites.length > 0 && (
              <div>
                <p className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-muted">
                  <Star size={12} className="fill-[#c9a34f] text-[#c9a34f]" /> 업로드 탭 즐겨찾기
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {favorites.map((favorite, index) => {
                    const selected =
                      favorite.bucket === config.bucket &&
                      normalizePrefix(favorite.prefix) === normalizePrefix(config.prefix)
                    return (
                      <button
                        key={`${favorite.bucket}/${favorite.prefix}/${index}`}
                        className={cn(
                          'rounded-full border px-2.5 py-1 text-[12px] transition-colors',
                          selected
                            ? 'border-accent/60 bg-accent/10 text-accent'
                            : 'border-line bg-surface text-muted hover:bg-surface-2 hover:text-ink'
                        )}
                        title={`${favorite.bucket}/${favorite.prefix}`}
                        onClick={() => chooseTarget(favorite.bucket, favorite.prefix)}
                      >
                        {favorite.name}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            <div className="overflow-hidden rounded-lg border border-line">
              <div className="flex items-center gap-2 border-b border-line bg-surface-2/50 p-2">
                <Select
                  value={browseBucket}
                  onValueChange={(bucket) => {
                    setBrowseBucket(bucket)
                    setBrowsePrefix('')
                  }}
                >
                  <SelectTrigger className="h-8 w-44">
                    <SelectValue placeholder="버킷 선택" />
                  </SelectTrigger>
                  <SelectContent>
                    {buckets.map((bucket) => (
                      <SelectItem key={bucket} value={bucket}>
                        {bucket}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto whitespace-nowrap text-[12px]">
                  <button
                    className="flex items-center gap-1 rounded px-1.5 py-1 text-muted hover:bg-surface hover:text-ink"
                    onClick={() => setBrowsePrefix('')}
                  >
                    <Home size={12} /> {browseBucket || '버킷'}
                  </button>
                  {segments.map((segment, index) => (
                    <span key={`${segment}-${index}`} className="flex items-center gap-0.5">
                      <span className="text-faint">/</span>
                      <button
                        className="rounded px-1.5 py-1 text-muted hover:bg-surface hover:text-ink"
                        onClick={() =>
                          setBrowsePrefix(`${segments.slice(0, index + 1).join('/')}/`)
                        }
                      >
                        {segment}
                      </button>
                    </span>
                  ))}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void createFolder()}
                  disabled={!browseBucket}
                >
                  <FolderPlus size={13} /> 새 폴더
                </Button>
              </div>

              <div className="h-36 overflow-y-auto p-2">
                {browserLoading ? (
                  <div className="grid h-full place-items-center">
                    <Loader2 size={16} className="animate-spin text-muted" />
                  </div>
                ) : folders.length > 0 ? (
                  <div className="space-y-0.5">
                    {folders.map((folder) => (
                      <button
                        key={folder}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-2"
                        onClick={() => setBrowsePrefix(folder)}
                      >
                        <Folder size={15} className="text-[#c9a34f]" />
                        <span className="min-w-0 flex-1 truncate">
                          {folder.slice(browsePrefix.length).replace(/\/$/, '')}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="grid h-full place-items-center text-[12px] text-faint">
                    하위 폴더 없음 · 현재 폴더 파일 {objectCount}개
                  </div>
                )}
              </div>
              <div className="flex items-center justify-between border-t border-line bg-surface-2/30 px-2 py-2">
                <span className="min-w-0 truncate px-1 font-mono text-[11px] text-faint">
                  {browseBucket}/{browsePrefix}
                </span>
                <Button
                  size="sm"
                  variant={
                    browseBucket === config.bucket &&
                    normalizePrefix(browsePrefix) === normalizePrefix(config.prefix)
                      ? 'default'
                      : 'accent'
                  }
                  disabled={!browseBucket}
                  onClick={() => chooseTarget(browseBucket, browsePrefix)}
                >
                  {browseBucket === config.bucket &&
                  normalizePrefix(browsePrefix) === normalizePrefix(config.prefix) ? (
                    <Check size={13} />
                  ) : null}
                  이 폴더 선택
                </Button>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-muted">
                즐겨찾기 해제 시 클플에서도 삭제
                <span className="block text-[11px] text-faint">끄면 클플 파일은 남겨둡니다.</span>
              </span>
              <Switch
                checked={config.deleteOnUnfavorite}
                onCheckedChange={(deleteOnUnfavorite) => save({ deleteOnUnfavorite })}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted">같은 이름이 있을 때</span>
              <Select
                value={config.conflictPolicy}
                onValueChange={(value) =>
                  save({ conflictPolicy: value as R2SyncConfig['conflictPolicy'] })
                }
              >
                <SelectTrigger className="h-8 w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ask">물어보기</SelectItem>
                  <SelectItem value="overwrite">항상 덮어쓰기</SelectItem>
                  <SelectItem value="skip">항상 건너뛰기</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-2 border-t border-line pt-3">
              <Button
                size="sm"
                variant="accent"
                disabled={!config.enabled || !config.bucket || status?.running}
                onClick={() => void window.nais.invoke('r2sync:run', { presetId })}
              >
                {status?.running ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <RefreshCw size={13} />
                )}
                지금 동기화
              </Button>
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-faint">
                {status?.running
                  ? '동기화 중…'
                  : last
                    ? `최근: 업로드 ${last.uploaded} · 이름변경 ${last.renamed} · 삭제 ${last.deleted}` +
                      (last.errors.length ? ` · 오류 ${last.errors.length}` : '')
                    : '아직 동기화 안 함'}
              </span>
            </div>
            {last && last.errors.length > 0 && (
              <div className="max-h-20 overflow-y-auto rounded-md border border-danger/30 bg-danger/5 p-2 text-[11px] text-danger">
                {last.errors.map((error, index) => (
                  <p key={index} className="truncate" title={error}>
                    {error}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end border-t border-line px-5 py-3">
          <Button onClick={() => onOpenChange(false)}>닫기</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Global conflict prompt and completion notifications. */
export function R2SyncHost(): React.JSX.Element {
  const [conflict, setConflict] = useState<{ presetId: number; keys: string[] } | null>(null)
  const [remember, setRemember] = useState(false)
  const lastAtRef = useRef(new Map<number, string>())

  useEffect(() => {
    return window.nais.on('r2sync:status', (status) => {
      if (status.conflicts.length > 0) {
        setConflict({ presetId: status.presetId, keys: status.conflicts })
        return
      }
      if (!status.running && status.last) {
        if (lastAtRef.current.get(status.presetId) === status.last.at) return
        lastAtRef.current.set(status.presetId, status.last.at)
        const { uploaded, renamed, deleted, errors } = status.last
        if (uploaded + renamed + deleted === 0 && errors.length === 0) return
        const parts: string[] = []
        if (uploaded) parts.push(`${uploaded}장 업로드`)
        if (renamed) parts.push(`${renamed}장 이름변경`)
        if (deleted) parts.push(`${deleted}장 삭제`)
        if (errors.length) parts.push(`오류 ${errors.length}`)
        toast(`클플 동기화: ${parts.join(' · ')}`, errors.length ? 'error' : 'success')
      }
    })
  }, [])

  const resolve = (choice: 'overwrite' | 'skip'): void => {
    if (!conflict) return
    void window.nais.invoke('r2sync:resolveConflicts', {
      presetId: conflict.presetId,
      choice,
      remember
    })
    setConflict(null)
    setRemember(false)
  }

  return (
    <Dialog open={conflict != null} onOpenChange={(nextOpen) => !nextOpen && resolve('skip')}>
      <DialogContent className="max-w-[420px] p-0">
        <div className="border-b border-line px-5 py-4">
          <DialogTitle>클플에 같은 이름이 있어요</DialogTitle>
          <DialogDescription className="mt-1">
            {conflict ? `${conflict.keys.length}개 파일이 대상 폴더의 기존 파일과 겹칩니다.` : ''}
          </DialogDescription>
        </div>
        <div className="max-h-40 space-y-0.5 overflow-y-auto px-5 py-3 font-mono text-[12px] text-muted">
          {conflict?.keys.map((key) => (
            <p key={key} className="truncate" title={key}>
              {key}
            </p>
          ))}
        </div>
        <label className="flex cursor-pointer items-center gap-2 px-5 pb-3 text-[12px] text-muted">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
          />
          이 모듈은 항상 이렇게 처리
        </label>
        <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <Button variant="ghost" onClick={() => resolve('skip')}>
            건너뛰기
          </Button>
          <Button variant="accent" onClick={() => resolve('overwrite')}>
            덮어쓰기
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
