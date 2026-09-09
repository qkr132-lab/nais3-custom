import { useEffect, useMemo, useState } from 'react'
import type { IpcInvokeMap } from '@shared/types'
import { useFragmentsStore } from '../stores/fragments-store'

type TokenChannel = 'tokens:count' | 'tokens:preview'
type TokenResponse<C extends TokenChannel> = IpcInvokeMap[C]['res']
const inFlight = new Map<string, Promise<unknown>>()
const fragmentRevisions = new WeakMap<object, WeakMap<object, number>>()
let nextFragmentRevision = 0

function fragmentRevisionFor(items: object, folders: object): number {
  let byFolder = fragmentRevisions.get(items)
  if (!byFolder) {
    byFolder = new WeakMap()
    fragmentRevisions.set(items, byFolder)
  }
  let revision = byFolder.get(folders)
  if (revision === undefined) {
    revision = ++nextFragmentRevision
    byFolder.set(folders, revision)
  }
  return revision
}

function query<C extends TokenChannel>(
  channel: C,
  key: string,
  request: IpcInvokeMap[C]['req']
): Promise<TokenResponse<C>> {
  const existing = inFlight.get(key)
  if (existing) return existing as Promise<TokenResponse<C>>
  const promise = Promise.resolve().then(() => window.nais.invoke(channel, request))
  inFlight.set(key, promise)
  const clear = (): void => {
    if (inFlight.get(key) === promise) inFlight.delete(key)
  }
  void promise.then(clear, clear)
  return promise
}

/** Debounced counts are visible only for the exact current model and inputs. */
export function usePromptTokens<C extends TokenChannel>(
  channel: C,
  request: IpcInvokeMap[C]['req'] | null
): { data: TokenResponse<C> | null; status: 'idle' | 'loading' | 'ready' | 'error' } {
  const serialized = request === null ? null : JSON.stringify(request)
  const fragments = useFragmentsStore((s) => s.items)
  const folders = useFragmentsStore((s) => s.folders)
  const fragmentRevision = useMemo(
    () => fragmentRevisionFor(fragments, folders),
    [fragments, folders]
  )
  const key = serialized === null ? null : `${channel}:${serialized}:${fragmentRevision}`
  const [snapshot, setSnapshot] = useState<{
    key: string | null
    data: TokenResponse<C> | null
    status: 'ready' | 'error'
  }>({ key: null, data: null, status: 'ready' })

  useEffect(() => {
    if (key === null || serialized === null) return
    let cancelled = false
    const timer = setTimeout(() => {
      const input = JSON.parse(serialized) as IpcInvokeMap[C]['req']
      void query(channel, key, input)
        .then((data) => {
          if (!cancelled) setSnapshot({ key, data, status: 'ready' })
        })
        .catch(() => {
          if (!cancelled) setSnapshot({ key, data: null, status: 'error' })
        })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [channel, key, serialized])

  if (key === null) return { data: null, status: 'idle' }
  if (snapshot.key !== key) return { data: null, status: 'loading' }
  return { data: snapshot.data, status: snapshot.status }
}
