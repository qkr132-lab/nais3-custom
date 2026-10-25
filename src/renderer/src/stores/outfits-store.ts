import { create } from 'zustand'
import type { Outfit, OutfitPiece, TagKind } from '@shared/outfit'
import {
  DEFAULT_EXPOSE_ACTS,
  EXPOSE_ACTS_VERSION,
  withDefaultActs,
  type ExposeActs
} from '@shared/auto-expose'
import { promptTags } from '@shared/nude-strip'

const ACTS_KEY = 'outfit_expose_acts'
const STRIP_KEY = 'nude_strip_clothes'
const EXPOSE_WORN_KEY = 'expose_worn_clothes'
const FUTA_REASSEMBLY_KEY = 'futa_reassembly'
const FUTA_VIEW_FIX_KEY = 'futa_view_fix'

/** 저장 모양 — 어느 판의 기본 목록까지 더했는지(v)를 같이 적는다 */
const actsJson = (acts: ExposeActs): string =>
  JSON.stringify({ lower: acts.lower, chest: acts.chest, v: EXPOSE_ACTS_VERSION })

/**
 * 복장 목록 (커스텀). 생성 요청을 만들 때 동기로 읽어야 해서 앱 시작 때 한 번 불러두고,
 * 고칠 때는 화면을 먼저 바꾸고 저장은 바로 보낸다 (캐릭터 카드와 같은 방식).
 */
interface OutfitsState {
  items: Outfit[]
  loaded: boolean
  /** nsfw 조각이 켜지는 장면 — 어떤 태그를 "아래/가슴이 드러나는 장면"으로 볼지 (복장 탭에서 고친다) */
  acts: ExposeActs
  setActs: (acts: ExposeActs) => void
  /** 누드면 옷 벗기기 — 장면에 nude가 있으면 복장을 빼고 카드의 옷 태그를 걷어낸다 (설정, 기본 켬) */
  stripOnNude: boolean
  setStripOnNude: (v: boolean) => void
  /**
   * 입은 옷 자동 젖힘 — 씬 태그가 아래·가슴을 드러내는 장면이면 카드에 적은 옷과 복장 조각에 맞는 젖힘 태그를 붙인다 (설정, 기본 켬).
   * 붙은 태그와 안 붙은 이유는 요청의 exposeNotes 로 화면에 보인다. 끄면 이 기능이 없던 때와 글자 단위로 같다
   */
  exposeWorn: boolean
  setExposeWorn: (v: boolean) => void
  /**
   * 후타 자동 재조립 — 카드에 futanari 가 있는 캐릭터가 그려지면, 씬 글의 남자 장면 선언(hetero·1boy·faceless male·male 구절·he/his)을
   * 후타 구성에 맞게 바꾸고 no testicles 를 더한다 (설정, 기본 켬). 바꾼 것은 요청의 bodyNotes 로 화면에 보인다.
   * 끄면 후타를 읽지 않아 이 기능이 없던 때와 글자 단위로 같다 (알몸 여성 캐릭터의 pink nipples 만 고정 규칙이라 그대로)
   */
  futaReassembly: boolean
  setFutaReassembly: (v: boolean) => void
  /** 후타 재조립 가운데 시점·구도(pov → from side, head out of frame·lower body·penis focus 빼기)만 따로 끄는 설정 (기본 켬) */
  futaViewFix: boolean
  setFutaViewFix: (v: boolean) => void
  /** 태그 → 옷/알몸/몸/모름. 분류 자료가 메인에 있어 생성 직전에 모자란 것만 물어 채운다 */
  kinds: Record<string, TagKind>
  ensureKinds: (prompts: string[]) => Promise<void>
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
  stripOnNude: true,
  exposeWorn: true,
  futaReassembly: true,
  futaViewFix: true,
  kinds: {},

  load: async () => {
    const [{ items }, { value }, strip, expose, futa, futaView] = await Promise.all([
      window.nais.invoke('outfits:list', undefined),
      window.nais.invoke('settings:get', { key: ACTS_KEY }),
      window.nais.invoke('settings:get', { key: STRIP_KEY }),
      window.nais.invoke('settings:get', { key: EXPOSE_WORN_KEY }),
      window.nais.invoke('settings:get', { key: FUTA_REASSEMBLY_KEY }),
      window.nais.invoke('settings:get', { key: FUTA_VIEW_FIX_KEY })
    ])
    let acts = DEFAULT_EXPOSE_ACTS
    try {
      const v = value ? (JSON.parse(value) as Partial<ExposeActs> & { v?: number }) : null
      if (v && Array.isArray(v.lower) && Array.isArray(v.chest)) {
        acts = { lower: v.lower, chest: v.chest }
        // 앱을 올려 기본 목록이 늘었으면 새 기본 태그를 더해 두고, 고친 것은 그대로 둔다
        if (v.v !== EXPOSE_ACTS_VERSION) {
          acts = withDefaultActs(acts)
          void window.nais.invoke('settings:set', { key: ACTS_KEY, value: actsJson(acts) })
        }
      }
    } catch {
      // 깨진 설정은 기본 목록으로
    }
    set({
      items,
      acts,
      stripOnNude: strip.value !== '0',
      exposeWorn: expose.value !== '0',
      futaReassembly: futa.value !== '0',
      futaViewFix: futaView.value !== '0',
      loaded: true
    })
  },

  setActs: (acts) => {
    set({ acts })
    void window.nais.invoke('settings:set', { key: ACTS_KEY, value: actsJson(acts) })
  },

  setStripOnNude: (stripOnNude) => {
    set({ stripOnNude })
    void window.nais.invoke('settings:set', { key: STRIP_KEY, value: stripOnNude ? '1' : '0' })
  },

  setExposeWorn: (exposeWorn) => {
    set({ exposeWorn })
    void window.nais.invoke('settings:set', {
      key: EXPOSE_WORN_KEY,
      value: exposeWorn ? '1' : '0'
    })
  },

  setFutaReassembly: (futaReassembly) => {
    set({ futaReassembly })
    void window.nais.invoke('settings:set', {
      key: FUTA_REASSEMBLY_KEY,
      value: futaReassembly ? '1' : '0'
    })
  },

  setFutaViewFix: (futaViewFix) => {
    set({ futaViewFix })
    void window.nais.invoke('settings:set', {
      key: FUTA_VIEW_FIX_KEY,
      value: futaViewFix ? '1' : '0'
    })
  },

  ensureKinds: async (prompts) => {
    const known = get().kinds
    // 복장 조각 태그도 함께 — 누드 조각을 켜면 다른 조각의 옷을 가려내야 한다
    const pieces = get().items.flatMap((o) => o.pieces.map((p) => p.tags))
    const missing = promptTags([...prompts, ...pieces]).filter((t) => !(t in known))
    if (!missing.length) return
    const { kinds } = await window.nais.invoke('outfits:classifyTags', { tags: missing })
    set({ kinds: { ...get().kinds, ...kinds } })
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

/** 생성 요청을 만들 때 쓰는 태그 → 옷 분류 (아직 안 물어본 태그는 '모름' — 카드에 남긴다) */
export function clothKindOf(): (tag: string) => TagKind {
  const kinds = useOutfitsStore.getState().kinds
  return (tag) => kinds[tag] ?? 'unknown'
}

/** 생성 요청을 만들 때 쓰는 id → 복장 */
export function outfitMap(): Map<number, Outfit> {
  return new Map(useOutfitsStore.getState().items.map((o) => [o.id, o]))
}
