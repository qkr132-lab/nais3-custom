// 메인 프로세스와 렌더러가 공유하는 타입.
// 규칙: 렌더러는 이 타입들로만 메인과 대화한다 (IPC 계약).

import type { OpusUsage } from './opus-usage'

export type { OpusUsage }

export interface CharacterPromptInput {
  prompt: string
  negativePrompt: string
  /** 0~1 정규화 좌표. 미지정 시 NAI의 AI's choice에 맡긴다 */
  center?: { x: number; y: number }
  enabled: boolean
  /** UI 표시용 (라이브러리에서 추가한 경우) — payload에는 들어가지 않음 */
  name?: string
  thumbnail?: string
}

/**
 * UC 프리셋 인덱스 (NAI 웹 실캡처 확정): 0=Heavy, 1=Light, 3=Human Focus, 4=None. 2는 미사용.
 * 실제 병합되는 텍스트는 main/nai/payload.ts의 UC_PRESETS_V45_FULL 참조.
 */
export type UcPresetIndex = 0 | 1 | 2 | 3 | 4

/** i2i/인페인트 소스 — mask가 있으면 인페인트, 없으면 i2i */
export interface SourceImage {
  imageBase64: string
  maskBase64?: string
  strength: number
  noise: number
}

/** 레퍼런스 라이브러리 카드 공통 (바이브/캐릭레퍼) */
export interface VibeItem {
  id: number
  name: string
  thumbnail: string
  enabled: boolean
  strength: number
  infoExtracted: number
  /** 현재 infoExtracted로 인코딩돼 있는지 (아니면 생성 시 2 Anlas 소모) */
  encodedReady: boolean
  folderId: number | null
}

export type CharRefType = 'character' | 'style' | 'character&style' | 'costume' | 'delta'

export interface CharRefItem {
  id: number
  name: string
  thumbnail: string
  enabled: boolean
  refType: CharRefType
  strength: number
  fidelity: number
  folderId: number | null
}

/** 캐릭터 배치 좌표 (커스텀). charId → {x,y}. 이 큐/씬에서만 카드 기본 위치를 덮어씀 */
export type CharPositions = Record<number, { x: number; y: number }>

/** 씬 행위 역할 (커스텀) — 캐릭터에 지정하면 생성 시 씬의 하는쪽/당하는쪽 태그가
 *  그 캐릭터 프롬프트 뒤에 자동으로 합쳐진다. 카드는 외형만 갖고 있으면 됨 */
export type CharRole = 'source' | 'target'
/** charId → 역할 */
export type CharRoles = Record<number, CharRole>

/** 큐 반복 항목 (커스텀) — 캐릭터/레퍼런스 조합을 바꿔가며 반복 생성. 대기 항목
 *  재구성(생성 중 편집 반영)을 위해 요청에 스냅샷으로 실린다. */
export interface SequenceEntry {
  id: string
  name: string
  characterIds: number[]
  charRefIds: number[]
  vibeIds: number[]
  enabled: boolean
  useCoords?: boolean
  positions?: CharPositions
  /** 캐릭터별 행위 역할 (커스텀) — 씬의 하는쪽/당하는쪽 태그를 자동으로 얹는다 */
  roles?: CharRoles
  /** 미리 잡아둔 자리 (커스텀) — 캐릭터 없이 위치·인원부터 정해둘 때 */
  slots?: { x: number; y: number }[]
  /** 캐릭터 id → 자리 번호 */
  slotOf?: Record<number, number>
  /** 자리 번호 → 행위 역할 (그 자리에 꽂는 캐릭터가 물려받는다) */
  slotRoles?: Record<number, CharRole | null>
}

export interface GenerationRequest {
  prompt: string
  /** Optional NAIS2-style split prompt parts. prompt is still the merged send text. */
  promptParts?: PromptParts
  negativePrompt: string
  model: string
  width: number
  height: number
  steps: number
  cfgScale: number
  cfgRescale: number
  sampler: string
  noiseSchedule: string
  seed: number
  variety: boolean
  qualityToggle: boolean
  ucPreset: UcPresetIndex
  characterPrompts: CharacterPromptInput[]
  useCoords: boolean
  /** i2i/인페인트 강도·노이즈 (소스가 있을 때 사용) */
  i2iStrength?: number
  i2iNoise?: number
  /** i2i/인페인트 모드일 때만. 바이브/캐릭레퍼는 생성 시 메인이 DB에서 enabled 항목을 읽는다 */
  source?: SourceImage
  /** 씬 생성이면 씬 id (저장 시 images.scene_id 연결) */
  sceneId?: number
  /** 예약 후 씬 태그가 바뀌어도 실행 직전에 재병합하기 위한 예약 당시 기본 프롬프트 */
  sceneBasePrompt?: string
  sceneBaseNegativePrompt?: string
  /** 분할 프롬프트 사용 시 예약 당시 가변(additional) 원문 */
  sceneBaseAdditionalPrompt?: string
  /** 지정 시 enabled 대신 이 id들의 바이브를 사용 (빈 배열 = 바이브 미적용). 씬 큐 반복/씬별 추가용 */
  vibeIds?: number[]
  /** 지정 시 enabled 대신 이 id들의 캐릭레퍼를 사용 (빈 배열 = 미적용). 씬 큐 반복/씬별 추가용 */
  charRefIds?: number[]
  /** 이 요청을 만든 큐 반복 항목 스냅샷 (커스텀) — 대기 항목 재구성 시 동일 조합으로 복원. null=일반 */
  sceneSequenceEntry?: SequenceEntry | null
}

