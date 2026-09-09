import { create } from 'zustand'
import type { CharacterCard, CharacterCardPatch, ListFolder } from '@shared/types'
import { canonicalize, moveRow, toOrderEntries } from '../lib/folder-list'
import { pushUndo } from './undo-store'

/**
 * 캐릭터 단일 리스트 모델 (공용 폴더 리스트 로직 사용):
 * - 카드가 직접 enabled(생성 포함)·위치·순서를 가진다
 * - 수백 개 전제: 시작 시 1회 로드, 변경은 낙관적 패치 + 즉시 IPC
 */
interface CharactersState {
  folders: ListFolder[]
  items: CharacterCard[]
  loaded: boolean
  overlayOpen: boolean
  toggleOverlay: () => void
  setOverlayOpen: (open: boolean) => void
  load: () => Promise<void>
  createCard: (folderId: number | null) => Promise<void>
  updateCard: (id: number, patch: CharacterCardPatch) => void
  /** 드래그로 좌표를 바꿀 때 — 화면은 즉시, 저장은 묶어서 (IPC 폭주 방지) */
  setCenterLive: (id: number, center: { x: number; y: number }) => void
  /** 활성 캐릭터 전체 해제 */
  disableAll: () => void
  removeCard: (id: number) => void
  /** 여러 카드 한 번에 삭제 — 되돌리기도 한 묶음 */
  removeCards: (ids: number[]) => void
  duplicateCard: (id: number) => Promise<void>
  pickThumbnail: (id: number) => Promise<void>
  clearThumbnail: (id: number) => Promise<void>
  createFolder: (name: string, parentId?: number | null) => Promise<number>
  renameFolder: (id: number, name: string) => void
  toggleCollapse: (id: number) => void
  setFolderColor: (id: number, color: string | null) => void
  removeFolder: (id: number) => void
  /** 폴더를 다른 폴더 안으로 넣거나(부모 id) 밖으로 빼기(null). 2단계까지 */
  setFolderParent: (id: number, parentId: number | null) => void
  /** 폴더와 그 안의 캐릭터를 통째로 삭제 (호출 전 확인은 UI 책임) */
  removeFolderWithItems: (id: number) => void
  move: (activeKey: string, overKey: string) => void
  /** 메타데이터의 캐릭터를 라이브러리로 가져오기 (기존 enabled는 모두 해제 후 새로 추가) */
  importFromMetadata: (
    chars: { prompt: string; negativePrompt: string; center?: { x: number; y: number } }[]
  ) => Promise<void>
}

/** 캐릭터별 좌표 저장 디바운스 타이머 */
const centerSaveTimers = new Map<number, ReturnType<typeof setTimeout>>()

