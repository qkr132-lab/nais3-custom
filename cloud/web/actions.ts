/** 상태를 바꾸는 동작들 — 화면은 이 함수들만 부른다 */
import type {
  CloudControlAction,
  CloudCreateJob,
  CloudCreateJobResponse,
  CloudImageItem,
  CloudJob,
  CloudMainPatch,
  CloudPhoneScene,
  CloudPhoneState
} from '@shared/cloud-contract'
import { api, imageCache, onThumbUploaded, setUnauthorizedHandler } from './client'
import { ApiError } from './lib/api'
import { pcControl } from './lib/control'
import { buildDriveTree, driveFolder, hasUncachedDriveFiles } from './lib/drive'
import { appendUnique, loadMoreBackoffMs, mergeHead } from './lib/gallery'
import { jobsSignature } from './lib/poll'
import { RequestIdKeeper, isAmbiguousFailure } from './lib/request-id'
import { writePref, writeToken } from './lib/storage'
import {
  app,
  confirms,
  drive,
  gallery,
  scenes,
  sheets,
  toasts,
  viewer,
  type ConfirmRequest,
  type GalleryFilter,
  type PresetScenes,
  type TabId
} from './stores'

export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  return '알 수 없는 오류가 났습니다'
}

// ── 토스트·확인 ─────────────────────────────────────────────────────

let toastSeq = 0

/** durationMs 를 주지 않으면 안내 3.2초, 오류 5초 */
export function toast(text: string, kind: 'info' | 'error' = 'info', durationMs?: number): void {
  const id = ++toastSeq
  toasts.set((s) => ({ items: [...s.items.slice(-2), { id, kind, text }] }))
  setTimeout(() => dismissToast(id), durationMs ?? (kind === 'error' ? 5000 : 3200))
}

export function dismissToast(id: number): void {
  toasts.set((s) => ({ items: s.items.filter((t) => t.id !== id) }))
}

export function askConfirm(opts: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => {
    // 이미 떠 있는 확인이 있으면 취소로 닫는다
    confirms.get().request?.resolve(false)
    confirms.set({ request: { ...opts, resolve } })
  })
}

export function answerConfirm(ok: boolean): void {
  const req = confirms.get().request
  confirms.set({ request: null })
  req?.resolve(ok)
}

// ── 연결·해제 ───────────────────────────────────────────────────────

/** 로그인 기록과 화면 상태를 모두 비운다 */
function resetSession(): void {
  writeToken(null)
  imageCache.clear()
  lastSignature = ''
  app.set({
    phone: null,
    stateError: null,
    offline: false,
    clockSkew: 0,
    device: null,
    tab: 'scenes',
    jobsVersion: 0,
    imagesVersion: 0
  })
  scenes.set({ byPreset: {} })
  gallery.set({
    items: [],
    next: null,
    loaded: false,
    loading: false,
    error: null,
    filter: null,
    moreError: null,
    moreFailures: 0,
    retryAt: 0
  })
  viewer.set({ current: null })
  sheets.set({ sceneId: null, picker: false, exportPresetId: null })
  drive.set({
    index: null,
    cachedFiles: {},
    currentPath: '',
    search: '',
    loading: false,
    error: null
  })
}

export function signOut(notice: string | null = null): void {
  resetSession()
  app.set({ auth: 'out', notice })
}

setUnauthorizedHandler(() => {
  if (app.get().auth === 'in') signOut('연결이 해제되었습니다. 다시 연결해 주세요.')
})

/** 연결 코드로 이 폰을 등록한다 */
export async function pairDevice(code: string, name: string): Promise<void> {
  const res = await api.pair(code, name)
  writeToken(res.token)
  app.set({ auth: 'in', notice: null, device: { deviceId: res.deviceId, name } })
  try {
    history.replaceState(null, '', location.pathname + location.search)
  } catch {
    /* 주소 정리는 못 해도 된다 */
  }
}

