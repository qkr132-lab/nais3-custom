import type { CloudAccountInfo } from '../../shared/cloud-contract'
import type { OpusUsage } from '../../shared/opus-usage'
import type { IpcEventMap, QueueStatusLite } from '../../shared/types'

/**
 * 클라우드 연결 모듈(src/main/cloud) 안에서 쓰는 작은 타입들.
 * sync.ts 는 electron·DB 를 직접 부르지 않고 아래 인터페이스로 주입받는다(테스트에서 가짜로 갈아 끼움).
 */

/** 설정 'cloud_upload_state' — 클라우드에 이미 올린 PC 그림 id (최근 것 위주로 잘라 둠) */
export interface CloudUploadState {
  uploaded: number[]
  /**
   * PC 에 저장은 했지만 클라우드에 「가져왔다」고 아직 못 알린 클라우드 그림 — 클라우드 그림 id → PC 그림 id.
   * 앱이 꺼졌다 켜져도 같은 그림을 한 번 더 저장하지 않으려고 같이 적어 둔다.
   */
  pendingImported?: Record<string, number>
}

export type ConnectImportResult = 'none' | 'imported' | 'invalid'

/** 클라우드 연결 설정 저장소 (설정 키는 config.ts 에서 정한다) */
export interface CloudConfigPort {
  url(): string
  /** PC 비밀값이 저장돼 있는가 (값 자체는 내보내지 않는다) */
  hasSecret(): boolean
  enabled(): boolean
  setEnabled(enabled: boolean): void
  uploadImages(): boolean
  setUploadImages(enabled: boolean): void
  keepImages(): number
  setKeepImages(count: number): void
  cloudGenEnabled(): boolean
  setCloudGenEnabled(enabled: boolean): void
  loadUploadState(): CloudUploadState
  saveUploadState(state: CloudUploadState): void
  /** 배포 스크립트가 둔 연결 파일이 있으면 읽어 저장하고 지운다 */
  importConnectFile(): ConnectImportResult
}

/** ipc.ts 의 broadcast 와 같은 모양 */
export type CloudBroadcast = <C extends keyof IpcEventMap>(
  channel: C,
  payload: IpcEventMap[C]
) => void

/** GenerationQueue 중 클라우드가 쓰는 부분 */
export interface CloudQueuePort {
  statusLite(): QueueStatusLite
  cancel(ids: string[]): void
  /** 요청의 cloudJobId 가 이 작업 id 인 큐 항목 id 전부 (상태 무관, 없으면 빈 배열) */
  idsByCloudJob(jobId: string): string[]
  on(event: 'changed', listener: (status: QueueStatusLite) => void): unknown
  off(event: 'changed', listener: (status: QueueStatusLite) => void): unknown
}

/** index.ts 의 생성 저장 직후 훅이 넘기는 정보 */
export interface CloudImageSavedInfo {
  id: number
  filePath: string
  sceneId?: number
  seed: number
  kind: string
  width: number
  height: number
}

/** 잔액 조회(fetchAnlasBalance) 결과 — 조회에 실패하면 셋 다 null */
export interface NaiBalanceInfo {
  tier: string | null
  anlas: number | null
  opusUsage: OpusUsage | null
  accounts?: CloudAccountInfo[]
  turboEnabled?: boolean
  autoSwitchEnabled?: boolean
}

/** 올릴 그림 한 장의 바이트 */
export interface UploadBytes {
  /** 메타데이터를 뺀 WebP */
  webp: Uint8Array
  /** DB 썸네일 BLOB (없으면 null) */
  thumb: Uint8Array | null
  width: number
  height: number
}

export interface RecentImage {
  id: number
  filePath: string
  sceneId: number | null
  seed: number | null
  kind: string
  /** ms epoch */
  createdAt: number
}

/** 클라우드에서 받은 그림을 PC 에 저장할 때 saveGeneratedImage 에 넘기는 값 (필요한 것만) */
export interface SaveGeneratedInput {
  png: Buffer
  sentPayload: string
  seed: number
  kind: 't2i' | 'scene'
  sceneId?: number
  format: 'png'
  sceneName?: string
  scenePresetName?: string
}

/** 그림 관련 DB·파일 접근 (실제 구현은 images.ts, 저장은 images/storage.ts) */
export interface CloudImageDeps {
  readForUpload(id: number, filePath: string): Promise<UploadBytes>
  listRecent(limit: number): RecentImage[]
  presetIdOfScene(sceneId: number): number | null
  /** 휴지통에 들지 않은 씬만. 없으면 null */
  findScene(sceneId: number): { id: number; name: string; presetId: number } | null
  presetName(presetId: number): string | null
  saveGenerated(input: SaveGeneratedInput): Promise<{ id: number; filePath: string }>
}
