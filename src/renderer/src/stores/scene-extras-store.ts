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
  /** 위치 적용 on/off (커스텀). undefined = 메인 설정 따름 */
  useCoords?: boolean
  /** 캐릭터별 위치 오버라이드 (커스텀) */
  positions?: CharPositions
  /** 캐릭터별 행위 역할 (커스텀) — 씬의 하는쪽/당하는쪽 태그가 프롬프트 뒤에 얹힘 */
  roles?: CharRoles
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
  /** 삭제된 캐릭터/레퍼/바이브 id를 모든 씬별 추가·큐 반복 항목에서 제거 (커스텀 — 정합성) */
  purgeIds: (ids: { characterIds?: number[]; charRefIds?: number[]; vibeIds?: number[] }) => void
}

const SETTINGS_KEY = 'scene_extras'

function persist(): void {
  const s = useSceneExtrasStore.getState()
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
  return !!a && (a.characterIds.length > 0 || a.charRefIds.length > 0 || a.vibeIds.length > 0)
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
    const filterAdd = (a: SceneAddition): SceneAddition => ({
      ...a,
      characterIds: a.characterIds.filter((id) => !cSet.has(id)),
      charRefIds: a.charRefIds.filter((id) => !rSet.has(id)),
      vibeIds: a.vibeIds.filter((id) => !vSet.has(id)),
      positions: stripPositions(a.positions),
      roles: stripRoles(a.roles)
    })
    const nextAdditions: AdditionsMap = {}
    for (const [presetId, scenes] of Object.entries(get().additions)) {
      const nextScenes: Record<number, SceneAddition> = {}
      for (const [sceneId, add] of Object.entries(scenes)) nextScenes[Number(sceneId)] = filterAdd(add)
      nextAdditions[Number(presetId)] = nextScenes
    }
    set({
      entries: get().entries.map((e) => ({
        ...e,
        characterIds: e.characterIds.filter((id) => !cSet.has(id)),
        charRefIds: e.charRefIds.filter((id) => !rSet.has(id)),
        vibeIds: e.vibeIds.filter((id) => !vSet.has(id)),
        positions: stripPositions(e.positions),
        roles: stripRoles(e.roles)
      })),
      additions: nextAdditions
    })
    persist()
  }
}))