/** 이 기기를 서버에서 지우고 로그아웃 */
export async function logout(): Promise<void> {
  try {
    await api.logout()
  } catch (err) {
    // 서버에 닿지 못했거나 서버가 고장이면 기기가 서버에 남으므로 해제하지 않고 알린다.
    // (401 등 서버가 이미 모르는 기기이면 이 폰의 연결만 끊으면 된다)
    if (!(err instanceof ApiError) || err.isNetwork || err.status >= 500) throw err
  }
  signOut(null)
}

export async function loadDevice(): Promise<void> {
  if (app.get().device) return
  try {
    const me = await api.me()
    app.set({ device: { deviceId: me.deviceId, name: me.name } })
  } catch {
    /* 이름은 없어도 된다 */
  }
}

// ── 상태 폴링 ───────────────────────────────────────────────────────

let lastSignature = ''
let stateInFlight: Promise<boolean> | null = null
let stateStartedAt = 0
/** 이 시간이 지나도 안 끝난 상태 요청은 멈춘 것으로 보고 따로 새로 받는다 (요청 자체에도 시간 제한이 있다) */
const STATE_STALE_MS = 30_000

/** /api/state 를 한 번 받아 저장한다. 실패하면 false */
export function refreshState(): Promise<boolean> {
  if (stateInFlight && Date.now() - stateStartedAt < STATE_STALE_MS) return stateInFlight
  stateStartedAt = Date.now()
  const run: Promise<boolean> = fetchState().finally(() => {
    if (stateInFlight === run) stateInFlight = null
  })
  stateInFlight = run
  return run
}

async function fetchState(): Promise<boolean> {
  if (app.get().auth !== 'in') return true
  try {
    const phone: CloudPhoneState = await api.state()
    const signature = jobsSignature(phone.jobs)
    const changed = signature !== lastSignature
    lastSignature = signature
    app.set((s) => ({
      phone,
      stateError: null,
      offline: false,
      clockSkew: phone.serverTime - Date.now(),
      jobsVersion: changed ? s.jobsVersion + 1 : s.jobsVersion,
      presetId: pickPreset(phone, s.presetId)
    }))
    return true
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return true // 로그아웃 처리됨
    const down = !(err instanceof ApiError) || err.isNetwork || err.status >= 500
    app.set((s) => ({
      offline: down ? true : s.offline,
      stateError: s.phone ? null : errorMessage(err)
    }))
    return false
  }
}

/** 고른 프리셋이 없거나 사라졌으면 첫 번째 씬 프리셋으로 */
function pickPreset(phone: CloudPhoneState, current: number | null): number | null {
  const presets = phone.library?.presets
  if (!presets || presets.length === 0) return null
  if (current != null && presets.some((p) => p.id === current)) return current
  const sorted = [...presets].sort((a, b) => a.sortOrder - b.sortOrder)
  return (sorted.find((p) => p.kind === 'scene') ?? sorted[0]).id
}

export function setTab(tab: TabId): void {
  app.set({ tab })
}

export function setPreset(id: number): void {
  app.set({ presetId: id })
  writePref('preset', String(id))
}

// ── 씬 ──────────────────────────────────────────────────────────────

const EMPTY_PRESET_SCENES: PresetScenes = { items: [], loaded: false, loading: false, error: null }

function setPresetScenes(presetId: number, patch: Partial<PresetScenes>): void {
  scenes.set((s) => ({
    byPreset: {
      ...s.byPreset,
      [presetId]: { ...(s.byPreset[presetId] ?? EMPTY_PRESET_SCENES), ...patch }
    }
  }))
}

