/**
 * 모바일 클라우드 계약 (커스텀) — PC 앱 ↔ 클라우드 워커 ↔ 폰 화면이 주고받는 모양.
 *
 * 설계 명세: cloud/DESIGN.md. 이 파일은 타입과 아주 작은 순수 상수만 둔다
 * (src/shared 는 렌더러·메인·워커 번들이 모두 import 하므로 node/electron/DOM 의존 금지).
 */
import type { OpusUsage } from './opus-usage'
import type { CensorKind, CensorWeights } from './censor-tags'
import type { SceneBackground } from './background-tags'
import type { GenerationRequest, PromptParts } from './types'

/** 계약 판 — 서로 다르면 PC가 「앱·워커 판이 다름」을 띄운다 */
export const CLOUD_PROTOCOL = 1

/** 폰 한 번에 요청할 수 있는 최대 장수 */
export const CLOUD_JOB_MAX_COUNT = 20

/** PC가 이 시간 안에 poll 했으면 「켜져 있음」으로 본다 (ms) */
export const CLOUD_PC_ONLINE_MS = 15_000

/** 클라우드 생성 무료 범위 — 이걸 넘는 요청은 클라우드에서 생성하지 않는다 */
export const CLOUD_FREE_MAX_PIXELS = 1024 * 1024
export const CLOUD_FREE_MAX_STEPS = 28

// ── 라이브러리 (PC → 클라우드, 폰이 읽음) ──────────────────────────

export interface CloudPresetLite {
  id: number
  name: string
  kind: 'scene' | 'background'
  sortOrder: number
  sceneCount: number
}

/** 씬 한 장 — 폰 표시용 + 클라우드 생성 때 refreshScenePrompts 재병합용 필드 */
export interface CloudSceneLite {
  id: number
  presetId: number
  kind: 'scene' | 'background'
  name: string
  prompt: string
  negativePrompt: string
  width: number
  height: number
  reserveCount: number
  sortOrder: number
  sourceTags: string
  targetTags: string
  exportNo: number | null
  background?: SceneBackground
  censorKinds?: CensorKind[]
  censorTagWeights?: CensorWeights
  suppressAnal?: boolean
}

export interface CloudCharacterLite {
  id: number
  name: string
  folderId: number | null
  enabled: boolean
  prompt: string
  negativePrompt: string
  role: 'source' | 'target' | null
  outfitId: number | null
  sortOrder: number
}

export interface CloudFolderLite {
  id: number
  name: string
  parentId: number | null
}

/** 메인 탭 생성 설정 중 폰이 보여 주고 고칠 수 있는 것 */
export interface CloudMainParams {
  prompt: string
  promptParts: PromptParts | null
  promptSplit: boolean
  negativePrompt: string
  model: string
  width: number
  height: number
  steps: number
}

export interface CloudAccountInfo {
  id: string
  label: string
  prefix: string
  active: boolean
  tier: string | null
  anlas: number | null
  opusUsage: OpusUsage | null
  updatedAt: number
}

export interface CloudNaiInfo {
  tier: string | null
  anlas: number | null
  opusUsage: OpusUsage | null
  updatedAt: number
  /** 연결된 모든 NAI 계정 목록 및 계정별 잔액·한도·추가 게이지 */
  accounts?: CloudAccountInfo[]
  /** 고속 모드(번개 버튼, 다중 계정 동시 생성) 켜짐 여부 */
  turboEnabled?: boolean
  /** 한도 소진 시 자동 계정 전환 켜짐 여부 */
  autoSwitchEnabled?: boolean
}

export interface CloudDriveFolderEntry {
  /** 루트 폴더 기준 상대 경로 (루트는 "", 구분자는 "/") */
  path: string
  /** 하위 폴더 이름 목록 */
  dirs: string[]
  /** 이 폴더 안의 그림 파일 이름 목록 */
  imgs: string[]
}

export interface CloudDriveIndex {
  rootName: string
  rootPath: string
  updatedAt: number
  folders: CloudDriveFolderEntry[]
}

export type CloudControlAction =
  | { kind: 'account:setActive'; accountId: string }
  | { kind: 'turbo:set'; enabled: boolean }
  | { kind: 'autoSwitch:set'; enabled: boolean }
  | { kind: 'accounts:refresh' }
  | { kind: 'images:uploadRecent'; count: number }
  | { kind: 'drive:mkdir'; relPath: string }
  | { kind: 'drive:exportPreset'; presetId: number; relPath: string; favoritesOnly?: boolean }
  | { kind: 'drive:syncFolder'; relPath: string }
  /** 고른 PC 폴더를 다시 훑어 색인을 올린다 */
  | { kind: 'drive:refreshIndex' }

export interface CloudLibrary {
  presets: CloudPresetLite[]
  characters: CloudCharacterLite[]
  charFolders: CloudFolderLite[]
  outfits: { id: number; name: string }[]
  main: CloudMainParams
  naiInfo: CloudNaiInfo | null
}

