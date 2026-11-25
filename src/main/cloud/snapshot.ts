import { createHash } from 'crypto'
import type {
  CloudCharacterLite,
  CloudFolderLite,
  CloudLibrary,
  CloudMainParams,
  CloudNaiInfo,
  CloudPresetLite,
  CloudQueueSummary,
  CloudSceneLite
} from '../../shared/cloud-contract'
import { requestForPromptMode } from '../../shared/prompt-state'
import type {
  Fragment,
  GenerationRequest,
  ListFolder,
  QueueStatusLite,
  Scene,
  ScenePreset
} from '../../shared/types'
import type { Outfit } from '../../shared/outfit'

/**
 * 클라우드 동기화용 스냅샷 (커스텀) — DB 내용을 CloudLibrary·씬 목록·조각 표로 바꾸고 해시를 낸다.
 * 이 파일은 순수 함수만 둔다(electron·DB 의존 없음). DB 읽기는 index.ts 의 연결 코드가 맡는다.
 */

// ── 해시 ────────────────────────────────────────────────────────────

/** 키를 정렬해 늘 같은 글자열이 나오는 JSON. undefined 값은 JSON.stringify 처럼 뺀다 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`
  const record = value as Record<string, unknown>
  const parts: string[] = []
  for (const key of Object.keys(record).sort()) {
    const v = record[key]
    if (v === undefined || typeof v === 'function') continue
    parts.push(`${JSON.stringify(key)}:${stableStringify(v)}`)
  }
  return `{${parts.join(',')}}`
}

export function sha1Hex(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

/** 안정 정렬 JSON 의 SHA-1 */
export function hashValue(value: unknown): string {
  return sha1Hex(stableStringify(value))
}

// ── 변환 ────────────────────────────────────────────────────────────

/**
 * 씬 한 장 → 폰/클라우드용. 기본값과 같은 선택 필드는 싣지 않는다(정규화 결과가 같다).
 * 그림 수(imageCount)는 싣지 않는다 — 그림이 저장될 때마다 바뀌어 프리셋 해시를 흔들고,
 * 그러면 씬 전체를 다시 올리게 된다. 그림 수는 sceneCountsOf 로 따로 올린다.
 */
export function toCloudScene(scene: Scene, sortOrder: number): CloudSceneLite {
  const out: CloudSceneLite = {
    id: scene.id,
    presetId: scene.presetId,
    kind: scene.kind ?? 'scene',
    name: scene.name,
    prompt: scene.prompt,
    negativePrompt: scene.negativePrompt,
    width: scene.width,
    height: scene.height,
    reserveCount: scene.reserveCount,
    sortOrder,
    sourceTags: scene.sourceTags,
    targetTags: scene.targetTags,
    exportNo: scene.exportNo
  }
  const bg = scene.background
  if (bg && (bg.prompt || bg.placement !== 'after-scene' || bg.replaceSimple)) out.background = bg
  if (scene.censorKinds && scene.censorKinds.length > 0) out.censorKinds = scene.censorKinds
  if (scene.censorTagWeights && Object.keys(scene.censorTagWeights).length > 0) {
    out.censorTagWeights = scene.censorTagWeights
  }
  if (scene.suppressAnal === true) out.suppressAnal = true
  return out
}

/** 씬 id(글자열) → 그림 수 — PUT /api/pc/scene-counts 본문. 그림이 없는 씬도 0 으로 싣는다 */
export function sceneCountsOf(scenes: Pick<Scene, 'id' | 'imageCount'>[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const scene of scenes) counts[String(scene.id)] = scene.imageCount
  return counts
}

/** 캐릭터 카드에서 클라우드가 쓰는 필드만 (CharacterCard 가 그대로 들어간다 — 썸네일은 없어도 된다) */
export interface CharacterInput {
  id: number
  name: string
  prompt: string
  negativePrompt: string
  enabled: boolean
  folderId: number | null
  role: 'source' | 'target' | null
  outfitId: number | null
}

export interface CharFolderInput {
  id: number
  name: string
  parentId?: number | null
}

/** 캐릭터 카드 → 클라우드용. 썸네일·좌표·상대 태그는 싣지 않는다 */
export function toCloudCharacter(card: CharacterInput, sortOrder: number): CloudCharacterLite {
  return {
    id: card.id,
    name: card.name,
    folderId: card.folderId,
    enabled: card.enabled,
    prompt: card.prompt,
    negativePrompt: card.negativePrompt,
    role: card.role,
    outfitId: card.outfitId,
    sortOrder
  }
}

