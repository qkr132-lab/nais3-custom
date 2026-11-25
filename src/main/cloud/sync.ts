import JSZip from 'jszip'
import { CLOUD_PROTOCOL } from '../../shared/cloud-contract'
import { quotaState } from '../../shared/opus-usage'
import type {
  CloudAckRequest,
  CloudControlAction,
  CloudDevice,
  CloudGeneratedImage,
  CloudHashes,
  CloudImageMeta,
  CloudJob,
  CloudNaiInfo,
  CloudOp,
  CloudPairing,
  CloudPcInfo,
  CloudPcStatus,
  CloudPollRequest,
  CloudPollResponse,
  CloudPreparedItem,
  CloudSceneCounts,
  CloudSettings,
  CloudWork,
  CloudWorkResult
} from '../../shared/cloud-contract'
import type { QueueStatusLite } from '../../shared/types'
import { CloudError, type CloudClient } from './client'
import {
  buildSnapshot,
  hashValue,
  sceneCountsOf,
  stableStringify,
  summarizeQueue,
  type SnapshotSource
} from './snapshot'
import type {
  CloudBroadcast,
  CloudConfigPort,
  CloudImageDeps,
  CloudImageSavedInfo,
  CloudQueuePort,
  NaiBalanceInfo,
  UploadBytes
} from './types'

/**
 * 클라우드 동기화 본체 (커스텀) — 설계 cloud/DESIGN.md 8절.
 *
 * 전역(electron·DB·fetch)을 직접 import 하지 않는다. 설정·큐·fetch(client)·DB 읽기·그림 저장·
 * 이벤트 전송을 전부 주입받아서, 테스트가 가짜로 갈아 끼운다. 실제 연결은 index.ts 가 한다.
 *
 * 비밀 규칙: PC 비밀값과 NAI 토큰은 로그·오류 문구·broadcast·상태에 넣지 않는다.
 */

// ── 상수 ────────────────────────────────────────────────────────────

export const POLL_INTERVAL_MS = 5_000
export const SYNC_INTERVAL_MS = 30_000
/** 그림 저장·편집 반영 뒤 바뀐 것을 올리기까지 기다리는 시간(디바운스) */
export const SYNC_DEBOUNCE_MS = 3_000
export const UPLOAD_CONCURRENCY = 2
/** 첫 시도가 실패한 뒤 다시 해 보는 횟수 */
export const UPLOAD_RETRIES = 3
export const UPLOAD_RETRY_DELAY_MS = 2_000
/** 그림 본문 업로드 제한 시간 */
const UPLOAD_TIMEOUT_MS = 60_000
/** 클라우드가 needsFullSync 를 계속 줄 때 전체 올리기를 다시 시도하기까지 최소 간격 */
export const FULL_SYNC_MIN_GAP_MS = 15_000
export const PREPARED_MAX_ITEMS = 200
/** 서버 한도(2MB)보다 여유 있게 */
export const PREPARED_MAX_BYTES = 1_500_000
const THUMB_MAX_BYTES = 512 * 1024
/** 클라우드 그림 가져오기를 연달아 이만큼 실패하면 그 그림은 이번 실행에서 건너뛴다 */
const IMPORT_MAX_FAILS = 3
const RECENT_MAX = 5000
/** 렌더러에 넘긴 scene:update 줄을 기억하는 최대 수 — 결과를 못 받고 남은 것이 쌓이지 않게 오래된 것부터 버린다 */
const HANDED_SCENE_OPS_MAX = 1000
/** 클라우드가 알려 준 무료 사용량 확인값을 믿는 시간 — 지나면 PC 가 잰 값으로 바꿔 보여 준다 */
export const QUOTA_FRESH_MS = 30 * 60_000
/** 계정 정보(잔액)가 그대로여도 이 시간이 지나면 시각만 새로 찍어 올린다 */
export const NAI_INFO_REFRESH_MS = 10 * 60_000
/** 씬마다 그림 수를 클라우드에 올리는 최소 간격 — 그림 한 장마다 올리지 않는다 */
export const SCENE_COUNTS_MIN_GAP_MS = 60_000
/** 잔액이 바뀌어도 이 시간 안에 이미 맞췄으면 3초 예약을 하지 않는다 (30초 주기가 맡는다) */
export const NAI_INFO_SYNC_GAP_MS = 60_000

// ── 순수 도우미 (테스트 대상) ────────────────────────────────────────

/** 완성 요청 묶음 나누기 — 한 묶음 최대 200개·약 1.5MB */
export function chunkPrepared(
  items: CloudPreparedItem[],
  maxItems = PREPARED_MAX_ITEMS,
  maxBytes = PREPARED_MAX_BYTES
): CloudPreparedItem[][] {
  const out: CloudPreparedItem[][] = []
  let cur: CloudPreparedItem[] = []
  let bytes = 0
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item))
    if (cur.length > 0 && (cur.length >= maxItems || bytes + size > maxBytes)) {
      out.push(cur)
      cur = []
      bytes = 0
    }
    cur.push(item)
    bytes += size
  }
  if (cur.length > 0) out.push(cur)
  return out
}

type JobAck = CloudAckRequest['jobs'][number]

/** 이번 동기화에서 되돌려 올릴 것 — 반영 못 한 편집이 있을 때 해시와 무관하게 다시 올린다 */
interface Revert {
  library: boolean
  sceneIds: Set<number>
}

/**
 * 작업이 끝났는지 보고 ack 를 만든다. 끝나지 않았으면 null.
 * 하나라도 만들었으면 done, 하나도 못 만들었으면 failed. 취소·누락은 실패 장수에 센다.
 */
export function jobOutcome(
  jobId: string,
  queueIds: string[],
  status: QueueStatusLite,
  scrub: (text: string) => string
): JobAck | null {
  const byId = new Map(status.items.map((i) => [i.id, i]))
  let done = 0
  let failed = 0
  let firstError: string | undefined
  for (const id of queueIds) {
    const item = byId.get(id)
    if (item && (item.state === 'pending' || item.state === 'generating')) return null
    if (item?.state === 'done') done++
    else {
      failed++
      if (!firstError)
        firstError = item?.error ?? (item?.state === 'cancelled' ? '취소됨' : undefined)
    }
  }
  if (done > 0) return { id: jobId, state: 'done', done, failed }
  return {
    id: jobId,
    state: 'failed',
    done: 0,
    failed,
    error: scrub(firstError ?? '그림을 만들지 못했습니다')
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47]
export function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b)
}

/** NAI 가 돌려준 zip 의 첫 파일(PNG 한 장) */
export async function firstPngFromZip(zip: Uint8Array): Promise<Buffer> {
  const loaded = await JSZip.loadAsync(zip)
  const entry = Object.values(loaded.files).find((f) => !f.dir)
  if (!entry) throw new Error('받은 파일에 그림이 없습니다')
  const png = await entry.async('nodebuffer')
  if (!isPng(png)) throw new Error('받은 그림의 형식이 올바르지 않습니다')
  return png
}

/**
 * 올릴 만큼 달라졌는가 — 다음 1% 회복까지 남은 초는 매번 달라지므로 보지 않는다.
 * 충전 아이템 추가분도 본다 — 일반분이 0%인 채 추가분만 늘거나 줄어도 폰에 알린다 (커스텀)
 */
