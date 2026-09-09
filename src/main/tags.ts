import { app } from 'electron'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { getSetting, setSetting } from './db/settings'
import type { TagSuggestion, TagUsage } from '../shared/tag-search'

export type TagEntry = TagSuggestion
let worker: Worker | null = null
let sequence = 0
let revision = 0
let sentRevision = -1
let usage: TagUsage | null = null
let userKo: Record<string, string> | null = null
interface Job {
  id: number
  method: 'search' | 'recommend' | 'lookup' | 'history'
  args: unknown[]
  resolve: (items: TagEntry[]) => void
  reject: (error: Error) => void
}
let active: Job | null = null
const queue: Job[] = []
let timeout: ReturnType<typeof setTimeout> | undefined
const keyFor = (name: string): string =>
  name.normalize('NFC').trim().toLowerCase().replace(/_/g, ' ')

function loadUserKo(): Record<string, string> {
  if (userKo) return userKo
  try {
    const parsed = JSON.parse(getSetting('tag_ko_user') ?? '{}')
    userKo =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (Object.fromEntries(
            Object.entries(parsed).filter(([, v]) => typeof v === 'string')
          ) as Record<string, string>)
        : {}
  } catch {
    userKo = {}
  }
  return userKo
}
function loadUsage(): TagUsage {
  if (usage) return usage
  usage = {}
  try {
    const parsed = JSON.parse(getSetting('tag_usage_v1') ?? '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [tag, raw] of Object.entries(parsed)) {
        const u = raw as { count?: unknown; lastUsed?: unknown }
        if (
          u &&
          typeof u.count === 'number' &&
          Number.isFinite(u.count) &&
          u.count > 0 &&
          typeof u.lastUsed === 'number' &&
          Number.isFinite(u.lastUsed)
        ) {
          usage[tag] = { count: Math.min(1000000, Math.floor(u.count)), lastUsed: u.lastUsed }
        }
      }
    }
  } catch {
    /* Malformed history must not break dictionary search. */
  }
  return usage
}
function fail(error: Error): void {
  clearTimeout(timeout)
  const old = worker
  worker = null
  sentRevision = -1
  active?.reject(error)
  active = null
  for (const job of queue.splice(0)) job.reject(error)
  if (old) {
    old.removeAllListeners()
    void old.terminate()
  }
}
function startWorker(): Worker {
  if (worker) return worker
  // SQLite needs a real filesystem path; resources/** is unpacked by the builder.
  const root = app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked')
  const next = new Worker(join(__dirname, 'tag-search-worker.js'), {
    workerData: { path: join(root, 'resources', 'tag-search.sqlite') }
  })
  worker = next
  next.unref()
  next.on('error', fail)
  next.on('exit', (code) => {
    if (worker === next) fail(new Error(`Tag worker exited (${code})`))
  })
  next.on('message', (message: { id: number; result?: TagEntry[]; error?: string }) => {
    if (message.id !== active?.id) return
    clearTimeout(timeout)
    const job = active
    active = null
    if (message.error) job.reject(new Error(message.error))
    else job.resolve(message.result ?? [])
    pump()
  })
  return next
}
function pump(): void {
  if (active || !queue.length) return
  active = queue.shift()!
  try {
    const w = startWorker()
    const personal =
      sentRevision !== revision ? { ko: loadUserKo(), usage: loadUsage() } : undefined
    w.postMessage({ id: active.id, method: active.method, args: active.args, personal })
    sentRevision = revision
    timeout = setTimeout(() => fail(new Error('Tag search timed out')), 15000)
    timeout.unref()
  } catch (error) {
    fail(error instanceof Error ? error : new Error(String(error)))
  }
}
function request(method: Job['method'], args: unknown[]): Promise<TagEntry[]> {
  return new Promise((resolve, reject) => {
    // Keep a single query in flight and only the newest pending search. Lookup
    // and history jobs keep their ordering; every discarded search settles.
    if (method === 'search' || method === 'recommend') {
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].method === 'search' || queue[i].method === 'recommend')
          queue.splice(i, 1)[0].resolve([])
      }
    }
    if (queue.length >= 64) {
      reject(new Error('Tag search is busy'))
      return
    }
    queue.push({ id: ++sequence, method, args, resolve, reject })
    pump()
  })
}
export function setUserTagKo(tag: string, ko: string): void {
  const map = { ...loadUserKo() },
    key = keyFor(tag)
  if (ko.trim()) map[key] = ko.trim()
  else delete map[key]
  setSetting('tag_ko_user', JSON.stringify(map))
  userKo = map
  revision++
}
export function listUserTagKo(): Record<string, string> {
  return { ...loadUserKo() }
}
export function lookupTags(names: string[]): Promise<TagEntry[]> {
  return request('lookup', [names])
}
export function searchTags(query: string, limit = 10): Promise<TagEntry[]> {
  return request('search', [query, limit])
}
export function recommendTags(query: string, limit = 10): Promise<TagEntry[]> {
  return request('recommend', [query, limit])
}
export function historyTags(mode: 'recent' | 'frequent', limit = 12): Promise<TagEntry[]> {
  return request('history', [mode, limit])
}
export async function recordTagUse(name: string): Promise<void> {
  const tag = keyFor(name)
  if (!(await lookupTags([tag])).length) return
  const previous = loadUsage()
  const next = {
    ...previous,
    [tag]: {
      count: Math.min(1000000, (previous[tag]?.count ?? 0) + 1),
      lastUsed: Math.max(Date.now(), ...Object.values(previous).map((u) => u.lastUsed + 1))
    }
  }
  const bounded = Object.fromEntries(
    Object.entries(next)
      .sort((a, b) => b[1].lastUsed - a[1].lastUsed)
      .slice(0, 500)
  )
  setSetting('tag_usage_v1', JSON.stringify(bounded))
  usage = bounded
  revision++
}
export function clearTagUsage(): void {
  setSetting('tag_usage_v1', '{}')
  usage = {}
  revision++
}
export function shutdownTagSearch(): void {
  fail(new Error('Tag search stopped'))
}
