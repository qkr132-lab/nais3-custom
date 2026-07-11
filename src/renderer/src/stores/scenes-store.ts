import { create } from 'zustand'
import { recordNav } from '../lib/nav-history'
import type { GenerationRequest, Scene, SceneImage, ScenePreset } from '@shared/types'
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
}

/** 씬 프롬프트를 기본 프롬프트 뒤에 이어붙임 (콤마 정리) */
export function appendPrompt(base: string, add: string): string {
  const b = base.trim().replace(/,\s*$/, '')
  const a = add.trim().replace(/^,\s*/, '')
  if (!b) return a
  if (!a) return b
  return `${b}, ${a}`
}

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

  // 캐릭터: 반복 항목이 있으면 항목 선택, 아니면 메인 enabled. 씬별 추가는 합집합.
  // NAI 동시 캐릭터 한도(6)를 넘지 않게 라이브러리 순서로 자른다.
  const charIds = new Set([
    ...(entry ? entry.characterIds : enabledCharacters().map((c) => c.id)),
    ...(add?.characterIds ?? [])
  ])
  // 위치(좌표): 씬별 추가 > 큐 항목 > 카드 기본 순으로 오버라이드 (커스텀)
  const characterPrompts = useCharactersStore
    .getState()
    .items.filter((c) => charIds.has(c.id) && c.prompt.trim())
    .slice(0, 6)
    .map((c) => ({
      prompt: c.prompt,
      negativePrompt: c.negativePrompt,
      center: add?.positions?.[c.id] ?? entry?.positions?.[c.id] ?? c.center,
      enabled: true as const
    }))
  // 위치 적용 on/off: 씬별 추가 > 큐 항목 > 메인 설정(전역 useCoords) 순 (커스텀)
  const useCoordsOverride = add?.useCoords ?? entry?.useCoords
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
      const enabled = useVibesStore.getState().items.filter((v) => v.enabled).map((v) => v.id)
      vibeIds = [...new Set([...enabled, ...add.vibeIds])]
    }
    if ((add && add.charRefIds.length > 0) || linked.length > 0) {
      const enabled = useCharRefsStore.getState().items.filter((c) => c.enabled).map((c) => c.id)
      charRefIds = [...new Set([...enabled, ...(add?.charRefIds ?? []), ...linked])]
    }
  }

  return {
    ...base,
    prompt: appendPrompt(base.prompt, scene.prompt),
    promptParts: base.promptParts
      ? { ...base.promptParts, detail: appendPrompt(base.promptParts.detail, scene.prompt) }
      : undefined,
    negativePrompt: appendPrompt(base.negativePrompt, scene.negativePrompt),
    width: src ? src.width : scene.width,
    height: src ? src.height : scene.height,
    // 씬별 variety+ 오버라이드 (커스텀) — 켜져 있으면 강제 on, 아니면 메인 설정 따름
    variety: scene.varietyPlus ? true : base.variety,
    // 위치 적용 오버라이드 (커스텀) — 큐/씬별 설정이 있으면 그걸, 없으면 메인 설정
    useCoords: useCoordsOverride ?? base.useCoords,
    characterPrompts,
    vibeIds,
    charRefIds,
    sceneId: scene.id,
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
    const { items } = await window.nais.invoke('scenePresets:list', undefined)
    set({ presets: items })
    if (!items.some((p) => p.id === get().activePresetId) && items[0]) {
      set({ activePresetId: items[0].id })
    }
    await get().load()
  },
  setActivePreset: async (id) => {
    set({ activePresetId: id, selectedId: null, selection: new Set() })
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
    set({ scenes: items })
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
    await Promise.all([get().load(), get().loadTrash()])
  },
  purgeScenes: async (ids) => {
    if (ids.length === 0) return
    await window.nais.invoke('scenes:purge', { ids })
    await get().loadTrash()
  },

  create: async (name) => {
    await window.nais.invoke('scenes:create', { presetId: get().activePresetId, name })
    await get().load()
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
        varietyPlus: patch.varietyPlus
      }
    })
  },
  duplicate: async (id) => {
    await window.nais.invoke('scenes:duplicate', { id })
    await get().load()
  },
  remove: async (id) => {
    const name = get().scenes.find((s) => s.id === id)?.name ?? '씬'
    await window.nais.invoke('scenes:delete', { id })
    if (get().selectedId === id) set({ selectedId: null })
    await get().load()
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
        .filter((i) => i.state === 'pending' && i.request.sceneId === id)
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
        void window.nais.invoke('scenes:update', { id: s.id, patch: { reserveCount: s.reserveCount } })
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
    const ids = get().scenes.filter((s) => get().selection.has(s.id)).map((s) => s.id)
    if (ids.length === 0) return
    for (const id of ids) await window.nais.invoke('scenes:duplicate', { id })
    set({ selection: new Set(), lastSelectedId: null })
    await get().load()
  },

  bulkMove: async (presetId) => {
    const ids = [...get().selection]
    await window.nais.invoke('scenes:bulkMove', { ids, presetId })
    set({ selection: new Set() })
    await get().load()
  },
  // 다른 프리셋으로 "복사" — 원본 유지 (커스텀, 이동=잘라내기와 짝)
  bulkCopy: async (presetId) => {
    const ids = get()
      .scenes.filter((s) => get().selection.has(s.id))
      .map((s) => s.id) // 목록 순서대로
    if (ids.length === 0) return 0
    const { copied } = await window.nais.invoke('scenes:bulkCopy', { ids, presetId })
    return copied
  },
  bulkDelete: async () => {
    const ids = [...get().selection]
    if (ids.length === 0) return
    await window.nais.invoke('scenes:bulkDelete', { ids })
    set({ selection: new Set(), lastSelectedId: null })
    await get().load()
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
