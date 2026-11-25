import { app } from 'electron'
import type { CloudAccountInfo, CloudControlAction } from '../../shared/cloud-contract'
import type { OpusUsage } from '../../shared/opus-usage'
import { accountToken, adoptLegacyToken, listAccounts, setActiveAccount } from '../db/accounts'
import { getNaiToken, getSetting, setSetting } from '../db/settings'
import { broadcast } from '../ipc'
import { clearProbeStamps, resetProbeCache } from '../nai/account-switch'
import { fetchAnlasBalance } from '../nai/client'
import { TURBO_KEY } from '../nai/turbo'
import type { GenerationQueue } from '../queue/generation-queue'
import { createCloudClient, type CloudClient } from './client'
import { cloudConfig, getPcSecret } from './config'
import {
  exportPresetToDriveFolder,
  getDriveRoot,
  mkdirDriveFolder,
  normalizeRelPath,
  readDriveImageForCloud,
  scanDriveIndex,
  setDriveRoot
} from './drive'
import { cloudImageDeps } from './images'
import { hashValue } from './snapshot'
import { readSceneCounts, readSnapshotSource } from './source'
import { createCloudSync, type CloudSync } from './sync'
import type { CloudImageSavedInfo, NaiBalanceInfo } from './types'

/**
 * 모바일 클라우드 연결 (커스텀) — 전역(electron·DB·fetch)을 sync.ts 에 이어 주는 얇은 파일.
 * index.ts / ipc.ts 는 여기서 내보내는 것만 쓴다. 설계: cloud/DESIGN.md 8절.
 */

export type { CloudImageSavedInfo, NaiBalanceInfo } from './types'

let sync: CloudSync | null = null
let activeClient: CloudClient | null = null
let activeQueue: GenerationQueue | null = null
let extraTimer: ReturnType<typeof setInterval> | null = null

interface CachedAccountBalance {
  tier: string | null
  anlas: number | null
  opusUsage: OpusUsage | null
  updatedAt: number
}

const accountBalanceCache = new Map<string, CachedAccountBalance>()
const ACCOUNT_CACHE_TTL_MS = 25_000
let probingAccounts: Promise<void> | null = null

let lastDriveHash: string | null = null
const syncedDriveFiles = new Set<string>()
let syncingDriveFolder = false

/**
 * 등록된 모든 NAI 계정의 잔액·한도·추가 게이지(purchasedPercent)를 조회해
 * 클라우드(library.naiInfo)로 보낸다.
 */
export async function probeAllAccountsForCloud(force = false): Promise<void> {
  if (!sync) return
  if (probingAccounts && !force) return probingAccounts
  const run = (async () => {
    try {
      adoptLegacyToken(getNaiToken())
      const accounts = listAccounts()
      const now = Date.now()
      const results: CloudAccountInfo[] = await Promise.all(
        accounts.map(async (acc) => {
          const cached = accountBalanceCache.get(acc.id)
          if (!force && cached && now - cached.updatedAt < ACCOUNT_CACHE_TTL_MS && cached.tier != null) {
            return {
              id: acc.id,
              label: acc.label,
              prefix: acc.prefix,
              active: acc.active,
              tier: cached.tier,
              anlas: cached.anlas,
              opusUsage: cached.opusUsage,
              updatedAt: cached.updatedAt
            }
          }
          const token = accountToken(acc.id)
          if (!token) {
            return {
              id: acc.id,
              label: acc.label,
              prefix: acc.prefix,
              active: acc.active,
              tier: cached?.tier ?? null,
              anlas: cached?.anlas ?? null,
              opusUsage: cached?.opusUsage ?? null,
              updatedAt: cached?.updatedAt ?? now
            }
          }
          const bal = await fetchAnlasBalance(token)
          const entry: CachedAccountBalance = {
            tier: bal.tier ?? cached?.tier ?? null,
            anlas: bal.anlas ?? cached?.anlas ?? null,
            opusUsage: bal.opusUsage ?? cached?.opusUsage ?? null,
            updatedAt: Date.now()
          }
          if (entry.tier != null || entry.anlas != null) {
            accountBalanceCache.set(acc.id, entry)
          }
          return {
            id: acc.id,
            label: acc.label,
            prefix: acc.prefix,
            active: acc.active,
            tier: entry.tier,
            anlas: entry.anlas,
            opusUsage: entry.opusUsage,
            updatedAt: entry.updatedAt
          }
        })
      )

      const activeAcc = results.find((a) => a.active) ?? results[0] ?? null
      const turboEnabled = getSetting(TURBO_KEY) === '1'
      const autoSwitchEnabled = getSetting('auto_switch_account') === '1'

      sync?.onNaiInfo({
        tier: activeAcc?.tier ?? getSetting('nai_tier') ?? null,
        anlas: activeAcc?.anlas ?? null,
        opusUsage: activeAcc?.opusUsage ?? null,
        accounts: results,
        turboEnabled,
        autoSwitchEnabled
      })
    } catch {
      // 조회 실패는 무시
    }
  })()
  probingAccounts = run
  try {
    await run
  } finally {
    if (probingAccounts === run) probingAccounts = null
  }
}

