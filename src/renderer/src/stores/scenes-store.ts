import { create } from 'zustand'
import { recordNav } from '../lib/nav-history'
import type { GenerationRequest, Scene, SceneImage, ScenePreset } from '@shared/types'
import { modelCaps } from '@shared/nai-models'
import {
  appendPrompt,
  autoRolePrefix,
  seatSlots,
  mergePromptParts,
  mergeSceneIntoPromptParts,
  prioritizeSceneCharacterIds,
  roleTagsFor
} from '@shared/scene-request'
import { enabledCharacters, linkedCharRefIds, useCharactersStore } from './characters-store'
import { randomSeed, useGenerationStore } from './generation-store'
import { useCharRefsStore, useVibesStore } from './refs-store'
import {
  enabledEntries,
  hasAddition,
  useSceneExtrasStore,
  type SequenceEntry
} from './scene-extras-store'
import { toast, toastUndo } from './toast-store'
import { pushUndo } from './undo-store'

const PAGE = 80 // 씬 상세 이미지 페이지 크기 (수만 장 대비: 한 번에 전부 로드 금지)
let presetsSeq = 0 // 프리셋 요약 비동기 응답 순서 보장용
let loadSeq = 0 // load() 비동기 응답 순서 보장용
let imagesSeq = 0 // loadImages() 비동기 응답 순서 보장용

interface ScenesState {
  presets: ScenePreset[]
  activePresetId: number
  scenes: Scene[]
  selectedId: number | null // 상세로 연 씬
  editMode: boolean
  selection: Set<number> // 편집 모드 체크된 씬들
  lastSelectedId: number | null // Shift 범위 선택 기준점 (커스텀)
  columns: number // 2~5
  cardOrientation: 'portrait' | 'landscape' // 카드 비율 고정 (해상도 무관)

  // 상세 이미지 (페이지네이션)
  images: SceneImage[]
  imagesTotal: number
  imagesLoading: boolean
  /** 씬 상세 "즐겨찾기만 보기" 필터 (N4) */
  favoritesOnly: boolean

  loadPresets: () => Promise<void>
  /** 구조 변경 뒤 프리셋별 씬 개수를 포함한 요약 목록을 최신화 */
  refreshPresetCounts: () => Promise<void>
  setActivePreset: (id: number) => Promise<void>
  createPreset: (name: string) => Promise<void>
  /** 모듈(프리셋) 복제 — 안의 씬 전부 포함 (커스텀) */
  duplicatePreset: (id: number) => Promise<void>
  renamePreset: (id: number, name: string) => Promise<void>
  deletePreset: (id: number) => Promise<void>
  /** 프리셋 순서 이동 (dir: -1 위 / +1 아래) */
  /** 프리셋 드래그 정렬 — 새 id 순서 반영 */
  reorderPresets: (ids: number[]) => Promise<void>

  load: () => Promise<void>
  select: (id: number | null) => void
  setEditMode: (v: boolean) => void
  setColumns: (n: number) => void
  setCardOrientation: (o: 'portrait' | 'landscape') => void
  toggleSelected: (id: number) => void
  /** Shift+클릭 범위 선택 — lastSelectedId부터 id까지 (커스텀) */
  selectRangeTo: (id: number) => void
  selectAll: () => void
  clearSelection: () => void

  // 휴지통 (소프트삭제 복원) — 커스텀
  trashed: (Scene & { deletedAt: string; presetName: string })[]
  loadTrash: () => Promise<void>
  restoreScenes: (ids: number[]) => Promise<void>
  purgeScenes: (ids: number[]) => Promise<void>

  create: (name: string) => Promise<void>
  update: (id: number, patch: Partial<Scene>) => Promise<void>
  duplicate: (id: number) => Promise<void>
  remove: (id: number) => Promise<void>
  reorder: (ids: number[]) => Promise<void>
  /** 프리셋의 새 씬 기본 해상도 설정 (N3) */
  setPresetDefaultResolution: (id: number, width: number, height: number) => Promise<void>

  // 예약
  adjustReserve: (id: number, delta: number) => Promise<void>
  adjustReserveAll: (delta: number) => Promise<void>
  clearReserveAll: () => Promise<void>

  // 편집 모드 일괄
  bulkMove: (presetId: number) => Promise<void>
  /** 다른 프리셋으로 복사 — 원본 유지 (커스텀). 반환: 복사된 씬 수 */
  bulkCopy: (presetId: number) => Promise<number>
  /** 씬 클립보드 (커스텀) — 우클릭 복사/잘라내기 → 원하는 씬 뒤에 붙여넣기 */
  sceneClipboard: { ids: number[]; mode: 'copy' | 'cut'; presetId: number } | null
  setSceneClipboard: (ids: number[], mode: 'copy' | 'cut') => void
  /** 클립보드 내용을 targetId 씬 바로 뒤에 붙여넣기 (null = 맨 뒤). 다른 모듈에서도 동작 */
  pasteSceneClipboard: (targetId: number | null) => Promise<void>
  /** 선택(또는 지정) 씬들을 목록 맨 앞/맨 뒤로 이동 (커스텀) */
  moveScenesToEdge: (ids: number[], edge: 'front' | 'back') => Promise<void>
  bulkDelete: () => Promise<void>
  /** 선택 씬만 예약 증감 (배치 수 단위) — 커스텀 */
  bulkAdjustReserve: (delta: number) => Promise<void>
  /** 선택 씬 예약 취소 — 커스텀 */
  bulkClearReserve: () => Promise<void>
  /** 선택 씬 variety+ 일괄 적용/해제 — 커스텀 */
  bulkSetVariety: (v: boolean) => Promise<void>
  /** 내보내기 번호 매기기 (커스텀) — 선택 씬 목록 순서대로 start부터. null = 제거 */
  bulkAssignNumbers: (start: number | null) => Promise<void>
  /** 선택 씬 일괄 복제 — 커스텀 */
  bulkDuplicate: () => Promise<void>
  bulkSetResolution: (width: number, height: number) => Promise<void>
  bulkClearFavorites: () => Promise<void>
  bulkClearImages: (keepFavorites?: boolean) => Promise<void>
  /** 단일 씬의 이미지 삭제 (우클릭 메뉴용, 커스텀). 파일은 OS 휴지통으로 */
  clearSceneImages: (id: number, keepFavorites?: boolean) => Promise<void>
  bulkExportZip: () => Promise<void>

