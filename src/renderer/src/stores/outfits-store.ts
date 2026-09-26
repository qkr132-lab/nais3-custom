import { create } from 'zustand'
import type { Outfit, OutfitPiece } from '@shared/outfit'
import { DEFAULT_EXPOSE_ACTS, type ExposeActs } from '@shared/auto-expose'

const ACTS_KEY = 'outfit_expose_acts'

/**
 * 복장 목록 (커스텀). 생성 요청을 만들 때 동기로 읽어야 해서 앱 시작 때 한 번 불러두고,
 * 고칠 때는 화면을 먼저 바꾸고 저장은 바로 보낸다 (캐릭터 카드와 같은 방식).
 */
interface OutfitsState {
  items: Outfit[]
  loaded: boolean
  /** 자동 젖히기 — 어떤 태그를 "아래/가슴이 드러나는 장면"으로 볼지 (복장 탭에서 고친다) */
  acts: ExposeActs
  setActs: (acts: ExposeActs) => void
  load: () => Promise<void>
  create: (name: string, pieces?: OutfitPiece[]) => Promise<number>
  update: (id: number, patch: { name?: string; pieces?: OutfitPiece[]; negative?: string }) => void
  remove: (id: number) => Promise<void>
  duplicate: (id: number) => Promise<number | null>
}

export const useOutfitsStore = create<OutfitsState>((set, get) => ({
  items: [],
  loaded: false,
  acts: DEFAULT_EXPOSE_ACTS,

  load: async () => {
    const [{ items }, { value }] = await Promise.all([
      window.nais.invoke('outfits:list', undefined),
      window.nais.invoke('settings:get', { key: ACTS_KEY })
    ])
    let acts = DEFAULT_EXPOSE_ACTS
    try {
      const v = value ? (JSON.parse(value) as Partial<ExposeActs>) : null
      if (v && Array.isArray(v.lower) && Array.isArray(v.chest)) acts = { lower: v.lower, chest: v.chest }
    } catch {
      // 깨진 설정은 기본 목록으로
    }
    set({ items, acts, loaded: true })
  },

  setActs: (acts) => {
    set({ acts })
    void window.nais.invoke('settings:set', { key: ACTS_KEY, value: JSON.stringify(acts) })
  },

  create: async (name, pieces) => {
    const { id } = await window.nais.invoke('outfits:create', { name, pieces })
    await get().load()
    return id
  },

  update: (id, patch) => {
    set({ items: get().items.map((o) => (o.id === id ? { ...o, ...patch } : o)) })
    void window.nais.invoke('outfits:update', { id, ...patch })
  },

  remove: async (id) => {
    set({ items: get().items.filter((o) => o.id !== id) })
    await window.nais.invoke('outfits:delete', { id })
    // 이 복장을 기본으로 입던 카드는 기본 복장이 비었다 — 카드 목록을 다시 읽는다
    const { useCharactersStore } = await import('./characters-store')
    await useCharactersStore.getState().load()
  },

  duplicate: async (id) => {
    const r = await window.nais.invoke('outfits:duplicate', { id })
    await get().load()
    return r.id
  }
}))

/** 생성 요청을 만들 때 쓰는 id → 복장 */
export function outfitMap(): Map<number, Outfit> {
  return new Map(useOutfitsStore.getState().items.map((o) => [o.id, o]))
}
