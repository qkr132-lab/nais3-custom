import { useEffect, useMemo, useState } from 'react'
import { promptTagTokens, tagLookupKey, unknownTagRanges } from '@shared/prompt-tag-tokens'

/**
 * 입력창의 "사전에 없는 태그" 범위 (커스텀).
 *
 * 글자가 바뀌면 조금 기다렸다가 아직 모르는 이름만 사전(tags:lookup)에 묻는다. 결과는 앱 전체에서
 * 같은 캐시를 쓴다 — 같은 태그를 칸마다 다시 묻지 않는다. 조회 전인 이름은 빨갛게 칠하지 않는다.
 */
const known = new Map<string, boolean>()
let version = 0
const listeners = new Set<() => void>()
const bump = (): void => {
  version++
  for (const l of listeners) l()
}
const pending = new Set<string>()

async function lookup(keys: string[]): Promise<void> {
  const ask = keys.filter((k) => !known.has(k) && !pending.has(k))
  if (!ask.length) return
  for (const k of ask) pending.add(k)
  try {
    const { items } = await window.nais.invoke('tags:lookup', { tags: ask })
    const found = new Set(items.map((i) => tagLookupKey(i.tag)))
    for (const k of ask) known.set(k, found.has(k))
  } catch {
    // 조회 실패는 모르는 채로 둔다 — 다음 입력 때 다시 묻는다
  } finally {
    for (const k of ask) pending.delete(k)
    bump()
  }
}

export function useUnknownTagRanges(
  value: string,
  enabled: boolean
): { start: number; end: number; text: string }[] {
  const [, setTick] = useState(0)
  useEffect(() => {
    const l = (): void => setTick(version)
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])
  useEffect(() => {
    if (!enabled) return
    const keys = [...new Set(promptTagTokens(value).map((t) => tagLookupKey(t.text)))]
    const missing = keys.filter((k) => !known.has(k))
    if (!missing.length) return
    const timer = setTimeout(() => void lookup(missing), 250)
    return () => clearTimeout(timer)
  }, [value, enabled])
  // version 은 setTick 으로만 바뀌므로 useMemo 의존성엔 tick 대신 known 조회 결과가 반영된다
  return useMemo(
    () => (enabled ? unknownTagRanges(value, (k) => known.get(k)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [value, enabled, version]
  )
}