/** 메인 탭 기본값 — renderer 의 DEFAULT_REQUEST 와 같은 값(저장값이 없을 때만 쓰인다) */
const MAIN_DEFAULTS = {
  prompt: '',
  negativePrompt: '',
  model: 'nai-diffusion-5-full',
  width: 832,
  height: 1216,
  steps: 28
}

/**
 * 설정 'main_params'(저장된 GenerationRequest JSON)와 'prompt_split_enabled' 로 메인 생성 설정을 만든다.
 * 분할 모드 규칙은 renderer 와 같은 requestForPromptMode — 분할이 꺼져 있으면 promptParts 는 null.
 */
export function buildMainParams(raw: string | null, split: boolean): CloudMainParams {
  let saved: Partial<GenerationRequest> = {}
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object') saved = parsed as Partial<GenerationRequest>
    } catch {
      // 손상된 저장값은 기본값으로
    }
  }
  const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback)
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback
  const base = {
    prompt: str(saved.prompt, MAIN_DEFAULTS.prompt),
    negativePrompt: str(saved.negativePrompt, MAIN_DEFAULTS.negativePrompt),
    model: str(saved.model, MAIN_DEFAULTS.model),
    width: num(saved.width, MAIN_DEFAULTS.width),
    height: num(saved.height, MAIN_DEFAULTS.height),
    steps: num(saved.steps, MAIN_DEFAULTS.steps),
    promptParts: saved.promptParts
  } as GenerationRequest
  const moded = requestForPromptMode(base, split)
  return {
    prompt: moded.prompt,
    promptParts: moded.promptParts ?? null,
    promptSplit: split,
    negativePrompt: moded.negativePrompt,
    model: moded.model,
    width: moded.width,
    height: moded.height,
    steps: moded.steps
  }
}

/** 조각 줄 목록 — fragments/repo.ts 의 contentToLines 와 같은 규칙(# 뒤는 주석, 빈 줄 제외) */
export function fragmentLines(content: string): string[] {
  return content
    .split('\n')
    .map((l) => {
      const i = l.indexOf('#')
      return (i === -1 ? l : l.slice(0, i)).trim()
    })
    .filter((l) => l.length > 0)
}

/**
 * 조각 조회 표 — fragments/repo.ts 의 fragmentSource 와 같은 키 규칙.
 * `이름`(소문자) 과, 폴더에 들어 있으면 `폴더/이름`(소문자) 두 키로 같은 줄 목록을 가리킨다.
 */
export function buildFragmentsByPath(
  folders: ListFolder[],
  items: Fragment[]
): Record<string, string[]> {
  const folderName = new Map(folders.map((f) => [f.id, f.name]))
  const byPath: Record<string, string[]> = Object.create(null)
  for (const f of items) {
    const lines = fragmentLines(f.content)
    byPath[f.name.toLowerCase()] = lines
    const folder = f.folderId != null ? folderName.get(f.folderId) : null
    if (folder) byPath[`${folder}/${f.name}`.toLowerCase()] = lines
  }
  // Object.create(null) 객체를 JSON 직렬화·테스트 비교가 쉬운 보통 객체로
  return { ...byPath }
}

// ── 스냅샷 ──────────────────────────────────────────────────────────

/**
 * 스냅샷에 들어가는 씬 — DB 의 정렬값(gen_scenes.sort_order)을 sortOrder 로 달고 온다.
 * 없으면(시험용 등) 프리셋 안의 목록 위치로 대신한다.
 */
export type SnapshotScene = Scene & { sortOrder?: number }

/** DB 에서 읽어 온 원재료 */
export interface SnapshotSource {
  /** 휴지통 제외 프리셋 — 씬 종류와 배경 종류 모두 */
  presets: ScenePreset[]
  /** 프리셋 → 씬 순서대로 정렬된, 휴지통 제외 모든 씬 */
  scenes: SnapshotScene[]
  characters: CharacterInput[]
  charFolders: CharFolderInput[]
  outfits: Pick<Outfit, 'id' | 'name'>[]
  fragmentFolders: ListFolder[]
  fragments: Fragment[]
  /** 설정 'main_params' 원문 */
  mainParamsRaw: string | null
  promptSplit: boolean
  /** 설정 'nai_tier' (paper | tablet | scroll | opus) */
  naiTier: string | null
}