export interface PromptParts {
  base: string
  additional: string
  detail: string
}

/** 생성 당시 실제 참조한 파일 조각의 스냅샷 — 메타데이터 확인용 */
export interface FragmentPromptMetadata {
  /** 입력에 적힌 토큰 그대로. 예: <a1>, <*의상/casual> */
  token: string
  /** 정규화된 조각 경로 */
  path: string
  /** 프롬프트/네거티브/캐릭터 등 사용 위치 */
  location: string
  /** 이번 생성에서 선택되고 중첩 파일 조각까지 치환된 한 줄 */
  selected: string
  /** 생성 당시 조각이 가진 전체 유효 후보 줄 */
  content: string
}

export type QueueItemState = 'pending' | 'generating' | 'done' | 'failed' | 'cancelled'

/** 렌더러로 보내는 큐 요약 항목 (커스텀 — 성능). 수천 장 큐에서 프롬프트 등
 *  대형 request를 매 변경마다 IPC로 직렬화하면 장마다 렉이 걸린다.
 *  UI에 필요한 최소 필드만 보내고, 전체 request는 queue:pending으로 필요할 때만. */
export interface QueueItemLite {
  id: string
  state: QueueItemState
  sceneId?: number
  error?: string
  filePath?: string
}

export interface QueueStatusLite {
  items: QueueItemLite[]
  running: boolean
  delayMs: number
}

export interface QueueItem {
  id: string
  state: QueueItemState
  request: GenerationRequest
  error?: string
  /** 생성 완료 시 저장된 이미지 파일 경로 */
  filePath?: string
}

export interface QueueStatus {
  items: QueueItem[]
  running: boolean
  delayMs: number
}

/** 캐릭터 완전 백업 파일을 열었을 때의 미리보기 (커스텀) */
export interface CharacterBackupPreview {
  ok: boolean
  filePath?: string
  characters: number
  folders: number
  sceneLinks: number
  queueEntries: number
  /** 기존과 완전히 같아 건너뛸 카드 수 */
  identical: number
  hasThumbnails: boolean
}

/** 완전 백업 복원 결과 (커스텀) */
export interface CharacterImportResult {
  created: number
  skipped: number
  removed: number
  sceneLinks: number
  queueEntries: number
  /** 이름이 맞는 씬·프리셋을 못 찾아 버린 연결 */
  droppedLinks: number
}

/** 휴지통에 든 캐릭터 카드 (커스텀) */
export interface TrashedCharacter {
  id: number
  name: string
  prompt: string
  /** 삭제 시각 (UTC 'YYYY-MM-DD HH:MM:SS') */
  deletedAt: string
  /** 삭제 당시 속해 있던 폴더 이름 — 폴더째 지운 경우 어디 있었는지 알려준다 */
  folderName: string | null
}

/** 등록된 NAI 계정 (토큰 본문은 절대 렌더러로 내보내지 않는다) */
export interface NaiAccountInfo {
  id: string
  label: string
  /** 토큰 앞 4글자 — 식별용 */
  prefix: string
  active: boolean
}

export interface SubscriptionInfo {
  tier: 'paper' | 'tablet' | 'scroll' | 'opus'
  anlasFixed: number
  anlasPurchased: number
}

/** 캐릭터 카드 (단일 리스트 모델 — 카드가 직접 생성 포함 여부·위치를 가짐) */
export interface CharacterCard {
  id: number
  name: string
  prompt: string
  negativePrompt: string
  /** webp 썸네일 base64, 없으면 '' */
  thumbnail: string
  enabled: boolean
  center: { x: number; y: number }
  /**
   * 자리 번호 (커스텀). 씬에 잡아둔 N번 자리로 자동 배치된다.
   * null이면 번호 없음 — 씬별 명시 배정이나 역할 위치를 따른다.
   */
  slotNo?: number | null
  folderId: number | null
  /** 연결된 캐릭레퍼 id (커스텀) — 이 캐릭터가 생성에 포함되면 레퍼런스도 자동 적용 */
  charRefId: number | null
  /** 기본 행위 역할 (커스텀) — 씬별 추가/큐 항목에서 따로 지정하지 않으면 이 값을 따른다 */
  role: CharRole | null
}

/** 폴더 행 (캐릭터/조각 공용 리스트 모델) */
export interface ListFolder {
  id: number
  name: string
  collapsed: boolean
  /** 구분용 색 (hex). null = 기본 (틴트 없음) */
  color: string | null
  /**
   * 상위 폴더 id (커스텀 — 캐릭터 폴더만 사용). null = 최상위.
   * 깊이는 2단계까지: 하위 폴더는 다시 하위를 가질 수 없다.
   */
  parentId?: number | null
}
export type CharacterFolder = ListFolder

/** 폴더 색 프리셋 — 한눈에 구분되는 선명한 색 */
export const FOLDER_COLORS = [
  '#ef4444', // red
  '#f97316', // orange
  '#eab308', // yellow
  '#22c55e', // green
  '#06b6d4', // cyan
  '#3b82f6', // blue
  '#a855f7', // purple
  '#ec4899' // pink
] as const

export type CharacterCardPatch = Partial<
  Pick<
    CharacterCard,
    | 'name'
    | 'prompt'
    | 'negativePrompt'
    | 'enabled'
    | 'center'
    | 'charRefId'
    | 'role'
    | 'slotNo'
  >
>

/** 리스트 전체 순서 (폴더 행 + 카드 행). 카드의 폴더 소속은 이 순서에서 파생된다 */
export type CharacterOrderEntry = { type: 'folder' | 'char'; id: number }

