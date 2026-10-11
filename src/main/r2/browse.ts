import { BrowserWindow, dialog } from 'electron'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { basename, dirname, extname, join } from 'path'
import type { R2TransferStatus } from '../../shared/types'
import { r2CacheRoot } from '../images/storage'
import { broadcast } from '../ipc'
import { listAllKeys, r2DeleteObject, r2GetObject } from './client'

/**
 * R2 둘러보기 (커스텀) — 올린 그림을 앱 안에서 보고, 내려받고, 지운다.
 * 미리보기는 userData/r2-cache 에 한 번 받아 두고 다시 쓴다 (nais-image 프로토콜이 이 폴더를 허용).
 */

/** 캐시 파일 이름 — 버킷·키·수정 시각의 해시. 같은 키라도 다시 올리면 다른 파일이 된다 */
export function cacheName(bucket: string, key: string, lastModified: string): string {
  const h = createHash('sha1')
    .update(`${bucket}\n${key}\n${lastModified}`)
    .digest('hex')
    .slice(0, 24)
  return `${h}${extname(key).toLowerCase() || '.bin'}`
}

/** 미리보기용 로컬 사본 경로 — 없으면 받아서 만든다 */
export async function previewPath(
  bucket: string,
  key: string,
  lastModified: string
): Promise<string> {
  const dir = r2CacheRoot()
  mkdirSync(dir, { recursive: true })
  const path = join(dir, cacheName(bucket, key, lastModified))
  if (!existsSync(path)) writeFileSync(path, await r2GetObject(bucket, key))
  return path
}

/**
 * 내려받을 때의 상대 경로 — 지금 보고 있는 폴더(base)를 기준으로 하위 구조를 그대로 둔다.
 * Windows에서 못 쓰는 글자는 `_`로.
 */
export function localRelative(key: string, base: string): string {
  const rel = base && key.startsWith(base) ? key.slice(base.length) : key
  return rel
    .split('/')
    .filter(Boolean)
    .map((seg) => seg.replace(/[\\:*?"<>|]/g, '_'))
    .join('/')
}

const transfer: R2TransferStatus = { running: false, kind: 'download', done: 0, total: 0 }

function notify(): void {
  broadcast('r2:transfer', { ...transfer })
}

export function transferStatus(): R2TransferStatus {
  return { ...transfer }
}

async function runWorkers<T>(
  items: T[],
  concurrency: number,
  work: (item: T) => Promise<void>
): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const item = items[next++]
        if (item === undefined) return
        await work(item)
        transfer.done++
        notify()
      }
    })
  )
}

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 폴더들 아래 모든 파일 키 (폴더 표식 0바이트 키는 뺌) */
async function filesUnder(bucket: string, folders: string[]): Promise<string[]> {
  const out: string[] = []
  for (const f of folders) {
    for (const o of await listAllKeys(bucket, f)) if (!o.key.endsWith('/')) out.push(o.key)
  }
  return out
}

/**
 * 고른 파일·폴더를 내려받는다. 파일 하나면 저장 대화상자, 아니면 폴더를 골라 그 안에
 * (base 기준 상대 경로로). 동시 3개.
 */
export async function downloadSelection(
  bucket: string,
  keys: string[],
  folders: string[],
  base: string
): Promise<{
  saved: number
  failed: { key: string; error: string }[]
  canceled: boolean
  dir: string
}> {
  if (transfer.running) throw new Error('다른 작업이 진행 중입니다')
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const canceled = { saved: 0, failed: [], canceled: true, dir: '' }
  let targets: { key: string; path: string }[]
  let dir = ''
  if (keys.length === 1 && folders.length === 0) {
    const r = await dialog.showSaveDialog(win, {
      title: 'R2 파일 저장',
      defaultPath: basename(keys[0])
    })
    if (r.canceled || !r.filePath) return canceled
    dir = dirname(r.filePath)
    targets = [{ key: keys[0], path: r.filePath }]
  } else {
    const r = await dialog.showOpenDialog(win, {
      title: '내려받을 폴더 선택',
      properties: ['openDirectory', 'createDirectory']
    })
    if (r.canceled || r.filePaths.length === 0) return canceled
    dir = r.filePaths[0]
    const all = [...new Set([...keys, ...(await filesUnder(bucket, folders))])]
    targets = all.map((key) => ({ key, path: join(dir, localRelative(key, base)) }))
  }
  transfer.running = true
  transfer.kind = 'download'
  transfer.done = 0
  transfer.total = targets.length
  notify()
  const failed: { key: string; error: string }[] = []
  let saved = 0
  try {
    await runWorkers(targets, 3, async (t) => {
      try {
        mkdirSync(dirname(t.path), { recursive: true })
        writeFileSync(t.path, await r2GetObject(bucket, t.key))
        saved++
      } catch (e) {
        failed.push({ key: t.key, error: msgOf(e) })
      }
    })
  } finally {
    transfer.running = false
    notify()
  }
  return { saved, failed, canceled: false, dir }
}

/** 고른 파일·폴더(안의 전부 + 폴더 표식)를 지운다. 동시 5개. 없는 키는 이미 지워진 것으로 친다 */
export async function deleteSelection(
  bucket: string,
  keys: string[],
  folders: string[]
): Promise<{ deleted: number; failed: { key: string; error: string }[] }> {
  if (transfer.running) throw new Error('다른 작업이 진행 중입니다')
  const all = new Set(keys)
  for (const f of folders) {
    for (const o of await listAllKeys(bucket, f)) all.add(o.key)
    all.add(f)
  }
  const targets = [...all]
  transfer.running = true
  transfer.kind = 'delete'
  transfer.done = 0
  transfer.total = targets.length
  notify()
  const failed: { key: string; error: string }[] = []
  let deleted = 0
  try {
    await runWorkers(targets, 5, async (key) => {
      try {
        await r2DeleteObject(bucket, key)
        deleted++
      } catch (e) {
        failed.push({ key, error: msgOf(e) })
      }
    })
  } finally {
    transfer.running = false
    notify()
  }
  return { deleted, failed }
}