  /** 완료 즉시 카드 썸네일을 새 원본으로 낙관적 갱신 (튐 방지) */
  setSceneThumb: (sceneId: number, filePath: string) => void
  loadImages: (sceneId: number, reset: boolean) => Promise<void>
  toggleFavorite: (imageId: number) => Promise<void>
  deleteImage: (imageId: number) => Promise<void>
  /** 즐겨찾기만 보기 토글 (N4) */
  setFavoritesOnly: (v: boolean) => void
  /** 즐겨찾기 제외 전체 삭제 (N5) */
  deleteNonFavorites: (sceneId: number) => Promise<number>

  /** 예약된 씬들을 예약 수만큼 큐에 넣는다 (메인 생성 버튼이 씬 모드에서 호출) */
  generateReserved: () => Promise<void>
  /** 취소된 대기 항목을 예약으로 복원 (커스텀 — cancelAll이 호출) */
  restoreReserves: (bySceneId: Map<number, number>) => Promise<void>
  /** 씬 상세 "생성" — 예약이 0이면 이 씬 1개 예약 후, 메인 '씬 생성'과 동일한 예약 생성 (커스텀) */
  reserveAndGenerateScene: (sceneId: number) => Promise<void>
  /** 생성 중 편집을 대기(pending) 큐 항목에 반영 — 현재 프리셋 씬을 최신 상태로 재구성 (커스텀) */
  resyncPendingScenes: () => Promise<void>
}

/** 씬 프롬프트를 기본 프롬프트 뒤에 이어붙임 (콤마 정리) */
export { appendPrompt } from '@shared/scene-request'

/**
 * 씬 → 생성 요청. 사이드바의 모든 것(기본/네거 프롬프트·캐릭터·조각·바이브·레퍼런스·
 * 파라미터)을 그대로 쓰고, 씬 프롬프트는 기본/네거 프롬프트 "뒤에 이어붙인다".
 * 해상도만 씬 것을 사용 (소스가 있으면 소스 해상도가 우선). 바이브/레퍼런스/조각은
 * 메인 프로세스가 DB·와일드카드에서 읽어 적용하므로 여기선 프롬프트·캐릭터·파라미터만 구성.
 *
 * 커스텀 확장 (NAIS2 Custom 이식):
 * - entry(큐 반복 항목)가 있으면 캐릭터/바이브/캐릭레퍼는 메인 설정 대신 항목의 선택만 적용
 * - 씬별 캐릭터 추가가 켜져 있으면 해당 씬의 추가 선택을 합집합으로 얹는다
 */
