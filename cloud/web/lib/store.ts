/** 아주 작은 상태 저장소 + Preact 훅 — 화면 여러 곳이 같은 값을 볼 때 쓴다 */
import { useEffect, useReducer, useRef } from 'preact/hooks'

export interface Store<T> {
  get(): T
  set(patch: Partial<T> | ((state: T) => Partial<T>)): void
  subscribe(fn: () => void): () => void
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial
  const subs = new Set<() => void>()
  return {
    get: () => state,
    set(patch) {
      const part = typeof patch === 'function' ? patch(state) : patch
      state = { ...state, ...part }
      for (const fn of [...subs]) fn()
    },
    subscribe(fn) {
      subs.add(fn)
      return () => {
        subs.delete(fn)
      }
    }
  }
}

/** 저장소의 일부만 구독한다. 고른 값이 (Object.is 로) 바뀔 때만 다시 그린다 */
export function useStore<T extends object, S>(store: Store<T>, select: (state: T) => S): S {
  const [, force] = useReducer((n: number) => n + 1, 0)
  const selectRef = useRef(select)
  selectRef.current = select
  const value = select(store.get())
  const lastRef = useRef(value)
  lastRef.current = value
  useEffect(
    () =>
      store.subscribe(() => {
        const next = selectRef.current(store.get())
        if (!Object.is(next, lastRef.current)) {
          lastRef.current = next
          force(0)
        }
      }),
    [store]
  )
  return value
}
