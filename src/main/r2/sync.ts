import { BrowserWindow } from 'electron'
import { existsSync } from 'fs'
import type { R2SyncConfig, R2SyncStatus } from '../../shared/types'
import { getDb } from '../db'
import { getSetting, setSetting } from '../db/settings'
import { assignExportName } from '../scenes/export-name'
import { r2AuthStatus, r2DeleteObject, r2ObjectExists, r2PutFile } from './client'

/** Per-preset reconciliation between favorite scene images and an R2 folder. */

const DEFAULT_CONFIG: R2SyncConfig = {
  enabled: false,
  bucket: '',
  prefix: '',
  deleteOnUnfavorite: true,
  conflictPolicy: 'ask'
}

const configKey = (presetId: number): string => `r2_sync_cfg_${presetId}`
const stateKey = (presetId: number): string => `r2_sync_state_${presetId}`

function normalizePrefix(prefix: string): string {
  const clean = prefix.trim().replace(/^\/+/, '').replace(/\/+/g, '/')
  return clean && !clean.endsWith('/') ? `${clean}/` : clean
}

function normalizeConfig(config: R2SyncConfig): R2SyncConfig {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    bucket: config.bucket.trim(),
    prefix: normalizePrefix(config.prefix)
  }
}

export function getSyncConfig(presetId: number): R2SyncConfig {
  try {
    const raw = getSetting(configKey(presetId))
    if (raw) return normalizeConfig({ ...DEFAULT_CONFIG, ...(JSON.parse(raw) as R2SyncConfig) })
  } catch {
    // Ignore a damaged local setting and fall back to disabled sync.
  }
  return { ...DEFAULT_CONFIG }
}

interface SyncStateStore {
  version: 2
  /** Separate tracking maps are essential: equal keys in different buckets are different objects. */
  targets: Record<string, Record<string, string>>
}

function targetId(config: Pick<R2SyncConfig, 'bucket' | 'prefix'>): string {
  return JSON.stringify([config.bucket.trim(), normalizePrefix(config.prefix)])
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    value != null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  )
}

function loadStateStore(presetId: number, legacyConfig: R2SyncConfig): SyncStateStore {
  try {
    const raw = getSetting(stateKey(presetId))
    if (!raw) return { version: 2, targets: {} }
    const parsed = JSON.parse(raw) as unknown
    if (
      parsed != null &&
      typeof parsed === 'object' &&
      (parsed as { version?: unknown }).version === 2 &&
      (parsed as { targets?: unknown }).targets != null &&
      typeof (parsed as { targets: unknown }).targets === 'object'
    ) {
      const targets: Record<string, Record<string, string>> = {}
      for (const [id, value] of Object.entries(
        (parsed as { targets: Record<string, unknown> }).targets
      )) {
        if (isStringRecord(value)) targets[id] = { ...value }
      }
      return { version: 2, targets }
    }
    // exp.1/exp.2 stored only imageId -> key. Associate it with the then-current target.
    if (isStringRecord(parsed) && legacyConfig.bucket) {
      return { version: 2, targets: { [targetId(legacyConfig)]: { ...parsed } } }
    }
  } catch {
    // Ignore a damaged tracking value. Reconciliation can rebuild it safely.
  }
  return { version: 2, targets: {} }
}

function saveStateStore(presetId: number, store: SyncStateStore): void {
  setSetting(stateKey(presetId), JSON.stringify(store))
}

export function setSyncConfig(presetId: number, config: R2SyncConfig): void {
  const previous = getSyncConfig(presetId)
  // Migrate legacy tracking before changing target identity.
  const store = loadStateStore(presetId, previous)
  saveStateStore(presetId, store)
  setSetting(configKey(presetId), JSON.stringify(normalizeConfig(config)))
}

interface DesiredItem {
  imageId: number
  filePath: string
  key: string
}