export const useCharactersStore = create<CharactersState>((set, get) => ({
  folders: [],
  items: [],
  loaded: false,
  overlayOpen: false,
  toggleOverlay: () => set({ overlayOpen: !get().overlayOpen }),
  setOverlayOpen: (overlayOpen) => set({ overlayOpen }),

  load: async () => {
    const { folders, items } = await window.nais.invoke('chars:list', undefined)
    set({ folders, items: canonicalize(folders, items), loaded: true })
  },

  createCard: async (folderId) => {
    const { id } = await window.nais.invoke('chars:create', { name: '', folderId })
    const card: CharacterCard = {
      id,
      name: '',
      prompt: '',
      negativePrompt: '',
      thumbnail: '',
      enabled: true,
      center: { x: 0.5, y: 0.5 },
      folderId,
      charRefId: null,
      role: null,
      slotNo: null
    }
    const { folders, items } = get()
    const next = canonicalize(folders, [...items, card])
    set({ items: next })
    get().updateCard(id, { enabled: true })
    void window.nais.invoke('chars:reorder', { order: toOrderEntries(folders, next) })
  },

  updateCard: (id, patch) => {
    // NAI는 모델별 캐릭터 상한 초과 시 실패 — 넘겨 켜는 것을 막는다 (V4.5=6, V5=32)
    if (patch.enabled === true) {
      const enabledCount = get().items.filter((c) => c.enabled && c.id !== id).length
      if (enabledCount >= getMaxCharacters()) return // 무시 (토글 안 됨)
    }
    set({ items: get().items.map((c) => (c.id === id ? { ...c, ...patch } : c)) })
    void window.nais.invoke('chars:update', { id, patch })
  },

  setCenterLive: (id, center) => {
    set({ items: get().items.map((c) => (c.id === id ? { ...c, center } : c)) })
    const timers = centerSaveTimers
    clearTimeout(timers.get(id))
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id)
        void window.nais.invoke('chars:update', { id, patch: { center } })
      }, 250)
    )
  },

  disableAll: () => {
    const enabled = get().items.filter((c) => c.enabled)
    if (!enabled.length) return
    set({ items: get().items.map((c) => (c.enabled ? { ...c, enabled: false } : c)) })
    for (const c of enabled)
      void window.nais.invoke('chars:update', { id: c.id, patch: { enabled: false } })
  },

  removeCard: (id) => {
    const card = get().items.find((c) => c.id === id)
    set({ items: get().items.filter((c) => c.id !== id) })
    void window.nais.invoke('chars:delete', { id })
    // 소프트삭제라 되살릴 수 있다 — Ctrl+Z 한 번으로 원위치 (커스텀)
    if (card)
      pushUndo(`캐릭터 삭제: ${card.name || card.prompt.slice(0, 20)}`, async () => {
        await window.nais.invoke('chars:restore', { ids: [id] })
        await get().load()
      })
    // 씬별 추가·큐 반복에 남은 이 캐릭터 참조 정리 (커스텀 — 정합성)
    void import('./scene-extras-store').then((m) =>
      m.useSceneExtrasStore.getState().purgeIds({ characterIds: [id] })
    )
  },

  removeCards: (ids) => {
    if (!ids.length) return
    const set_ = new Set(ids)
    set({ items: get().items.filter((c) => !set_.has(c.id)) })
    void window.nais.invoke('chars:deleteMany', { ids })
    pushUndo(`캐릭터 ${ids.length}개 삭제`, async () => {
      await window.nais.invoke('chars:restore', { ids })
      await get().load()
    })
    void import('./scene-extras-store').then((m) =>
      m.useSceneExtrasStore.getState().purgeIds({ characterIds: ids })
    )
  },

  duplicateCard: async (id) => {
    await window.nais.invoke('chars:duplicate', { id })
    await get().load()
  },

  pickThumbnail: async (id) => {
    const { thumbnail } = await window.nais.invoke('chars:pickThumbnail', { id })
    if (thumbnail === null) return
    set({ items: get().items.map((c) => (c.id === id ? { ...c, thumbnail } : c)) })
  },
  clearThumbnail: async (id) => {
    set({ items: get().items.map((c) => (c.id === id ? { ...c, thumbnail: '' } : c)) })
    await window.nais.invoke('chars:clearThumbnail', { id })
  },

  createFolder: async (name, parentId = null) => {
    const { id } = await window.nais.invoke('chars:folderCreate', { name, parentId })
    set({
      folders: [
        ...get().folders.map((folder) =>
          folder.id === parentId ? { ...folder, collapsed: false } : folder
        ),
        { id, name, parentId, collapsed: false, color: null }
      ]
    })
    return id
  },

  renameFolder: (id, name) => {
    set({ folders: get().folders.map((f) => (f.id === id ? { ...f, name } : f)) })
    void window.nais.invoke('chars:folderRename', { id, name })
  },

  toggleCollapse: (id) => {
    const folder = get().folders.find((f) => f.id === id)
    if (!folder) return
    set({
      folders: get().folders.map((f) => (f.id === id ? { ...f, collapsed: !f.collapsed } : f))
    })
    void window.nais.invoke('chars:folderCollapse', { id, collapsed: !folder.collapsed })
  },

  setFolderColor: (id, color) => {
    set({ folders: get().folders.map((f) => (f.id === id ? { ...f, color } : f)) })
    void window.nais.invoke('chars:folderColor', { id, color })
  },

  setFolderParent: (id, parentId) => {
    void window.nais.invoke('chars:folderSetParent', { id, parentId }).then(({ ok }) => {
      if (ok) void get().load()
    })
  },

  removeFolder: (id) => {
    const { folders, items } = get()
    const nextItems = items.map((c) => (c.folderId === id ? { ...c, folderId: null } : c))
    const nextFolders = folders.filter((f) => f.id !== id)
    set({ folders: nextFolders, items: canonicalize(nextFolders, nextItems) })
    void window.nais.invoke('chars:folderDelete', { id })
  },

  removeFolderWithItems: (id) => {
    const { folders, items } = get()
    const folder = folders.find((f) => f.id === id)
    set({
      folders: folders.filter((f) => f.id !== id),
      items: items.filter((c) => c.folderId !== id)
    })
    void window.nais
      .invoke('chars:folderDeleteWithItems', { id })
      .then(({ folderIds, cardIds }) => {
        // 폴더·카드 모두 소프트삭제 — Ctrl+Z 한 번에 폴더가 이름·색·순서·중첩 그대로
        // 돌아오고 카드도 그 안에 다시 들어간다.
        pushUndo(`폴더 삭제: ${folder?.name ?? '폴더'} (${cardIds.length}개)`, async () => {
          await window.nais.invoke('chars:folderRestore', { folderIds, cardIds })
          await get().load()
        })
      })
  },

  importFromMetadata: async (chars) => {
    // 1) 기존 enabled 캐릭터 모두 해제 (메타 재현 = 정확히 그 캐릭터만)
    for (const c of get().items) if (c.enabled) get().updateCard(c.id, { enabled: false })
    // 2) 메타 캐릭터를 새 카드로 생성 (가져온 캐릭터 N)
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i]
      const { id } = await window.nais.invoke('chars:create', {
        name: `가져온 캐릭터 ${i + 1}`,
        folderId: null
      })
      const card: CharacterCard = {
        id,
        name: `가져온 캐릭터 ${i + 1}`,
        prompt: ch.prompt,
        negativePrompt: ch.negativePrompt,
        thumbnail: '',
        enabled: true,
        center: ch.center ?? { x: 0.5, y: 0.5 },
        folderId: null,
        charRefId: null,
        role: null,
        slotNo: null
      }
      set({ items: canonicalize(get().folders, [...get().items, card]) })
      get().updateCard(id, {
        name: card.name,
        prompt: card.prompt,
        negativePrompt: card.negativePrompt,
        enabled: true,
        center: card.center
      })
    }
  },

  move: (activeKey, overKey) => {
    const { folders, items } = get()
    const next = moveRow(folders, items, activeKey, overKey)
    set(next)
    void window.nais.invoke('chars:reorder', { order: toOrderEntries(next.folders, next.items) })
  }
}))