function buildSceneRequest(scene: Scene, entry?: SequenceEntry | null): GenerationRequest {
  const base = useGenerationStore.getState().request
  const src = useGenerationStore.getState().source
  const extras = useSceneExtrasStore.getState()
  const rawAddition = extras.additionsEnabled
    ? extras.additions[scene.presetId]?.[scene.id]
    : undefined
  const add = hasAddition(rawAddition) ? rawAddition : null

  /**
   * 자리 묶음은 통째로 한쪽만 쓴다 — 씬별 추가에 자리가 있으면 그것, 없으면 큐 항목 것.
   * 좌표·역할·태그가 모두 자리 번호로 엮여 있어서, 두 곳을 섞으면 엉뚱한 자리에 붙는다.
   * (1.12.0~1.14.0에서는 씬별 추가만 읽어, 큐 항목에 잡아둔 자리가 조용히 무시됐다)
   */
  const layout = add?.slots?.length ? add : entry?.slots?.length ? entry : null

  // 캐릭터: 씬별 선택 순서 우선 → 반복 항목/메인 enabled 순서. 중복은 한 번만 포함한다.
  const baseCharIds = entry ? entry.characterIds : enabledCharacters().map((c) => c.id)
  const orderedCharIds = prioritizeSceneCharacterIds(add?.characterIds ?? [], baseCharIds)
  const charIds = new Set(orderedCharIds)
  // 위치(좌표): 씬별 추가 > 큐 항목 > 카드 기본 순으로 오버라이드 (커스텀)
  const charactersById = new Map(useCharactersStore.getState().items.map((c) => [c.id, c]))
  // 행위 역할 (커스텀): 역할이 지정된 캐릭터는 씬의 하는쪽/당하는쪽 태그를 프롬프트 뒤에 합친다.
  // 우선순위: 씬별 추가 > 큐 항목 > 캐릭터 카드 기본 역할 (캐릭터탭에서 지정).
  // bare 상호작용 태그(sex, fellatio 등)는 roleTagsFor가 source#/target#을 자동으로 붙인다
  const roleOf = (id: number): 'source' | 'target' | undefined =>
    add?.roles?.[id] ?? entry?.roles?.[id] ?? charactersById.get(id)?.role ?? undefined
  // 씬별 역할 위치 (커스텀): 이 씬에서 하는쪽/당하는쪽이 "누구든" 역할 기준 좌표로 배치.
  // 큐 항목 위치는 전체 씬 공통이므로, 특정 씬만 다르게 두는 이 좌표가 그보다 우선한다.
  const rolePos = (id: number): { x: number; y: number } | undefined => {
    const r = roleOf(id)
    return (r === 'source' ? scene.sourcePos : r === 'target' ? scene.targetPos : null) ?? undefined
  }
  let rolePosApplied = false
  let slotApplied = false
  const sceneChars = orderedCharIds.flatMap((id) => {
    const character = charactersById.get(id)
    return character?.prompt.trim() ? [character] : []
  })
  // 미리 잡아둔 자리에 앉은 캐릭터는 그 자리 좌표·태그·역할로 그린다 (커스텀).
  // 한 카드가 여러 자리에 앉을 수 있어, 같은 인물이 자리 수만큼 나온다.
  const seating = seatSlots(
    // 역할까지 넘겨야 "카드에 당하는쪽만 걸어두면 당하는쪽 자리가 알아서 찬다"가 된다
    sceneChars.map((c) => ({ id: c.id, slotNo: c.slotNo, role: roleOf(c.id) ?? null })),
    layout ?? {}
  )

  /**
   * 자리 하나 = 인물 하나. 캐릭터 순서는 그대로 두고, 여러 자리에 앉은 캐릭터만
   * 자리 번호 순으로 이어 넣는다 (한 자리씩만 쓰던 기존 씬은 결과가 그대로다).
   */
  const placements = sceneChars.flatMap((c) => {
    const seats = seating.bySlots.get(c.id)
    return seats?.length
      ? seats.map((slotIndex) => ({ char: c, slotIndex }))
      : [{ char: c, slotIndex: undefined as number | undefined }]
  })
  // NAI 동시 캐릭터 한도를 넘으면 이 순서대로 자른다 (V4.5=6, V5=32)
  const built = placements
    .slice(0, modelCaps(base.model).maxCharacters)
    .map(({ char: c, slotIndex }) => {
      const seated = slotIndex != null
      const slotPos = seated ? layout?.slots?.[slotIndex] : undefined
      // 자리 태그 (커스텀) — 그 자리에 앉은 캐릭터 뒤에 붙는다. 위치 적용 여부와 무관하게
      // 얹는 건 역할 태그와 같은 취급 — 자리는 좌표만이 아니라 "그 자리의 연기"이기도 하다
      const slotTag = seated ? (layout?.slotTags?.[slotIndex] ?? '') : ''
      // 이 씬(또는 이 큐 항목)에서만 이 캐릭터에 얹는 태그 — 카드는 건드리지 않는다
      const charTag = add?.charTags?.[c.id] ?? entry?.charTags?.[c.id] ?? ''
      // 앉은 캐릭터는 자리 좌표가 곧 배치다. 캐릭터별 좌표는 자리에 앉지 않은 쪽에만 쓴다
      // — 그래야 배치 창에서 본 그림과 실제 생성이 같다.
      const addPos = seated ? undefined : add?.positions?.[c.id]
      // 자리 역할이 먼저 — 같은 캐릭터라도 자리마다 하는쪽/당하는쪽이 다를 수 있다
      const role =
        (seated ? (layout?.slotRoles?.[slotIndex] ?? undefined) : undefined) ?? roleOf(c.id)
      /**
       * 자리·씬 태그에 sex 같은 상호작용 태그를 적으면 그 자리의 역할로 접두사를 붙인다 (커스텀).
       * 씬의 행위 태그는 씬에 하나뿐이라 "같은 당하는쪽이라도 자리마다 다른 행위"를 하려면
       * 자리 태그에 적어야 하는데, 여기까지 자동으로 붙지 않으면 target#을 손으로 적어야 했다.
       * 표정·포즈 같은 일반 태그는 MUTUAL_TAGS에 없어 그대로 남는다.
       */
      const withRole = (tags: string): string =>
        role && tags.trim() ? autoRolePrefix(tags, role) : tags
      if (slotPos) slotApplied = true
      const rp = addPos == null && slotPos == null ? rolePos(c.id) : undefined
      if (rp) rolePosApplied = true
      const explicit = addPos ?? slotPos ?? rp ?? (seated ? undefined : entry?.positions?.[c.id])
      return {
        // 카드 → 이 씬 태그 → 자리 태그 → 역할 태그 순으로 이어붙인다
        prompt: appendPrompt(
          appendPrompt(appendPrompt(c.prompt, withRole(charTag)), withRole(slotTag)),
          roleTagsFor(role, scene)
        ),
        negativePrompt: c.negativePrompt,
        // 미지정 캐릭터는 중립(0.5) — 카드 기본 좌표를 쓰면 배치 탭에서 끌어놓은
        // 위치가 씬으로 새어 들어온다. 겹침은 아래 자동 분산이 풀어준다.
        center: explicit ?? { x: 0.5, y: 0.5 },
        // 명시 위치(씬별/역할/큐)가 있었는지 — 아래 겹침 분산에서 이 캐릭터는 건드리지 않는다
        positioned: explicit != null,
        enabled: true as const
      }
    })
  // 위치 적용 on/off: 씬별 추가 > 큐 항목 > 역할 위치 (커스텀).
  // ⚠️ 전역(배치 탭) 위치 지정은 메인 탭 전용 — 씬에는 새지 않는다. 전역을 켰더니
  // 씬의 "지정 안 한 캐릭터"까지 배치판 좌표로 그려지던 혼란(1.11.2 리포트)의 수정.
  const useCoordsOverride = add?.useCoords ?? entry?.useCoords
  const finalUseCoords = useCoordsOverride ?? (rolePosApplied || slotApplied)
  // 좌표 모드에서 위치를 안 준 캐릭터들이 같은 칸(카드 기본 0.5,0.5)에 겹치면 NAI가
  // 한 명으로 합쳐 그린다 — 역할 위치 때문에 좌표가 켜졌을 때 특히 잘 남. 미지정
  // 캐릭터끼리(또는 지정 캐릭터와) 칸이 겹치면 같은 줄의 빈 칸으로 자동 분산 (커스텀)
  if (finalUseCoords && built.length >= 2) {
    const key = (p: { x: number; y: number }): string => `${p.x},${p.y}`
    const used = new Set(built.filter((b) => b.positioned).map((b) => key(b.center)))
    const slots = [0.5, 0.3, 0.7, 0.1, 0.9]
    for (const b of built) {
      if (b.positioned) continue
      if (!used.has(key(b.center))) {
        used.add(key(b.center))
        continue
      }
      const free = slots.find((x) => !used.has(`${x},${b.center.y}`))
      if (free != null) {
        b.center = { x: free, y: b.center.y }
        used.add(key(b.center))
      }
    }
  }
  const characterPrompts = built.map((b) => ({
    prompt: b.prompt,
    negativePrompt: b.negativePrompt,
    center: b.center,
    enabled: b.enabled
  }))
  // 포함된 캐릭터에 연결된 캐릭레퍼는 자동 적용 (커스텀)
  const linked = linkedCharRefIds(charIds)

  // 바이브/캐릭레퍼 오버라이드 — undefined면 메인이 enabled 항목을 그대로 사용
  let vibeIds: number[] | undefined
  let charRefIds: number[] | undefined
  if (entry) {
    // 반복 모드: 메인 설정 미적용, 항목 선택(+씬별 추가+연결 레퍼런스)만 — 빈 배열이면 아예 미적용
    vibeIds = [...new Set([...entry.vibeIds, ...(add?.vibeIds ?? [])])]
    charRefIds = [...new Set([...entry.charRefIds, ...(add?.charRefIds ?? []), ...linked])]
  } else {
    if (add && add.vibeIds.length > 0) {
      const enabled = useVibesStore
        .getState()
        .items.filter((v) => v.enabled)
        .map((v) => v.id)
      vibeIds = [...new Set([...enabled, ...add.vibeIds])]
    }
    if ((add && add.charRefIds.length > 0) || linked.length > 0) {
      const enabled = useCharRefsStore
        .getState()
        .items.filter((c) => c.enabled)
        .map((c) => c.id)
      charRefIds = [...new Set([...enabled, ...(add?.charRefIds ?? []), ...linked])]
    }
  }

  // 분할 사용 시 씬 프롬프트는 가변 뒤·디테일 앞 (전체 끝에 붙이면 디테일에 묻힘 — 커스텀 수정)
  const mergedParts = base.promptParts
    ? mergeSceneIntoPromptParts(base.promptParts, scene.prompt)
    : undefined
  return {
    ...base,
    prompt: mergedParts ? mergePromptParts(mergedParts) : appendPrompt(base.prompt, scene.prompt),
    promptParts: mergedParts,
    negativePrompt: appendPrompt(base.negativePrompt, scene.negativePrompt),
    width: src ? src.width : scene.width,
    height: src ? src.height : scene.height,
    // 씬별 variety+ 오버라이드 (커스텀) — 켜져 있으면 강제 on, 아니면 메인 설정 따름
    variety: scene.varietyPlus ? true : base.variety,
    // 위치 적용 오버라이드 (커스텀) — 큐/씬별 설정 > 씬 역할 위치가 잡혔으면 자동 on > 메인 설정
    useCoords: finalUseCoords,
    characterPrompts,
    vibeIds,
    charRefIds,
    sceneId: scene.id,
    // 큐 실행 시 최신 씬 태그를 다시 붙일 수 있도록 기본 부분을 별도로 보존한다.
    sceneBasePrompt: base.prompt,
    sceneBaseNegativePrompt: base.negativePrompt,
    sceneBaseAdditionalPrompt: base.promptParts?.additional,
    // 대기 항목 재구성(생성 중 편집 반영) 시 같은 큐 반복 조합으로 복원하기 위한 스냅샷
    sceneSequenceEntry: entry ?? null,
    source: src
      ? {
          imageBase64: src.imageBase64,
          maskBase64: src.maskBase64,
          strength: base.i2iStrength ?? 0.7,
          noise: base.i2iNoise ?? 0
        }
      : undefined
  }
}

