import { createRoot } from 'react-dom/client'
import type { CloudDevice, CloudPairing, CloudPcStatus } from '../../src/shared/cloud-contract'
import type { IpcEventMap, IpcInvokeMap } from '../../src/shared/types'
import { CloudSection } from '../../src/renderer/src/components/cloud-section'
import { SettingsDialog } from '../../src/renderer/src/components/token-dialog'
import { TextPromptHost } from '../../src/renderer/src/components/text-prompt-host'
import { Toaster } from '../../src/renderer/src/components/toaster'
import { TooltipProvider } from '../../src/renderer/src/components/ui/tooltip'
import './placement.css'

/**
 * 모바일(클라우드) 설정 섹션 시각 검증 하네스.
 * 실제 CloudSection(과 SettingsDialog)을 그리고, window.nais 는 메모리 가짜다 — 네트워크·파일·NAI 호출 없음.
 *
 * 주소 인자
 *   ?state=connected|disconnected|unconfigured   (기본 connected)
 *   ?devices=0|1|2                               연결된 기기 수 (기본 2)
 *   ?gen=1                                       클라우드 생성 켜짐 (+ quota=available|exhausted|unknown|none)
 *   ?pending=N                                   그림 올리기 대기 N장
 *   ?failed=N                                    「올리지 못한 그림 N장」 (재시도 끝에 포기한 수)
 *   ?mismatch=1                                  판 불일치
 *   ?error=문구                                  오류 문구
 *   ?bare=1                                      설정 창 없이 섹션만 (폭 432px)
 *   ?fail=1                                      cloud:status 가 실패하는 경우
 *   ?expire=1                                    연결 코드가 4초 뒤 만료 (카운트다운·만료 표시 확인)
 *   ?section=모바일                              설정 창에서 그 탭을 자동으로 연다 (스크린샷용)
 *   ?click=연결 코드 만들기,지금 동기화          버튼을 글자로 찾아 차례로 누른다 (스크린샷용)
 * 브라우저 콘솔 window.cloudFixture 로 상태를 바꾸고 이벤트를 밀어 넣을 수 있다.
 */

const params = new URLSearchParams(location.search)
const MINUTE = 60_000

const baseStatus: CloudPcStatus = {
  configured: true,
  enabled: true,
  connected: true,
  url: 'https://nais3-cloud.example.workers.dev',
  lastSyncAt: Date.now() - 3 * MINUTE,
  error: null,
  uploadImages: true,
  cloudGen: { enabled: false, hasToken: true, quota: null },
  keepImages: 2000,
  devices: 2,
  pendingUploads: 0,
  failedUploads: 0,
  importedCount: 4,
  cloudJobsActive: 0,
  protocolMismatch: false
}

function initialStatus(): CloudPcStatus {
  const state = params.get('state') ?? 'connected'
  const status: CloudPcStatus = {
    ...baseStatus,
    devices: Number(params.get('devices') ?? 2),
    pendingUploads: Number(params.get('pending') ?? 0),
    failedUploads: Number(params.get('failed') ?? 0)
  }
  if (state === 'disconnected') {
    status.connected = false
    status.error = '클라우드에 연결하지 못했습니다 (시간 초과)'
  }
  if (state === 'unconfigured') {
    status.configured = false
    status.enabled = false
    status.connected = false
    status.url = ''
    status.lastSyncAt = null
    status.devices = 0
    status.uploadImages = false
  }
  if (params.get('gen') === '1') {
    const raw = params.get('quota') ?? 'available'
    const quota = raw === 'none' ? null : (raw as 'available' | 'exhausted' | 'unknown')
    status.cloudGen = { enabled: true, hasToken: true, quota }
  }
  if (params.get('mismatch') === '1') status.protocolMismatch = true
  if (params.get('error')) status.error = params.get('error')
  return status
}

let status = initialStatus()
let devices: CloudDevice[] = [
  { id: 'd1', name: '내 폰', createdAt: Date.now() - 86400_000, lastSeen: Date.now() - 20_000 },
  {
    id: 'd2',
    name: '태블릿',
    createdAt: Date.now() - 5 * 86400_000,
    lastSeen: Date.now() - 2 * 3600_000
  }
].slice(0, Number(params.get('devices') ?? 2))
const calls: { channel: string; req: unknown }[] = []

type Listener = (payload: never) => void
const listeners = new Map<string, Set<Listener>>()
const emit = <C extends keyof IpcEventMap>(channel: C, payload: IpcEventMap[C]): void =>
  listeners.get(channel)?.forEach((l) => (l as (p: IpcEventMap[C]) => void)(payload))

