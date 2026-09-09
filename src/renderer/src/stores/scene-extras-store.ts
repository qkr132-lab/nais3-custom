import { create } from 'zustand'
import type { CharPositions, CharRoles, SequenceEntry } from '@shared/types'

export type { CharPositions, CharRoles, SequenceEntry }

/**
 * 씬 모드 커스텀 확장 (NAIS2 Custom 이식):
 * - 큐 반복: 캐릭터/캐릭레퍼/바이브 조합 항목을 바꿔가며 예약 전체를 반복 생성.
 *   반복 모드에선 메인 설정의 캐릭터/레퍼런스 대신 항목의 선택만 적용된다.
 * - 씬별 캐릭터 추가: 특정 씬 생성 시에만 추가로 합쳐지는 캐릭터/레퍼런스 선택.
 * 영속: settings KV(JSON) — 백업/복원에 함께 포함된다.
 */

// CharPositions · SequenceEntry 정의는 shared/types.ts로 이동(요청에 실어 재구성용). 위에서 재export.

export interface SceneAddition {
  characterIds: number[]
  charRefIds: number[]
  vibeIds: number[]
  /** 위치 적용 on/off. undefined = 큐 항목을 따르고, 없으면 자리·씬 역할 위치로 자동 결정 */
  useCoords?: boolean
  /** 캐릭터별 위치 오버라이드 (커스텀) */
  positions?: CharPositions
  /** 캐릭터별 행위 역할 (커스텀) — 씬의 하는쪽/당하는쪽 태그가 프롬프트 뒤에 얹힘 */
  roles?: CharRoles
  /**
   * 미리 잡아둔 자리 (커스텀). 캐릭터와 무관하게 좌표만 먼저 정해 둔다 —
   * "이 씬은 2명, 여기랑 여기" 를 캐릭터 없이 짜두고 나중에 채우는 용도.
   */
  slots?: { x: number; y: number }[]
  /** 캐릭터 id → 자리 번호(0-based). 배정된 캐릭터는 그 자리 좌표로 생성된다 */
  slotOf?: Record<number, number>
  /** 자리 번호 → 행위 역할. 그 자리에 꽂는 캐릭터가 이 역할을 물려받는다 */
  slotRoles?: Record<number, 'source' | 'target' | null>
  /**
   * 자리 번호 → 그 자리에 꽂는 캐릭터에게 덧붙는 태그 (커스텀).
   * "1번 자리는 웃는 얼굴" 식으로 자리에 연기를 걸어두면, 어느 캐릭터를 꽂든 그 태그가
   * 카드 태그 뒤에 붙는다. 카드 자체는 건드리지 않으므로 이 씬에만 적용된다.
   */
  slotTags?: Record<number, string>
  /**
   * 자리 번호 → 그 자리에 앉은 캐릭터 id (커스텀).
   * 같은 캐릭터를 여러 자리에 앉힐 수 있다 — 한 카드로 같은 인물을 여러 명 그리는 구도용.
   * 구형 slotOf(캐릭터당 한 자리)는 이게 없을 때만 읽는다.
   */
  slotChars?: Record<number, number>
  /**
   * 캐릭터 id → 이 씬에서만 덧붙는 태그 (커스텀).
   * 카드 태그는 그대로 두고 이 씬에서만 얹는다 — "이 씬에서 이 캐릭터는 교복" 같은 것.
   */
  charTags?: Record<number, string>
}

/** presetId → sceneId → 추가 선택 */
type AdditionsMap = Record<number, Record<number, SceneAddition>>

interface SceneExtrasState {
  loaded: boolean
  sequenceEnabled: boolean
  entries: SequenceEntry[]
  additionsEnabled: boolean
  additions: AdditionsMap

  load: () => Promise<void>
  setSequenceEnabled: (v: boolean) => void
  addEntry: () => void
  updateEntry: (id: string, patch: Partial<SequenceEntry>) => void
  removeEntry: (id: string) => void
  /** 항목 하나를 그 자리에서 여러 항목으로 교체 (커스텀 — "1명씩 분리"용) */
  replaceEntry: (id: string, replacements: SequenceEntry[]) => void
  clearEntries: () => void
  setAdditionsEnabled: (v: boolean) => void
  updateAddition: (presetId: number, sceneId: number, addition: SceneAddition) => void
  clearAddition: (presetId: number, sceneId: number) => void
  /**
   * 씬별 추가·큐 반복에 저장된 '위치 적용' 오버라이드를 전부 지운다 (커스텀).
   * 이 오버라이드는 전역 위치 지정 스위치보다 우선이라, 남아 있으면 전역을 꺼도
   * 그 씬들은 계속 좌표를 쓴다 — "껐는데 유지된다"의 주범.
   */
  clearCoordOverrides: () => void
  /** 위치 적용 오버라이드가 켜진 항목 수 (씬별 추가 / 큐 반복) */
  countCoordOverrides: () => { additions: number; entries: number }
  /** 삭제된 캐릭터/레퍼/바이브 id를 모든 씬별 추가·큐 반복 항목에서 제거 (커스텀 — 정합성) */
  purgeIds: (ids: { characterIds?: number[]; charRefIds?: number[]; vibeIds?: number[] }) => void
}