/** 커스텀 확장이 참조하는 스토어들이 로드됐는지 보장 (씬 생성 직전 호출) */
async function ensureExtrasData(): Promise<void> {
  const jobs: Promise<void>[] = []
  if (!useSceneExtrasStore.getState().loaded) jobs.push(useSceneExtrasStore.getState().load())
  if (!useCharactersStore.getState().loaded) jobs.push(useCharactersStore.getState().load())
  if (!useVibesStore.getState().loaded) jobs.push(useVibesStore.getState().load())
  if (!useCharRefsStore.getState().loaded) jobs.push(useCharRefsStore.getState().load())
  await Promise.all(jobs)
}

/**
 * 이미지 소프트삭제 실행취소 등록 (커스텀). 유예시간 안이면 deleted_at을 해제해 복원.
 * 복원 후 씬 목록·현재 씬 상세·히스토리를 갱신한다.
 */
function registerImageDeleteUndo(get: () => ScenesState, ids: number[]): void {
  if (ids.length === 0) return
  pushUndo(`이미지 ${ids.length}장 삭제`, async () => {
    await window.nais.invoke('scenes:restoreImages', { ids })
    await get().load()
    const sid = get().selectedId
    if (sid != null) await get().loadImages(sid, true)
    void useGenerationStore.getState().refreshHistory()
  })
}