/** 조각 프롬프트 — content는 줄 단위 와일드카드 (빈 줄·# 주석은 치환 시 제외) */
export interface Fragment {
  id: number
  name: string
  content: string
  folderId: number | null
}

export interface HistoryItem {
  id: number
  filePath: string
  /** webp 썸네일 base64 (data URL 프리픽스 없음) */
  thumbnail: string
  kind: string
  seed: number | null
  createdAt: string
}

/** 디렉터 툴 (augment-image req_type) */
export type DirectorMethod =
  | 'bg-removal'
  | 'lineart'
  | 'sketch'
  | 'colorize'
  | 'emotion'
  | 'declutter'
  | 'declutter-keep-bubbles'

/** 표정 변경 감정 목록 (웹 번들 확정) */
export const EMOTIONS = [
  'neutral',
  'happy',
  'sad',
  'angry',
  'scared',
  'surprised',
  'shy',
  'disgusted',
  'smug',
  'bored',
  'laughing',
  'irritated',
  'aroused',
  'embarrassed',
  'worried',
  'love',
  'determined',
  'hurt',
  'playful'
] as const

/** NAI PNG에서 읽은 이미지 메타데이터 (정규화) */
export interface ImageMetadata {
  prompt: string
  promptParts?: PromptParts & { negative?: string; inpainting?: string }
  fragmentPrompts?: FragmentPromptMetadata[]
  negativePrompt: string
  seed?: number
  steps?: number
  cfgScale?: number
  cfgRescale?: number
  sampler?: string
  noiseSchedule?: string
  width?: number
  height?: number
  /** Source 청크 (모델명 등, 표시용) */
  model?: string
  software?: string
  variety?: boolean
  useCoords?: boolean
  /** 병합 최종본 기준 — 있으면 적용 시 프롬프트/네거티브에서 프리셋을 벗겨 재병합 */
  qualityToggle?: boolean
  ucPreset?: number
  characterPrompts?: { prompt: string; negativePrompt: string; center?: { x: number; y: number } }[]
}

/** 씬 프리셋 (씬들의 그룹) */
export interface ScenePreset {
  id: number
  name: string
  /** 새 씬 기본 해상도 (null = 832×1216) */
  defaultWidth: number | null
  defaultHeight: number | null
  /** 이 프리셋의 씬 개수 (커스텀 — 드롭다운 표시용). listPresets에서만 채워짐 */
  sceneCount?: number
}

/** 프리셋에 함께 저장되는 생성 파라미터 (시드·캐릭터는 제외).
 *  promptParts: 3분할(고정/가변/디테일)도 프리셋마다 저장/복원 (커스텀) — params_json에 함께 실림 */
export type PresetParams = Partial<
  Pick<
    GenerationRequest,
    | 'model'
    | 'width'
    | 'height'
    | 'steps'
    | 'cfgScale'
    | 'cfgRescale'
    | 'sampler'
    | 'noiseSchedule'
    | 'variety'
    | 'qualityToggle'
    | 'ucPreset'
    | 'promptParts'
  >
>

/** 프롬프트 프리셋 (기본 프롬프트+네거티브+파라미터 저장) */
export interface PromptPreset {
  id: number
  name: string
  prompt: string
  negativePrompt: string
  /** 스텝·CFG 등 — 프리셋 전환 시 함께 복원 (구버전 프리셋은 null) */
  params: PresetParams | null
}

/** 씬 (미리 저장한 프롬프트+해상도. 예약 수만큼 생성) */
export interface Scene {
  id: number
  presetId: number
  name: string
  prompt: string
  negativePrompt: string
  width: number
  height: number
  /** 예약 수 (예약→생성 워크플로. +/-로 조정) */
  reserveCount: number
  /** 씬별 variety+ 강제 적용 (커스텀. false = 메인 설정 따름) */
  varietyPlus: boolean
  /** 하는쪽 행위 태그 (커스텀) — 역할이 '하는쪽'인 캐릭터 프롬프트 뒤에 합쳐짐 */
  sourceTags: string
  /** 당하는쪽 행위 태그 (커스텀) — 역할이 '당하는쪽'인 캐릭터 프롬프트 뒤에 합쳐짐 */
  targetTags: string
  /** 이 씬에서 하는쪽 역할의 배치 좌표 (커스텀) — 캐릭터가 누구든 역할 기준으로 적용. null=지정 안 함 */
  sourcePos: { x: number; y: number } | null
  /** 이 씬에서 당하는쪽 역할의 배치 좌표 (커스텀) */
  targetPos: { x: number; y: number } | null
  /** 내보내기 번호 (커스텀) — 지정 시 내보내는 파일명이 "01" 등 번호가 됨. null = 씬 이름 사용 */
  exportNo: number | null
  /** 목록 카드용: 최신 생성 이미지 썸네일 (없으면 '') */
  thumbnail: string
  /** 최신 생성 이미지의 원본 파일 경로 (카드에 풀해상도로 선명하게 표시. 없으면 '') */
  thumbnailPath: string
  /** 이 씬으로 생성된 이미지 수 */
  imageCount: number
}

/** 씬 상세의 생성 이미지 (페이지네이션 단위) */
export interface SceneImage {
  id: number
  filePath: string
  thumbnail: string
  seed: number | null
  favorite: boolean
}

/** 이미지 라이브러리 항목 (NAIS2 Library 이식) — 참고 이미지 모음 */
export interface LibraryImage {
  id: number
  name: string
  filePath: string
  /** webp 썸네일 base64 (data URL 프리픽스 없음) */
  thumbnail: string
  width: number
  height: number
  createdAt: string
}

