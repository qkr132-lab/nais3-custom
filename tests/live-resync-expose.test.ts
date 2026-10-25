import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() })
  vi.stubGlobal('window', { nais: { invoke: vi.fn() } })
})

import { initLiveResync } from '../src/renderer/src/lib/live-resync'
import { useGenerationStore } from '../src/renderer/src/stores/generation-store'
import { useOutfitsStore } from '../src/renderer/src/stores/outfits-store'
import { useScenesStore } from '../src/renderer/src/stores/scenes-store'
import { DEFAULT_EXPOSE_ACTS } from '../src/shared/auto-expose'

// 입은 옷 자동 젖힘 — 복장·장면 행위 목록·전체 설정을 고치면 아직 안 뽑힌 대기 항목도 새 값으로 다시 만든다
describe('생성 중 편집 자동 반영 — 입은 옷 자동 젖힘', () => {
  const resync = vi.fn(async () => {})

  beforeEach(() => {
    vi.useFakeTimers()
    resync.mockClear()
    useScenesStore.setState({ resyncPendingScenes: resync })
    useOutfitsStore.setState({ items: [], acts: DEFAULT_EXPOSE_ACTS, exposeWorn: true })
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

  it('전체 설정을 바꾸면 다시 만든다', () => {
    waitingQueue()
    useOutfitsStore.setState({ exposeWorn: false })
    vi.advanceTimersByTime(600)
    expect(resync).toHaveBeenCalledTimes(1)
  })

  it('후타 재조립 설정과 시점·구도 설정을 바꾸면 다시 만든다', () => {
    waitingQueue()
    useOutfitsStore.setState({ futaReassembly: false })
    vi.advanceTimersByTime(600)
    expect(resync).toHaveBeenCalledTimes(1)
    useOutfitsStore.setState({ futaViewFix: false })
    vi.advanceTimersByTime(600)
    expect(resync).toHaveBeenCalledTimes(2)
  })

  it('복장을 고치면 다시 만든다', () => {
    waitingQueue()
    useOutfitsStore.setState({
      items: [{ id: 1, name: '교복', negative: '', pieces: [] }]
    })
    vi.advanceTimersByTime(600)
    expect(resync).toHaveBeenCalledTimes(1)
  })

  it('장면 행위 목록을 고치면 다시 만든다', () => {
    waitingQueue()
    useOutfitsStore.setState({ acts: { lower: ['sex'], chest: [] } })
    vi.advanceTimersByTime(600)
    expect(resync).toHaveBeenCalledTimes(1)
  })

  it('대기 항목이 없으면 다시 만들지 않는다', () => {
    useOutfitsStore.setState({ exposeWorn: false })
    vi.advanceTimersByTime(600)
    expect(resync).not.toHaveBeenCalled()
  })

  it('복장과 상관없는 변경은 다시 만들지 않는다', () => {
    waitingQueue()
    useOutfitsStore.setState({ kinds: { skirt: 'cloth' } })
    vi.advanceTimersByTime(600)
    expect(resync).not.toHaveBeenCalled()
  })
})