export const useScenesStore = create<ScenesState>((set, get) => ({
  presets: [],
  activePresetId: 1,
  scenes: [],
  selectedId: null,
  editMode: false,
  selection: new Set(),
  lastSelectedId: null,
  trashed: [],
  columns: Number(localStorage.getItem('scene_columns')) || 3,
  cardOrientation:
    (localStorage.getItem('scene_orientation') as 'portrait' | 'landscape') || 'portrait',
  images: [],
  imagesTotal: 0,
  imagesLoading: false,
  favoritesOnly: false,

  loadPresets: async () => {
    await get().refreshPresetCounts()
    await get().load()
  },
  refreshPresetCounts: async () => {
    const seq = ++presetsSeq
    const { items } = await window.nais.invoke('scenePresets:list', undefined)
    if (seq !== presetsSeq) return
    const currentId = get().activePresetId
    const activePresetId = items.some((p) => p.id === currentId)
      ? currentId
      : (items[0]?.id ?? currentId)
    set({ presets: items, activePresetId })
  },
  setActivePreset: async (id) => {
    set({ activePresetId: id, selectedId: null, selection: new Set(), lastSelectedId: null })
    await get().load()
  },
  createPreset: async (name) => {
    const { id } = await window.nais.invoke('scenePresets:create', { name })
    await get().loadPresets()
    await get().setActivePreset(id)
  },
  // 모듈(프리셋) 복제 — 안의 씬 전부 포함, 복제본으로 전환 (커스텀)
  duplicatePreset: async (id) => {
    const { id: newId } = await window.nais.invoke('scenes:duplicatePreset', { id })
    if (newId > 0) {
      await get().loadPresets()
      await get().setActivePreset(newId)
    }
  },
  renamePreset: async (id, name) => {
    set({ presets: get().presets.map((p) => (p.id === id ? { ...p, name } : p)) })
    await window.nais.invoke('scenePresets:rename', { id, name })
  },
  deletePreset: async (id) => {
    await window.nais.invoke('scenePresets:delete', { id })
    await get().loadPresets()
  },
  reorderPresets: async (ids) => {
    const byId = new Map(get().presets.map((p) => [p.id, p]))
    set({ presets: ids.map((pid) => byId.get(pid)!).filter(Boolean) })
    await window.nais.invoke('scenePresets:reorder', { ids })
  },
  setPresetDefaultResolution: async (id, width, height) => {
    set({
      presets: get().presets.map((p) =>
        p.id === id ? { ...p, defaultWidth: width, defaultHeight: height } : p
      )
    })
    await window.nais.invoke('scenePresets:setDefaultResolution', { id, width, height })
  },

  load: async () => {
    // 시퀀스 가드: 생성 중 scenes:changed가 연달아 오면 응답이 뒤섞여 옛 썸네일이 남을 수 있음
    const seq = ++loadSeq
    const presetId = get().activePresetId
    const { items } = await window.nais.invoke('scenes:list', { presetId })
    if (seq !== loadSeq || get().activePresetId !== presetId) return // 더 최신 로드가 있으면 폐기
    set({
      scenes: items,
      // import처럼 이 load()만 호출하는 경로도 드롭다운의 활성 모듈 개수가 즉시 맞는다.
      presets: get().presets.map((p) =>
        p.id === presetId ? { ...p, sceneCount: items.length } : p
      )
    })
  },
  select: (selectedId) => {
    if (selectedId !== get().selectedId) recordNav() // 마우스 뒤로/앞으로용 히스토리
    set({ selectedId, images: [], imagesTotal: 0, favoritesOnly: false })
    if (selectedId != null) void get().loadImages(selectedId, true)
  },
  setEditMode: (editMode) => set({ editMode, selection: new Set(), lastSelectedId: null }),
  setColumns: (columns) => {
    set({ columns })
    localStorage.setItem('scene_columns', String(columns))
  },
  setCardOrientation: (cardOrientation) => {
    set({ cardOrientation })
    localStorage.setItem('scene_orientation', cardOrientation)
  },
  toggleSelected: (id) => {
    const next = new Set(get().selection)
    next.has(id) ? next.delete(id) : next.add(id)
    set({ selection: next, lastSelectedId: id })
  },
  selectRangeTo: (id) => {
    const { scenes, lastSelectedId, selection } = get()
    const to = scenes.findIndex((s) => s.id === id)
    const from = lastSelectedId != null ? scenes.findIndex((s) => s.id === lastSelectedId) : -1
    if (to < 0) return
    if (from < 0) {
      // 기준점 없으면 단일 선택
      const next = new Set(selection)
      next.add(id)
      set({ selection: next, lastSelectedId: id })
      return
    }
    const [lo, hi] = from <= to ? [from, to] : [to, from]
    const next = new Set(selection)
    for (let i = lo; i <= hi; i++) next.add(scenes[i].id)
    set({ selection: next, lastSelectedId: id })
  },
  selectAll: () => set({ selection: new Set(get().scenes.map((s) => s.id)) }),
  clearSelection: () => set({ selection: new Set(), lastSelectedId: null }),

  loadTrash: async () => {
    const { items } = await window.nais.invoke('scenes:trash', undefined)
    set({ trashed: items })
  },
  restoreScenes: async (ids) => {
    if (ids.length === 0) return
    await window.nais.invoke('scenes:restore', { ids })
    await Promise.all([get().load(), get().loadTrash(), get().refreshPresetCounts()])
  },
  purgeScenes: async (ids) => {
    if (ids.length === 0) return
    await window.nais.invoke('scenes:purge', { ids })
    await get().loadTrash()
  },

  create: async (name) => {
    await window.nais.invoke('scenes:create', { presetId: get().activePresetId, name })
    await Promise.all([get().load(), get().refreshPresetCounts()])
  },
  update: async (id, patch) => {
    set({ scenes: get().scenes.map((s) => (s.id === id ? { ...s, ...patch } : s)) })
    await window.nais.invoke('scenes:update', {
      id,
      patch: {
        name: patch.name,
        prompt: patch.prompt,
        negativePrompt: patch.negativePrompt,
        width: patch.width,
        height: patch.height,
        reserveCount: patch.reserveCount,
        varietyPlus: patch.varietyPlus,
        sourceTags: patch.sourceTags,
        targetTags: patch.targetTags,
        // 씬별 역할 위치 (커스텀) — 여기 빠지면 낙관적 갱신만 되고 저장이 안 돼
        // 다음 load()에서 초기화된다 (v1.6.19 버그)
        sourcePos: patch.sourcePos,
        targetPos: patch.targetPos
      }
    })
  },
  duplicate: async (id) => {
    await window.nais.invoke('scenes:duplicate', { id })
    await Promise.all([get().load(), get().refreshPresetCounts()])
  },
  remove: async (id) => {
    const name = get().scenes.find((s) => s.id === id)?.name ?? '씬'
    await window.nais.invoke('scenes:delete', { id })
    if (get().selectedId === id) set({ selectedId: null })
    await Promise.all([get().load(), get().refreshPresetCounts()])
    // 소프트삭제 — 토스트 버튼 또는 Ctrl+Z로 복원 (휴지통에서도 가능)
    toastUndo(`"${name}" 삭제됨`, () => void get().restoreScenes([id]))
    pushUndo(`"${name}" 삭제`, () => void get().restoreScenes([id]))
  },
  reorder: async (ids) => {
    set({ scenes: ids.map((id) => get().scenes.find((s) => s.id === id)!).filter(Boolean) })
    await window.nais.invoke('scenes:reorder', { ids })
  },

  adjustReserve: async (id, delta) => {
    const scene = get().scenes.find((s) => s.id === id)
    if (!scene) return
    // 예약은 배치 생성 개수 단위로 (배치 3이면 +3/-3 — NAIS2 워크플로)
    const step = delta * (useGenerationStore.getState().batchCount || 1)
    // 생성 중에 +를 누르면 예약만 쌓지 않고 즉시 큐에 이어붙인다 (커스텀).
    // 안 그러면 이미 돌던 큐만 처리하고 새 예약은 다음 생성 때까지 무시됨.
    const q = useGenerationStore.getState().queue
    const generating =
      q?.items.some((i) => i.state === 'pending' || i.state === 'generating') ?? false
    if (delta > 0 && generating) {
      await ensureExtrasData()
      const requests: GenerationRequest[] = []
      for (let i = 0; i < step; i++) {
        requests.push({ ...buildSceneRequest(scene), seed: sceneSeed(i) })
      }
      // 맨 뒤가 아니라 "지금 생성 중인 것 바로 다음"에 끼워넣어 곧바로 뽑히게 (커스텀)
      await window.nais.invoke('queue:enqueueNext', { requests })
      toast(`"${scene.name}" ${step}장 — 다음 차례로 추가됨`, 'success')
      return
    }
    // 생성 중 − : 예약은 이미 큐로 넘어가 0이므로, 이 씬의 "대기" 항목을 뒤에서부터 취소 (커스텀).
    // 취소되면 queue:changed가 와서 상세/카드 숫자가 바로 줄어든다
    if (delta < 0 && generating && scene.reserveCount === 0) {
      const pendingIds = (q?.items ?? [])
        .filter((i) => i.state === 'pending' && i.sceneId === id)
        .map((i) => i.id)
      if (pendingIds.length > 0) {
        const cancel = pendingIds.slice(-Math.min(pendingIds.length, Math.abs(step)))
        await window.nais.invoke('queue:cancel', { ids: cancel })
        toast(`"${scene.name}" ${cancel.length}장 취소됨`, 'info')
        return
      }
      return // 취소할 대기 항목 없음 (지금 생성 중인 1장은 여기서 안 끊음)
    }
    const reserveCount = Math.max(0, scene.reserveCount + step)
    set({ scenes: get().scenes.map((s) => (s.id === id ? { ...s, reserveCount } : s)) })
    await window.nais.invoke('scenes:update', { id, patch: { reserveCount } })
  },
  adjustReserveAll: async (delta) => {
    const step = delta * (useGenerationStore.getState().batchCount || 1)
    set({
      scenes: get().scenes.map((s) => ({ ...s, reserveCount: Math.max(0, s.reserveCount + step) }))
    })
    await window.nais.invoke('scenes:adjustReserveAll', {
      presetId: get().activePresetId,
      delta: step
    })
  },
  clearReserveAll: async () => {
    set({ scenes: get().scenes.map((s) => ({ ...s, reserveCount: 0 })) })
    await window.nais.invoke('scenes:setReserveAll', { presetId: get().activePresetId, count: 0 })
  },

  bulkAdjustReserve: async (delta) => {
    const ids = new Set(get().selection)
    if (ids.size === 0) return
    const step = delta * (useGenerationStore.getState().batchCount || 1)
    const next = get().scenes.map((s) =>
      ids.has(s.id) ? { ...s, reserveCount: Math.max(0, s.reserveCount + step) } : s
    )
    set({ scenes: next })
    for (const s of next) {
      if (ids.has(s.id))
        void window.nais.invoke('scenes:update', {
          id: s.id,
          patch: { reserveCount: s.reserveCount }
        })
    }
  },
  bulkClearReserve: async () => {
    const ids = new Set(get().selection)
    if (ids.size === 0) return
    set({
      scenes: get().scenes.map((s) => (ids.has(s.id) ? { ...s, reserveCount: 0 } : s))
    })
    for (const id of ids) {
      void window.nais.invoke('scenes:update', { id, patch: { reserveCount: 0 } })
    }
  },
  bulkSetVariety: async (v) => {
    const ids = new Set(get().selection)
    if (ids.size === 0) return
    set({
      scenes: get().scenes.map((s) => (ids.has(s.id) ? { ...s, varietyPlus: v } : s))
    })
    for (const id of ids) {
      void window.nais.invoke('scenes:update', { id, patch: { varietyPlus: v } })
    }
  },
  // 내보내기 번호 매기기 (커스텀) — 선택 씬을 화면(목록) 순서대로 start부터 순번. null = 번호 제거
  bulkAssignNumbers: async (start) => {
    const ids = get()
      .scenes.filter((s) => get().selection.has(s.id))
      .map((s) => s.id)
    if (ids.length === 0) return
    await window.nais.invoke('scenes:assignExportNumbers', { ids, start })
    await get().load()
  },
  bulkDuplicate: async () => {
    // 목록 순서대로 복제 (선택 순서 아님)
    const ids = get()
      .scenes.filter((s) => get().selection.has(s.id))
      .map((s) => s.id)
    if (ids.length === 0) return
    for (const id of ids) await window.nais.invoke('scenes:duplicate', { id })
    set({ selection: new Set(), lastSelectedId: null })
    await Promise.all([get().load(), get().refreshPresetCounts()])
  },

  bulkMove: async (presetId) => {
    // 클릭 순서(Set)가 아니라 목록 순서대로 넘겨야 대상 모듈 뒤에 원래 순서로 붙는다
    const ids = get()
      .scenes.filter((s) => get().selection.has(s.id))
      .map((s) => s.id)
    if (ids.length === 0) return
    await window.nais.invoke('scenes:bulkMove', { ids, presetId })
    set({ selection: new Set(), lastSelectedId: null })
    await Promise.all([get().load(), get().refreshPresetCounts()])
  },
  // 다른 프리셋으로 "복사" — 원본 유지 (커스텀, 이동=잘라내기와 짝)
  bulkCopy: async (presetId) => {
    const ids = get()
      .scenes.filter((s) => get().selection.has(s.id))
      .map((s) => s.id) // 목록 순서대로
    if (ids.length === 0) return 0
    const { copied } = await window.nais.invoke('scenes:bulkCopy', { ids, presetId })
    await get().refreshPresetCounts()
    return copied
  },

  sceneClipboard: null,
  setSceneClipboard: (ids, mode) => {
    // 목록 순서대로 담아야 붙여넣을 때 원래 순서가 유지된다
    const ordered = get()
      .scenes.filter((s) => ids.includes(s.id))
      .map((s) => s.id)
    if (ordered.length === 0) return
    set({ sceneClipboard: { ids: ordered, mode, presetId: get().activePresetId } })
    toast(
      mode === 'copy'
        ? `씬 ${ordered.length}개 복사됨 — 원하는 씬에 우클릭 → 붙여넣기`
        : `씬 ${ordered.length}개 잘라냄 — 원하는 씬에 우클릭 → 붙여넣기`,
      'success'
    )
  },
  pasteSceneClipboard: async (targetId) => {
    const clip = get().sceneClipboard
    if (!clip || clip.ids.length === 0) return
    const presetId = get().activePresetId
    let pastedIds: number[] = []

    if (clip.mode === 'copy') {
      const { ids } = await window.nais.invoke('scenes:bulkCopy', { ids: clip.ids, presetId })
      pastedIds = ids
    } else if (clip.presetId === presetId) {
      // 같은 모듈 내 잘라내기 → DB 이동 없이 순서만 재배치
      pastedIds = clip.ids.filter((id) => get().scenes.some((s) => s.id === id))
    } else {
      await window.nais.invoke('scenes:bulkMove', { ids: clip.ids, presetId })
      pastedIds = clip.ids
    }
    if (clip.mode === 'cut') set({ sceneClipboard: null }) // 잘라내기는 1회성

    await Promise.all([get().load(), get().refreshPresetCounts()])
    // 위치 재배치: 붙여넣은 씬들을 빼낸 나머지에서 target 뒤에 끼워넣는다
    const pasted = new Set(pastedIds)
    const rest = get()
      .scenes.map((s) => s.id)
      .filter((id) => !pasted.has(id))
    const ordered = pastedIds.filter((id) => get().scenes.some((s) => s.id === id))
    if (ordered.length === 0) return
    const at = targetId != null ? rest.indexOf(targetId) + 1 : rest.length
    const next = [...rest.slice(0, at), ...ordered, ...rest.slice(at)]
    await get().reorder(next)
    toast(`씬 ${ordered.length}개 붙여넣음`, 'success')
  },
  moveScenesToEdge: async (ids, edge) => {
    const moving = get()
      .scenes.filter((s) => ids.includes(s.id))
      .map((s) => s.id)
    if (moving.length === 0) return
    const set_ = new Set(moving)
    const rest = get()
      .scenes.map((s) => s.id)
      .filter((id) => !set_.has(id))
    const next = edge === 'front' ? [...moving, ...rest] : [...rest, ...moving]
    await get().reorder(next)
  },
  bulkDelete: async () => {
    const ids = [...get().selection]
    if (ids.length === 0) return
    await window.nais.invoke('scenes:bulkDelete', { ids })
    set({ selection: new Set(), lastSelectedId: null })
    await Promise.all([get().load(), get().refreshPresetCounts()])
    // 소프트삭제 — 토스트 버튼 또는 Ctrl+Z로 전부 되살림 (휴지통에서도 가능)
    toastUndo(`씬 ${ids.length}개 삭제됨`, () => void get().restoreScenes(ids))
    pushUndo(`씬 ${ids.length}개 삭제`, () => void get().restoreScenes(ids))
  },
  bulkSetResolution: async (width, height) => {
    const ids = [...get().selection]
    await window.nais.invoke('scenes:bulkSetResolution', { ids, width, height })
    await get().load()
  },
  bulkClearFavorites: async () => {
    await window.nais.invoke('scenes:bulkClearFavorites', { ids: [...get().selection] })
  },
  bulkClearImages: async (keepFavorites = false) => {
    const { ids } = await window.nais.invoke('scenes:bulkClearImages', {
      ids: [...get().selection],
      keepFavorites
    })
    set({ selection: new Set() })
    await get().load()
    registerImageDeleteUndo(get, ids)
  },
  clearSceneImages: async (id, keepFavorites = false) => {
    const { ids } = await window.nais.invoke('scenes:bulkClearImages', { ids: [id], keepFavorites })
    await get().load()
    registerImageDeleteUndo(get, ids)
  },
  bulkExportZip: async () => {
    await window.nais.invoke('scenes:bulkExportZip', { ids: [...get().selection] })
  },

  setSceneThumb: (sceneId, filePath) =>
    set({
      // thumbnail(base64) 비우고 thumbnailPath로 → 카드가 새 원본을 즉시 표시
      scenes: get().scenes.map((s) =>
        s.id === sceneId
          ? { ...s, thumbnail: '', thumbnailPath: filePath, imageCount: s.imageCount + 1 }
          : s
      )
    }),

  loadImages: async (sceneId, reset) => {
    if (!reset && get().imagesLoading) return // 페이지네이션 중복 방지 (reset은 항상 허용)
    const seq = ++imagesSeq
    set({ imagesLoading: true })
    const offset = reset ? 0 : get().images.length
    const { items, total } = await window.nais.invoke('scenes:images', {
      sceneId,
      limit: PAGE,
      offset,
      favoritesOnly: get().favoritesOnly
    })
    if (seq !== imagesSeq || get().selectedId !== sceneId) return // 더 최신 로드가 있으면 폐기
    set((s) => ({
      images: reset ? items : [...s.images, ...items],
      imagesTotal: total,
      imagesLoading: false
    }))
  },
  toggleFavorite: async (imageId) => {
    const img = get().images.find((i) => i.id === imageId)
    if (!img) return
    const favorite = !img.favorite
    set({ images: get().images.map((i) => (i.id === imageId ? { ...i, favorite } : i)) })
    await window.nais.invoke('images:setFavorite', { id: imageId, favorite })
  },
  deleteImage: async (imageId) => {
    const target = get().images.find((i) => i.id === imageId)
    set({
      images: get().images.filter((i) => i.id !== imageId),
      imagesTotal: Math.max(0, get().imagesTotal - 1)
    })
    // 메인 프리뷰가 이 파일을 보고 있으면 정리 — 삭제 후 깨진(NULL) 이미지 방지 (B8)
    const gen = useGenerationStore.getState()
    if (target && gen.viewingFilePath === target.filePath) gen.view(null)
    // 씬 상세의 명시적 삭제 — 소프트삭제(유예 후 파일 휴지통). 실행취소 가능 (커스텀)
    await window.nais.invoke('images:delete', { id: imageId, deleteFile: true })
    void gen.refreshHistory()
    void get().load() // 씬 그리드 카드 썸네일·장수 즉시 갱신 (지운 이미지가 카드에 남던 문제)
    registerImageDeleteUndo(get, [imageId])
  },
  setFavoritesOnly: (v) => {
    if (v === get().favoritesOnly) return
    set({ favoritesOnly: v, images: [], imagesTotal: 0 })
    const id = get().selectedId
    if (id != null) void get().loadImages(id, true)
  },
  deleteNonFavorites: async (sceneId) => {
    const { deleted, ids } = await window.nais.invoke('scenes:deleteNonFavorites', { sceneId })
    if (deleted > 0) {
      await get().loadImages(sceneId, true)
      void get().load() // 카드 썸네일/카운트 갱신
      void useGenerationStore.getState().refreshHistory()
      registerImageDeleteUndo(get, ids)
    }
    return deleted
  },

  generateReserved: async () => {
    await ensureExtrasData()
    const reserved = get().scenes.filter((s) => s.reserveCount > 0)
    // 예약을 큐에 넣는 즉시 예약 수는 소진(0) — 예약이란 게 "뽑을 대기열"이므로
    set({ scenes: get().scenes.map((s) => (s.reserveCount > 0 ? { ...s, reserveCount: 0 } : s)) })
    void window.nais.invoke('scenes:setReserveAll', { presetId: get().activePresetId, count: 0 })
    let offset = 0
    // 큐 반복: 활성 항목이 있으면 항목마다 예약 전체를 반복 (항목 → 씬 순서, NAIS2 Custom과 동일)
    const entries = enabledEntries()
    const rounds: (SequenceEntry | null)[] = entries.length > 0 ? entries : [null]
    // 전부 만들어 한 번에 등록 — 건별 등록 중 취소하면 뒤이어 도착하는 항목이 살아남는 문제 방지
    const requests: GenerationRequest[] = []
    for (const entry of rounds) {
      for (const scene of reserved) {
        for (let i = 0; i < scene.reserveCount; i++) {
          requests.push({ ...buildSceneRequest(scene, entry), seed: sceneSeed(offset++) })
        }
      }
    }
    if (requests.length > 0) await window.nais.invoke('queue:enqueueMany', { requests })
  },

  /** 취소 시 대기 중이던 씬 항목을 예약 수로 복원 (sceneId → 개수) — cancelAll이 호출 */
  restoreReserves: async (bySceneId) => {
    for (const [sceneId, count] of bySceneId) {
      const { scene } = await window.nais.invoke('scenes:get', { id: sceneId })
      if (!scene) continue
      await window.nais.invoke('scenes:update', {
        id: sceneId,
        patch: { reserveCount: scene.reserveCount + count }
      })
    }
    await get().load()
  },

  reserveAndGenerateScene: async (sceneId) => {
    // 씬 상세 "생성"용 (커스텀) — 예약이 0이면 이 씬만 1개 예약 후, 메인과 동일한 예약 생성 흐름
    const scene = get().scenes.find((s) => s.id === sceneId)
    if (!scene) return
    if (scene.reserveCount === 0) await get().adjustReserve(sceneId, 1)
    await get().generateReserved()
  },

  resyncPendingScenes: async () => {
    // 생성 중 편집 반영 — 아직 안 뽑힌(pending) 씬 항목을 현재 상태로 다시 만들어 큐에 교체.
    // 이미 서버로 넘어간 generating 항목은 건드리지 않는다. 다른 프리셋 항목도 스킵.
    // 브로드캐스트는 요약본이라 전체 request는 여기서만 필요할 때 조회한다 (커스텀 — 성능)
    const { items } = await window.nais.invoke('queue:pending', undefined)
    const pending = items.filter((i) => i.request.sceneId != null)
    if (pending.length === 0) return
    await ensureExtrasData()
    const byId = new Map(get().scenes.map((s) => [s.id, s]))
    // 큐 반복 항목은 스냅샷 대신 현재 편집본으로 재구성 (역할·캐릭터 변경이 대기 항목에도 반영).
    // 항목이 삭제됐으면 스냅샷으로 폴백해 원래 조합을 유지한다 (커스텀)
    const liveEntries = new Map(
      useSceneExtrasStore.getState().entries.map((e) => [e.id, e] as const)
    )
    const updates: { id: string; request: GenerationRequest }[] = []
    for (const item of pending) {
      const scene = byId.get(item.request.sceneId!)
      if (!scene) continue // 현재 프리셋에 없는 씬(다른 프리셋 대기 항목)은 그대로 둔다
      const snap = item.request.sceneSequenceEntry ?? null
      const entry = snap ? (liveEntries.get(snap.id) ?? snap) : null
      // 시드·i2i 소스는 원래 항목 것을 유지하고, 프롬프트/캐릭터/레퍼런스만 최신으로 재구성
      const rebuilt: GenerationRequest = {
        ...buildSceneRequest(scene, entry),
        seed: item.request.seed,
        source: item.request.source
      }
      updates.push({ id: item.id, request: rebuilt })
    }
    if (updates.length > 0) await window.nais.invoke('queue:updatePending', { updates })
  }
}))