/** IPC invoke 채널 계약: 채널명 → (요청, 응답) */
export interface IpcInvokeMap {
  'db:status': { req: void; res: { version: number; path: string } }
  /** 앱 버전 */
  'app:version': { req: void; res: { version: string } }
  /** 데이터 폴더(userData) 탐색기로 열기 (커스텀) */
  'app:openDataFolder': { req: void; res: void }
  'nai:verifyToken': {
    req: { token: string }
    res: { valid: boolean; subscription?: SubscriptionInfo; error?: string }
  }
  'nai:setToken': {
    req: { token: string }
    res: { valid: boolean; subscription?: SubscriptionInfo; error?: string }
  }
  'nai:tokenStatus': { req: void; res: { hasToken: boolean; prefix: string; length: number } }
  'nai:revealToken': { req: void; res: { token: string | null } }
  'nai:deleteToken': { req: void; res: void }
  /** 잔액 조회 (스냅샷 로그에도 기록) */
  'nai:balance': {
    req: void
    res: { anlas: number | null; tier: string | null; opusUsage: OpusUsage | null }
  }
  'nai:anlasUsage': { req: void; res: { today: number; week: number } }
  /** NAI 계정 여러 개 (커스텀) — 한도 소진 시 갈아타기용 */
  /** 캐릭터 휴지통 (커스텀) — 폴더째 삭제해도 되살릴 수 있게 */
  'chars:trash': { req: void; res: { items: TrashedCharacter[] } }
  'chars:restore': { req: { ids: number[] }; res: void }
  'chars:purge': { req: { ids: number[] }; res: void }
  /** 폴더 + 안의 카드 삭제(소프트). 되살리기용으로 폴더·카드 id를 돌려준다 */
  'chars:folderDeleteWithItems': {
    req: { id: number }
    res: { folderIds: number[]; cardIds: number[] }
  }
  /** 폴더째 삭제를 통째로 되돌리기 — 폴더가 이름·색·순서·중첩 그대로 돌아온다 */
  'chars:folderRestore': { req: { folderIds: number[]; cardIds: number[] }; res: void }
  /** 여러 카드 한 번에 삭제 (다중 선택) */
  'chars:deleteMany': { req: { ids: number[] }; res: void }
  /** 폴더를 다른 폴더 안으로 넣거나(parentId) 밖으로 빼기(null). 2단계까지만 */
  'chars:folderSetParent': { req: { id: number; parentId: number | null }; res: { ok: boolean } }
  /** 캐릭터 내보내기/가져오기 (커스텀) — folderId가 없으면 전체 */
  'chars:exportJson': { req: { folderId?: number | null }; res: { saved: boolean; count: number } }
  /** 완전 백업 (커스텀) — 폴더·역할·좌표·레퍼런스 연결·씬별 추가·큐 반복까지 */
  'chars:exportBackup': {
    req: { includeThumbnails?: boolean }
    res: { saved: boolean; count: number }
  }
  /** 백업 파일을 골라 무엇이 들어올지 미리 보여준다 (실제 반영 전) */
  'chars:pickBackup': { req: void; res: CharacterBackupPreview }
  'chars:importBackup': {
    req: { filePath: string; mode: 'skip-identical' | 'always-copy' | 'replace-all' }
    res: CharacterImportResult
  }
  'chars:importJson': { req: { folderId?: number | null }; res: { imported: number } }
  'accounts:list': { req: void; res: { accounts: NaiAccountInfo[] } }
  'accounts:add': { req: { label: string; token: string }; res: { accounts: NaiAccountInfo[] } }
  'accounts:rename': { req: { id: string; label: string }; res: { accounts: NaiAccountInfo[] } }
  'accounts:remove': { req: { id: string }; res: { accounts: NaiAccountInfo[] } }
  'accounts:setActive': { req: { id: string }; res: { accounts: NaiAccountInfo[] } }
  'queue:enqueue': { req: { request: GenerationRequest; count: number }; res: { ids: string[] } }
  /** 여러 요청 원자적 일괄 등록 (씬 예약/큐 반복용 — 취소 누락 방지) */
  'queue:enqueueMany': { req: { requests: GenerationRequest[] }; res: { ids: string[] } }
  /** 우선 등록 (커스텀) — 생성 중인 항목 바로 다음에 끼워넣어 다음 차례로 */
  'queue:enqueueNext': { req: { requests: GenerationRequest[] }; res: { ids: string[] } }
  'queue:cancel': { req: { ids: string[] }; res: void }
  /** 대기(pending) 항목의 요청을 최신값으로 교체 (커스텀 — 생성 중 편집 반영) */
  'queue:updatePending': {
    req: { updates: { id: string; request: GenerationRequest }[] }
    res: void
  }
  /** 대기 항목의 전체 request (커스텀 — 재구성용). 요약 브로드캐스트엔 없는 상세를 필요할 때만 */
  'queue:pending': { req: void; res: { items: { id: string; request: GenerationRequest }[] } }
  'queue:status': { req: void; res: QueueStatusLite }
  'images:list': {
    req: { limit: number; offset: number }
    res: { items: HistoryItem[]; total: number }
  }
  'images:payload': { req: { id: number }; res: { payloadJson: string | null } }
  'settings:get': { req: { key: string }; res: { value: string | null } }
  'settings:set': { req: { key: string; value: string }; res: void }
  'window:control': { req: { action: 'minimize' | 'maximize' | 'close' }; res: void }
  /** 리사이즈 시 노출되는 네이티브 창 배경색 (테마 전환 시 갱신) */
  'window:setBackground': { req: { color: string }; res: void }
  'chars:list': { req: void; res: { folders: CharacterFolder[]; items: CharacterCard[] } }
  'chars:create': { req: { name: string; folderId: number | null }; res: { id: number } }
  'chars:update': { req: { id: number; patch: CharacterCardPatch }; res: void }
  'chars:delete': { req: { id: number }; res: void }
  'chars:duplicate': { req: { id: number }; res: { id: number } }
  /** 네이티브 파일 선택 → sharp 리사이즈 → BLOB 저장. 취소 시 thumbnail null */
  'chars:pickThumbnail': { req: { id: number }; res: { thumbnail: string | null } }
  'chars:clearThumbnail': { req: { id: number }; res: void }
  'chars:reorder': { req: { order: CharacterOrderEntry[] }; res: void }
  'chars:folderCreate': { req: { name: string }; res: { id: number } }
  'chars:folderRename': { req: { id: number; name: string }; res: void }
  'chars:folderCollapse': { req: { id: number; collapsed: boolean }; res: void }
  'chars:folderColor': { req: { id: number; color: string | null }; res: void }
  /** 폴더 삭제 — 소속 카드는 미분류로 이동 */
  'chars:folderDelete': { req: { id: number }; res: void }
  'frags:list': { req: void; res: { folders: ListFolder[]; items: Fragment[] } }
  'frags:create': { req: { name: string; folderId: number | null }; res: { id: number } }
  'frags:update': {
    req: { id: number; patch: { name?: string; content?: string } }
    res: void
  }
  'frags:delete': { req: { id: number }; res: void }
  'frags:duplicate': { req: { id: number }; res: { id: number | null } }
  'frags:importTxt': { req: void; res: { count: number } }
  'frags:exportTxt': { req: { id: number }; res: { saved: boolean } }
  /** 조각 전체를 ZIP으로 내보내기 (공유/백업) */
  'frags:exportAll': { req: void; res: { count: number } }
  /** 순차 선택(<*이름>) 카운터 전체 리셋 — 다시 처음 줄부터 (NAIS2 기능) */
  'frags:resetSequential': { req: void; res: void }
  'frags:reorder': { req: { order: CharacterOrderEntry[] }; res: void }
  'frags:folderCreate': { req: { name: string }; res: { id: number } }
  'frags:folderRename': { req: { id: number; name: string }; res: void }
  'frags:folderCollapse': { req: { id: number; collapsed: boolean }; res: void }
  'frags:folderColor': { req: { id: number; color: string | null }; res: void }
  'frags:folderDelete': { req: { id: number }; res: void }
  'tags:search': {
    req: { query: string; limit?: number }
    res: {
      items: {
        tag: string
        count: number
        type: string
        ko?: string
        /** 단보루 위키 영어 설명 (커스텀) */
        desc?: string
        /** 사용자가 직접 단 한글 뜻 */
        userKo?: boolean
      }[]
    }
  }
  /** 사용자 한글 뜻 달기 (커스텀) — 빈 문자열이면 지운다 */
  'tags:setKo': { req: { tag: string; ko: string }; res: void }
  'tags:listUserKo': { req: void; res: { entries: Record<string, string> } }
  'tags:lookup': {
    req: { tags: string[] }
    res: { items: { tag: string; count: number; type: string; ko?: string }[] }
  }
  /** T5 토큰 카운트 (V4.5 한도 512, EOS 포함 — NAI 웹과 동일 방식) */
  'tokens:count': { req: { texts: string[] }; res: { counts: number[] } }
  /** 히스토리 이미지를 i2i/인페인트 소스로 읽기 */
  'images:readForSource': {
    req: { filePath: string }
    res: { base64: string; width: number; height: number } | { error: string }
  }
  /** 파일 탐색기에서 해당 파일 위치 열기 (파일 선택 상태로) */
  'images:showInFolder': { req: { filePath: string }; res: void }
  /** OS 네이티브 드래그 시작 — 이미지를 앱 밖(탐색기 등)으로 끌어 저장 (NAIS2 기능).
   *  toWeb=true면 창 통과를 끄고 드래그 → 내장 브라우저(webview) 업로드 칸에 바로 드롭 */
  'images:startDrag': { req: { filePath: string; toWeb?: boolean }; res: void }
  /** 다른 이름으로 저장 — 파일 저장 다이얼로그로 복사 */
  'images:saveAs': { req: { filePath: string }; res: { saved: boolean } }
  /** 이미지를 클립보드로 복사 */
  'images:copy': { req: { filePath: string }; res: { copied: boolean } }
  /** 저장 폴더: 현재 경로 조회 / 폴더 선택 / 기본값으로 초기화 */
  /** target 생략 = main(메인 모드). 'scene' = 씬 모드 저장 폴더 */
  'settings:getSaveDir': {
    req: { target?: 'main' | 'scene' } | void
    res: { dir: string; isDefault: boolean }
  }
  'settings:pickSaveDir': { req: { target?: 'main' | 'scene' } | void; res: { dir: string | null } }
  'settings:resetSaveDir': { req: { target?: 'main' | 'scene' } | void; res: { dir: string } }
  /** 생성 지연 시간(ms) 설정 — 큐에 즉시 반영 + 영속 */
  'gen:setDelay': { req: { ms: number }; res: void }
  /** 디렉터 툴 실행 — 결과를 히스토리에 저장하고 파일 경로 + 결과 base64 반환 */
  'director:run': {
    req: { method: DirectorMethod; imageBase64: string; prompt?: string; defry?: number }
    res: { filePath: string; base64: string } | { error: string }
  }
  /** 업스케일 (2x/4x) — 결과를 히스토리에 저장하고 파일 경로 + 결과 base64 반환 */
  'images:upscale': {
    req: { imageBase64: string; scale: number }
    res: { filePath: string; base64: string } | { error: string }
  }
  /** 이미지 메타데이터 읽기 (filePath는 우리 파일, base64는 외부 드롭). PNG tEXt→DB→stealth */
  'images:readMetadata': {
    req: { filePath?: string; base64?: string }
    res: { meta: ImageMetadata } | { error: string }
  }
  'scenePresets:list': { req: void; res: { items: ScenePreset[] } }
  'scenePresets:create': { req: { name: string }; res: { id: number } }
  'scenePresets:rename': { req: { id: number; name: string }; res: void }
  'scenePresets:delete': { req: { id: number }; res: void }
  'scenePresets:reorder': { req: { ids: number[] }; res: void }
  /** 프리셋의 새 씬 기본 해상도 (N3) */
  'scenePresets:setDefaultResolution': {
    req: { id: number; width: number; height: number }
    res: void
  }
  'promptPresets:reorder': { req: { ids: number[] }; res: void }
  'promptPresets:list': { req: void; res: { items: PromptPreset[] } }
  'promptPresets:create': {
    req: { name: string; prompt: string; negativePrompt: string; params?: PresetParams }
    res: { id: number }
  }
  'promptPresets:update': {
    req: {
      id: number
      patch: Partial<Pick<PromptPreset, 'name' | 'prompt' | 'negativePrompt' | 'params'>>
    }
    res: void
  }
  'promptPresets:delete': { req: { id: number }; res: void }
  /** 업데이트 다운로드 시작 (완료 시 자동 설치/재시작) */
  'update:start': { req: void; res: void }
  /** 지금 업데이트 확인 (커스텀 — 정보 화면 열 때 실시간 재확인). 결과는 update:status 이벤트로 */
  'update:check': { req: void; res: void }
  /** 전체 데이터 JSON 내보내기 (저장 다이얼로그).
   *  includeSecrets=true면 NAI 토큰·클플 인증을 평문으로 포함 (내보내기 전 반드시 물어볼 것, 커스텀) */
  'backup:export': { req: { includeSecrets?: boolean }; res: { saved: boolean } }
  /** DB 백업 폴더 열기 (커스텀 — 자동 스냅샷 보관소) */
  'backup:openFolder': { req: void; res: void }
  /** 지금 즉시 DB 백업 스냅샷 생성 (커스텀) */
  'backup:now': { req: void; res: { path: string } }
  /** 백업 폴더 현황 — 개수/총 용량 (커스텀, 설정 UI 표시용) */
  'backup:info': { req: void; res: { dir: string; count: number; totalBytes: number } }
  /** 웹 모드 프록시 설정 (커스텀 — 단보루 등 우회). rules 빈 문자열이면 직접 연결 */
  'web:setProxy': { req: { rules: string }; res: { ok: boolean } }
  /** JSON 가져오기 (열기 다이얼로그). NAIS3/NAIS2 포맷 자동 감지. summary=사람이 읽는 결과 */
  'backup:import': {
    req: void
    res: { summary: string; needsPromptReload: boolean } | { error: string } | { canceled: true }
  }
  /** 특정 프리셋의 씬 목록 */
  'scenes:list': { req: { presetId: number }; res: { items: Scene[] } }
  /** 휴지통(소프트삭제) 씬 목록 (커스텀 — 복원용) */
  'scenes:trash': {
    req: void
    res: { items: (Scene & { deletedAt: string; presetName: string })[] }
  }
  /** 휴지통 씬 복원 */
  'scenes:restore': { req: { ids: number[] }; res: void }
  /** 휴지통 씬 영구 삭제 (파일은 OS 휴지통으로) */
  'scenes:purge': { req: { ids: number[] }; res: void }
  'scenes:create': { req: { presetId: number; name: string }; res: { id: number } }
  'scenes:get': { req: { id: number }; res: { scene: Scene | null } }
  'scenes:update': {
    req: {
      id: number
      patch: Partial<
        Pick<
          Scene,
          | 'name'
          | 'prompt'
          | 'negativePrompt'
          | 'width'
          | 'height'
          | 'reserveCount'
          | 'varietyPlus'
          | 'sourceTags'
          | 'targetTags'
          | 'sourcePos'
          | 'targetPos'
          | 'exportNo'
        >
      >
    }
    res: void
  }
  /** 씬 내보내기 번호 일괄 부여 (커스텀) — ids 순서대로 start부터 순번. start=null이면 번호 제거 */
  'scenes:assignExportNumbers': { req: { ids: number[]; start: number | null }; res: void }
  'scenes:duplicate': { req: { id: number }; res: { id: number } }
  /** 모듈(프리셋) 복제 — 안의 씬 전부 포함 (커스텀) */
  'scenes:duplicatePreset': { req: { id: number }; res: { id: number } }
  /** 씬들을 다른 프리셋으로 복사 — 원본 유지 (커스텀, bulkMove=잘라내기와 짝) */
  /** 다른 프리셋으로 복사 — 새로 만든 씬 id들을 (넘긴 순서대로) 함께 반환 */
  'scenes:bulkCopy': {
    req: { ids: number[]; presetId: number }
    res: { copied: number; ids: number[] }
  }
  'scenes:delete': { req: { id: number }; res: void }
  'scenes:reorder': { req: { ids: number[] }; res: void }
  /** 예약: 전체 취소(count=0 등 절대값 설정) */
  'scenes:setReserveAll': { req: { presetId: number; count: number }; res: void }
  /** 예약: 전체 씬 예약 수를 delta만큼 증감 (최소 0) */
  'scenes:adjustReserveAll': { req: { presetId: number; delta: number }; res: void }
  /** 편집 모드 일괄 작업 (선택 씬 대상) */
  'scenes:bulkMove': { req: { ids: number[]; presetId: number }; res: void }
  'scenes:bulkDelete': { req: { ids: number[] }; res: void }
  'scenes:bulkSetResolution': { req: { ids: number[]; width: number; height: number }; res: void }
  'scenes:bulkClearFavorites': { req: { ids: number[] }; res: void }
  'scenes:bulkClearImages': {
    req: { ids: number[]; keepFavorites?: boolean }
    res: { deleted: number; ids: number[] }
  }
  /** 소프트삭제된 이미지 복원 (실행취소, 커스텀) */
  'scenes:restoreImages': { req: { ids: number[] }; res: void }
  'scenes:bulkExportZip': { req: { ids: number[] }; res: { count: number } }
  /** 씬 상세 이미지 페이지네이션 (수만 장 대비) */
  'scenes:images': {
    req: { sceneId: number; limit: number; offset: number; favoritesOnly?: boolean }
    res: { items: SceneImage[]; total: number }
  }
  /** 씬의 즐겨찾기 제외 전체 소프트삭제 — 반환에 복원용 이미지 id 포함 */
  'scenes:deleteNonFavorites': { req: { sceneId: number }; res: { deleted: number; ids: number[] } }
  'images:setFavorite': { req: { id: number; favorite: boolean }; res: void }
  /** 이미지 삭제 — deleteFile=true면 파일까지(씬 상세), 아니면 기록만(히스토리, 파일 보존) */
  'images:delete': { req: { id: number; deleteFile?: boolean }; res: void }
  /** 히스토리 전체 비우기 (레코드+파일, 씬 이미지 포함) */
  'images:clearAll': { req: void; res: { count: number } }
  /** 씬 이미지 폴더 열기 (NAIS3_scene/<프리셋>/<씬>) */
  'scenes:openFolder': { req: { sceneId: number }; res: { ok: boolean } }
  /** 씬 JSON 내보내기/불러오기 (파일 다이얼로그, 활성 프리셋 기준) */
  'scenes:exportJson': { req: { presetId: number }; res: { saved: boolean } }
  /** 불러오기 — 씬에 캐릭터탭(characters/sharedCharacters)이 실려 있으면 카드로 만들고
   *  additions로 돌려줘 렌더러가 "씬별 캐릭터 추가"에 연결한다. roles = 행위 역할 (커스텀) */
  'scenes:importJson': {
    req: { presetId: number }
    res: {
      count: number
      additions: { sceneId: number; characterIds: number[]; roles?: CharRoles }[]
    }
  }
  /** 즐겨찾기 이미지 또는 각 씬 최상단 이미지를 ZIP으로 (파일 다이얼로그) */
  'scenes:exportZip': { req: { mode: 'favorites' | 'sceneTop' }; res: { count: number } }
  /** 이미지를 폴더로 그대로 복사 (커스텀). scope=씬 ids 또는 즐겨찾기/각 씬 최상단.
   *  policy 미지정+충돌 시 conflicts 반환 */
  'scenes:exportToFolder': {
    req: {
      ids?: number[]
      mode?: 'favorites' | 'sceneTop'
      /** ids와 함께: 해당 씬들의 즐겨찾기 이미지만 (커스텀) */
      favoritesOnly?: boolean
      dir?: string
      policy?: 'overwrite' | 'rename' | 'skip'
    }
    res: {
      canceled?: true
      dir?: string
      conflicts?: { name: string; existingThumb: string; incomingThumb: string }[]
      total?: number
      copied?: number
      skipped?: number
    }
  }
  'vibes:list': { req: void; res: { folders: ListFolder[]; items: VibeItem[] } }
  /** 파일 다이얼로그(다중)로 추가 */
  'vibes:add': { req: { folderId: number | null }; res: { count: number } }
  'vibes:update': {
    req: {
      id: number
      patch: Partial<Pick<VibeItem, 'name' | 'enabled' | 'strength' | 'infoExtracted'>>
    }
    res: void
  }
  'vibes:delete': { req: { id: number }; res: void }
  'vibes:reorder': { req: { order: CharacterOrderEntry[] }; res: void }
  'vibes:folderCreate': { req: { name: string }; res: { id: number } }
  'vibes:folderRename': { req: { id: number; name: string }; res: void }
  'vibes:folderCollapse': { req: { id: number; collapsed: boolean }; res: void }
  'vibes:folderColor': { req: { id: number; color: string | null }; res: void }
  'vibes:folderDelete': { req: { id: number }; res: void }
  /** 이미지 라이브러리 (NAIS2 Library 이식) */
  'library:list': { req: void; res: { items: LibraryImage[] } }
  'library:add': { req: void; res: { count: number } }
  'library:addFromPaths': { req: { paths: string[] }; res: { count: number } }
  'library:rename': { req: { id: number; name: string }; res: void }
  'library:delete': { req: { ids: number[] }; res: void }
  'library:reorder': { req: { ids: number[] }; res: void }
  /** 스타일(작가) 태그 분석 — Kaloscope HF Space (NAIS2 스마트 도구 이식) */
  'tools:analyzeStyle': {
    req: { filePath?: string; base64?: string }
    res: { tags: { label: string; score: number }[] } | { error: string }
  }
  'crefs:list': { req: void; res: { folders: ListFolder[]; items: CharRefItem[] } }
  'crefs:add': { req: { folderId: number | null }; res: { count: number } }
  'crefs:update': {
    req: {
      id: number
      patch: Partial<Pick<CharRefItem, 'name' | 'enabled' | 'refType' | 'strength' | 'fidelity'>>
    }
    res: void
  }
  'crefs:delete': { req: { id: number }; res: void }
  'crefs:reorder': { req: { order: CharacterOrderEntry[] }; res: void }
  'crefs:folderCreate': { req: { name: string }; res: { id: number } }
  'crefs:folderRename': { req: { id: number; name: string }; res: void }
  'crefs:folderCollapse': { req: { id: number; collapsed: boolean }; res: void }
  'crefs:folderColor': { req: { id: number; color: string | null }; res: void }
  'crefs:folderDelete': { req: { id: number }; res: void }
  // ── Cloudflare R2 업로드 (커스텀) — 인증은 safeStorage 암호화, 로컬 저장만 ──
  /** 검증(버킷 목록 호출) 성공 시에만 저장 */
  'r2:setAuth': {
    req: { accountId: string; accessKeyId: string; secretAccessKey: string }
    res: { ok: boolean; error?: string }
  }
  'r2:authStatus': { req: void; res: { connected: boolean; accountId: string } }
  'r2:deleteAuth': { req: void; res: void }
  /** R2 API 토큰 발급 페이지를 기본 브라우저로 */
  'r2:openTokenPage': { req: void; res: void }
  'r2:listBuckets': { req: void; res: { buckets: string[] } }
  /** prefix 하위 폴더(CommonPrefixes)와 객체 목록 (1000개 페이지네이션 전부) */
  'r2:list': {
    req: { bucket: string; prefix: string }
    res: { folders: string[]; objects: R2Object[] }
  }
  'r2:createFolder': { req: { bucket: string; prefix: string; name: string }; res: void }
  /** 파일/폴더 선택 다이얼로그 → 업로드 큐에 추가 (폴더는 재귀, 개수 제한 없음) */
  'r2:pickUpload': {
    req: { bucket: string; prefix: string; kind: 'files' | 'folder' }
    res: { queued: number }
  }
  /** 드래그 앤 드롭된 경로들을 업로드 큐에 추가 */
  'r2:uploadPaths': {
    req: { bucket: string; prefix: string; paths: string[] }
    res: { queued: number }
  }
  'r2:uploadStatus': { req: void; res: R2UploadStatus }
  'r2sync:getConfig': { req: { presetId: number }; res: R2SyncConfig }
  'r2sync:setConfig': { req: { presetId: number; config: R2SyncConfig }; res: void }
  'r2sync:run': { req: { presetId: number }; res: R2SyncStatus }
  'r2sync:status': { req: { presetId: number }; res: R2SyncStatus }
  'r2sync:resolveConflicts': {
    req: { presetId: number; choice: 'overwrite' | 'skip'; remember: boolean }
    res: R2SyncStatus
  }
  'r2:retryFailed': { req: void; res: { queued: number } }
  'r2:cancelUpload': { req: void; res: void }
  'r2:clearUploadHistory': { req: void; res: void }
}