// ── 폰 → PC 편집 (클라우드가 줄 세워 PC에 전달) ──────────────────────

export interface CloudScenePatch {
  name?: string
  prompt?: string
  negativePrompt?: string
  width?: number
  height?: number
}

export interface CloudCharPatch {
  enabled?: boolean
  prompt?: string
}

export interface CloudMainPatch {
  prompt?: string
  promptParts?: PromptParts
  negativePrompt?: string
}

export type CloudOp =
  | { id: number; at: number; type: 'scene:update'; sceneId: number; patch: CloudScenePatch }
  | { id: number; at: number; type: 'char:update'; charId: number; patch: CloudCharPatch }
  | { id: number; at: number; type: 'main:update'; patch: CloudMainPatch }
  /** PC가 맡은 작업 취소 — PC 메인이 그 작업의 큐 항목을 직접 취소한다 */
  | { id: number; at: number; type: 'job:cancel'; jobId: string }
  /** 폰 → PC 제어 명령 (계정 전환·고속 모드·폴더 내보내기·폴더 동기화 등) */
  | { id: number; at: number; type: 'pc:control'; action: CloudControlAction }

// ── 생성 작업 ───────────────────────────────────────────────────────

export type CloudJobTarget = { type: 'scene'; sceneId: number } | { type: 'main' }

/**
 * queued = PC가 가져가길 기다림 / pc = PC 큐에 들어감 / cloud = 클라우드가 생성 중·대기
 * done·failed·cancelled = 끝
 */
export type CloudJobState = 'queued' | 'pc' | 'cloud' | 'done' | 'failed' | 'cancelled'

/** auto = PC 켜져 있으면 PC, 꺼져 있으면 클라우드 */
export type CloudJobPlace = 'auto' | 'pc' | 'cloud'

export interface CloudJob {
  id: string
  target: CloudJobTarget
  /** 사람이 읽는 이름 — 씬 이름 또는 「메인 생성」 */
  label: string
  count: number
  done: number
  failed: number
  state: CloudJobState
  place: CloudJobPlace
  runner: 'pc' | 'cloud' | null
  error: string | null
  createdAt: number
  updatedAt: number
}

/** PC 큐 요약 — poll 때 PC가 올리고 폰이 진행 상황으로 보여 준다 */
export interface CloudQueueSummary {
  running: boolean
  pending: number
  generating: number
  done: number
  failed: number
  generatingSceneId: number | null
  updatedAt: number
}

// ── 그림 ────────────────────────────────────────────────────────────

/** 폰 갤러리 항목. pc = PC가 올린 WebP, cloud = 클라우드가 NAI에서 받은 zip(PNG 한 장) */
export interface CloudImageItem {
  id: string
  source: 'pc' | 'cloud'
  sceneId: number | null
  presetId: number | null
  jobId: string | null
  seed: number | null
  width: number
  height: number
  createdAt: number
  hasThumb: boolean
  format: 'webp' | 'zip'
  /** 클라우드 생성분인데 PC가 아직 안 가져감 — 지우면 유일한 사본이 사라진다(DELETE 에 ?force=1 필요, 없으면 409) */
  pcPending: boolean
}

/** PC가 그림을 올릴 때 함께 보내는 정보 (헤더 x-nais-meta, base64url JSON) */
export interface CloudImageMeta {
  pcImageId: number
  sceneId: number | null
  presetId: number | null
  seed: number | null
  width: number
  height: number
  createdAt: number
  kind: string
}

/** 클라우드가 생성했고 PC가 아직 가져가지 않은 그림 */
export interface CloudGeneratedImage {
  id: string
  jobId: string
  sceneId: number | null
  presetId: number | null
  seed: number
  /** 워커가 NAI에 보낸 payload JSON — PC가 saveGeneratedImage 의 sentPayload 로 쓴다 */
  sentPayload: string
  createdAt: number
}

export interface CloudDevice {
  id: string
  name: string
  createdAt: number
  lastSeen: number | null
}

// ── PC ↔ 클라우드 API 본문 ─────────────────────────────────────────

export interface CloudPreparedItem {
  /** 'main' 또는 `scene:${id}` */
  key: string
  hash: string
  /** 시드를 뺀 완성 요청 (buildSceneRequest·메인 생성 조립 결과) */
  request: GenerationRequest
}

/** PUT /api/pc/scene-counts — 씬 id → PC 그림 수 (PC는 60초에 한 번 이하로 보낸다) */
export interface CloudSceneCounts {
  counts: Record<string, number>
}

export interface CloudHashes {
  library: string | null
  fragments: string | null
  scenes: Record<string, string>
  prepared: Record<string, string>
}

export interface CloudPollRequest {
  protocol: number
  appVersion: string
  queue: CloudQueueSummary
  /** PC가 지금 폰 작업을 받을 수 있는가 (렌더러 준비·동기화 켬) */
  acceptsJobs: boolean
  /**
   * PC가 지금 큐에 들고 있는 작업 id 전부. state 'pc' 인데 여기 없는 작업은
   * (앱 재시작 등으로) PC가 잃은 것 — 클라우드가 실패로 정리한다 (accepted 뒤 60초 유예)
   */
  activeJobIds: string[]
}