/** 씬 생성 시드 — 시드 고정을 존중 (고정이면 base+offset, 아니면 랜덤) */
function sceneSeed(offset: number): number {
  const g = useGenerationStore.getState()
  return g.seedLocked && g.request.seed >= 0 ? (g.request.seed + offset) % 4294967296 : randomSeed()
}

/** 활성 프리셋의 총 예약 수 (메인 생성 버튼 활성/표시용) */
export function totalReserved(scenes: Scene[]): number {
  return scenes.reduce((sum, s) => sum + s.reserveCount, 0)
}

/**
 * 씬 생성 완료 이벤트 바인딩 (목록 썸네일/개수 + 열린 상세 이미지 갱신).
 * 대량 배치 시 이벤트가 쏟아지므로 디바운스로 DB 부하·리렌더를 줄인다.
 */
export function bindSceneEvents(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let reloadSelected = false
  return window.nais.on('scenes:changed', ({ sceneId, filePath }) => {
    const st = useScenesStore.getState()
    // 완료 즉시 카드 낙관적 갱신 — 스트리밍 프레임이 사라진 뒤 옛 썸네일이 튀는 것 방지.
    // 새 원본을 바로 표시(thumbnail 비워 thumbnailPath로 폴백), load()가 곧 정식 썸네일로 대체.
    st.setSceneThumb(sceneId, filePath)
    if (st.selectedId === sceneId) reloadSelected = true
    clearTimeout(timer)
    timer = setTimeout(() => {
      const s = useScenesStore.getState()
      void s.load()
      if (reloadSelected && s.selectedId != null) void s.loadImages(s.selectedId, true)
      reloadSelected = false
    }, 300)
  })
}