const SETTINGS_KEY = 'scene_extras'

function persist(): void {
  const s = useSceneExtrasStore.getState()
  // 하이드레이션 전에 저장하면 빈 상태가 디스크의 설정 전체(씬별 캐릭터·역할·큐 항목)를
  // 덮어써 날려버린다 — 재부팅 직후 토글이 설정을 지우던 버그의 원인. 로드 전엔 쓰지 않는다.
  if (!s.loaded) return
  void window.nais.invoke('settings:set', {
    key: SETTINGS_KEY,
    value: JSON.stringify({
      sequenceEnabled: s.sequenceEnabled,
      entries: s.entries,
      additionsEnabled: s.additionsEnabled,
      additions: s.additions
    })
  })
}

export function hasAddition(a: SceneAddition | undefined | null): a is SceneAddition {
  return (
    !!a &&
    // 캐릭터 창/큐에서 함께 나가는 카드의 위치·태그만 고친 경우도 유효한 씬 설정이다.
    // 특히 false는 자동 배치를 끄려는 명시 설정이므로 빈 설정으로 버리면 안 된다.
    (a.characterIds.length > 0 ||
      a.charRefIds.length > 0 ||
      a.vibeIds.length > 0 ||
      (a.slots?.length ?? 0) > 0 ||
      a.useCoords !== undefined ||
      Object.keys(a.positions ?? {}).length > 0 ||
      Object.keys(a.roles ?? {}).length > 0 ||
      Object.keys(a.charTags ?? {}).length > 0)
  )
}

/** 활성 항목들 (큐 반복 실행 대상) */
export function enabledEntries(): SequenceEntry[] {
  const s = useSceneExtrasStore.getState()
  return s.sequenceEnabled ? s.entries.filter((e) => e.enabled) : []
}