/** 프리셋의 씬 목록. silent 면 이미 보이는 목록을 그대로 두고 조용히 갱신 */
export async function loadScenes(presetId: number, opts: { silent?: boolean } = {}): Promise<void> {
  const cur = scenes.get().byPreset[presetId]
  if (cur?.loading) return
  if (!(opts.silent && cur?.loaded)) setPresetScenes(presetId, { loading: true, error: null })
  else setPresetScenes(presetId, { loading: true })
  try {
    const res = await api.scenes(presetId)
    setPresetScenes(presetId, { items: res.items, loaded: true, loading: false, error: null })
  } catch (err) {
    const stale = scenes.get().byPreset[presetId]?.loaded
    setPresetScenes(presetId, {
      loading: false,
      error: stale && opts.silent ? null : errorMessage(err)
    })
  }
}

/** 서버가 돌려준 씬으로 목록의 같은 씬을 바꾼다 */
export function replaceScene(scene: CloudPhoneScene): void {
  scenes.set((s) => {
    const entry = s.byPreset[scene.presetId]
    if (!entry) return {}
    return {
      byPreset: {
        ...s.byPreset,
        [scene.presetId]: {
          ...entry,
          items: entry.items.map((it) => (it.id === scene.id ? scene : it))
        }
      }
    }
  })
}

// ── 갤러리 ──────────────────────────────────────────────────────────

const GALLERY_PAGE = 45
let galleryToken = 0

function galleryQuery(filter: GalleryFilter | null, before?: string | null) {
  return {
    sceneId: filter?.sceneId ?? null,
    presetId: filter?.sceneId == null ? (filter?.presetId ?? null) : null,
    before: before ?? null,
    limit: GALLERY_PAGE
  }
}

/** 다음 페이지가 연달아 실패하면 자동 재시도는 이 횟수까지만 (그 뒤로는 「다시 시도」 버튼으로만) */
export const LOAD_MORE_AUTO_RETRIES = 4

/** 첫 페이지부터 다시 불러온다 (처음 열 때·필터를 바꿀 때·다시 시도) */
export async function loadGallery(): Promise<void> {
  const token = ++galleryToken
  gallery.set({ loading: true, error: null, moreError: null, moreFailures: 0, retryAt: 0 })
  try {
    const res = await api.images(galleryQuery(gallery.get().filter))
    if (token !== galleryToken) return
    gallery.set({ items: res.items, next: res.next, loaded: true, loading: false })
  } catch (err) {
    if (token !== galleryToken) return
    const message = errorMessage(err)
    const hadList = gallery.get().items.length > 0
    gallery.set({ loading: false, error: message })
    // 이미 보이는 목록이 있으면 오류 화면으로 바꾸지 않고 알리기만 한다
    if (hadList) toast(message, 'error')
  }
}

/**
 * 다음 페이지를 불러온다. 실패하면 간격을 두 배씩 늘려(3초부터 60초까지) 그 시각 전에는 자동으로 다시 요청하지 않는다.
 * manual 은 사용자가 「다시 시도」를 누른 경우 — 대기 시간을 무시한다
 */
export async function loadMoreGallery(opts: { manual?: boolean } = {}): Promise<void> {
  const g = gallery.get()
  if (g.loading || !g.next || !g.loaded) return
  if (!opts.manual && g.moreError && Date.now() < g.retryAt) return
  const token = galleryToken
  gallery.set({ loading: true })
  try {
    const res = await api.images(galleryQuery(g.filter, g.next))
    if (token !== galleryToken) return
    gallery.set((s) => ({
      items: appendUnique(s.items, res.items),
      next: res.next,
      loading: false,
      moreError: null,
      moreFailures: 0,
      retryAt: 0
    }))
  } catch (err) {
    if (token !== galleryToken) return
    const failures = gallery.get().moreFailures + 1
    gallery.set({
      loading: false,
      moreError: errorMessage(err),
      moreFailures: failures,
      retryAt: Date.now() + loadMoreBackoffMs(failures)
    })
    // 처음 실패했을 때와 사용자가 직접 눌렀을 때만 토스트 (자동 재시도마다 띄우면 계속 갈아 끼워진다)
    if (opts.manual || failures === 1) toast(errorMessage(err), 'error')
  }
}