/** 스캔은 안 되는 가짜 QR — 모양과 여백만 본다 */
function fakeQrSvg(seed: string): string {
  const n = 29
  const quiet = 2
  let h = 0
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  const rand = (): number => {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0
    return h / 4294967296
  }
  const finder = (x: number, y: number): boolean => {
    const inBox = (ox: number, oy: number): boolean =>
      x >= ox && x < ox + 7 && y >= oy && y < oy + 7
    const ring = (ox: number, oy: number): boolean => {
      const dx = x - ox
      const dy = y - oy
      return (
        dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4)
      )
    }
    return (
      (inBox(0, 0) && ring(0, 0)) ||
      (inBox(n - 7, 0) && ring(n - 7, 0)) ||
      (inBox(0, n - 7) && ring(0, n - 7))
    )
  }
  const reserved = (x: number, y: number): boolean =>
    (x < 8 && y < 8) || (x >= n - 8 && y < 8) || (x < 8 && y >= n - 8)
  let d = ''
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const on = reserved(x, y) ? finder(x, y) : rand() > 0.52
      if (on) d += `M${x + quiet} ${y + quiet}h1v1h-1z`
    }
  }
  const size = n + quiet * 2
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`
}

let pairingSeq = 0
// 폰과 나눌 PC 폴더 — 처음에는 고르지 않은 상태
let driveRoot = ''

window.nais = {
  invoke: async <C extends keyof IpcInvokeMap>(
    channel: C,
    req: IpcInvokeMap[C]['req']
  ): Promise<IpcInvokeMap[C]['res']> => {
    calls.push({ channel, req })
    let result: unknown
    switch (channel) {
      case 'cloud:status':
        if (params.get('fail') === '1') throw new Error('상태를 읽지 못했습니다')
        result = status
        break
      case 'cloud:setEnabled':
        status = { ...status, enabled: (req as { enabled: boolean }).enabled }
        result = status
        break
      case 'cloud:setUploadImages':
        status = { ...status, uploadImages: (req as { enabled: boolean }).enabled }
        result = status
        break
      case 'cloud:setKeepImages':
        status = { ...status, keepImages: (req as { count: number }).count }
        result = status
        break
      case 'cloud:setCloudGen': {
        const enabled = (req as { enabled: boolean }).enabled
        status = {
          ...status,
          cloudGen: { enabled, hasToken: enabled, quota: enabled ? 'available' : null }
        }
        result = status
        break
      }
      case 'cloud:syncNow':
        status = { ...status, lastSyncAt: Date.now(), error: null, connected: true }
        result = status
        break
      case 'cloud:uploadRecent':
        result = { queued: 12 }
        break
      case 'cloud:driveRoot':
        result = { path: driveRoot }
        break
      case 'cloud:pickDriveRoot':
        driveRoot = 'C:/Pictures/NAIS3 공유'
        result = { path: driveRoot }
        break
      case 'cloud:clearDriveRoot':
        driveRoot = ''
        result = { path: driveRoot }
        break
      case 'cloud:pairing': {
        const code = ['K7QM2XWD', 'H4ZP9TNB', 'R3VE6CYA'][pairingSeq++ % 3]
        const pairing: CloudPairing = {
          code,
          url: `${status.url}/#pair=${code}`,
          expiresAt: Date.now() + (params.get('expire') === '1' ? 4_000 : 10 * MINUTE),
          qrSvg: fakeQrSvg(code)
        }
        result = pairing
        break
      }
      case 'cloud:devices':
        result = { items: devices }
        break
      case 'cloud:revokeDevice':
        devices = devices.filter((d) => d.id !== (req as { id: string }).id)
        status = { ...status, devices: devices.length }
        result = { items: devices }
        break
      default:
        throw new Error(`UI fixture blocked IPC: ${channel}`)
    }
    return result as IpcInvokeMap[C]['res']
  },
  on: (channel, listener) => {
    const set = listeners.get(channel) ?? new Set<Listener>()
    set.add(listener as Listener)
    listeners.set(channel, set)
    return () => set.delete(listener as Listener)
  },
  pathForFile: () => {
    throw new Error('No filesystem in fixture')
  }
}

Object.assign(window, {
  cloudFixture: {
    calls: () => calls,
    status: () => status,
    /** 상태를 일부 바꾸고 메인이 밀어 주는 것처럼 cloud:status 이벤트를 보낸다 */
    push: (patch: Partial<CloudPcStatus>) => {
      status = { ...status, ...patch }
      emit('cloud:status', status)
    }
  }
})

const bare = params.get('bare') === '1'

/** 스크린샷용 자동 조작 — ?section=모바일 (설정 창 탭 열기), ?click=버튼 글자 (쉼표로 여러 개, 앞에서부터 차례로) */
function autoDrive(): void {
  const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  const find = async (select: () => HTMLElement | undefined): Promise<HTMLElement | undefined> => {
    for (let i = 0; i < 40; i++) {
      const el = select()
      if (el) return el
      await pause(50)
    }
    return undefined
  }
  void (async () => {
    const section = params.get('section')
    if (section) {
      const tab = await find(() =>
        [...document.querySelectorAll<HTMLElement>('[role=tab]')].find((t) =>
          t.textContent?.includes(section)
        )
      )
      // Radix 탭은 마우스 누름으로 바뀐다
      tab?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      await pause(300)
    }
    for (const label of (params.get('click') ?? '').split(',').filter(Boolean)) {
      const button = await find(() =>
        [...document.querySelectorAll<HTMLElement>('button')].find((b) =>
          b.textContent?.includes(label)
        )
      )
      button?.click()
      await pause(400)
    }
  })()
}
autoDrive()

createRoot(document.getElementById('root')!).render(
  <TooltipProvider>
    {bare ? (
      <main className="mx-auto w-[432px] px-0 py-6">
        <CloudSection />
      </main>
    ) : (
      <SettingsDialog open onOpenChange={() => undefined} />
    )}
    <TextPromptHost />
    <Toaster />
  </TooltipProvider>
)