/** 특정 계정의 방금 조회한 잔액·한도를 캐시에 즉시 반영하고 전체 계정 요약을 클라우드로 민다 */
export function updateCloudAccountBalance(
  accountId: string | null,
  info: { tier: string | null; anlas: number | null; opusUsage: OpusUsage | null }
): void {
  if (accountId && (info.tier != null || info.anlas != null)) {
    accountBalanceCache.set(accountId, {
      tier: info.tier,
      anlas: info.anlas,
      opusUsage: info.opusUsage,
      updatedAt: Date.now()
    })
  }
  void probeAllAccountsForCloud(false)
}

/** 고른 PC 폴더의 색인을 클라우드로 올린다 */
export async function syncDriveIndexToCloud(force = false): Promise<void> {
  if (!sync || !activeClient || !cloudConfig.hasSecret() || !cloudConfig.enabled()) return
  const scanned = scanDriveIndex()
  if (!scanned) return
  const hash = hashValue(scanned.index.folders)
  if (!force && hash === lastDriveHash) return
  try {
    await activeClient.request('/api/pc/drive-index', {
      method: 'PUT',
      json: { index: scanned.index }
    })
    lastDriveHash = hash
    if (scanned.latestFolder !== null) {
      void syncDriveFolderImagesToCloud(scanned.latestFolder)
    }
  } catch {
    // 다음 주기에 재시도
  }
}

/** 특정 하위 폴더 안의 그림들을 클라우드 미리보기(R2)로 올린다 */
export async function syncDriveFolderImagesToCloud(relFolder: string): Promise<void> {
  if (syncingDriveFolder || !activeClient || !cloudConfig.hasSecret() || !cloudConfig.enabled()) return
  const cleanFolder = normalizeRelPath(relFolder)
  const scanned = scanDriveIndex()
  if (!scanned) return
  const entry = scanned.index.folders.find((f) => f.path === cleanFolder)
  if (!entry || entry.imgs.length === 0) return

  syncingDriveFolder = true
  try {
    const client = activeClient
    for (const imgName of entry.imgs.slice(0, 120)) {
      const relFile = cleanFolder ? `${cleanFolder}/${imgName}` : imgName
      if (syncedDriveFiles.has(relFile)) continue
      const data = await readDriveImageForCloud(relFile)
      if (!data) continue
      const q = encodeURIComponent(relFile)
      await client.request(`/api/pc/drive-image?path=${q}`, {
        method: 'PUT',
        body: data.webp,
        headers: { 'content-type': 'image/webp' },
        timeoutMs: 30_000
      })
      await client.request(`/api/pc/drive-image?path=${q}&thumb=1`, {
        method: 'PUT',
        body: data.thumb,
        headers: { 'content-type': 'image/webp' },
        timeoutMs: 20_000
      })
      syncedDriveFiles.add(relFile)
    }
  } catch {
    // 일부 업로드 실패는 다음 요청 때 재시도
  } finally {
    syncingDriveFolder = false
  }
}