/** 새 그림이 올라왔는지 첫 페이지만 조용히 다시 받는다 */
export async function refreshGalleryHead(): Promise<void> {
  const g = gallery.get()
  if (!g.loaded || g.loading) return
  const token = galleryToken
  try {
    const res = await api.images(galleryQuery(g.filter))
    if (token !== galleryToken) return
    gallery.set((s) => mergeHead(s, res))
  } catch {
    /* 다음 주기에 다시 */
  }
}

export function setGalleryFilter(filter: GalleryFilter | null): void {
  gallery.set({
    filter,
    items: [],
    next: null,
    loaded: false,
    moreError: null,
    moreFailures: 0,
    retryAt: 0
  })
  void loadGallery()
}

onThumbUploaded((id) => {
  gallery.set((s) => ({
    items: s.items.map((it) => (it.id === id ? { ...it, hasThumb: true } : it))
  }))
})

// ── 그림 보기·삭제 ──────────────────────────────────────────────────

export function openViewer(
  items: CloudImageItem[],
  index: number,
  source: 'gallery' | 'list'
): void {
  viewer.set({ current: { items, index, id: items[index]?.id ?? null, source } })
}

export function closeViewer(): void {
  viewer.set({ current: null })
}

/** 좌우 이동 — 지금 보이는 목록(갤러리 목록은 새 그림이 끼면 달라진다)의 index 번째 그림으로 간다 */
export function setViewerIndex(index: number): void {
  viewer.set((s) => {
    const cur = s.current
    if (!cur) return {}
    const list = cur.source === 'gallery' ? gallery.get().items : cur.items
    const item = list[index]
    return item ? { current: { ...cur, index, id: item.id } } : {}
  })
}

/** 목록이 바뀌어 보던 그림의 위치가 달라졌거나 보던 그림이 지워졌을 때, 기억하는 id·위치를 지금 보이는 그림에 맞춘다 */
export function syncViewer(id: string | null, index: number): void {
  viewer.set((s) =>
    s.current && (s.current.id !== id || s.current.index !== index)
      ? { current: { ...s.current, id, index } }
      : {}
  )
}

/**
 * 클라우드 사본만 지운다 (PC 원본은 그대로).
 * PC로 아직 옮기지 않은 그림(pcPending)은 이 사본이 유일하므로 force 로 확인을 받은 뒤에만 지운다
 */
export async function deleteImage(id: string, opts: { force?: boolean } = {}): Promise<void> {
  await api.deleteImage(id, opts)
  gallery.set((s) => ({ items: s.items.filter((it) => it.id !== id) }))
  viewer.set((s) =>
    s.current
      ? { current: { ...s.current, items: s.current.items.filter((it) => it.id !== id) } }
      : {}
  )
  app.set((s) => ({ imagesVersion: s.imagesVersion + 1 }))
}

// ── 작업 ────────────────────────────────────────────────────────────

function putJob(job: CloudJob): void {
  app.set((s) => {
    if (!s.phone) return {}
    const jobs = [job, ...s.phone.jobs.filter((j) => j.id !== job.id)]
    return { phone: { ...s.phone, jobs } }
  })
}

const requestIds = new RequestIdKeeper()

/**
 * 생성 작업을 만든다. 서버가 막으면 오류를 던진다.
 * 요청 id 는 누를 때마다 새로 쓰되, 응답이 끊기는 등 결과를 모르는 실패 뒤 같은 내용으로 다시 누르면 같은 값을 보내
 * 서버가 작업을 두 번 만들지 않게 한다
 */
export async function createJob(
  body: Omit<CloudCreateJob, 'requestId'>
): Promise<CloudCreateJobResponse> {
  const requestId = requestIds.idFor(body)
  try {
    const res = await api.createJob({ ...body, requestId })
    requestIds.settle(null)
    putJob(res.job)
    void refreshState()
    return res
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 0
    requestIds.settle(status)
    // 응답만 유실됐다면 작업은 이미 만들어졌을 수 있다 — 상태를 다시 받아 목록에 나타나게 한다
    if (isAmbiguousFailure(status)) void refreshState()
    throw err
  }
}

