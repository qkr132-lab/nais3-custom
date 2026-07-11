import { create } from 'zustand'
import type { CharRefItem, CharRefType, ListFolder, VibeItem } from '@shared/types'
import { canonicalize, moveRow, toOrderEntries } from '../lib/folder-list'

/**
 * 바이브 / 캐릭터 레퍼런스 라이브러리 스토어 팩토리.
 * 두 라이브러리가 완전히 같은 폴더 리스트 구조라 하나의 팩토리로 만든다.
 */

interface RefsState<T extends { id: number; folderId: number | null }> {
  folders: ListFolder[]
  items: T[]
  loaded: boolean
  overlayOpen: boolean
  toggleOverlay: () => void
  setOverlayOpen: (open: boolean) => void
  load: () => Promise<void>
  add: (folderId: number | null) => Promise<void>
  update: (id: number, patch: Record<string, unknown>) => void
  /** 여러 아이템에 같은 patch를 한 번에 적용 (일괄 설정) — 건드린 필드만 넘긴다 */
  bulkUpdate: (ids: number[], patch: Record<string, unknown>) => void
  remove: (id: number) => void
  createFolder: (name: string) => Promise<void>
  renameFolder: (id: number, name: string) => void
  toggleCollapse: (id: number) => void
  setFolderColor: (id: number, color: string | null) => void
  removeFolder: (id: number) => void
  move: (activeKey: string, overKey: string) => void
}

function makeRefsStore<T extends { id: number; folderId: number | null }>(ns: string) {
  const ch = {
    list: `${ns}:list`,
    add: `${ns}:add`,
    update: `${ns}:update`,
    delete: `${ns}:delete`,
    reorder: `${ns}:reorder`,
    folderCreate: `${ns}:folderCreate`,
    folderRename: `${ns}:folderRename`,
    folderCollapse: `${ns}:folderCollapse`,
    folderColor: `${ns}:folderColor`,
    folderDelete: `${ns}:folderDelete`
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any

  return create<RefsState<T>>((set, get) => ({
    folders: [],
    items: [],
    loaded: false,
    overlayOpen: false,
    toggleOverlay: () => set({ overlayOpen: !get().overlayOpen }),
    setOverlayOpen: (overlayOpen) => set({ overlayOpen }),

    load: async () => {
      const { folders, items } = await window.nais.invoke(ch.list, undefined)
      set({ folders, items: canonicalize(folders, items as T[]), loaded: true })
    },
    add: async (folderId) => {
      const { count } = await window.nais.invoke(ch.add, { folderId })
      if (count > 0) await get().load()
    },
    update: (id, patch) => {
      set({ items: get().items.map((c) => (c.id === id ? { ...c, ...patch } : c)) })
      void window.nais.invoke(ch.update, { id, patch })
    },
    bulkUpdate: (ids, patch) => {
      if (ids.length === 0 || Object.keys(patch).length === 0) return
      const idset = new Set(ids)
      set({ items: get().items.map((c) => (idset.has(c.id) ? { ...c, ...patch } : c)) })
      // 기존 단건 update 핸들러를 그대로 재사용 — IPC 계약을 늘리지 않는다
      for (const id of ids) void window.nais.invoke(ch.update, { id, patch })
    },
    remove: (id) => {
      set({ items: get().items.filter((c) => c.id !== id) })
      void window.nais.invoke(ch.delete, { id })
      // 씬별 추가·큐 반복·캐릭터 연결에 남은 이 레퍼/바이브 참조 정리 (커스텀 — 정합성)
      const isVibe = ns === 'vibes'
      void import('./scene-extras-store').then((m) =>
        m.useSceneExtrasStore
          .getState()
          .purgeIds(isVibe ? { vibeIds: [id] } : { charRefIds: [id] })
      )
      if (!isVibe) {
        // 이 캐릭레퍼에 연결돼 있던 캐릭터 카드의 연결 해제
        void import('./characters-store').then((m) => {
          for (const c of m.useCharactersStore.getState().items) {
            if (c.charRefId === id) m.useCharactersStore.getState().updateCard(c.id, { charRefId: null })
          }
        })
      }
    },
    createFolder: async (name) => {
      const { id } = await window.nais.invoke(ch.folderCreate, { name })
      set({ folders: [...get().folders, { id, name, collapsed: false, color: null }] })
    },
    renameFolder: (id, name) => {
      set({ folders: get().folders.map((f) => (f.id === id ? { ...f, name } : f)) })
      void window.nais.invoke(ch.folderRename, { id, name })
    },
    toggleCollapse: (id) => {
      const folder = get().folders.find((f) => f.id === id)
      if (!folder) return
      set({
        folders: get().folders.map((f) => (f.id === id ? { ...f, collapsed: !f.collapsed } : f))
      })
      void window.nais.invoke(ch.folderCollapse, { id, collapsed: !folder.collapsed })
    },
    setFolderColor: (id, color) => {
      set({ folders: get().folders.map((f) => (f.id === id ? { ...f, color } : f)) })
      void window.nais.invoke(ch.folderColor, { id, color })
    },
    removeFolder: (id) => {
      const { folders, items } = get()
      const nextItems = items.map((c) => (c.folderId === id ? { ...c, folderId: null } : c))
      const nextFolders = folders.filter((f) => f.id !== id)
      set({ folders: nextFolders, items: canonicalize(nextFolders, nextItems) })
      void window.nais.invoke(ch.folderDelete, { id })
    },
    move: (activeKey, overKey) => {
      const { folders, items } = get()
      const next = moveRow(folders, items, activeKey, overKey)
      set(next)
      void window.nais.invoke(ch.reorder, { order: toOrderEntries(next.folders, next.items) })
    }
  }))
}

export const useVibesStore = makeRefsStore<VibeItem>('vibes')
export const useCharRefsStore = makeRefsStore<CharRefItem>('crefs')

/** 오버레이가 kind로 스토어를 고를 때 쓰는 공통 타입 (두 스토어의 아이템 유니온) */
export type AnyRefsStore = ReturnType<typeof makeRefsStore<VibeItem | CharRefItem>>
export function refsStoreFor(kind: 'vibe' | 'charref'): AnyRefsStore {
  return (kind === 'vibe' ? useVibesStore : useCharRefsStore) as unknown as AnyRefsStore
}

// NAI 웹과 동일 항목 — 캐릭터 연결창(REF_TYPE_LABELS)과 라벨을 맞춘다
export const CHARREF_TYPES: { value: CharRefType; label: string }[] = [
  { value: 'character', label: '캐릭터' },
  { value: 'style', label: '스타일' },
  { value: 'character&style', label: '캐릭터+스타일' },
  { value: 'costume', label: '의상' },
  { value: 'delta', label: '델타' }
]

export function enabledRefCount(): { vibes: number; crefs: number } {
  return {
    vibes: useVibesStore.getState().items.filter((v) => v.enabled).length,
    crefs: useCharRefsStore.getState().items.filter((c) => c.enabled).length
  }
}