function desiredState(presetId: number, prefix: string): DesiredItem[] {
  const rows = getDb()
    .prepare(
      `SELECT i.id, i.file_path, s.name AS scene_name, s.export_no
       FROM images i
       JOIN gen_scenes s ON s.id = i.scene_id
       WHERE s.preset_id = ? AND s.deleted_at IS NULL
         AND i.deleted_at IS NULL AND i.favorite = 1
       ORDER BY s.sort_order, s.id, i.id`
    )
    .all(presetId) as {
    id: number
    file_path: string
    scene_name: string
    export_no: number | null
  }[]
  const used = new Set<string>()
  return rows.map((row) => ({
    imageId: row.id,
    filePath: row.file_path,
    key:
      normalizePrefix(prefix) +
      assignExportName(row.scene_name, row.file_path, used, '.', row.export_no)
  }))
}

interface PendingConflict {
  imageId: number
  key: string
  target: string
}

interface SyncRun {
  running: boolean
  dirty: boolean
  conflicts: PendingConflict[]
  last: R2SyncStatus['last']
}

const runs = new Map<number, SyncRun>()
const timers = new Map<number, NodeJS.Timeout>()

function runOf(presetId: number): SyncRun {
  let run = runs.get(presetId)
  if (!run) {
    run = { running: false, dirty: false, conflicts: [], last: null }
    runs.set(presetId, run)
  }
  return run
}

function statusOf(presetId: number): R2SyncStatus {
  const run = runOf(presetId)
  return {
    presetId,
    running: run.running,
    conflicts: run.conflicts.map((conflict) => conflict.key),
    last: run.last
  }
}

function notify(presetId: number): void {
  const status = statusOf(presetId)
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('r2sync:status', status)
  }
}

export function scheduleSync(presetId: number): void {
  if (!getSyncConfig(presetId).enabled) return
  const previous = timers.get(presetId)
  if (previous) clearTimeout(previous)
  timers.set(
    presetId,
    setTimeout(() => {
      timers.delete(presetId)
      void runSync(presetId)
    }, 1500)
  )
}

function placeholders(length: number): string {
  return Array(length).fill('?').join(',')
}

export function presetIdsForScenes(sceneIds: number[]): number[] {
  if (sceneIds.length === 0) return []
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT preset_id AS presetId FROM gen_scenes WHERE id IN (${placeholders(sceneIds.length)})`
    )
    .all(...sceneIds) as { presetId: number }[]
  return rows.map((row) => row.presetId)
}

export function presetIdsForImages(imageIds: number[]): number[] {
  if (imageIds.length === 0) return []
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT s.preset_id AS presetId
       FROM images i JOIN gen_scenes s ON s.id = i.scene_id
       WHERE i.id IN (${placeholders(imageIds.length)})`
    )
    .all(...imageIds) as { presetId: number }[]
  return rows.map((row) => row.presetId)
}