export async function cancelJob(id: string): Promise<void> {
  const res = await api.cancelJob(id)
  putJob(res.job)
  void refreshState()
}

// ── 메인·캐릭터 ─────────────────────────────────────────────────────

/** 캐릭터 켜기/끄기 — 먼저 화면에 반영하고 서버가 거절하면 되돌린다 */
export async function setCharacterEnabled(id: number, enabled: boolean): Promise<void> {
  const before = app.get().phone?.library?.characters.find((c) => c.id === id)?.enabled
  patchLocalCharacter(id, enabled)
  try {
    await api.patchCharacter(id, { enabled })
  } catch (err) {
    if (before !== undefined) patchLocalCharacter(id, before)
    throw err
  }
}

function patchLocalCharacter(id: number, enabled: boolean): void {
  app.set((s) => {
    const lib = s.phone?.library
    if (!s.phone || !lib) return {}
    return {
      phone: {
        ...s.phone,
        library: {
          ...lib,
          characters: lib.characters.map((c) => (c.id === id ? { ...c, enabled } : c))
        }
      }
    }
  })
}

/** 메인 프롬프트를 저장한다. 서버 사본이 바로 바뀌므로 화면의 사본도 같이 바꾼다 */
export async function saveMain(patch: CloudMainPatch): Promise<void> {
  await api.patchMain(patch)
  app.set((s) => {
    const lib = s.phone?.library
    if (!s.phone || !lib) return {}
    return {
      phone: {
        ...s.phone,
        library: {
          ...lib,
          main: {
            ...lib.main,
            ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
            ...(patch.promptParts !== undefined ? { promptParts: patch.promptParts } : {}),
            ...(patch.negativePrompt !== undefined ? { negativePrompt: patch.negativePrompt } : {})
          }
        }
      }
    }
  })
  void refreshState()
}

// ── PC 원격 제어 & PC 폴더 브라우징 ─────────────────────────────────────

export async function sendControl(
  action: CloudControlAction,
  successText?: string
): Promise<boolean> {
  try {
    await api.control(action)
    if (successText) toast(successText)
    setTimeout(() => {
      void refreshState()
      if (action.kind.startsWith('drive:')) void loadDriveIndex({ silent: true })
      if (action.kind === 'images:uploadRecent') void loadGallery()
    }, 1500)
    setTimeout(() => {
      void refreshState()
      if (action.kind.startsWith('drive:')) void loadDriveIndex({ silent: true })
      if (action.kind === 'images:uploadRecent') void loadGallery()
    }, 3800)
    return true
  } catch (err) {
    toast(errorMessage(err), 'error')
    return false
  }
}

export async function loadDriveIndex(opts: { silent?: boolean } = {}): Promise<void> {
  const cur = drive.get()
  if (cur.loading) return
  if (!(opts.silent && cur.index)) drive.set({ loading: true, error: null })
  else drive.set({ loading: true })
  try {
    const res = await api.driveIndex()
    drive.set({
      index: res.index,
      cachedFiles: res.cachedFiles ?? {},
      loading: false,
      error: null
    })
  } catch (err) {
    drive.set({
      loading: false,
      error: opts.silent && drive.get().index ? null : errorMessage(err)
    })
  }
}

export function openDriveFolder(relPath: string): void {
  drive.set({ currentPath: relPath, search: '' })
  const { index, cachedFiles } = drive.get()
  const folder = index ? driveFolder(buildDriveTree(index), relPath) : null
  if (hasUncachedDriveFiles(folder, cachedFiles)) {
    void api.control(pcControl.syncDriveFolder(relPath)).catch(() => {})
    setTimeout(() => void loadDriveIndex({ silent: true }), 2200)
    setTimeout(() => void loadDriveIndex({ silent: true }), 4800)
    setTimeout(() => void loadDriveIndex({ silent: true }), 8000)
  }
}
