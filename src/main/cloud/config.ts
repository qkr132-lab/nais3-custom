import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { getSetting, setSetting } from '../db/settings'
import type { CloudConfigPort, CloudUploadState, ConnectImportResult } from './types'

/**
 * 클라우드 연결 설정 (커스텀). 값은 전부 DB settings 에 둔다.
 * PC 비밀값은 NAI 토큰·R2 인증과 같은 방식으로 safeStorage 로 암호화한다(불가하면 base64).
 */

/** 연결 파일을 두는 홈 폴더 아래 폴더 이름 — 배포 스크립트(cloud/scripts/deploy.mjs)와 같아야 한다 */
export const CONNECT_DIR_NAME = 'NAIS3 Custom 폰 연결'
export const KEEP_IMAGES_DEFAULT = 2000
export const KEEP_IMAGES_MIN = 100
export const KEEP_IMAGES_MAX = 20000
/** 올린 그림 id 를 기억하는 상한 — 넘으면 오래된 것부터 잊는다 */
const UPLOADED_CAP = KEEP_IMAGES_MAX

const KEY = {
  url: 'cloud_url',
  // 설정 이름일 뿐 비밀값이 아니다 — 속성 이름이 secret 으로 끝나면 비밀값 점검(audit-release)이 오탐한다
  secretSetting: 'cloud_pc_secret_encrypted',
  enabled: 'cloud_enabled',
  uploadImages: 'cloud_upload_images',
  keepImages: 'cloud_keep_images',
  gen: 'cloud_gen_enabled',
  uploadState: 'cloud_upload_state'
} as const

/** 배포 스크립트가 만드는 연결 파일 — 홈 폴더 아래 「NAIS3 Custom 폰 연결」 */
export function connectFilePath(): string {
  return join(app.getPath('home'), CONNECT_DIR_NAME, 'cloud-connect.json')
}

/**
 * 연결 파일 검사. 주소는 https 만(로컬 개발용 http://localhost 계열 예외) — 비밀값이 평문으로 나가면 안 된다.
 * 모양이 틀리면 null.
 */
export function parseConnectFile(text: string): { url: string; secret: string } | null {
  let data: unknown
  try {
    // 메모장이 붙이는 BOM(U+FEFF)은 떼고 읽는다
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    return null
  }
  const rec = data as { url?: unknown; secret?: unknown } | null
  if (!rec || typeof rec.url !== 'string' || typeof rec.secret !== 'string') return null
  const url = rec.url.trim().replace(/\/+$/, '')
  const secret = rec.secret.trim()
  const httpsOk = /^https:\/\/[^/\s]+$/i.test(url)
  const localOk = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(url)
  if (!httpsOk && !localOk) return null
  if (!secret || secret.length > 200 || /\s/.test(secret)) return null
  return { url, secret }
}

export function getPcSecret(): string | null {
  const stored = getSetting(KEY.secretSetting)
  if (!stored) return null
  try {
    const buf = Buffer.from(stored, 'base64')
    const secret = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(buf)
      : buf.toString('utf-8')
    return secret || null
  } catch {
    return null
  }
}

function setPcSecret(secret: string): void {
  setSetting(
    KEY.secretSetting,
    safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(secret).toString('base64')
      : Buffer.from(secret).toString('base64')
  )
}

/** 연결 파일이 있으면 읽어 저장하고 파일을 지운다 — 파일이 틀리면 그대로 두고 'invalid' */
export function importConnectFile(): ConnectImportResult {
  const path = connectFilePath()
  if (!existsSync(path)) return 'none'
  try {
    const parsed = parseConnectFile(readFileSync(path, 'utf8'))
    if (!parsed) return 'invalid'
    setSetting(KEY.url, parsed.url)
    setPcSecret(parsed.secret)
  } catch {
    return 'invalid'
  }
  try {
    unlinkSync(path) // 비밀값이 평문 파일로 남지 않게
  } catch {
    // 지우지 못해도 저장은 끝났다
  }
  return 'imported'
}

function flag(key: string, fallback: boolean): boolean {
  const v = getSetting(key)
  return v == null ? fallback : v !== '0'
}

export function clampKeepImages(count: number): number {
  if (!Number.isFinite(count)) return KEEP_IMAGES_DEFAULT
  return Math.min(KEEP_IMAGES_MAX, Math.max(KEEP_IMAGES_MIN, Math.round(count)))
}

/** 「가져왔다」 알림 대기표 — 클라우드 그림 id(글자열) → PC 그림 id(정수) 만 남긴다. 모양이 틀리면 빈 표 */
export function parsePendingImported(value: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [cloudId, pcId] of Object.entries(value as Record<string, unknown>)) {
    if (typeof pcId === 'number' && Number.isInteger(pcId)) out[cloudId] = pcId
  }
  return out
}

export const cloudConfig: CloudConfigPort = {
  // 주소는 연결 파일로만 들어온다 — 없으면 '' 이고 「설정 안 됨」으로 본다
  url: () => getSetting(KEY.url)?.trim() ?? '',
  hasSecret: () => getPcSecret() != null,
  enabled: () => flag(KEY.enabled, true),
  setEnabled: (enabled) => setSetting(KEY.enabled, enabled ? '1' : '0'),
  uploadImages: () => flag(KEY.uploadImages, true),
  setUploadImages: (enabled) => setSetting(KEY.uploadImages, enabled ? '1' : '0'),
  keepImages: () => {
    const raw = getSetting(KEY.keepImages)
    return raw == null ? KEEP_IMAGES_DEFAULT : clampKeepImages(Number(raw))
  },
  setKeepImages: (count) => setSetting(KEY.keepImages, String(clampKeepImages(count))),
  cloudGenEnabled: () => getSetting(KEY.gen) === '1',
  setCloudGenEnabled: (enabled) => setSetting(KEY.gen, enabled ? '1' : '0'),
  loadUploadState: (): CloudUploadState => {
    const raw = getSetting(KEY.uploadState)
    if (!raw) return { uploaded: [] }
    try {
      const parsed = JSON.parse(raw) as { uploaded?: unknown; pendingImported?: unknown }
      const list = Array.isArray(parsed?.uploaded) ? parsed.uploaded : []
      const state: CloudUploadState = {
        uploaded: list.filter((n): n is number => Number.isInteger(n))
      }
      const pending = parsePendingImported(parsed?.pendingImported)
      if (Object.keys(pending).length > 0) state.pendingImported = pending
      return state
    } catch {
      return { uploaded: [] }
    }
  },
  saveUploadState: (state) => {
    const pending = parsePendingImported(state.pendingImported)
    setSetting(
      KEY.uploadState,
      JSON.stringify({
        uploaded: state.uploaded.slice(-UPLOADED_CAP),
        ...(Object.keys(pending).length > 0 ? { pendingImported: pending } : {})
      })
    )
  },
  importConnectFile
}