export function sameNaiBalance(a: NaiBalanceInfo, b: NaiBalanceInfo): boolean {
  const accSig = (x: NaiBalanceInfo): string =>
    x.accounts
      ? JSON.stringify(
          x.accounts.map((acc) => [
            acc.id,
            acc.label,
            acc.active,
            acc.tier,
            acc.anlas,
            acc.opusUsage?.percent ?? null,
            acc.opusUsage?.purchasedPercent ?? 0,
            acc.opusUsage?.isNegative ?? null
          ])
        )
      : ''
  return (
    a.tier === b.tier &&
    a.anlas === b.anlas &&
    (a.opusUsage?.percent ?? null) === (b.opusUsage?.percent ?? null) &&
    (a.opusUsage?.purchasedPercent ?? 0) === (b.opusUsage?.purchasedPercent ?? 0) &&
    (a.opusUsage?.isNegative ?? null) === (b.opusUsage?.isNegative ?? null) &&
    (a.turboEnabled ?? false) === (b.turboEnabled ?? false) &&
    (a.autoSwitchEnabled ?? false) === (b.autoSwitchEnabled ?? false) &&
    accSig(a) === accSig(b)
  )
}

const sameSet = (a: Iterable<string>, b: Iterable<string>): boolean => {
  const x = new Set(a)
  const y = new Set(b)
  if (x.size !== y.size) return false
  for (const v of x) if (!y.has(v)) return false
  return true
}

// ── 본체 ────────────────────────────────────────────────────────────