export function presetIdsForAllImages(): number[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT s.preset_id AS presetId
       FROM images i JOIN gen_scenes s ON s.id = i.scene_id`
    )
    .all() as { presetId: number }[]
  return rows.map((row) => row.presetId)
}

export function scheduleSyncForPresets(presetIds: number[]): void {
  for (const presetId of new Set(presetIds)) scheduleSync(presetId)
}

export function scheduleSyncForScenes(sceneIds: number[]): void {
  scheduleSyncForPresets(presetIdsForScenes(sceneIds))
}

export function scheduleSyncForImages(imageIds: number[]): void {
  scheduleSyncForPresets(presetIdsForImages(imageIds))
}

export function scheduleSyncForImage(imageId: number): void {
  scheduleSyncForImages([imageId])
}

export async function runSync(presetId: number): Promise<R2SyncStatus> {
  const config = getSyncConfig(presetId)
  const run = runOf(presetId)
  if (!config.enabled || !config.bucket || !r2AuthStatus().connected) return statusOf(presetId)
  if (run.running) {
    run.dirty = true
    return statusOf(presetId)
  }

  const currentTarget = targetId(config)
  run.running = true
  run.conflicts = []
  notify(presetId)
  const result = { uploaded: 0, renamed: 0, deleted: 0, skipped: 0, errors: [] as string[] }

  try {
    const desired = desiredState(presetId, config.prefix)
    const desiredById = new Map(desired.map((item) => [String(item.imageId), item]))
    const desiredKeys = new Set(desired.map((item) => item.key))
    const store = loadStateStore(presetId, config)
    const state = (store.targets[currentTarget] ??= {})

    for (const item of desired) {
      const imageId = String(item.imageId)
      const tracked = state[imageId]
      if (tracked === item.key) continue
      if (!existsSync(item.filePath)) {
        result.errors.push(`파일 없음: ${item.key}`)
        continue
      }
      try {
        const ours = Object.values(state).includes(item.key)
        if (!ours && (await r2ObjectExists(config.bucket, item.key))) {
          if (config.conflictPolicy === 'skip') {
            result.skipped++
            continue
          }
          if (config.conflictPolicy === 'ask') {
            run.conflicts.push({ imageId: item.imageId, key: item.key, target: currentTarget })
            continue
          }
        }
        await r2PutFile(config.bucket, item.key, item.filePath)
        if (tracked && tracked !== item.key) {
          if (!desiredKeys.has(tracked)) await r2DeleteObject(config.bucket, tracked)
          result.renamed++
        } else {
          result.uploaded++
        }
        state[imageId] = item.key
      } catch (error) {
        result.errors.push(`${item.key}: ${error instanceof Error ? error.message : error}`)
      }
    }

    for (const [imageId, key] of Object.entries(state)) {
      if (desiredById.has(imageId)) continue
      if (config.deleteOnUnfavorite && !desiredKeys.has(key)) {
        try {
          await r2DeleteObject(config.bucket, key)
          result.deleted++
        } catch (error) {
          result.errors.push(`${key} 삭제: ${error instanceof Error ? error.message : error}`)
          continue
        }
      }
      delete state[imageId]
    }

    saveStateStore(presetId, store)
    run.last = { ...result, at: new Date().toISOString() }
  } catch (error) {
    run.last = {
      uploaded: 0,
      renamed: 0,
      deleted: 0,
      skipped: 0,
      errors: [error instanceof Error ? error.message : String(error)],
      at: new Date().toISOString()
    }
  } finally {
    run.running = false
    notify(presetId)
    if (run.dirty) {
      run.dirty = false
      scheduleSync(presetId)
    }
  }
  return statusOf(presetId)
}

export async function resolveConflicts(
  presetId: number,
  choice: 'overwrite' | 'skip',
  remember: boolean
): Promise<R2SyncStatus> {
  const config = getSyncConfig(presetId)
  if (remember) setSyncConfig(presetId, { ...config, conflictPolicy: choice })
  const run = runOf(presetId)
  const currentTarget = targetId(config)
  const pending = run.conflicts.filter((conflict) => conflict.target === currentTarget)
  run.conflicts = []
  if (choice === 'skip' || pending.length === 0) {
    notify(presetId)
    return statusOf(presetId)
  }

  const store = loadStateStore(presetId, config)
  const state = (store.targets[currentTarget] ??= {})
  const desired = desiredState(presetId, config.prefix)
  const desiredKeys = new Set(desired.map((item) => item.key))
  let uploaded = 0
  let renamed = 0
  const errors: string[] = []
  for (const conflict of pending) {
    const item = desired.find(
      (candidate) => candidate.imageId === conflict.imageId && candidate.key === conflict.key
    )
    if (!item || !existsSync(item.filePath)) continue
    try {
      const oldKey = state[String(item.imageId)]
      await r2PutFile(config.bucket, item.key, item.filePath)
      if (oldKey && oldKey !== item.key) {
        if (!desiredKeys.has(oldKey)) await r2DeleteObject(config.bucket, oldKey)
        renamed++
      } else {
        uploaded++
      }
      state[String(item.imageId)] = item.key
    } catch (error) {
      errors.push(`${item.key}: ${error instanceof Error ? error.message : error}`)
    }
  }
  saveStateStore(presetId, store)
  const previous = run.last ?? {
    uploaded: 0,
    renamed: 0,
    deleted: 0,
    skipped: 0,
    errors: [],
    at: new Date().toISOString()
  }
  run.last = {
    ...previous,
    uploaded: previous.uploaded + uploaded,
    renamed: previous.renamed + renamed,
    errors: [...previous.errors, ...errors],
    at: new Date().toISOString()
  }
  notify(presetId)
  return statusOf(presetId)
}

export function syncStatus(presetId: number): R2SyncStatus {
  return statusOf(presetId)
}