async function handleControlOp(action: CloudControlAction): Promise<void> {
  switch (action.kind) {
    case 'account:setActive': {
      const switched = setActiveAccount(action.accountId)
      resetProbeCache()
      if (switched) onNaiTokenChanged()
      activeQueue?.reconcile(false)
      await probeAllAccountsForCloud(true)
      await sync?.syncOnce(false)
      break
    }
    case 'turbo:set': {
      const usable = (activeQueue?.turboStatus().accounts.length ?? 0) >= 2
      const on = action.enabled && usable
      if (on && getSetting(TURBO_KEY) !== '1') clearProbeStamps()
      setSetting(TURBO_KEY, on ? '1' : '0')
      activeQueue?.reconcile()
      await probeAllAccountsForCloud(false)
      await sync?.syncOnce(false)
      break
    }
    case 'autoSwitch:set': {
      setSetting('auto_switch_account', action.enabled ? '1' : '0')
      await probeAllAccountsForCloud(false)
      await sync?.syncOnce(false)
      break
    }
    case 'accounts:refresh': {
      await probeAllAccountsForCloud(true)
      await sync?.syncOnce(false)
      break
    }
    case 'images:uploadRecent': {
      sync?.uploadRecent(action.count || 200)
      break
    }
    case 'drive:mkdir': {
      if (mkdirDriveFolder(action.relPath)) {
        await syncDriveIndexToCloud(true)
      }
      break
    }
    case 'drive:exportPreset': {
      const res = await exportPresetToDriveFolder(
        action.presetId,
        action.relPath,
        action.favoritesOnly
      )
      if (res.copied > 0) {
        // 다시 내보낸 파일들은 덮어썼을 수 있으므로 캐시 기록에서 지우고 새로 올린다
        const prefix = normalizeRelPath(action.relPath)
        for (const f of [...syncedDriveFiles]) {
          if (f.startsWith(prefix ? `${prefix}/` : '')) syncedDriveFiles.delete(f)
        }
        await syncDriveIndexToCloud(true)
        void syncDriveFolderImagesToCloud(action.relPath)
      }
      break
    }
    case 'drive:syncFolder': {
      void syncDriveFolderImagesToCloud(action.relPath)
      break
    }
    case 'drive:refreshIndex': {
      await syncDriveIndexToCloud(true)
      break
    }
  }
}

/** registerIpcHandlers 직후 한 번 — 연결 파일을 가져오고 동기화 타이머를 시작한다 */
export function startCloud(ctx: { queue: GenerationQueue }): void {
  if (sync) return
  try {
    activeQueue = ctx.queue
    const client = createCloudClient({
      fetch: (input, init) => fetch(input, init),
      url: () => cloudConfig.url(),
      secret: getPcSecret
    })
    activeClient = client
    sync = createCloudSync({
      client,
      config: cloudConfig,
      queue: ctx.queue,
      broadcast,
      readSource: readSnapshotSource,
      readSceneCounts,
      images: cloudImageDeps,
      getNaiToken,
      onControlOp: handleControlOp,
      appVersion: app.getVersion()
    })
    sync.start()
    // 시작 직후 모든 계정 잔액·추가 게이지 조회 + 연결된 폴더 색인 업로드 + 미업로드 최근 그림 동기화
    void probeAllAccountsForCloud(true).then(() => sync?.syncOnce(false))
    void syncDriveIndexToCloud(true)
    if (cloudConfig.uploadImages()) {
      setTimeout(() => {
        try {
          sync?.uploadRecent(150)
        } catch {
          // ignore
        }
      }, 2500)
    }
    extraTimer = setInterval(() => {
      void probeAllAccountsForCloud(false)
      void syncDriveIndexToCloud(false)
      if (cloudConfig.uploadImages()) {
        try {
          sync?.uploadRecent(100)
        } catch {
          // ignore
        }
      }
    }, 35_000)
    ;(extraTimer as { unref?: () => void }).unref?.()
  } catch (e) {
    // 클라우드가 안 켜져도 앱은 떠야 한다
    console.error('[cloud] 시작 실패:', e instanceof Error ? e.message : 'unknown')
    sync = null
  }
}