export const useSceneExtrasStore = create<SceneExtrasState>((set, get) => ({
  loaded: false,
  sequenceEnabled: false,
  entries: [],
  additionsEnabled: false,
  additions: {},

  load: async () => {
    if (get().loaded) return
    const { value } = await window.nais.invoke('settings:get', { key: SETTINGS_KEY })
    if (value) {
      try {
        const parsed = JSON.parse(value)
        set({
          sequenceEnabled: !!parsed.sequenceEnabled,
          entries: Array.isArray(parsed.entries) ? parsed.entries : [],
          additionsEnabled: !!parsed.additionsEnabled,
          additions: parsed.additions ?? {}
        })
      } catch {
        // 손상된 설정은 무시하고 기본값으로 시작
      }
    }
    set({ loaded: true })
  },

  setSequenceEnabled: (sequenceEnabled) => {
    set({ sequenceEnabled })
    persist()
  },
  addEntry: () => {
    const entry: SequenceEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: `반복 ${get().entries.length + 1}`,
      characterIds: [],
      charRefIds: [],
      vibeIds: [],
      enabled: true
    }
    set({ entries: [...get().entries, entry] })
    persist()
  },
  updateEntry: (id, patch) => {
    set({ entries: get().entries.map((e) => (e.id === id ? { ...e, ...patch } : e)) })
    persist()
  },
  removeEntry: (id) => {
    set({ entries: get().entries.filter((e) => e.id !== id) })
    persist()
  },
  replaceEntry: (id, replacements) => {
    const entries = get().entries
    const at = entries.findIndex((e) => e.id === id)
    if (at < 0 || replacements.length === 0) return
    set({ entries: [...entries.slice(0, at), ...replacements, ...entries.slice(at + 1)] })
    persist()
  },
  clearEntries: () => {
    set({ entries: [] })
    persist()
  },

  setAdditionsEnabled: (additionsEnabled) => {
    set({ additionsEnabled })
    persist()
  },
  updateAddition: (presetId, sceneId, addition) => {
    set({
      additions: {
        ...get().additions,
        [presetId]: { ...(get().additions[presetId] ?? {}), [sceneId]: addition }
      }
    })
    persist()
  },
  clearAddition: (presetId, sceneId) => {
    const preset = { ...(get().additions[presetId] ?? {}) }
    delete preset[sceneId]
    set({ additions: { ...get().additions, [presetId]: preset } })
    persist()
  },

  clearCoordOverrides: () => {
    const { entries, additions } = get()
    const nextEntries = entries.map((e) =>
      e.useCoords === undefined ? e : { ...e, useCoords: undefined }
    )
    const nextAdditions: AdditionsMap = {}
    for (const [pid, scenes] of Object.entries(additions)) {
      nextAdditions[Number(pid)] = Object.fromEntries(
        Object.entries(scenes).map(([sid, a]) => [
          sid,
          a.useCoords === undefined ? a : { ...a, useCoords: undefined }
        ])
      )
    }
    set({ entries: nextEntries, additions: nextAdditions })
    persist()
  },

  countCoordOverrides: () => {
    const { entries, additions } = get()
    let adds = 0
    for (const scenes of Object.values(additions))
      for (const a of Object.values(scenes)) if (a.useCoords !== undefined) adds++
    return { additions: adds, entries: entries.filter((e) => e.useCoords !== undefined).length }
  },

  purgeIds: ({ characterIds, charRefIds, vibeIds }) => {
    const cSet = new Set(characterIds ?? [])
    const rSet = new Set(charRefIds ?? [])
    const vSet = new Set(vibeIds ?? [])
    if (cSet.size === 0 && rSet.size === 0 && vSet.size === 0) return
    // 삭제된 캐릭터의 위치·역할 오버라이드도 함께 제거 (useCoords 등 나머지는 보존)
    const stripPositions = (pos?: CharPositions): CharPositions | undefined => {
      if (!pos) return pos
      const next: CharPositions = {}
      for (const [id, c] of Object.entries(pos)) if (!cSet.has(Number(id))) next[Number(id)] = c
      return next
    }
    const stripRoles = (roles?: CharRoles): CharRoles | undefined => {
      if (!roles) return roles
      const next: CharRoles = {}
      for (const [id, r] of Object.entries(roles)) if (!cSet.has(Number(id))) next[Number(id)] = r
      return next
    }
    // 자리에 앉아 있던 캐릭터가 지워지면 그 자리는 비운다 (유령이 앉아 있지 않게)
    const stripSlotChars = (
      map?: Record<number, number>
    ): Record<number, number> | undefined => {
      if (!map) return map
      const next: Record<number, number> = {}
      for (const [at, id] of Object.entries(map)) if (!cSet.has(id)) next[Number(at)] = id
      return next
    }
    const stripKeyed = <V,>(map?: Record<number, V>): Record<number, V> | undefined => {
      if (!map) return map
      const next: Record<number, V> = {}
      for (const [id, v] of Object.entries(map)) if (!cSet.has(Number(id))) next[Number(id)] = v
      return next
    }
    const filterAdd = (a: SceneAddition): SceneAddition => ({
      ...a,
      characterIds: a.characterIds.filter((id) => !cSet.has(id)),
      charRefIds: a.charRefIds.filter((id) => !rSet.has(id)),
      vibeIds: a.vibeIds.filter((id) => !vSet.has(id)),
      positions: stripPositions(a.positions),
      roles: stripRoles(a.roles),
      slotOf: stripKeyed(a.slotOf),
      slotChars: stripSlotChars(a.slotChars),
      charTags: stripKeyed(a.charTags)
    })
    const nextAdditions: AdditionsMap = {}
    for (const [presetId, scenes] of Object.entries(get().additions)) {
      const nextScenes: Record<number, SceneAddition> = {}
      for (const [sceneId, add] of Object.entries(scenes))
        nextScenes[Number(sceneId)] = filterAdd(add)
      nextAdditions[Number(presetId)] = nextScenes
    }
    set({
      entries: get().entries.map((e) => ({
        ...e,
        characterIds: e.characterIds.filter((id) => !cSet.has(id)),
        charRefIds: e.charRefIds.filter((id) => !rSet.has(id)),
        vibeIds: e.vibeIds.filter((id) => !vSet.has(id)),
        positions: stripPositions(e.positions),
        roles: stripRoles(e.roles),
        slotOf: stripKeyed(e.slotOf),
        slotChars: stripSlotChars(e.slotChars),
        charTags: stripKeyed(e.charTags)
      })),
      additions: nextAdditions
    })
    persist()
  }
}))
