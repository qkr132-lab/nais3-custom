import { safeStorage, shell } from 'electron'
import { readFileSync, readdirSync, statSync } from 'fs'
import { basename, extname, join } from 'path'
import { AwsClient } from 'aws4fetch'
import type { R2Object, R2UploadStatus } from '../../shared/types'
import { getDb } from '../db'
import { getSetting, setSetting } from '../db/settings'
import { broadcast } from '../ipc'

/**
 * Cloudflare R2 업로드 (커스텀).
 * - S3 호환 API를 직접 호출하므로 대시보드의 "한 번에 100개" 제한이 없다.
 * - 인증 정보(계정 ID + Access Key)는 NAI 토큰과 동일하게 safeStorage(DPAPI)로
 *   암호화해 로컬 DB에만 저장한다. 외부 서버로 전송되지 않으며,
 *   Cloudflare API 호출에만 사용된다.
 */

// ── 인증 ────────────────────────────────────────────────────────────

export interface R2Auth {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
}

const AUTH_KEY = 'r2_auth_encrypted'

function saveAuth(auth: R2Auth): void {
  const json = JSON.stringify(auth)
  const encrypted = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json).toString('base64')
    : Buffer.from(json).toString('base64')
  setSetting(AUTH_KEY, encrypted)
}

function loadAuth(): R2Auth | null {
  const stored = getSetting(AUTH_KEY)
  if (!stored) return null
  try {
    const buf = Buffer.from(stored, 'base64')
    const json = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(buf)
      : buf.toString('utf-8')
    const parsed = JSON.parse(json)
    if (parsed.accountId && parsed.accessKeyId && parsed.secretAccessKey) return parsed
    return null
  } catch {
    return null
  }
}

export function deleteR2Auth(): void {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(AUTH_KEY)
}

export function r2AuthStatus(): { connected: boolean; accountId: string } {
  const auth = loadAuth()
  return { connected: !!auth, accountId: auth ? auth.accountId : '' }
}

/** R2 API 토큰 발급 페이지 열기 (계정 선택 후 R2 → API 토큰) */
export function openR2TokenPage(): void {
  void shell.openExternal('https://dash.cloudflare.com/?to=/:account/r2/api-tokens')
}

function endpoint(auth: R2Auth): string {
  return `https://${auth.accountId}.r2.cloudflarestorage.com`
}

function client(auth: R2Auth): AwsClient {
  return new AwsClient({
    accessKeyId: auth.accessKeyId,
    secretAccessKey: auth.secretAccessKey,
    service: 's3',
    region: 'auto'
  })
}

// ── XML 응답 파싱 (S3 표준 응답에서 필요한 필드만) ─────────────────

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function xmlValues(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g')
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) out.push(xmlUnescape(m[1]))
  return out
}

function xmlBlocks(xml: string, tag: string): string[] {
  return xmlValues(xml, tag)
}

// ── 버킷/객체 조회 ──────────────────────────────────────────────────

async function requireAuth(): Promise<R2Auth> {
  const auth = loadAuth()
  if (!auth) throw new Error('R2 인증 정보가 없습니다. 먼저 연결하세요.')
  return auth
}

export async function listBuckets(authOverride?: R2Auth): Promise<string[]> {
  const auth = authOverride ?? (await requireAuth())
  const res = await client(auth).fetch(endpoint(auth), { method: 'GET' })
  if (!res.ok) throw new Error(`버킷 목록 실패 (${res.status}): ${await errText(res)}`)
  const xml = await res.text()
  return xmlBlocks(xml, 'Bucket').map((b) => xmlValues(b, 'Name')[0] ?? '')
}

