/** 화면 전체가 같이 보는 상태 저장소들 — 바꾸는 함수는 actions.ts */
import type {
  CloudDriveIndex,
  CloudImageItem,
  CloudPhoneScene,
  CloudPhoneState
} from '@shared/cloud-contract'
import { createStore } from './lib/store'
import { readPref, readToken } from './lib/storage'

export type TabId = 'scenes' | 'create' | 'gallery' | 'jobs' | 'settings'

export interface AppState {
  auth: 'in' | 'out'
  /** 연결 화면 위에 띄우는 안내 (연결이 해제됨 등) */
  notice: string | null
  phone: CloudPhoneState | null
  /** 첫 상태를 못 받았을 때의 오류 문장 */
  stateError: string | null
  /** 서버에 닿지 못하는 중 */
  offline: boolean
  /** 서버 시각 − 기기 시각 (상대 시간 보정) */
  clockSkew: number
  device: { deviceId: string; name: string } | null
  tab: TabId
  /** 씬 탭에서 고른 프리셋 */
  presetId: number | null
  /** 작업 목록이 바뀔 때마다 늘어난다 — 목록 화면들이 다시 받을 때 쓴다 */
  jobsVersion: number
  /** 그림을 지울 때마다 늘어난다 */
  imagesVersion: number
}

export const app = createStore<AppState>({
  auth: readToken() ? 'in' : 'out',
  notice: null,
  phone: null,
  stateError: null,
  offline: false,
  clockSkew: 0,
  device: null,
  tab: 'scenes',
  presetId: Number(readPref('preset')) || null,
  jobsVersion: 0,
  imagesVersion: 0
})

// ── 씬 ──────────────────────────────────────────────────────────────

export interface PresetScenes {
  items: CloudPhoneScene[]
  loaded: boolean
  loading: boolean
  error: string | null
}

export const scenes = createStore<{ byPreset: Record<number, PresetScenes> }>({ byPreset: {} })

export function findScene(
  state: { byPreset: Record<number, PresetScenes> },
  id: number | null
): CloudPhoneScene | null {
  if (id == null) return null
  for (const p of Object.values(state.byPreset)) {
    const hit = p.items.find((s) => s.id === id)
    if (hit) return hit
  }
  return null
}

// ── 갤러리 ──────────────────────────────────────────────────────────

export interface GalleryFilter {
  sceneId: number | null
  presetId: number | null
  /** 칩에 보이는 이름 */
  label: string
}

export interface GalleryState {
  items: CloudImageItem[]
  next: string | null
  loaded: boolean
  loading: boolean
  error: string | null
  filter: GalleryFilter | null
  /** 다음 페이지를 못 불러온 이유. 있으면 자동으로 다시 시도하지 않고 버튼·대기 시간 뒤에만 시도 */
  moreError: string | null
  /** 다음 페이지 불러오기가 연달아 실패한 횟수 */
  moreFailures: number
  /** 이 시각(ms) 전에는 다음 페이지를 자동으로 요청하지 않는다 */
  retryAt: number
}

export const gallery = createStore<GalleryState>({
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

// ── 겹침 화면 ───────────────────────────────────────────────────────

export interface ViewerState {
  /** gallery = 갤러리 목록을 그대로 따라감, list = 열 때 넘겨받은 목록 */
  source: 'gallery' | 'list'
  items: CloudImageItem[]
  /** 보고 있는 그림의 id — 목록 앞에 새 그림이 끼어도 같은 그림을 보여 주려고 이걸로 찾는다 */
  id: string | null
  /** 마지막으로 알던 위치 — id 를 목록에서 못 찾을 때(지워짐) 가까운 항목으로 가는 데 쓴다 */
  index: number
}

export const viewer = createStore<{ current: ViewerState | null }>({ current: null })

/** 씬 시트·씬 고르기 시트·폴더 분류 시트 */
export const sheets = createStore<{
  sceneId: number | null
  picker: boolean
  exportPresetId: number | null
}>({
  sceneId: null,
  picker: false,
  exportPresetId: null
})

// ── PC 폴더 브라우징 ────────────────────────────────────────────────

export interface DriveState {
  index: CloudDriveIndex | null
  cachedFiles: Record<string, number>
  currentPath: string
  search: string
  loading: boolean
  error: string | null
}

export const drive = createStore<DriveState>({
  index: null,
  cachedFiles: {},
  currentPath: '',
  search: '',
  loading: false,
  error: null
})

export interface ToastItem {
  id: number
  kind: 'info' | 'error'
  text: string
}

export const toasts = createStore<{ items: ToastItem[] }>({ items: [] })

export interface ConfirmRequest {
  title: string
  body?: string
  confirmLabel: string
  danger?: boolean
  resolve: (ok: boolean) => void
}

export const confirms = createStore<{ request: ConfirmRequest | null }>({ request: null })