export interface CloudSceneBatch {
  presetId: number
  scenes: CloudSceneLite[]
  hash: string
}

export interface CloudSnapshot {
  library: CloudLibrary
  libraryHash: string
  /** 라이브러리에 든 프리셋마다 하나 (씬이 없는 프리셋은 빈 목록) */
  scenes: CloudSceneBatch[]
  fragments: { byPath: Record<string, string[]>; hash: string }
}

/**
 * 계정 정보 — 잔액 조회 결과를 아직 못 받았을 때의 바탕값. 설정에 적어 둔 등급만 싣는다. 모르면 null.
 * 잔액 조회 결과(Anlas·Opus 사용량)가 있으면 buildSnapshot 의 둘째 인자로 받아 이걸 대신한다.
 */
export function buildNaiInfo(tier: string | null): CloudNaiInfo | null {
  if (!tier) return null
  return { tier, anlas: null, opusUsage: null, updatedAt: 0 }
}

/**
 * @param naiInfo 잔액 조회로 받은 계정 정보(sync 가 들고 있음). 없으면 설정의 등급만 싣는다.
 */
export function buildSnapshot(src: SnapshotSource, naiInfo?: CloudNaiInfo | null): CloudSnapshot {
  const presets: CloudPresetLite[] = []
  for (const kind of ['scene', 'background'] as const) {
    src.presets
      .filter((p) => (p.kind ?? 'scene') === kind)
      .forEach((p, index) =>
        presets.push({
          id: p.id,
          name: p.name,
          kind,
          sortOrder: index,
          sceneCount: p.sceneCount ?? 0
        })
      )
  }

  const library: CloudLibrary = {
    presets,
    characters: src.characters.map((c, i) => toCloudCharacter(c, i)),
    charFolders: src.charFolders.map((f): CloudFolderLite => ({
      id: f.id,
      name: f.name,
      parentId: f.parentId ?? null
    })),
    outfits: src.outfits.map((o) => ({ id: o.id, name: o.name })),
    main: buildMainParams(src.mainParamsRaw, src.promptSplit),
    naiInfo: naiInfo ? { ...naiInfo, tier: naiInfo.tier ?? src.naiTier } : buildNaiInfo(src.naiTier)
  }

  const byPreset = new Map<number, CloudSceneLite[]>()
  for (const p of presets) byPreset.set(p.id, [])
  for (const scene of src.scenes) {
    const list = byPreset.get(scene.presetId)
    if (!list) continue
    // 목록 위치(index)가 아니라 DB 의 sort_order — 가운데 씬 하나를 지워도 뒤 씬들이 전부 다시 쓰이지 않는다.
    // 같은 값이면 클라우드도 id 순으로 정렬하므로 PC 목록 순서와 같다
    const order =
      typeof scene.sortOrder === 'number' && Number.isFinite(scene.sortOrder)
        ? scene.sortOrder
        : list.length
    list.push(toCloudScene(scene, order))
  }
  const scenes: CloudSceneBatch[] = presets.map((p) => {
    const list = byPreset.get(p.id) ?? []
    return { presetId: p.id, scenes: list, hash: hashValue(list) }
  })

  const byPath = buildFragmentsByPath(src.fragmentFolders, src.fragments)
  return {
    library,
    libraryHash: hashValue(library),
    scenes,
    fragments: { byPath, hash: hashValue(byPath) }
  }
}

// ── 큐 요약 ─────────────────────────────────────────────────────────

/** 큐 상태 → poll 에 싣는 요약 */
export function summarizeQueue(status: QueueStatusLite, now: number): CloudQueueSummary {
  let pending = 0
  let generating = 0
  let done = 0
  let failed = 0
  let generatingSceneId: number | null = null
  for (const item of status.items) {
    if (item.state === 'pending') pending++
    else if (item.state === 'generating') {
      generating++
      if (generatingSceneId == null && item.sceneId != null) generatingSceneId = item.sceneId
    } else if (item.state === 'done') done++
    else if (item.state === 'failed') failed++
  }
  return {
    running: status.running,
    pending,
    generating,
    done,
    failed,
    generatingSceneId,
    updatedAt: now
  }
}
