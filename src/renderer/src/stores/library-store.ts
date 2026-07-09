import { create } from 'zustand'
import type { LibraryImage } from '@shared/types'
import { toast } from './toast-store'

/**
 * 이미지 라이브러리 스토어 (NAIS2 Library 이식).
 * 참고 이미지를 모아두고 메타데이터 보기 / i2i 소스 / 태그 분석에 쓴다.
 */

interface LibraryState {
  items: LibraryImage[]
  loaded: boolean
  columns: number
  editMode: boolean
  selection: Set<number>
  lastSelectedId: number | null

  load: () => Promise<void>
  add: () => Promise<void>
  addFromPaths: (paths: string[]) => Promise<void>
  rename: (id: number, name: string) => Promise<void>
  remove: (ids: number[]) => Promise<void>
  reorder: (ids: number[]) => Promise<void>

  setColumns: (n: number) => void
  setEditMode: (v: boolean) => void
  toggleSelected: (id: number) => void
  selectRangeTo: (id: number) => void
  selectAll: () => void
  clearSelection: () => void
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  items: [],
  loaded: false,
  columns: Number(localStorage.getItem('library_columns')) || 4,
  editMode: false,
  selection: new Set(),
  lastSelectedId: null,

  load: async () => {
    const { items } = await window.nais.invoke('library:list', undefined)
    set({ items, loaded: true })
  },
  add: async () => {
    const { count } = await window.nais.invoke('library:add', undefined)
    if (count > 0) {
      toast(`이미지 ${count}개 추가됨`, 'success')
      await get().load()
    }
  },
  addFromPaths: async (paths) => {
    const { count } = await window.nais.invoke('library:addFromPaths', { paths })
    if (count > 0) {
      toast(`이미지 ${count}개 추가됨`, 'success')
      await get().load()
    }
  },
  rename: async (id, name) => {
    set({ items: get().items.map((i) => (i.id === id ? { ...i, name } : i)) })
    await window.nais.invoke('library:rename', { id, name })
  },
  remove: async (ids) => {
    set({
      items: get().items.filter((i) => !ids.includes(i.id)),
      selection: new Set(),
      editMode: false
    })
    await window.nais.invoke('library:delete', { ids })
  },
  reorder: async (ids) => {
    set({ items: ids.map((id) => get().items.find((i) => i.id === id)!).filter(Boolean) })
    await window.nais.invoke('library:reorder', { ids })
  },

  setColumns: (columns) => {
    set({ columns })
    localStorage.setItem('library_columns', String(columns))
  },
  setEditMode: (editMode) => set({ editMode, selection: new Set(), lastSelectedId: null }),
  toggleSelected: (id) => {
    const next = new Set(get().selection)
    next.has(id) ? next.delete(id) : next.add(id)
    set({ selection: next, lastSelectedId: id })
  },
  selectRangeTo: (id) => {
    const { items, lastSelectedId, selection } = get()
    const to = items.findIndex((i) => i.id === id)
    const from = lastSelectedId != null ? items.findIndex((i) => i.id === lastSelectedId) : -1
    if (to < 0) return
    const next = new Set(selection)
    if (from < 0) {
      next.add(id)
    } else {
      const [lo, hi] = from <= to ? [from, to] : [to, from]
      for (let i = lo; i <= hi; i++) next.add(items[i].id)
    }
    set({ selection: next, lastSelectedId: id })
  },
  selectAll: () => set({ selection: new Set(get().items.map((i) => i.id)) }),
  clearSelection: () => set({ selection: new Set(), lastSelectedId: null })
}))
