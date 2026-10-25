import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() })
  vi.stubGlobal('window', { nais: { invoke: vi.fn() } })
})

import { initLiveResync } from '../src/renderer/src/lib/live-resync'
import { useGenerationStore } from '../src/renderer/src/stores/generation-store'
import { useOutfitsStore } from '../src/renderer/src/stores/outfits-store'
import { useSceneExtrasStore } from '../src/renderer/src/stores/scene-extras-store'
import { useScenesStore } from '../src/renderer/src/stores/scenes-store'

// 옷 벗기기 값을 바꾸면 아직 안 뽑힌 대기 항목도 새 값으로 다시 만든다
describe('생성 중 편집 자동 반영 — 옷 벗기기', () => {
  const resync = vi.fn(async () => {})

  beforeEach(() => {
    vi.useFakeTimers()
    resync.mockClear()
    useScenesStore.setState({ resyncPendingScenes: resync })
    useSceneExtrasStore.setState({ nudeStrips: {} })
    useOutfitsStore.setState({ stripOnNude: false })
    initLiveResync()
  })

  afterEach(() => {
    vi.useRealTimers()
    useGenerationStore.setState({ queue: null })
  })

  const waitingQueue = (): void =>
    useGenerationStore.setState({
      queue: { items: [{ id: 'q1', state: 'pending' }] } as never
    })

  it('씬의 옷 벗기기 값(남캐만 등)을 바꾸면 대기 항목을 다시 만든다', () => {
    waitingQueue()
    useSceneExtrasStore.setState({ nudeStrips: { 1: { 4: 'male' } } })
    vi.advanceTimersByTime(600)
    expect(resync).toHaveBeenCalledTimes(1)
    useSceneExtrasStore.setState({ nudeStrips: { 1: { 4: 'female' } } })
    vi.advanceTimersByTime(600)
    expect(resync).toHaveBeenCalledTimes(2)
  })

  it('전체 설정(누드면 옷 벗기기)을 바꿔도 다시 만든다', () => {
    waitingQueue()
    useOutfitsStore.setState({ stripOnNude: true })
    vi.advanceTimersByTime(600)
    expect(resync).toHaveBeenCalledTimes(1)
  })

  it('대기 항목이 없으면 다시 만들지 않는다', () => {
    useSceneExtrasStore.setState({ nudeStrips: { 1: { 4: true } } })
    vi.advanceTimersByTime(600)
    expect(resync).not.toHaveBeenCalled()
  })

  it('옷 벗기기와 상관없는 변경은 다시 만들지 않는다', () => {
    waitingQueue()
    useSceneExtrasStore.setState({ loaded: true })
    vi.advanceTimersByTime(600)
    expect(resync).not.toHaveBeenCalled()
  })
})
