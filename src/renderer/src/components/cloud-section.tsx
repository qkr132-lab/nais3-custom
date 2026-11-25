import { FolderOpen, Loader2, RefreshCw, Trash2, Upload } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { CloudDevice, CloudPairing, CloudPcStatus } from '@shared/cloud-contract'
import { cn } from '../lib/utils'
import { askConfirm } from '../stores/dialog-store'
import { toast } from '../stores/toast-store'
import { Button } from './ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Switch } from './ui/switch'

/**
 * 설정 → 「모바일」 (커스텀) — PC가 꺼져도 폰에서 쓰는 클라우드의 연결·동기화 설정.
 * 설계: cloud/DESIGN.md 9절. 상태는 메인이 `cloud:status` 로 밀어 준다.
 */

/** 클라우드에 남길 최근 그림 수 선택지 */
const KEEP_CHOICES = [500, 1000, 2000, 5000]

/** 연결 코드 유효 시간 — 워커와 PC 시계가 어긋나도 카운트다운이 이 안에서 움직이게 한다 */
const PAIRING_TTL_MS = 10 * 60 * 1000

/** 설정 창 한 줄 (token-dialog 의 Row 와 같은 모양 — 그쪽이 이 파일을 불러오므로 복사해 둠) */
function Row({
  label,
  hint,
  children
}: {
  label: string
  hint?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-6 py-2.5">
      <div className="min-w-0">
        <p className="text-[13px] text-ink">{label}</p>
        {hint && <p className="mt-0.5 text-[11.5px] text-faint">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

/** 「방금」「3분 전」 식 상대 시간 */
function relativeTime(at: number | null, now: number): string {
  if (at == null) return '없음'
  const sec = Math.max(0, Math.floor((now - at) / 1000))
  if (sec < 45) return '방금'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${Math.max(1, min)}분 전`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour}시간 전`
  return `${Math.floor(hour / 24)}일 전`
}

/** 메인 IPC 오류의 「Error invoking remote method …:」 머리말을 걷어 낸다 */
function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return raw.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '').trim()
}

/** 주기적으로 현재 시각을 갱신해 상대 시간 표시가 저절로 바뀌게 한다 */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

function remainingLabel(ms: number): string {
  const total = Math.ceil(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** 연결 코드 8자를 4자씩 끊어 읽기 쉽게 */
function groupCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code
}

type Quota = CloudPcStatus['cloudGen']['quota']

function quotaLabel(quota: Quota): string {
  switch (quota) {
    case 'available':
      return '이번 달 무료 사용량 남음'
    case 'exhausted':
      return '이번 달 무료 사용량 소진 — 생성이 멈춥니다'
    case 'unknown':
      return '무료 사용량을 확인하지 못해 생성이 멈춥니다'
    default:
      return '무료 사용량 아직 확인 전'
  }
}

/** 남음=초록, 소진·확인 안 됨(생성이 멈추는 상태)=경고색, 아직 확인한 적 없음=보통 */
function quotaTone(quota: Quota): string {
  if (quota === 'available') return 'text-emerald-500'
  if (quota === 'exhausted' || quota === 'unknown') return 'text-danger'
  return 'text-muted'
}

type Connection = 'connected' | 'disconnected' | 'unconfigured'

function connectionOf(status: CloudPcStatus): Connection {
  if (!status.configured) return 'unconfigured'
  return status.enabled && status.connected ? 'connected' : 'disconnected'
}

const CONNECTION_LABEL: Record<Connection, string> = {
  connected: '연결됨',
  disconnected: '끊김',
  unconfigured: '설정 안 됨'
}

const CONNECTION_DOT: Record<Connection, string> = {
  connected: 'bg-emerald-500',
  disconnected: 'bg-danger',
  unconfigured: 'bg-faint'
}

function StatusCard({ status }: { status: CloudPcStatus }): React.JSX.Element {
  const now = useNow(15_000)
  const connection = connectionOf(status)
  return (
    <div className="rounded-lg border border-line bg-surface-2/50 p-3">
      <div className="flex items-center gap-2">
        <span className={cn('size-2 shrink-0 rounded-full', CONNECTION_DOT[connection])} />
        <span className="text-[13px] font-medium text-ink">{CONNECTION_LABEL[connection]}</span>
        {connection !== 'unconfigured' && (
          <span className="ml-auto text-[11.5px] text-faint">
            마지막 동기화 {relativeTime(status.lastSyncAt, now)}
          </span>
        )}
      </div>
      {status.url && (
        <p className="mt-1.5 truncate font-mono text-[11.5px] text-faint" title={status.url}>
          {status.url}
        </p>
      )}
      {connection === 'unconfigured' && (
        <p className="mt-1.5 text-[12px] text-muted">
          클라우드 연결 정보가 없습니다. 배포 스크립트가 만든 cloud-connect.json 을 홈 폴더의
          「NAIS3 Custom 폰 연결」 폴더에 두고 앱을 다시 켜세요.
        </p>
      )}
      {connection === 'disconnected' && !status.enabled && (
        <p className="mt-1.5 text-[12px] text-muted">동기화를 꺼 둔 상태입니다.</p>
      )}
      {status.error && <p className="mt-1.5 break-words text-[12px] text-danger">{status.error}</p>}
      {status.protocolMismatch && (
        <p className="mt-1.5 rounded-md bg-accent/15 px-2 py-1.5 text-[12px] text-accent">
          앱과 클라우드의 판이 다릅니다. 앱 또는 클라우드를 같은 판으로 업데이트해 주세요.
        </p>
      )}
    </div>
  )
}

/** 폰 연결 — 코드 만들기 + QR + 남은 시간 */
function PairingBlock({ disabled }: { disabled: boolean }): React.JSX.Element {
  const [pairing, setPairing] = useState<(CloudPairing & { deadline: number }) | null>(null)
  const [creating, setCreating] = useState(false)
  /** 코드가 만료될 때까지 남은 시간 (ms) */
  const [left, setLeft] = useState(0)

  // 코드가 있는 동안 남은 시간을 줄인다 — 처음 값은 만든 순간 create()가 넣는다
  useEffect(() => {
    if (!pairing) return
    const timer = setInterval(() => setLeft(Math.max(0, pairing.deadline - Date.now())), 500)
    return () => clearInterval(timer)
  }, [pairing])

  const create = async (): Promise<void> => {
    setCreating(true)
    try {
      const made = await window.nais.invoke('cloud:pairing', undefined)
      const raw = made.expiresAt - Date.now()
      // 워커 시계 기준 expiresAt 이 이상하게 멀거나 과거여도 10분 안에서 센다
      const remaining = raw > 0 && raw <= PAIRING_TTL_MS ? raw : PAIRING_TTL_MS
      setLeft(remaining)
      setPairing({ ...made, deadline: Date.now() + remaining })
    } catch (e) {
      toast(`연결 코드를 만들지 못했습니다: ${errorText(e)}`, 'error')
    } finally {
      setCreating(false)
    }
  }

  const expired = pairing !== null && left <= 0

  return (
    <div className="border-t border-line pt-3">
      <p className="text-[13px] text-ink">폰 연결</p>
      <p className="mt-0.5 text-[11.5px] text-faint">
        폰 브라우저로 QR을 읽거나, 클라우드 주소를 열어 코드를 입력하세요. 코드는 10분 동안, 한 번만
        쓸 수 있습니다.
      </p>
      <div className="mt-2 flex items-center gap-3">
        <Button
          variant="default"
          className="gap-1.5"
          disabled={disabled || creating}
          onClick={() => void create()}
        >
          {creating && <Loader2 size={14} className="animate-spin" />}
          {pairing ? '새 연결 코드 만들기' : '연결 코드 만들기'}
        </Button>
      </div>
      {pairing && (
        <div className="mt-3 flex items-center gap-4 rounded-lg border border-line bg-surface-2/50 p-3">
          <img
            src={`data:image/svg+xml;utf8,${encodeURIComponent(pairing.qrSvg)}`}
            alt="폰 연결 QR"
            className={cn(
              'size-36 shrink-0 rounded-md bg-white p-2',
              expired && 'opacity-25 grayscale'
            )}
          />
          <div className="min-w-0">
            <p
              className={cn(
                'font-mono text-[22px] font-medium tracking-[0.14em]',
                expired ? 'text-faint line-through' : 'text-ink'
              )}
            >
              {groupCode(pairing.code)}
            </p>
            {expired ? (
              <p className="mt-1 text-[12px] text-danger">
                코드가 만료되었습니다. 새로 만들어 주세요.
              </p>
            ) : (
              <p className="mt-1 text-[12px] text-muted">
                남은 시간{' '}
                <span className="font-mono text-ink tabular-nums">{remainingLabel(left)}</span>
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** 연결된 기기 목록 + 해제 */
function DevicesBlock({ enabled, count }: { enabled: boolean; count: number }): React.JSX.Element {
  const [devices, setDevices] = useState<CloudDevice[] | null>(null)
  const [failed, setFailed] = useState(false)
  const now = useNow(15_000)

  // 연결 설정이 있고, 기기 수가 바뀔 때마다 다시 읽는다
  useEffect(() => {
    if (!enabled) return
    let alive = true
    window.nais
      .invoke('cloud:devices', undefined)
      .then(({ items }) => {
        if (!alive) return
        setDevices(items)
        setFailed(false)
      })
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [enabled, count])

  const revoke = async (device: CloudDevice): Promise<void> => {
    const ok = await askConfirm('기기 해제', {
      message: `"${device.name}" 기기를 해제합니다. 이 기기는 다시 연결 코드를 입력해야 접속할 수 있습니다.`,
      confirmLabel: '해제',
      danger: true
    })
    if (!ok) return
    try {
      const { items } = await window.nais.invoke('cloud:revokeDevice', { id: device.id })
      setDevices(items)
      toast('기기를 해제했습니다', 'success')
    } catch (e) {
      toast(`기기를 해제하지 못했습니다: ${errorText(e)}`, 'error')
    }
  }

  return (
    <div className="border-t border-line pt-3">
      <p className="text-[13px] text-ink">연결된 기기</p>
      <div className="mt-2 flex flex-col gap-1">
        {devices?.map((device) => (
          <div
            key={device.id}
            className="flex items-center gap-2 rounded-md border border-line bg-paper px-2.5 py-1.5"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12.5px] text-ink" title={device.name}>
                {device.name}
              </p>
              <p className="text-[11px] text-faint">
                {device.lastSeen == null
                  ? '아직 접속 기록 없음'
                  : `마지막 접속 ${relativeTime(device.lastSeen, now)}`}
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0 gap-1 px-2 text-[12px] hover:text-danger"
              onClick={() => void revoke(device)}
            >
              <Trash2 size={12} /> 해제
            </Button>
          </div>
        ))}
        {devices !== null && devices.length === 0 && (
          <p className="py-1 text-[11.5px] text-faint">연결된 기기가 없습니다.</p>
        )}
        {devices === null && (
          <p className="py-1 text-[11.5px] text-faint">
            {failed ? '기기 목록을 불러오지 못했습니다.' : enabled ? '불러오는 중…' : '—'}
          </p>
        )}
      </div>
    </div>
  )
}

export function CloudSection(): React.JSX.Element {
  const [status, setStatus] = useState<CloudPcStatus | null>(null)
  const [failed, setFailed] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [uploading, setUploading] = useState(false)
  // 폰과 나눌 PC 폴더 — '' 이면 고르지 않은 것
  const [driveRoot, setDriveRoot] = useState('')

  useEffect(() => {
    let alive = true
    window.nais
      .invoke('cloud:status', undefined)
      .then((s) => alive && setStatus(s))
      .catch(() => alive && setFailed(true))
    window.nais
      .invoke('cloud:driveRoot', undefined)
      .then((r) => alive && setDriveRoot(r.path))
      .catch(() => {})
    // 상태는 바뀔 때마다 메인이 밀어 준다
    const off = window.nais.on('cloud:status', (s) => setStatus(s))
    return () => {
      alive = false
      off()
    }
  }, [])

  /** 상태를 돌려주는 IPC 한 번 — 실패하면 알림을 띄우고 화면은 예전 상태 그대로 둔다 */
  const apply = async (call: () => Promise<CloudPcStatus>, failMessage: string): Promise<void> => {
    try {
      setStatus(await call())
    } catch (e) {
      toast(`${failMessage}: ${errorText(e)}`, 'error')
    }
  }

  if (!status) {
    return (
      <p className="flex items-center gap-1.5 py-6 text-[12.5px] text-faint">
        {failed ? (
          '모바일 상태를 불러오지 못했습니다.'
        ) : (
          <>
            <Loader2 size={13} className="animate-spin" /> 불러오는 중…
          </>
        )}
      </p>
    )
  }

  const configured = status.configured
  const keepChoices = KEEP_CHOICES.includes(status.keepImages)
    ? KEEP_CHOICES
    : [...KEEP_CHOICES, status.keepImages].sort((a, b) => a - b)

  const toggleCloudGen = async (on: boolean): Promise<void> => {
    if (on) {
      const ok = await askConfirm('PC 꺼졌을 때 클라우드 생성', {
        message:
          'NAI 토큰을 클라우드(내 Cloudflare 계정)에 맡깁니다. 무료 범위(Opus · 1024×1024 이하 · 28스텝 이하 · 이번 달 무료 사용량 남음)일 때만 생성하고, Anlas가 줄면 즉시 멈춥니다.',
        confirmLabel: '켜기',
        // 토큰을 맡기는 결정이라 「확인 창 끄기」여도 반드시 묻는다
        important: true
      })
      if (!ok) return
    }
    await apply(
      () => window.nais.invoke('cloud:setCloudGen', { enabled: on }),
      on ? '클라우드 생성을 켜지 못했습니다' : '클라우드 생성을 끄지 못했습니다'
    )
  }

  const syncNow = async (): Promise<void> => {
    setSyncing(true)
    try {
      const next = await window.nais.invoke('cloud:syncNow', undefined)
      setStatus(next)
      if (next.error) toast(`동기화하지 못했습니다: ${next.error}`, 'error')
      else toast('동기화했습니다', 'success')
    } catch (e) {
      toast(`동기화하지 못했습니다: ${errorText(e)}`, 'error')
    } finally {
      setSyncing(false)
    }
  }

  const uploadRecent = async (): Promise<void> => {
    setUploading(true)
    try {
      const { queued } = await window.nais.invoke('cloud:uploadRecent', { count: 100 })
      toast(
        queued > 0 ? `최근 그림 ${queued}장을 올리는 중입니다` : '새로 올릴 그림이 없습니다',
        queued > 0 ? 'success' : 'info'
      )
    } catch (e) {
      toast(`그림을 올리지 못했습니다: ${errorText(e)}`, 'error')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <StatusCard status={status} />

      <div className="-mb-1 divide-y divide-line">
        <Row label="동기화" hint="라이브러리·씬·그림을 내 클라우드에 올려 폰에서 봅니다">
          <Switch
            checked={status.enabled}
            disabled={!configured}
            onCheckedChange={(v) =>
              void apply(
                () => window.nais.invoke('cloud:setEnabled', { enabled: v }),
                '동기화 설정을 바꾸지 못했습니다'
              )
            }
          />
        </Row>
      </div>

      <PairingBlock disabled={!configured} />

      <DevicesBlock enabled={configured} count={status.devices} />

      <div className="divide-y divide-line border-t border-line pt-1">
        <Row
          label="그림 올리기"
          hint={
            <>
              {`새로 만든 그림을 메타데이터를 뺀 WebP로 올립니다${
                status.pendingUploads > 0 ? ` · 대기 ${status.pendingUploads}장` : ''
              }`}
              {status.failedUploads > 0 && (
                <span className="mt-0.5 block text-danger">
                  올리지 못한 그림 {status.failedUploads}장
                </span>
              )}
            </>
          }
        >
          <Switch
            checked={status.uploadImages}
            disabled={!configured}
            onCheckedChange={(v) =>
              void apply(
                () => window.nais.invoke('cloud:setUploadImages', { enabled: v }),
                '그림 올리기 설정을 바꾸지 못했습니다'
              )
            }
          />
        </Row>
        <Row label="클라우드 보관 장수" hint="넘으면 오래된 그림부터 클라우드에서만 지웁니다">
          <Select
            value={String(status.keepImages)}
            disabled={!configured}
            onValueChange={(v) =>
              void apply(
                () => window.nais.invoke('cloud:setKeepImages', { count: Number(v) }),
                '보관 장수를 바꾸지 못했습니다'
              )
            }
          >
            <SelectTrigger className="w-28 data-[disabled]:opacity-50">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {keepChoices.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n.toLocaleString()}장
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
        <Row label="최근 그림 올리기" hint="이미 올린 그림은 건너뜁니다">
          <Button
            variant="default"
            className="gap-1.5"
            disabled={!configured || uploading}
            onClick={() => void uploadRecent()}
          >
            {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            최근 100장 올리기
          </Button>
        </Row>
      </div>

      <div className="border-t border-line pt-1">
        <Row
          label="PC 폴더 공유"
          hint={
            driveRoot
              ? `${driveRoot} · 폰 갤러리에서 이 폴더의 그림을 보고, 씬 그림을 이 폴더로 내보냅니다`
              : '폴더를 고르면 폰 갤러리에서 그 폴더의 그림을 보고, 씬 그림을 그 폴더로 내보냅니다'
          }
        >
          <div className="flex items-center gap-1.5">
            <Button
              variant="default"
              className="gap-1.5"
              onClick={() =>
                void window.nais
                  .invoke('cloud:pickDriveRoot', undefined)
                  .then((r) => setDriveRoot(r.path))
                  .catch((e) => toast(`폴더를 바꾸지 못했습니다: ${errorText(e)}`, 'error'))
              }
            >
              <FolderOpen size={14} /> 폴더 선택
            </Button>
            {driveRoot && (
              <Button
                variant="ghost"
                onClick={() =>
                  void window.nais
                    .invoke('cloud:clearDriveRoot', undefined)
                    .then((r) => setDriveRoot(r.path))
                    .catch((e) => toast(`공유를 끄지 못했습니다: ${errorText(e)}`, 'error'))
                }
              >
                해제
              </Button>
            )}
          </div>
        </Row>
      </div>

      <div className="border-t border-line pt-1">
        <Row
          label="PC 꺼졌을 때 클라우드 생성"
          hint="폰에서 요청하면 클라우드가 대신 생성합니다 · 무료 범위일 때만"
        >
          <Switch
            checked={status.cloudGen.enabled}
            disabled={!configured}
            onCheckedChange={(v) => void toggleCloudGen(v)}
          />
        </Row>
        {status.cloudGen.enabled && (
          <div className="mb-1 flex flex-col gap-0.5 rounded-md bg-surface-2/50 px-3 py-2 text-[12px]">
            <p className={quotaTone(status.cloudGen.quota)}>{quotaLabel(status.cloudGen.quota)}</p>
            {!status.cloudGen.hasToken && (
              <p className="text-danger">NAI 토큰이 클라우드에 없어 생성이 멈춥니다.</p>
            )}
            {status.cloudJobsActive > 0 && (
              <p className="text-muted">클라우드가 생성 중인 작업 {status.cloudJobsActive}건</p>
            )}
          </div>
        )}
      </div>

      <div className="flex justify-end border-t border-line pt-3">
        <Button
          variant="default"
          className="gap-1.5"
          disabled={!configured || syncing}
          onClick={() => void syncNow()}
        >
          {syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          지금 동기화
        </Button>
      </div>
    </div>
  )
}