export interface CloudPollResponse {
  protocol: number
  serverTime: number
  ops: CloudOp[]
  jobs: CloudJob[]
  /** 클라우드 저장소가 비었거나 판이 바뀌어 전부 다시 올려야 함 */
  needsFullSync: boolean
}

export interface CloudAckRequest {
  opIds: number[]
  /** opIds 중 PC가 반영하지 못한 줄 — 클라우드 생성의 「ack 된 메인 편집 덧입힘」에서 뺀다 */
  failedOpIds?: number[]
  jobs: {
    id: string
    state: 'accepted' | 'done' | 'failed'
    done?: number
    failed?: number
    error?: string
  }[]
}

export interface CloudSettings {
  cloudGenEnabled: boolean
  /** 클라우드에 남길 최근 그림 수 (PC가 아직 안 가져간 클라우드 생성분은 세지 않고 지우지도 않는다) */
  keepImages: number
}

/** 클라우드가 마지막으로 확인한 Opus 무료 사용량 상태 */
export interface CloudQuota {
  state: 'available' | 'exhausted' | 'unknown'
  checkedAt: number
}

export interface CloudPcInfo {
  protocol: number
  hasNaiToken: boolean
  settings: CloudSettings
  devices: number
  imagesStored: number
  cloudJobsActive: number
  /** 클라우드 생성 때 확인한 무료 사용량 (확인한 적 없으면 null) */
  quota: CloudQuota | null
}

// ── 폰 API 본문 ─────────────────────────────────────────────────────

export interface CloudPhoneState {
  protocol: number
  serverTime: number
  pc: { online: boolean; lastSeen: number | null; queue: CloudQueueSummary | null }
  library: CloudLibrary | null
  cloudGen: {
    enabled: boolean
    hasNaiToken: boolean
    /** 지금 클라우드에서 생성 가능한가 — 아니면 reason 에 이유 */
    ready: boolean
    reason: string | null
    /** 마지막으로 확인한 무료 사용량 (클라우드 확인값, 없으면 PC가 올린 naiInfo 기준, 둘 다 없으면 null) */
    quota: CloudQuota | null
  }
  jobs: CloudJob[]
}

export interface CloudPhoneScene extends CloudSceneLite {
  /** PC 기준 그림 수 — PUT /api/pc/scene-counts 로 따로 받는다(씬 본문 해시에 넣으면 그림마다 씬 전체를 다시 올리게 됨) */
  imageCount: number
  latestImageId: string | null
  /** 폰에서 고쳤는데 PC가 아직 반영 안 함 */
  pendingEdit: boolean
}

export interface CloudCreateJob {
  target: CloudJobTarget
  count: number
  place: CloudJobPlace
  /** 폰이 만든 요청 id — 같은 id 로 10분 안에 다시 오면 새로 만들지 않고 앞서 만든 작업을 돌려준다(응답 유실 재시도 대비) */
  requestId?: string
}

/** POST /api/jobs 응답 — notice 는 place 'pc' 인데 PC가 꺼져 있을 때 등 안내 문장 */
export interface CloudCreateJobResponse {
  job: CloudJob
  notice?: string
}

// ── PC 앱 내부 IPC (메인 ↔ 렌더러) ─────────────────────────────────

export interface CloudPcStatus {
  /** PC 비밀값이 있음 (배포 때 받은 연결 정보) */
  configured: boolean
  /** 동기화 켬 */
  enabled: boolean
  /** 마지막 요청이 성공했는가 */
  connected: boolean
  url: string
  lastSyncAt: number | null
  error: string | null
  uploadImages: boolean
  cloudGen: {
    enabled: boolean
    hasToken: boolean
    quota: 'available' | 'exhausted' | 'unknown' | null
  }
  keepImages: number
  devices: number
  pendingUploads: number
  /** 재시도 끝에 올리지 못한 그림 수 */
  failedUploads: number
  importedCount: number
  cloudJobsActive: number
  protocolMismatch: boolean
}

/** 메인이 렌더러에 넘기는 할 일 — 렌더러가 스토어를 거쳐 반영·생성한다 */
export interface CloudWork {
  ops: CloudOp[]
  jobs: CloudJob[]
}

/** 렌더러가 할 일을 끝내고 메인에 돌려주는 결과 */
export interface CloudWorkResult {
  opIds: number[]
  /** 반영하지 못한 편집(예: 캐릭터 최대 수) — 메인은 다음 라이브러리 업로드를 해시와 무관하게 강제해 폰 사본을 PC 실제 값으로 되돌린다 */
  failedOpIds?: number[]
  jobs: { id: string; queueIds: string[]; error?: string }[]
}

export interface CloudPairing {
  code: string
  url: string
  expiresAt: number
  /** 연결 주소 QR (SVG 문자열) */
  qrSvg: string
}