export interface CloudSyncDeps {
  client: CloudClient
  config: CloudConfigPort
  queue: CloudQueuePort
  broadcast: CloudBroadcast
  readSource: () => SnapshotSource
  /**
   * 씬 id → 그림 수. 씬 목록을 읽지 않고 한 번에 센다.
   * 없으면 readSource 로 읽은 씬의 imageCount 로 대신한다(시험용 — 느리다)
   */
  readSceneCounts?: () => Record<string, number>
  images: CloudImageDeps
  /** 현재 활성 NAI 토큰 — 클라우드 생성을 켤 때·토큰이 바뀔 때만 클라우드로 보낸다 */
  getNaiToken: () => string | null
  /** 폰에서 보낸 PC 제어 명령 처리 (계정 전환·고속 모드·폴더 내보내기 등) */
  onControlOp?: (action: CloudControlAction) => void | Promise<void>
  appVersion: string
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface CloudSync {
  start(): void
  stop(): void
  status(): CloudPcStatus
  setEnabled(enabled: boolean): Promise<CloudPcStatus>
  setUploadImages(enabled: boolean): CloudPcStatus
  setKeepImages(count: number): Promise<CloudPcStatus>
  setCloudGen(enabled: boolean): Promise<CloudPcStatus>
  pairing(): Promise<CloudPairing>
  devices(): Promise<{ items: CloudDevice[] }>
  revokeDevice(id: string): Promise<{ items: CloudDevice[] }>
  syncNow(): Promise<CloudPcStatus>
  uploadRecent(count: number): { queued: number }
  rendererReady(): void
  workDone(result: CloudWorkResult): Promise<void>
  putPrepared(req: { items: CloudPreparedItem[]; allKeys?: string[] }): Promise<void>
  onImageSaved(info: CloudImageSavedInfo): void
  onNaiTokenChanged(): Promise<void>
  /** 잔액 조회 결과 — library.naiInfo 로 실어 다음 동기화 때 올린다 */
  onNaiInfo(info: NaiBalanceInfo): void
  // 아래는 타이머가 부르는 일 — 테스트가 직접 부른다
  pollOnce(): Promise<void>
  /** 해시 비교로 바뀐 것만 올리기. full 이면 해시를 무시하고 전부. 성공하면 true */
  syncOnce(full?: boolean): Promise<boolean>
  refreshInfo(): Promise<void>
  importOnce(): Promise<void>
  /** 올리기 대기열이 빌 때까지 */
  drainUploads(): Promise<void>
}

interface UploadJob {
  id: number
  filePath: string
  sceneId: number | null
  seed: number | null
  kind: string
  width?: number
  height?: number
  createdAt: number
}

interface TrackedJob {
  queueIds: string[]
}

export function createCloudSync(deps: CloudSyncDeps): CloudSync {
  const { client, config, queue, images } = deps
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  // 연결 상태
  let connected = false
  let connError: string | null = null
  let connectFileError: string | null = null
  let syncError: string | null = null
  let lastSyncAt: number | null = null
  let protocolMismatch = false
  let info: CloudPcInfo | null = null
  let deviceCount = 0
  let cloudJobsActive = 0
  let importedCount = 0
  let lastEmitted = ''
  /** 잔액 조회로 받은 계정 정보 (메모리에만 — 다시 켜면 첫 조회 때까지 등급만 올라간다) */
  let naiInfo: CloudNaiInfo | null = null

  // 폰 작업
  let rendererIsReady = false
  const handedOps = new Set<number>()
  const handedJobs = new Map<string, CloudJob>()
  const cancelRequested = new Set<string>()
  const tracked = new Map<string, TrackedJob>()
  const outbox = { opIds: new Set<number>(), jobs: new Map<string, JobAck>() }

  // 해시·완성 요청
  let knownPrepared: Record<string, string> | null = null
  let lastFullSyncAt = 0
  let settingsBusy = false
  /** 렌더러가 반영 못 한 폰 편집이 있었다 — 다음 라이브러리 업로드는 해시가 같아도 보내 폰 사본을 PC 실제 값으로 되돌린다 */
  let forceLibraryUpload = false
  /**
   * 되돌릴 씬 id — 반영 못 한 scene:update 의 씬. 씬은 프리셋 해시가 같으면 다시 보내지 않으므로
   * (라이브러리 강제 업로드로는 안 돌아온다) 그 씬의 프리셋을 해시와 무관하게 다음 동기화 때 다시 올린다
   */
  const forceSceneIds = new Set<number>()
  /**
   * 반영 못 한 편집 줄 번호 — 이 줄들의 ack 가 워커에 닿은 뒤에야 되돌리는 업로드를 한다.
   * ack 전(워커의 acked=0)에 올리면 워커가 그 줄(char·main·scene)을 업로드 위에 다시 덧입혀 되돌림이 사라진다
   */
  const failedEditIds = new Set<number>()
  /** 렌더러에 넘긴 scene:update 줄 번호 → 씬 id — 실패한 줄이 어느 씬 것인지 알아내는 용도 (넘길 때 적고, 결과를 받으면 지운다) */
  const handedSceneOps = new Map<number, number>()

  // 씬 그림 수 (씬 본문과 따로 — 60초에 한 번 이하, 바뀌었을 때만)
  /** 마지막으로 올린 그림 수 묶음의 해시 (null = 아직 안 올렸다) */
  let countsKey: string | null = null
  /** 마지막으로 그림 수를 센 시각 (0 = 아직 안 셌다) */
  let countsCheckedAt = 0
  /** 그림이 저장돼 그림 수를 곧 다시 세야 한다 */
  let countsDirty = false

  // NAI 토큰을 바꿔 올리려다 실패했다 — 정보 확인 때 성공할 때까지 다시 올린다
  let pendingTokenPush = false

  // 그림 올리기
  const uploadQueue: UploadJob[] = []
  const queuedIds = new Set<number>()
  const failedUploads = new Set<number>()
  let uploadedSet: Set<number> | null = null
  let uploadedDirty = false
  let uploading = 0
  const idleWaiters: (() => void)[] = []

  // 클라우드 그림 가져오기 — 알림 대기표는 설정(cloud_upload_state)에도 적어 둔다
  const pendingImported = new Map<string, number>()
  const importFails = new Map<string, number>()
  let importing = false

  // 타이머·동시 실행 막이
  let started = false
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let syncTimer: ReturnType<typeof setInterval> | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let countsTimer: ReturnType<typeof setTimeout> | null = null
  let polling = false
  let slowRunning = false
  let syncTail: Promise<unknown> = Promise.resolve()
  let queuedNormalSync: Promise<boolean> | null = null

  const active = (): boolean => config.hasSecret() && config.enabled()
  /** 판이 같을 때만 올리고 받는다 */
  const usable = (): boolean => active() && !protocolMismatch

  // ── 상태 ──────────────────────────────────────────────────────────

  /** 무료 사용량 — 클라우드가 30분 안에 확인한 값, 아니면 PC 가 잰 Opus 사용량, 둘 다 없으면 null */
  function quota(): CloudPcStatus['cloudGen']['quota'] {
    const checked = info?.quota
    if (checked && now() - checked.checkedAt <= QUOTA_FRESH_MS) return checked.state
    return naiInfo?.opusUsage ? quotaState(naiInfo.opusUsage) : null
  }

  function status(): CloudPcStatus {
    return {
      configured: config.hasSecret(),
      enabled: config.enabled(),
      connected,
      url: config.url(),
      lastSyncAt,
      error: connError ?? connectFileError ?? syncError,
      uploadImages: config.uploadImages(),
      cloudGen: {
        enabled: config.cloudGenEnabled(),
        hasToken: info?.hasNaiToken ?? false,
        quota: quota()
      },
      keepImages: config.keepImages(),
      devices: deviceCount,
      pendingUploads: uploadQueue.length + uploading,
      failedUploads: failedUploads.size,
      importedCount,
      cloudJobsActive,
      protocolMismatch
    }
  }

  /** 바뀐 때만 보낸다 */
  function emitStatus(): void {
    const s = status()
    const key = stableStringify(s)
    if (key === lastEmitted) return
    lastEmitted = key
    deps.broadcast('cloud:status', s)
  }

  /** 글자열에서 PC 비밀값·NAI 토큰을 가린다 (오류 문구에 실리는 글자용) */
  function scrub(text: string): string {
    let out = client.redact(text)
    const token = deps.getNaiToken()
    if (token) out = out.split(token).join('***')
    return out.replace(/pst-[A-Za-z0-9_-]+/g, '***').slice(0, 300)
  }

  const errorText = (e: unknown): string => scrub(e instanceof Error ? e.message : String(e))

  /** 요청 한 번 — 성공·실패를 연결 상태에 반영한다 */
  async function call<T = Record<string, unknown>>(
    path: string,
    init?: Parameters<CloudClient['request']>[1]
  ): Promise<T> {
    try {
      const res = await client.request<T>(path, init)
      connected = true
      connError = null
      return res
    } catch (e) {
      connected = false
      connError = errorText(e)
      throw e
    }
  }

  async function callBytes(
    path: string,
    init?: Parameters<CloudClient['request']>[1]
  ): Promise<Uint8Array> {
    try {
      const res = await client.requestBytes(path, init)
      connected = true
      connError = null
      return res
    } catch (e) {
      connected = false
      connError = errorText(e)
      throw e
    }
  }

  const settingsBody = (cloudGenEnabled = config.cloudGenEnabled()): CloudSettings => ({
    cloudGenEnabled,
    keepImages: config.keepImages()
  })

  // ── 연결 파일 ─────────────────────────────────────────────────────

  function checkConnectFile(): void {
    const result = config.importConnectFile()
    if (result === 'invalid') {
      connectFileError = 'cloud-connect.json 파일 형식이 올바르지 않습니다'
    } else {
      connectFileError = null
      if (result === 'imported') {
        // 새 연결 정보 — 이전 상태는 버리고 바로 한 번 맞춘다. 저장소가 새로 생겼을 수 있으니
        // 「이미 올림」 기록도 비운다(안 비우면 [최근 올리기]가 「올릴 그림 없음」으로 끝난다)
        connError = null
        info = null
        knownPrepared = null
        resetUploadRecords()
        void slowCycle()
      }
    }
  }

  // ── 해시 비교 올리기 ──────────────────────────────────────────────

  /**
   * 반영 못 한 편집을 되돌리는 업로드를 지금 해도 되는지 보고, 해도 되면 플래그를 내리며 가져간다.
   * 실패한 줄의 ack 가 워커에 닿기 전에 올리면 워커가 아직 acked=0 인 그 줄을 업로드 위에 다시 덧입혀 되돌림이 사라진다 —
   * 그래서 대기 중인 ack 를 먼저 보내 보고, 실패한 줄이 아직 outbox 에 남아 있으면 이번엔 올리지 않고 플래그를 그대로 둔다.
   * (ack 를 기다린 뒤 확인과 플래그 내리기는 끊김 없이 한다 — 그 사이 새 반영 실패가 오면 그 플래그를 삼키지 않게)
   */
  async function takeRevert(): Promise<Revert> {
    await flushAcks()
    for (const id of [...failedEditIds]) if (!outbox.opIds.has(id)) failedEditIds.delete(id)
    if (failedEditIds.size > 0) return { library: false, sceneIds: new Set() }
    const taken: Revert = { library: forceLibraryUpload, sceneIds: new Set(forceSceneIds) }
    forceLibraryUpload = false
    forceSceneIds.clear()
    return taken
  }

  async function runSync(full: boolean): Promise<boolean> {
    if (!usable()) return false
    let revert: Revert = { library: false, sceneIds: new Set() }
    let libraryDone = false
    /** 이번에 올린 프리셋에 든 되돌릴 씬 */
    const revertedScenes = new Set<number>()
    try {
      if (forceLibraryUpload || forceSceneIds.size > 0) revert = await takeRevert()
      const snap = buildSnapshot(deps.readSource(), naiInfo)
      syncError = null
      const hashes: CloudHashes = full
        ? { library: null, fragments: null, scenes: {}, prepared: {} }
        : await call<CloudHashes>('/api/pc/hashes')
      knownPrepared = { ...(hashes.prepared ?? {}) }
      // 라이브러리를 먼저 — 워커는 라이브러리에 없는 프리셋의 씬을 지운다
      if (revert.library || hashes.library !== snap.libraryHash) {
        await call('/api/pc/library', {
          method: 'PUT',
          json: { library: snap.library, hash: snap.libraryHash }
        })
      }
      libraryDone = true
      for (const batch of snap.scenes) {
        // 되돌릴 씬이 든 프리셋은 해시가 같아도 다시 올린다 (PC 에서 지워진 씬은 어느 프리셋에도 없어 건너뛴다)
        const reverting =
          revert.sceneIds.size > 0 ? batch.scenes.filter((s) => revert.sceneIds.has(s.id)) : []
        if (reverting.length > 0 || hashes.scenes?.[String(batch.presetId)] !== batch.hash) {
          await call('/api/pc/scenes', {
            method: 'PUT',
            json: { presetId: batch.presetId, scenes: batch.scenes, hash: batch.hash }
          })
        }
        for (const s of reverting) revertedScenes.add(s.id)
      }
      if (hashes.fragments !== snap.fragments.hash) {
        await call('/api/pc/fragments', {
          method: 'PUT',
          json: { byPath: snap.fragments.byPath, hash: snap.fragments.hash }
        })
      }
      await syncSceneCounts(full)
      lastSyncAt = now()
      return true
    } catch (e) {
      // 가져간 되돌림 중 못 끝낸 것은 되살려 다음 동기화에서 다시 한다 (끝낸 것은 다시 하지 않는다)
      if (revert.library && !libraryDone) forceLibraryUpload = true
      for (const id of revert.sceneIds) if (!revertedScenes.has(id)) forceSceneIds.add(id)
      if (!(e instanceof CloudError)) syncError = `동기화 준비 실패: ${errorText(e)}`
      return false
    } finally {
      emitStatus()
    }
  }

  function syncOnce(full = false): Promise<boolean> {
    if (!full && queuedNormalSync) return queuedNormalSync
    const run = syncTail.then(() => {
      if (!full) queuedNormalSync = null
      return runSync(full)
    })
    syncTail = run
    if (!full) queuedNormalSync = run
    return run
  }

  function scheduleSync(): void {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void syncOnce(false)
    }, SYNC_DEBOUNCE_MS)
    ;(debounceTimer as { unref?: () => void }).unref?.()
  }

  // ── 씬 그림 수 ────────────────────────────────────────────────────

  function readCounts(): Record<string, number> {
    return deps.readSceneCounts ? deps.readSceneCounts() : sceneCountsOf(deps.readSource().scenes)
  }

  /**
   * 씬마다 그림 수를 세어, 지난번에 올린 것과 다를 때만 올린다. 세는 일도 60초에 한 번 이하 —
   * 그림 수는 씬 본문에 넣지 않으므로(프리셋 해시를 흔든다) 그림 한 장마다 씬 전체를 올리는 일이 없다.
   * force(클라우드 저장소가 새로 생겼을 때)면 간격도 같은 값 검사도 건너뛰고 올린다. 실패해도 던지지 않는다.
   */
  async function syncSceneCounts(force: boolean): Promise<void> {
    if (!usable()) return
    if (!force && countsCheckedAt > 0 && now() - countsCheckedAt < SCENE_COUNTS_MIN_GAP_MS) {
      if (countsDirty) armCounts() // 그 사이 그림이 또 저장됐다 — 간격이 지난 뒤에 다시 센다
      return
    }
    let counts: Record<string, number>
    try {
      counts = readCounts()
    } catch {
      return // DB 를 못 읽었다 — 다음 주기에
    }
    countsCheckedAt = now()
    countsDirty = false
    const key = hashValue(counts)
    if (!force && key === countsKey) return
    const body: CloudSceneCounts = { counts }
    try {
      await call('/api/pc/scene-counts', { method: 'PUT', json: body })
      countsKey = key
    } catch {
      // 연결 상태는 call 이 이미 기록했다 — 다음 주기에 다시
    }
  }

  /** 그림 수를 곧 다시 센다 — 마지막으로 센 지 60초가 안 됐으면 60초가 찰 때까지 기다린다 */
  function armCounts(): void {
    countsDirty = true
    if (countsTimer) return
    const wait = Math.max(SYNC_DEBOUNCE_MS, countsCheckedAt + SCENE_COUNTS_MIN_GAP_MS - now())
    countsTimer = setTimeout(() => {
      countsTimer = null
      void syncSceneCounts(false)
    }, wait)
    ;(countsTimer as { unref?: () => void }).unref?.()
  }

  // ── 클라우드 정보·설정 맞추기 ─────────────────────────────────────

  async function reconcileSettings(r: CloudPcInfo): Promise<void> {
    // 로컬 토큰이 없는데 클라우드 생성이 켜져 있다(토큰을 지울 때 연결이 안 됐던 경우) — 다시 끈다
    if (config.cloudGenEnabled() && !deps.getNaiToken()) {
      await dropCloudGenWithoutToken()
      if (!config.cloudGenEnabled()) {
        info = { ...r, hasNaiToken: false, settings: settingsBody(false) }
      }
      return
    }
    // 클라우드가 Anlas 감소 안전망으로 스스로 껐으면 PC 도 끈 것으로 따른다
    if (config.cloudGenEnabled() && !r.settings.cloudGenEnabled) config.setCloudGenEnabled(false)
    // PC 가 가진 설정이 기준 — 보관 장수가 다르거나, PC 는 꺼 뒀는데 클라우드가 켜져 있으면 맞춘다(켜는 쪽으론 맞추지 않는다)
    const body = settingsBody()
    if (
      r.settings.keepImages !== body.keepImages ||
      (r.settings.cloudGenEnabled && !body.cloudGenEnabled)
    ) {
      await call('/api/pc/settings', { method: 'PUT', json: body })
      info = { ...r, settings: body }
    }
  }

  /** 토큰을 바꿔 올리다 실패했으면 성공할 때까지 정보 확인 때마다 다시 올린다 */
  async function retryTokenPush(): Promise<void> {
    if (!pendingTokenPush) return
    const token = deps.getNaiToken()
    if (!config.cloudGenEnabled() || !token) {
      pendingTokenPush = false // 클라우드 생성이 꺼졌거나 토큰이 없어졌다 — 다른 경로가 맡는다
      return
    }
    await call('/api/pc/nai-token', { method: 'PUT', json: { token } })
    pendingTokenPush = false
  }

  async function refreshInfo(): Promise<void> {
    if (!active()) return
    try {
      const r = await call<CloudPcInfo>('/api/pc/info')
      info = r
      deviceCount = r.devices
      cloudJobsActive = r.cloudJobsActive
      setProtocolMismatch(r.protocol !== CLOUD_PROTOCOL)
      if (!settingsBusy && !protocolMismatch) {
        await reconcileSettings(r)
        await retryTokenPush()
      }
    } catch {
      // 연결 상태는 call 이 이미 기록했다
    }
    emitStatus()
  }

  /**
   * 완성 요청을 처음부터 다시 올리게 한다 — 올리지 못한 동안(동기화 꺼짐·판 불일치) 바뀐 내용을
   * 렌더러가 올린 것으로 알고 있을 수 있어서, 렌더러의 「보냄」 기록을 비우게 하고 클라우드가 가진 해시도 다시 읽는다.
   * rereadHashes=false 는 방금 전체 올리기로 클라우드 완성 요청이 비었다고 알아낸 경우 — 해시를 다시 읽지 않고 빈 것으로 둔다.
   */
  function requestFullPrepared(rereadHashes = true): void {
    if (rereadHashes) knownPrepared = null
    deps.broadcast('cloud:needPrepared', { full: true })
  }

  /** 앱·워커 판이 맞는지 기록한다. 달라졌다가 다시 맞으면 완성 요청을 전부 다시 올리게 한다 */
  function setProtocolMismatch(next: boolean): void {
    const was = protocolMismatch
    protocolMismatch = next
    if (was && !next) requestFullPrepared()
  }

  // ── poll · 폰 작업 ────────────────────────────────────────────────

  /** ack 보내기 — 실패하면 쌓아 두고 다음에 다시 */
  let flushing: Promise<void> | null = null
  function flushAcks(): Promise<void> {
    if (flushing) return flushing
    if (outbox.opIds.size === 0 && outbox.jobs.size === 0) return Promise.resolve()
    const run = (async () => {
      for (let round = 0; round < 5; round++) {
        if (outbox.opIds.size === 0 && outbox.jobs.size === 0) break
        const opIds = [...outbox.opIds]
        const failedOpIds = opIds.filter((id) => failedEditIds.has(id))
        const jobs = [...outbox.jobs.values()]
        const body: CloudAckRequest =
          failedOpIds.length > 0 ? { opIds, failedOpIds, jobs } : { opIds, jobs }
        try {
          await call('/api/pc/ack', { method: 'POST', json: body })
        } catch {
          break
        }
        for (const id of opIds) outbox.opIds.delete(id)
        for (const job of jobs) if (outbox.jobs.get(job.id) === job) outbox.jobs.delete(job.id)
      }
    })()
    flushing = run
    void run.finally(() => {
      if (flushing === run) flushing = null
    })
    return run
  }

  /** job:cancel 은 메인이 직접 — 그 작업의 큐 항목을 취소한다 */
  function handleCancel(op: Extract<CloudOp, { type: 'job:cancel' }>): void {
    const t = tracked.get(op.jobId)
    if (t) {
      queue.cancel(t.queueIds)
    } else {
      // 아직 큐에 안 들어갔다 — 들어오는 대로 취소하고, 새로 넘기지도 않는다
      cancelRequested.add(op.jobId)
    }
    outbox.opIds.add(op.id)
  }

  /** 작업의 큐 항목을 지켜보기 시작한다 — 취소 요청이 먼저 와 있었으면 바로 취소하고, accepted ack 를 쌓는다 */
  function trackJob(jobId: string, queueIds: string[]): void {
    tracked.set(jobId, { queueIds })
    listenQueue()
    // accepted 를 먼저 쌓는다 — 아래 취소가 바로 끝 상태 알림을 불러 끝 ack 로 바꿔 놓을 수 있다
    outbox.jobs.set(jobId, { id: jobId, state: 'accepted' })
    if (cancelRequested.has(jobId)) queue.cancel(queueIds)
  }

  /**
   * 큐에 이미 이 작업의 항목이 있는 작업은 렌더러에 다시 넘기지 않고 그 큐 id 들로 이어 받는다.
   * (렌더러 새로고침으로 넘겼다는 기억이 지워졌거나, 늦게 온 poll 응답에 끝난 작업이 또 실려 온 경우)
   * 렌더러가 준비됐는지와 상관없이 메인 안에서 끝나는 일이다. 렌더러에 넘길 나머지 작업을 돌려준다.
   */
  function adoptQueuedJobs(jobs: CloudJob[]): CloudJob[] {
    const rest: CloudJob[] = []
    let adopted = false
    for (const job of jobs) {
      if (handedJobs.has(job.id) || tracked.has(job.id) || outbox.jobs.has(job.id)) continue
      const queueIds = queue.idsByCloudJob(job.id)
      if (queueIds.length > 0) {
        trackJob(job.id, queueIds)
        adopted = true
      } else if (!cancelRequested.has(job.id)) {
        rest.push(job)
      }
    }
    // 이어 받자마자 이미 끝나 있을 수도 있다
    if (adopted) evaluateTracked(queue.statusLite())
    return rest
  }

  /** 렌더러에 넘긴 scene:update 줄을 기억한다 — 반영에 실패했다는 답이 오면 어느 씬을 되돌릴지 알아야 한다 */
  function rememberSceneOp(opId: number, sceneId: number): void {
    handedSceneOps.set(opId, sceneId)
    if (handedSceneOps.size > HANDED_SCENE_OPS_MAX) {
      const oldest = handedSceneOps.keys().next()
      if (!oldest.done) handedSceneOps.delete(oldest.value)
    }
  }

  function dispatchWork(res: CloudPollResponse): void {
    for (const op of res.ops) {
      if (op.type === 'job:cancel') handleCancel(op)
      else if (op.type === 'pc:control' && !handedOps.has(op.id)) {
        handedOps.add(op.id)
        outbox.opIds.add(op.id)
        void Promise.resolve(deps.onControlOp?.(op.action)).catch(() => undefined)
      }
    }

    const jobs = adoptQueuedJobs(res.jobs)
    if (!rendererIsReady) return
    const ops = res.ops
      .filter((op) => op.type !== 'job:cancel' && op.type !== 'pc:control' && !handedOps.has(op.id))
      .sort((a, b) => a.id - b.id)
    if (ops.length === 0 && jobs.length === 0) return
    for (const op of ops) {
      handedOps.add(op.id)
      if (op.type === 'scene:update') rememberSceneOp(op.id, op.sceneId)
    }
    for (const job of jobs) handedJobs.set(job.id, job)
    const work: CloudWork = { ops, jobs }
    deps.broadcast('cloud:work', work)
  }

  /**
   * 지금 PC 가 맡고 있는 폰 작업 id 전부 — 큐를 지켜보는 중인 것 + 끝났지만 끝 ack 가 아직 클라우드에
   * 못 간 것. 클라우드는 여기 없는 'pc' 상태 작업을 PC 가 잃은 것으로 보고 실패 처리한다(accepted 뒤 60초 유예).
   */
  function activeJobIds(): string[] {
    const ids = new Set<string>(tracked.keys())
    for (const id of outbox.jobs.keys()) ids.add(id)
    return [...ids]
  }

  async function doPoll(): Promise<void> {
    const body: CloudPollRequest = {
      protocol: CLOUD_PROTOCOL,
      appVersion: deps.appVersion,
      queue: summarizeQueue(queue.statusLite(), now()),
      acceptsJobs: rendererIsReady,
      activeJobIds: activeJobIds()
    }
    let res: CloudPollResponse
    try {
      res = await call<CloudPollResponse>('/api/pc/poll', { method: 'POST', json: body })
    } catch {
      return
    }
    setProtocolMismatch(res.protocol !== CLOUD_PROTOCOL)
    if (protocolMismatch) return

    await flushAcks()
    dispatchWork(res)
    await flushAcks()

    if (res.needsFullSync && now() - lastFullSyncAt >= FULL_SYNC_MIN_GAP_MS) {
      lastFullSyncAt = now()
      // 클라우드 저장소가 비었다 — 거기 올렸다고 기록한 그림들도 없다
      resetUploadRecords()
      if (await syncOnce(true)) requestFullPrepared(false) // 전체 올리기가 해시를 빈 것으로 이미 맞춰 뒀다
    }
    if (cloudJobsActive > 0) await importOnce()
  }

  async function pollOnce(): Promise<void> {
    if (polling) return
    polling = true
    try {
      checkConnectFile()
      if (!active()) return
      await doPoll()
    } finally {
      polling = false
      emitStatus()
    }
  }

  /** 큐가 바뀔 때마다 — 넘겨 받은 작업의 큐 항목이 전부 끝났는지 본다 */
  function onQueueChanged(queueStatus: QueueStatusLite): void {
    evaluateTracked(queueStatus)
  }

  /** 지켜볼 작업이 있는 동안만 큐 알림을 듣는다 */
  let listening = false
  function listenQueue(): void {
    if (listening) return
    listening = true
    queue.on('changed', onQueueChanged)
  }
  function unlistenQueue(force = false): void {
    if (!listening || (!force && tracked.size > 0)) return
    listening = false
    queue.off('changed', onQueueChanged)
  }

  function evaluateTracked(queueStatus: QueueStatusLite): void {
    if (tracked.size === 0) return
    let changed = false
    for (const [jobId, t] of [...tracked]) {
      const ack = jobOutcome(jobId, t.queueIds, queueStatus, scrub)
      if (!ack) continue
      tracked.delete(jobId)
      // 폰에서 취소한 작업도 끝 ack 를 보낸다 — 클라우드는 취소 상태를 그대로 두고 PC 가 만든 장수·실패 장수만 반영한다
      outbox.jobs.set(jobId, ack)
      changed = true
    }
    unlistenQueue()
    if (changed) void flushAcks().then(emitStatus)
  }

  async function workDone(result: CloudWorkResult): Promise<void> {
    for (const id of result.opIds) outbox.opIds.add(id)
    // 반영하지 못한 편집은 폰 사본에만 남아 있다 — 해시가 같아도 다음 라이브러리 업로드를 강제한다.
    // 실패한 scene:update 는 라이브러리를 올려도 안 돌아오므로(씬은 프리셋 해시가 같으면 다시 안 보낸다) 그 씬도 되돌릴 목록에 올린다.
    // 되돌리는 업로드는 이 줄들의 ack 가 워커에 닿은 뒤에야 나간다 (takeRevert)
    const failedIds = Array.isArray(result.failedOpIds)
      ? result.failedOpIds.filter((id) => Number.isInteger(id))
      : []
    const hasFailedOps = failedIds.length > 0
    if (hasFailedOps) {
      forceLibraryUpload = true
      for (const id of failedIds) {
        failedEditIds.add(id)
        const sceneId = handedSceneOps.get(id)
        if (sceneId !== undefined) forceSceneIds.add(sceneId)
      }
    }
    // 결과를 받은 줄은 더 기억할 필요가 없다 (다시 넘기면 그때 다시 적는다)
    for (const id of result.opIds) handedSceneOps.delete(id)
    for (const id of failedIds) handedSceneOps.delete(id)
    for (const j of result.jobs) {
      const handed = handedJobs.get(j.id)
      const queueIds = j.queueIds ?? []
      if (j.error || queueIds.length === 0) {
        outbox.jobs.set(j.id, {
          id: j.id,
          state: 'failed',
          done: 0,
          failed: handed?.count ?? 0,
          error: scrub(j.error ?? '큐에 들어간 항목이 없습니다')
        })
        continue
      }
      trackJob(j.id, queueIds)
    }
    await flushAcks()
    // 넘겨 받자마자 끝났을 수도 있다
    evaluateTracked(queue.statusLite())
    // 편집이 반영됐으니 바뀐 내용을 곧 올린다
    if (result.opIds.length > 0 || hasFailedOps) scheduleSync()
    emitStatus()
  }

  function rendererReady(): void {
    rendererIsReady = true
    // 렌더러가 새로 떴다 — 넘겨 놓고 답을 못 받은 것은 처음부터 다시 넘긴다
    handedOps.clear()
    for (const id of [...handedJobs.keys()]) {
      if (!tracked.has(id) && !outbox.jobs.has(id)) handedJobs.delete(id)
    }
    if (started) void pollOnce()
  }

  // ── 완성 요청(prepared) ───────────────────────────────────────────

  function unusableReason(): string {
    if (!config.hasSecret()) return '클라우드 연결 정보가 없어 완성 요청을 올리지 못했습니다'
    if (!config.enabled()) return '클라우드 동기화가 꺼져 있어 완성 요청을 올리지 못했습니다'
    return '앱과 클라우드의 판이 달라 완성 요청을 올리지 못했습니다'
  }

  async function putPrepared(req: {
    items: CloudPreparedItem[]
    allKeys?: string[]
  }): Promise<void> {
    // 조용히 돌려보내면 렌더러가 올린 것으로 기록해 영영 안 올라간다 — 던져서 다시 시도하게 한다
    if (!usable()) throw new Error(unusableReason())
    if (!knownPrepared) {
      const hashes = await call<CloudHashes>('/api/pc/hashes')
      knownPrepared = { ...(hashes.prepared ?? {}) }
    }
    const known = knownPrepared
    const changed = req.items.filter((item) => known[item.key] !== item.hash)
    const batches = chunkPrepared(changed)
    const allKeys = req.allKeys
    // allKeys 는 마지막 묶음에 — 바뀐 것이 없어도 남는 키가 있으면 지우러 한 번 보낸다
    if (allKeys && batches.length === 0 && !sameSet(allKeys, Object.keys(known))) batches.push([])
    for (let i = 0; i < batches.length; i++) {
      const last = i === batches.length - 1
      await call('/api/pc/prepared', {
        method: 'PUT',
        json: { items: batches[i], ...(last && allKeys ? { allKeys } : {}) }
      })
      for (const item of batches[i]) known[item.key] = item.hash
    }
    if (allKeys && batches.length > 0) {
      const keep = new Set(allKeys)
      for (const key of Object.keys(known)) if (!keep.has(key)) delete known[key]
    }
  }

  // ── 그림 올리기 ───────────────────────────────────────────────────

  /** 설정(cloud_upload_state)에 적어 둔 「올린 그림」과 「가져왔다 알림 대기표」를 처음 쓸 때 한 번 읽는다 */
  function uploaded(): Set<number> {
    if (!uploadedSet) {
      const saved = config.loadUploadState()
      uploadedSet = new Set(saved.uploaded)
      for (const [cloudId, pcId] of Object.entries(saved.pendingImported ?? {})) {
        if (Number.isInteger(pcId) && !pendingImported.has(cloudId)) {
          pendingImported.set(cloudId, pcId)
        }
      }
    }
    return uploadedSet
  }

  /** 두 기록을 한꺼번에 저장한다. 설정을 못 써도 던지지 않는다(메모리 기록은 그대로) */
  function persistState(): void {
    const set = uploaded()
    uploadedDirty = false
    try {
      config.saveUploadState({
        uploaded: [...set].sort((a, b) => a - b),
        pendingImported: Object.fromEntries(pendingImported)
      })
    } catch {
      uploadedDirty = true // 다음 기회에 다시
    }
  }

  function persistUploaded(): void {
    if (uploadedDirty && uploadedSet) persistState()
  }

  function markUploaded(id: number): void {
    uploaded().add(id)
    uploadedDirty = true
  }

  /**
   * 클라우드 저장소가 새로 생겼다(연결 파일을 새로 가져옴 · 클라우드가 전체 올리기를 요구함) —
   * 「이미 올림」 기록과 마지막으로 올린 그림 수를 비워 다시 올릴 수 있게 한다.
   * (가져왔다 알림 대기표는 그대로 둔다 — 같은 클라우드면 아직 유효하고, 없는 그림이면 404 로 정리된다)
   */
  function resetUploadRecords(): void {
    uploaded() // 알림 대기표까지 먼저 읽어 둔다
    uploadedSet = new Set()
    uploadedDirty = true
    persistState()
    countsKey = null
    countsCheckedAt = 0
  }

  function enqueueUpload(job: UploadJob): boolean {
    if (queuedIds.has(job.id) || uploaded().has(job.id)) return false
    failedUploads.delete(job.id)
    queuedIds.add(job.id)
    uploadQueue.push(job)
    pumpUploads()
    return true
  }

  async function sendImage(job: UploadJob, data: UploadBytes): Promise<void> {
    const meta: CloudImageMeta = {
      pcImageId: job.id,
      sceneId: job.sceneId,
      presetId: job.sceneId != null ? images.presetIdOfScene(job.sceneId) : null,
      seed: job.seed,
      width: job.width ?? data.width,
      height: job.height ?? data.height,
      createdAt: job.createdAt,
      kind: job.kind
    }
    await call(`/api/pc/images/p${job.id}`, {
      method: 'PUT',
      body: data.webp,
      headers: {
        'content-type': 'image/webp',
        'x-nais-meta': Buffer.from(JSON.stringify(meta), 'utf8').toString('base64url')
      },
      timeoutMs: UPLOAD_TIMEOUT_MS
    })
    if (data.thumb && data.thumb.byteLength > 0 && data.thumb.byteLength <= THUMB_MAX_BYTES) {
      await call(`/api/pc/images/p${job.id}/thumb`, {
        method: 'PUT',
        body: data.thumb,
        headers: { 'content-type': 'image/webp' },
        timeoutMs: UPLOAD_TIMEOUT_MS
      })
    }
  }

  /** 다시 해 봐도 소용없는 실패(요청 자체가 틀림·인증 실패) */
  const isPermanent = (e: unknown): boolean =>
    e instanceof CloudError &&
    e.status >= 400 &&
    e.status < 500 &&
    e.status !== 408 &&
    e.status !== 429

  async function runUpload(job: UploadJob): Promise<void> {
    if (!usable()) return
    let data: UploadBytes
    try {
      data = await images.readForUpload(job.id, job.filePath)
    } catch {
      failedUploads.add(job.id) // 파일을 못 읽음 — 다시 해도 같다
      return
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await sendImage(job, data)
        failedUploads.delete(job.id)
        markUploaded(job.id)
        return
      } catch (e) {
        if (attempt >= UPLOAD_RETRIES || isPermanent(e) || !usable()) {
          failedUploads.add(job.id)
          return
        }
        await sleep(UPLOAD_RETRY_DELAY_MS * (attempt + 1))
      }
    }
  }

  function pumpUploads(): void {
    while (uploading < UPLOAD_CONCURRENCY && uploadQueue.length > 0) {
      const job = uploadQueue.shift() as UploadJob
      uploading++
      void runUpload(job)
        .catch(() => failedUploads.add(job.id))
        .finally(() => {
          uploading--
          queuedIds.delete(job.id)
          pumpUploads()
          emitStatus()
        })
    }
    if (uploading === 0 && uploadQueue.length === 0) {
      persistUploaded()
      for (const wake of idleWaiters.splice(0)) wake()
    }
  }

  function drainUploads(): Promise<void> {
    if (uploading === 0 && uploadQueue.length === 0) return Promise.resolve()
    return new Promise<void>((resolve) => idleWaiters.push(resolve))
  }

  function onImageSaved(saved: CloudImageSavedInfo): void {
    if (!usable()) return
    // 씬 그림이면 그 씬의 그림 수가 바뀌었다 — 씬 스냅샷은 다시 만들지 않고 그림 수만 따로 (60초에 한 번 이하).
    // 씬이 없는 그림(메인 탭)은 어떤 씬의 수도 바꾸지 않으므로 아무것도 안 한다
    if (saved.sceneId != null) armCounts()
    if (!config.uploadImages()) return
    // SQLite 가 전체 비우기 뒤 id 를 1부터 다시 쓸 수 있으므로 방금 저장된 새 그림은 이전 업로드 기록에서 지운다
    if (uploaded().delete(saved.id)) uploadedDirty = true
    enqueueUpload({
      id: saved.id,
      filePath: saved.filePath,
      sceneId: saved.sceneId ?? null,
      seed: saved.seed,
      kind: saved.kind,
      width: saved.width,
      height: saved.height,
      createdAt: now()
    })
    emitStatus()
  }

  function uploadRecent(count: number): { queued: number } {
    if (!usable()) return { queued: 0 }
    const limit = Math.min(RECENT_MAX, Math.max(1, Math.floor(Number(count)) || 1))
    const recentList = images.listRecent(limit)
    if (recentList.length > 0) {
      const maxLiveId = Math.max(...recentList.map((r) => r.id))
      const set = uploaded()
      let maxUploaded = 0
      for (const id of set) if (id > maxUploaded) maxUploaded = id
      // 전체 비우기 뒤 SQLite id 가 초기화돼 이전 업로드 기록에 현재 최대 id 보다 큰 번호가 남아 있으면 정리한다
      if (maxUploaded > maxLiveId) {
        set.clear()
        uploadedDirty = true
        persistState()
      }
    }
    let queued = 0
    for (const r of recentList) {
      if (
        enqueueUpload({
          id: r.id,
          filePath: r.filePath,
          sceneId: r.sceneId,
          seed: r.seed,
          kind: r.kind,
          createdAt: r.createdAt
        })
      ) {
        queued++
      }
    }
    emitStatus()
    return { queued }
  }

  // ── 클라우드가 만든 그림 가져오기 ─────────────────────────────────

  const enc = encodeURIComponent

  async function importOne(item: CloudGeneratedImage): Promise<void> {
    // zip 은 수 MB 일 수 있어 그림 올리기와 같이 긴 제한 시간을 준다
    const zip = await callBytes(`/api/pc/cloud-images/${enc(item.id)}/file`, {
      timeoutMs: UPLOAD_TIMEOUT_MS
    })
    const png = await firstPngFromZip(zip)
    // 씬이 PC에서 지워졌으면 씬 없이 일반 그림으로 저장한다
    const scene = item.sceneId != null ? images.findScene(item.sceneId) : null
    const saved = await images.saveGenerated({
      png,
      sentPayload: item.sentPayload,
      seed: item.seed,
      kind: scene ? 'scene' : 't2i',
      format: 'png',
      ...(scene
        ? {
            sceneId: scene.id,
            sceneName: scene.name,
            scenePresetName: images.presetName(scene.presetId) ?? undefined
          }
        : {})
    })
    // 저장한 즉시 알림 대기표에 올리고 설정에도 적는다 — 이 뒤로 무엇이 던져도, 앱이 꺼졌다 켜져도
    // 같은 그림을 다시 받아 한 번 더 저장하지 않는다
    pendingImported.set(item.id, saved.id)
    markUploaded(saved.id) // 클라우드에서 온 그림은 다시 올리지 않는다
    persistState()
    importedCount++
    if (scene) {
      armCounts() // 그 씬의 그림 수가 늘었다
      try {
        deps.broadcast('scenes:changed', { sceneId: scene.id, filePath: saved.filePath })
      } catch {
        // 알림이 안 가도 그림은 저장됐다
      }
    }
    await notifyImported(item.id)
  }

  /**
   * 가져왔다고 알린다 — 실패하면 대기표에 남겨 두고(설정에도 적혀 있다) 다음에 다시 알리며, 그림은 다시 받지 않는다.
   * 클라우드에 그 그림이 없다고(404) 하면 알릴 곳이 없으니 대기표에서 뺀다.
   */
  async function notifyImported(cloudId: string): Promise<boolean> {
    const pcImageId = pendingImported.get(cloudId)
    if (pcImageId == null) return true
    try {
      await call(`/api/pc/cloud-images/${enc(cloudId)}/imported`, {
        method: 'POST',
        json: { pcImageId }
      })
    } catch (e) {
      if (!(e instanceof CloudError && e.status === 404)) return false
    }
    pendingImported.delete(cloudId)
    persistState()
    return true
  }

  async function importOnce(): Promise<void> {
    if (importing || !usable()) return
    importing = true
    try {
      // 지난 실행에서 못 알린 것부터 — 앱을 다시 켠 뒤에도 설정에서 읽어 와 먼저 다시 알린다
      uploaded()
      for (const cloudId of [...pendingImported.keys()]) {
        if (!(await notifyImported(cloudId))) return
      }
      const list = await call<{ items: CloudGeneratedImage[] }>('/api/pc/cloud-images')
      for (const item of list.items ?? []) {
        if (pendingImported.has(item.id)) continue
        if ((importFails.get(item.id) ?? 0) >= IMPORT_MAX_FAILS) continue
        try {
          await importOne(item)
        } catch (e) {
          if (e instanceof CloudError && e.status === 0) return // 연결 문제 — 다음 차례에
          importFails.set(item.id, (importFails.get(item.id) ?? 0) + 1)
          if (!(e instanceof CloudError)) syncError = `클라우드 그림 가져오기 실패: ${errorText(e)}`
        }
      }
    } catch {
      // 연결 상태는 call 이 이미 기록했다
    } finally {
      importing = false
      emitStatus()
    }
  }

  // ── 클라우드 생성 · NAI 토큰 ──────────────────────────────────────

  /** 클라우드에 맡긴 토큰부터 지우고 클라우드 생성을 끈다 */
  async function disableCloudGen(): Promise<void> {
    pendingTokenPush = false // 끄는 중이다 — 새 토큰을 다시 올릴 일이 없다
    // 토큰부터 지운다 — 설정 쪽이 실패해도 토큰은 이미 없다(다음 정보 확인 때 설정을 맞춘다)
    await call('/api/pc/nai-token', { method: 'DELETE' })
    config.setCloudGenEnabled(false)
    await call('/api/pc/settings', { method: 'PUT', json: settingsBody(false) })
  }

  /**
   * PC 에서 NAI 토큰이 사라졌는데 클라우드 생성이 켜져 있다 — 맡긴 토큰도 지우고 끈다.
   * 실패하면 켜 둔 채로 두고(연결 상태는 call 이 기록한다) 다음 정보 확인 때 다시 시도한다.
   */
  async function dropCloudGenWithoutToken(): Promise<void> {
    settingsBusy = true
    try {
      await disableCloudGen()
    } catch {
      // 위 설명대로 다음에 다시
    } finally {
      settingsBusy = false
    }
  }

  async function setCloudGen(enabled: boolean): Promise<CloudPcStatus> {
    if (!config.hasSecret()) throw new Error('클라우드 연결 정보가 없습니다')
    settingsBusy = true
    try {
      if (enabled) {
        const token = deps.getNaiToken()
        if (!token) throw new Error('NAI 토큰이 설정되지 않았습니다')
        await call('/api/pc/nai-token', { method: 'PUT', json: { token } })
        pendingTokenPush = false
        try {
          await call('/api/pc/settings', { method: 'PUT', json: settingsBody(true) })
        } catch (e) {
          // 토큰만 맡긴 채 남지 않게 되돌린다
          await call('/api/pc/nai-token', { method: 'DELETE' }).catch(() => undefined)
          throw e
        }
        config.setCloudGenEnabled(true)
        deps.broadcast('cloud:needPrepared', { full: false })
      } else {
        await disableCloudGen()
      }
    } finally {
      settingsBusy = false
      emitStatus()
    }
    await refreshInfo()
    return status()
  }

  async function onNaiTokenChanged(): Promise<void> {
    if (!config.hasSecret() || !config.cloudGenEnabled()) return
    const token = deps.getNaiToken()
    if (!token) {
      // 토큰을 지웠다 — 클라우드에 남은 사본도 지우고 클라우드 생성을 끈다
      await dropCloudGenWithoutToken()
      emitStatus()
      // 실패해서 아직 켜져 있으면 다음 정보 확인 때 다시 한다 (바로 또 시도하지 않는다)
      if (!config.cloudGenEnabled()) await refreshInfo()
      return
    }
    try {
      await call('/api/pc/nai-token', { method: 'PUT', json: { token } })
      pendingTokenPush = false
    } catch {
      // 연결 상태는 call 이 이미 기록했다. 클라우드에 옛 계정 토큰이 남지 않게 정보 확인 때 성공할 때까지 다시 올린다
      pendingTokenPush = true
    }
    emitStatus()
  }

  function onNaiInfo(next: NaiBalanceInfo): void {
    // 조회에 실패하면 셋 다 null 로 온다 — 이전 값을 지우지 않는다
    if (
      next.tier == null &&
      next.anlas == null &&
      next.opusUsage == null &&
      (!next.accounts || next.accounts.length === 0)
    )
      return
    const prev = naiInfo
    if (prev && sameNaiBalance(prev, next) && now() - prev.updatedAt < NAI_INFO_REFRESH_MS) return
    const accountsChanged =
      JSON.stringify(prev?.accounts?.map((a) => [a.id, a.active, a.opusUsage?.percent, a.opusUsage?.purchasedPercent])) !==
        JSON.stringify(next.accounts?.map((a) => [a.id, a.active, a.opusUsage?.percent, a.opusUsage?.purchasedPercent])) ||
      prev?.turboEnabled !== next.turboEnabled ||
      prev?.autoSwitchEnabled !== next.autoSwitchEnabled
    naiInfo = {
      tier: next.tier,
      anlas: next.anlas,
      opusUsage: next.opusUsage,
      updatedAt: now(),
      ...(next.accounts ? { accounts: next.accounts } : prev?.accounts ? { accounts: prev.accounts } : {}),
      ...(next.turboEnabled !== undefined
        ? { turboEnabled: next.turboEnabled }
        : prev?.turboEnabled !== undefined
          ? { turboEnabled: prev.turboEnabled }
          : {}),
      ...(next.autoSwitchEnabled !== undefined
        ? { autoSwitchEnabled: next.autoSwitchEnabled }
        : prev?.autoSwitchEnabled !== undefined
          ? { autoSwitchEnabled: prev.autoSwitchEnabled }
          : {})
    }
    emitStatus()
    // 계정 전환·추가 게이지 변동·다중 계정 정보 갱신은 바로 올리고, 단순 잔액 변화는 60초 간격을 지킨다
    if (
      usable() &&
      (accountsChanged || lastSyncAt == null || now() - lastSyncAt >= NAI_INFO_SYNC_GAP_MS)
    ) {
      scheduleSync()
    }
  }

  // ── 바깥에서 부르는 동작 ──────────────────────────────────────────

  async function slowCycle(): Promise<void> {
    if (slowRunning || !active()) return
    slowRunning = true
    try {
      await refreshInfo()
      await syncOnce(false)
      await importOnce()
    } finally {
      slowRunning = false
    }
  }

  function start(): void {
    if (started) return
    started = true
    pollTimer = setInterval(() => void pollOnce(), POLL_INTERVAL_MS)
    syncTimer = setInterval(() => void slowCycle(), SYNC_INTERVAL_MS)
    ;(pollTimer as { unref?: () => void }).unref?.()
    ;(syncTimer as { unref?: () => void }).unref?.()
    emitStatus()
    void slowCycle()
    void pollOnce()
  }

  function stop(): void {
    started = false
    unlistenQueue(true)
    if (pollTimer) clearInterval(pollTimer)
    if (syncTimer) clearInterval(syncTimer)
    if (debounceTimer) clearTimeout(debounceTimer)
    if (countsTimer) clearTimeout(countsTimer)
    pollTimer = syncTimer = debounceTimer = countsTimer = null
    persistUploaded()
  }

  return {
    start,
    stop,
    status,
    async setEnabled(enabled) {
      const was = config.enabled()
      config.setEnabled(enabled)
      // 꺼져 있는 동안 바뀐 내용은 못 올렸다 — 켜지면 완성 요청을 처음부터 다시 올리게 한다
      if (enabled && !was) requestFullPrepared()
      if (enabled && started) {
        void pollOnce()
        void slowCycle()
      }
      emitStatus()
      return status()
    },
    setUploadImages(enabled) {
      config.setUploadImages(enabled)
      emitStatus()
      return status()
    },
    async setKeepImages(count) {
      config.setKeepImages(count)
      // PC 가 아는 클라우드 생성 켜짐 값은 낡았을 수 있다(클라우드가 Anlas 안전망으로 껐을 수 있다) — 그걸 실어
      // 올리면 꺼진 클라우드 생성이 되살아난다. 클라우드 상태를 먼저 읽어 맞춘 뒤(refreshInfo 가 보관 장수도 맞춘다)
      // 새 값만 반영한다. 연결이 안 돼도 저장은 끝났다 — 다음 정보 확인 때 맞춘다
      if (usable()) await refreshInfo()
      emitStatus()
      return status()
    },
    setCloudGen,
    async pairing() {
      const r = await call<CloudPairing>('/api/pc/pairing', { method: 'POST' })
      return { code: r.code, url: r.url, expiresAt: r.expiresAt, qrSvg: r.qrSvg }
    },
    async devices() {
      const r = await call<{ items: CloudDevice[] }>('/api/pc/devices')
      deviceCount = r.items.length
      emitStatus()
      return { items: r.items }
    },
    async revokeDevice(id) {
      const r = await call<{ items: CloudDevice[] }>(`/api/pc/devices/${enc(id)}`, {
        method: 'DELETE'
      })
      deviceCount = r.items.length
      emitStatus()
      return { items: r.items }
    },
    async syncNow() {
      if (active()) {
        await refreshInfo()
        await syncOnce(false)
        await pollOnce()
        await importOnce()
      }
      emitStatus()
      return status()
    },
    uploadRecent,
    rendererReady,
    workDone,
    putPrepared,
    onImageSaved,
    onNaiTokenChanged,
    onNaiInfo,
    pollOnce,
    syncOnce,
    refreshInfo,
    importOnce,
    drainUploads
  }
}