/** Automatic R2 synchronization settings, stored independently for each scene preset. */
export interface R2SyncConfig {
  enabled: boolean
  bucket: string
  /** Target folder with a trailing slash, or an empty string for the bucket root. */
  prefix: string
  deleteOnUnfavorite: boolean
  conflictPolicy: 'ask' | 'overwrite' | 'skip'
}

export interface R2SyncStatus {
  presetId: number
  running: boolean
  conflicts: string[]
  last: {
    uploaded: number
    renamed: number
    deleted: number
    skipped: number
    errors: string[]
    at: string
  } | null
}

/** R2 객체 (표시용) */
export interface R2Object {
  key: string
  size: number
  lastModified: string
}

/** R2 업로드 큐 상태 (커스텀) */
export interface R2UploadStatus {
  running: boolean
  bucket: string
  total: number
  done: number
  failedCount: number
  /** 실패 항목 (표시 상한 200) — 재시도 대상 */
  failed: { name: string; key: string; error: string }[]
  currentName: string
}

/** 메인 → 렌더러 이벤트 채널 */
export interface IpcEventMap {
  'queue:changed': QueueStatusLite
  /** 생성 완료 등으로 잔액이 갱신될 때 */
  'anlas:balance': { anlas: number; opusUsage: OpusUsage | null }
  /** 한도가 바닥나 다른 계정으로 갈아탔을 때 (커스텀) */
  'accounts:switched': { label: string }
  /** 등록한 계정이 전부 한도를 소진했을 때 — 이후 생성은 Anlas가 나간다 */
  'accounts:allExhausted': void
  'generation:progress': {
    id: string
    stepIx: number
    totalSteps: number
    /** 중간 미리보기 PNG base64 (없을 수 있음) */
    previewPng?: string
  }
  /** 씬에 새 이미지가 생성됨 (목록/상세 갱신). filePath로 카드 즉시 낙관적 갱신 */
  'scenes:changed': { sceneId: number; filePath: string }
  /** 바이브 인코딩 완료 — 카드의 인코딩 표시 갱신용 */
  'vibes:encoded': Record<string, never>
  /** 자동 업데이트 상태 (GitHub release) */
  'update:status': {
    state: 'checking' | 'available' | 'none' | 'downloading' | 'downloaded' | 'error'
    version?: string
    percent?: number
    message?: string
  }
  /** R2 업로드 진행 상황 (커스텀) */
  'r2:progress': R2UploadStatus
  'r2sync:status': R2SyncStatus
}
