import { create } from 'zustand'

/**
 * 씬 모드 커스텀 확장 (NAIS2 Custom 이식):
 * - 큐 반복: 캐릭터/캐릭레퍼/바이브 조합 항목을 바꿔가며 예약 전체를 반복 생성.
 *   반복 모드에선 메인 설정의 캐릭터/레퍼런스 대신 항목의 선택만 적용된다.
 * - 씬별 캐릭터 추가: 특정 씬 생성 시에만 추가로 합쳐지는 캐릭터/레퍼런스 선택.
 * 영속: settings KV(JSON) — 백업/복원에 함께 포함된다.
 */

export interface SequenceEntry {
  id: string
  name: string
  characterIds: number[]
  charRefIds: number[]
  vibeIds: number[]
  enabled: boolean
}

export interface SceneAddition {
  characterIds: number[]
  charRefIds: number[]
  vibeIds: number[]
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
  clearEntries: () => void
  setAdditionsEnabled: (v: boolean) => void
  updateAddition: (presetId: number, sceneId: number, addition: SceneAddition) => void
  clearAddition: (presetId: number, sceneId: number) => void
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
  }
}))