export function stopCloud(): void {
  if (extraTimer) clearInterval(extraTimer)
  extraTimer = null
  sync?.stop()
  sync = null
  activeClient = null
  activeQueue = null
}

/** 생성 그림이 저장된 직후 — 클라우드로 올릴 그림을 대기열에 넣는다 */
export function onCloudImageSaved(info: CloudImageSavedInfo): void {
  // 생성 큐 안에서 불리므로 여기서 오류가 새 나가면 이미 저장된 그림이 실패로 표시된다
  try {
    sync?.onImageSaved(info)
  } catch {
    // 업로드를 못 올려도 생성은 성공이다
  }
}

/**
 * NAI 토큰이 바뀐 뒤(nai:setToken · nai:deleteToken · accounts:setActive · accounts:remove ·
 * 자동 계정 전환 · 백업 복원) — 클라우드 생성이 켜져 있으면 새 토큰을 맡기고,
 * 토큰이 없어졌으면 맡긴 토큰도 지우고 클라우드 생성을 끈다
 */
export function onNaiTokenChanged(): void {
  // 호출한 쪽(IPC·생성 큐)의 흐름에는 영향을 주지 않는다
  sync?.onNaiTokenChanged().catch(() => undefined)
  void probeAllAccountsForCloud(true)
}

/** 잔액 조회(fetchAnlasBalance)가 끝날 때마다 — 등급·Anlas·Opus 사용량을 library.naiInfo 로 올릴 준비를 한다 */
export function onCloudNaiInfo(info: NaiBalanceInfo): void {
  try {
    if (info.accounts) {
      sync?.onNaiInfo(info)
    } else {
      // 단일 활성 계정 조회 결과가 들어오면 전체 계정 목록과 함께 합쳐서 보낸다
      adoptLegacyToken(getNaiToken())
      const active = listAccounts().find((a) => a.active)
      if (active && (info.tier != null || info.anlas != null)) {
        accountBalanceCache.set(active.id, {
          tier: info.tier,
          anlas: info.anlas,
          opusUsage: info.opusUsage,
          updatedAt: Date.now()
        })
      }
      void probeAllAccountsForCloud(false)
    }
  } catch {
    // 잔액 조회 흐름에 영향을 주지 않는다
  }
}

function running(): CloudSync {
  if (!sync) throw new Error('클라우드 연결이 아직 시작되지 않았습니다')
  return sync
}

/** 폰과 나눌 PC 폴더를 바꾼다 ('' 이면 공유를 끈다) — 올려 둔 기록을 잊고 새 폴더의 색인을 올린다 */
async function changeDriveRoot(dirPath: string): Promise<{ path: string }> {
  setDriveRoot(dirPath)
  lastDriveHash = null
  syncedDriveFiles.clear()
  await syncDriveIndexToCloud(true)
  return { path: getDriveRoot() }
}

/** ipc.ts 가 cloud:* 채널에 물리는 동작 모음 */
export const cloudApi = {
  driveRoot: () => ({ path: getDriveRoot() }),
  setDriveRoot: changeDriveRoot,
  status: () => running().status(),
  setEnabled: (enabled: boolean) => running().setEnabled(enabled),
  setUploadImages: (enabled: boolean) => running().setUploadImages(enabled),
  setKeepImages: (count: number) => running().setKeepImages(count),
  setCloudGen: (enabled: boolean) => running().setCloudGen(enabled),
  pairing: () => running().pairing(),
  devices: () => running().devices(),
  revokeDevice: (id: string) => running().revokeDevice(id),
  syncNow: async () => {
    await probeAllAccountsForCloud(true)
    await syncDriveIndexToCloud(true)
    return running().syncNow()
  },
  uploadRecent: (count: number) => running().uploadRecent(count),
  rendererReady: () => running().rendererReady(),
  workDone: (result: Parameters<CloudSync['workDone']>[0]) => running().workDone(result),
  prepared: (req: Parameters<CloudSync['putPrepared']>[0]) => running().putPrepared(req)
}