/** 인증 검증 — 성공 시에만 저장 (NAI 토큰 패턴) */
export async function setR2Auth(auth: R2Auth): Promise<{ ok: boolean; error?: string }> {
  const trimmed: R2Auth = {
    accountId: auth.accountId.trim(),
    accessKeyId: auth.accessKeyId.trim(),
    secretAccessKey: auth.secretAccessKey.trim()
  }
  try {
    await listBuckets(trimmed)
    saveAuth(trimmed)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function errText(res: Response): Promise<string> {
  try {
    const xml = await res.text()
    return xmlValues(xml, 'Message')[0] ?? xml.slice(0, 200)
  } catch {
    return ''
  }
}

export async function listObjects(
  bucket: string,
  prefix: string
): Promise<{ folders: string[]; objects: R2Object[] }> {
  const auth = await requireAuth()
  const c = client(auth)
  const folders: string[] = []
  const objects: R2Object[] = []
  let token: string | undefined
  // 1000개 단위 페이지네이션 — 전부 가져온다
  do {
    const params = new URLSearchParams({ 'list-type': '2', delimiter: '/', prefix })
    if (token) params.set('continuation-token', token)
    const res = await c.fetch(`${endpoint(auth)}/${bucket}?${params}`, { method: 'GET' })
    if (!res.ok) throw new Error(`목록 실패 (${res.status}): ${await errText(res)}`)
    const xml = await res.text()
    for (const p of xmlBlocks(xml, 'CommonPrefixes')) {
      const v = xmlValues(p, 'Prefix')[0]
      if (v) folders.push(v)
    }
    for (const item of xmlBlocks(xml, 'Contents')) {
      const key = xmlValues(item, 'Key')[0] ?? ''
      if (!key || key === prefix) continue // 폴더 표식(0바이트 키 자신)은 제외
      objects.push({
        key,
        size: Number(xmlValues(item, 'Size')[0] ?? 0),
        lastModified: xmlValues(item, 'LastModified')[0] ?? ''
      })
    }
    token = xmlValues(xml, 'NextContinuationToken')[0]
  } while (token)
  return { folders, objects }
}

/** S3 관례상 폴더 = "prefix/" 0바이트 객체 */
export async function createR2Folder(bucket: string, prefix: string, name: string): Promise<void> {
  const auth = await requireAuth()
  const safe = name.replace(/[/\\]/g, '_').trim()
  if (!safe) return
  const res = await client(auth).fetch(
    `${endpoint(auth)}/${bucket}/${encodeKey(`${prefix}${safe}/`)}`,
    { method: 'PUT', body: new Uint8Array(0) }
  )
  if (!res.ok) throw new Error(`폴더 생성 실패 (${res.status}): ${await errText(res)}`)
}

function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/')
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.zip': 'application/zip'
}

// ── 업로드 큐 (개수 제한 없음 · 동시 3개 · 실패 목록 · 재시도) ─────

interface UploadItem {
  id: number
  path: string
  /** 버킷 내 대상 키 */
  key: string
  size: number
  state: 'pending' | 'uploading' | 'done' | 'failed'
  error?: string
}

const queue: {
  bucket: string
  items: UploadItem[]
  running: boolean
  cancelled: boolean
  nextId: number
} = { bucket: '', items: [], running: false, cancelled: false, nextId: 1 }

const CONCURRENCY = 3

function statusSnapshot(): R2UploadStatus {
  const total = queue.items.length
  const done = queue.items.filter((i) => i.state === 'done').length
  const failed = queue.items
    .filter((i) => i.state === 'failed')
    .map((i) => ({ name: basename(i.path), key: i.key, error: i.error ?? '' }))
  const current = queue.items.find((i) => i.state === 'uploading')
  return {
    running: queue.running,
    bucket: queue.bucket,
    total,
    done,
    failedCount: failed.length,
    failed: failed.slice(0, 200), // 표시용 상한 (전송 페이로드 폭주 방지)
    currentName: current ? basename(current.path) : ''
  }
}

function notify(): void {
  broadcast('r2:progress', statusSnapshot())
}

/** 디렉터리는 재귀로 펼쳐서 (상대 경로 유지) 업로드 항목을 만든다 */
function expandPaths(
  paths: string[],
  prefix: string
): { path: string; key: string; size: number }[] {
  const out: { path: string; key: string; size: number }[] = []
  const walk = (p: string, keyBase: string): void => {
    const st = statSync(p)
    if (st.isDirectory()) {
      const dirKey = `${keyBase}${basename(p)}/`
      for (const entry of readdirSync(p)) walk(join(p, entry), dirKey)
    } else {
      out.push({ path: p, key: `${keyBase}${basename(p)}`, size: st.size })
    }
  }
  for (const p of paths) {
    try {
      walk(p, prefix)
    } catch {
      // 접근 불가 항목은 건너뜀
    }
  }
  return out
}

export function enqueueUpload(bucket: string, prefix: string, paths: string[]): number {
  // 다른 버킷으로 새 업로드 시작 시 이전 완료 기록은 정리
  if (queue.bucket !== bucket && !queue.running) queue.items = []
  queue.bucket = bucket
  const expanded = expandPaths(paths, prefix)
  for (const e of expanded) {
    queue.items.push({ id: queue.nextId++, state: 'pending', ...e })
  }
  if (expanded.length > 0) void runQueue()
  return expanded.length
}

export function retryFailed(): number {
  let n = 0
  for (const item of queue.items) {
    if (item.state === 'failed') {
      item.state = 'pending'
      item.error = undefined
      n++
    }
  }
  if (n > 0) void runQueue()
  return n
}

export function cancelUpload(): void {
  queue.cancelled = true
}

export function clearUploadHistory(): void {
  if (queue.running) return
  queue.items = []
  notify()
}

export function uploadStatus(): R2UploadStatus {
  return statusSnapshot()
}

async function uploadOne(auth: R2Auth, c: AwsClient, item: UploadItem): Promise<void> {
  const body = readFileSync(item.path)
  const type = MIME[extname(item.path).toLowerCase()] ?? 'application/octet-stream'
  const res = await c.fetch(`${endpoint(auth)}/${queue.bucket}/${encodeKey(item.key)}`, {
    method: 'PUT',
    headers: { 'content-type': type },
    body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await errText(res)}`)
}

async function runQueue(): Promise<void> {
  if (queue.running) return
  queue.running = true
  queue.cancelled = false
  try {
    const auth = await requireAuth()
    const c = client(auth)
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        if (queue.cancelled) return
        const item = queue.items.find((i) => i.state === 'pending')
        if (!item) return
        item.state = 'uploading'
        notify()
        try {
          await uploadOne(auth, c, item)
          item.state = 'done'
        } catch (e) {
          item.state = 'failed'
          item.error = e instanceof Error ? e.message : String(e)
        }
        notify()
      }
    })
    await Promise.all(workers)
  } catch (e) {
    // 인증 소실 등 — 남은 pending을 실패 처리해 사용자에게 보이게
    const msg = e instanceof Error ? e.message : String(e)
    for (const item of queue.items) {
      if (item.state === 'pending') {
        item.state = 'failed'
        item.error = msg
      }
    }
  } finally {
    // 취소 시 남은 pending도 실패로 표시
    if (queue.cancelled) {
      for (const item of queue.items) {
        if (item.state === 'pending') {
          item.state = 'failed'
          item.error = '취소됨'
        }
      }
    }
    queue.running = false
    notify()
  }
}