/** 생성에 포함될 캐릭터 (정규 순서 = v4 use_order 순서) */
/**
 * NAI 동시 캐릭터 상한 (초과 시 API 실패). 모델 의존 — V4.5=6, V5=32.
 *
 * 스토어끼리 순환 참조가 생기지 않게(generation-store가 이미 이 파일을 읽는다)
 * 모델이 바뀔 때 generation-store가 이 값을 밀어 넣는다. 화면 표시는 컴포넌트가
 * modelCaps(model)로 직접 계산하므로 여기 값은 토글 차단 판정에만 쓴다.
 */
let maxCharacters = 6

export function setMaxCharacters(n: number): void {
  maxCharacters = n
}

export function getMaxCharacters(): number {
  return maxCharacters
}

export function enabledCharacters(): CharacterCard[] {
  return useCharactersStore.getState().items.filter((c) => c.enabled && c.prompt.trim())
}

/** 연결된 캐릭레퍼 id들 (커스텀) — charIds 지정 시 그 캐릭터들, 아니면 enabled 캐릭터 기준 */
export function linkedCharRefIds(charIds?: Set<number>): number[] {
  return useCharactersStore
    .getState()
    .items.filter(
      (c) => (charIds ? charIds.has(c.id) : c.enabled && c.prompt.trim()) && c.charRefId != null
    )
    .map((c) => c.charRefId as number)
}
