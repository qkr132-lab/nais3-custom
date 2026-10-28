import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueueItemLite, QueueStatusLite, TurboNotice, TurboStatus } from '../src/shared/types'

/**
 * 고속 모드 — 렌더러 쪽: 여러 장이 동시에 생성 중일 때 진행 미리보기는 가장 먼저 시작한 한 장만 따라가고,
 * 씬별 생성 중 개수·두 번개 버튼 상태·알림 토스트가 맞는지. 가짜 IPC 이벤트만 쓴다.
 */

const handlers = vi.hoisted(() => {
  const map = new Map<string, (payload: unknown) => void>()
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() })
  vi.stubGlobal('window', {
    nais: {
      invoke: vi.fn(async (channel: string) => {
        if (channel === 'images:list') return { items: [], total: 0 } // 완료 시 히스토리 새로고침
        throw new Error(`예상하지 못한 IPC: ${channel}`)
      }),
      on: (channel: string, listener: (payload: unknown) => void) => {
        map.set(channel, listener)
        return () => map.delete(channel)
      }
    },
    setInterval: () => 0,
    clearInterval: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  })
  vi.stubGlobal('document', {
    visibilityState: 'hidden',
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  })
  return map
})

import {
  bindGenerationEvents,
  useGenerationStore
} from '../src/renderer/src/stores/generation-store'
import {
  turboActiveCount,
  turboOn,
  turboUsable,
  useTurboStore
} from '../src/renderer/src/stores/turbo-store'
import { useToastStore } from '../src/renderer/src/stores/toast-store'

const item = (
  id: string,
  state: QueueItemLite['state'],
  sceneId?: number,
  filePath?: string
): QueueItemLite => ({ id, state, sceneId, filePath })
const queueOf = (items: QueueItemLite[]): QueueStatusLite => ({
  items,
  running: items.some((i) => i.state === 'generating'),
  delayMs: 0
})
const emit = (channel: string, payload: unknown): void => handlers.get(channel)?.(payload)
const progress = (id: string, stepIx: number, previewPng?: string): void =>
  emit('generation:progress', { id, stepIx, totalSteps: 28, previewPng })
const state = (): ReturnType<typeof useGenerationStore.getState> => useGenerationStore.getState()

let unbind: () => void
beforeEach(() => {
  unbind?.()
  handlers.clear()
  useGenerationStore.setState({
    queue: null,
    pendingBySceneId: {},
    generatingBySceneId: {},
    previewSceneId: null,
    previewPng: null,
    progress: null,
    genStartAt: null,
    viewingFilePath: null,
    viewPinned: false
  })
  useTurboStore.setState({ status: null })
  useToastStore.setState({ toasts: [] })
  unbind = bindGenerationEvents()
})

describe('여러 장이 동시에 생성 중일 때의 렌더러 상태', () => {
  it('씬별 생성 중 개수와 대기 수를 따로 센다 (같은 씬 두 장도 2)', () => {
    emit(
      'queue:changed',
      queueOf([
        item('a', 'generating', 1),
        item('b', 'generating', 1),
        item('c', 'generating', 2),
        item('d', 'pending', 1),
        item('e', 'pending', 3)
      ])
    )
    expect(state().generatingBySceneId).toEqual({ 1: 2, 2: 1 })
    expect(state().pendingBySceneId).toEqual({ 1: 1, 3: 1 })
  })

  it('씬별 생성 중 개수가 그대로면 같은 객체를 유지한다 (씬 화면이 불필요하게 다시 그려지지 않게)', () => {
    emit('queue:changed', queueOf([item('a', 'generating', 1), item('b', 'pending', 1)]))
    const first = state().generatingBySceneId
    emit('queue:changed', queueOf([item('a', 'generating', 1), item('b', 'pending', 1)]))
    expect(state().generatingBySceneId).toBe(first)
    emit('queue:changed', queueOf([item('a', 'generating', 1), item('b', 'generating', 2)]))
    expect(state().generatingBySceneId).not.toBe(first)
    expect(state().generatingBySceneId).toEqual({ 1: 1, 2: 1 })
  })

  it('미리보기는 가장 먼저 시작한 한 장만 따라간다 — 다른 장의 진행은 무시', () => {
    emit('queue:changed', queueOf([item('a', 'generating', 1), item('b', 'generating', 2)]))
    expect(state().previewSceneId).toBe(1)
    progress('a', 3, 'frame-a')
    progress('b', 9, 'frame-b')
    progress('a', 4, 'frame-a2')
    progress('b', 10, 'frame-b2')
    expect(state().previewPng).toBe('frame-a2')
    expect(state().progress).toEqual({ stepIx: 4, totalSteps: 28 })
  })

  it('따라가던 장이 끝나면 다음 장으로 넘어가고 진행 표시는 한 번 비운다', () => {
    emit('queue:changed', queueOf([item('a', 'generating', 1), item('b', 'generating', 2)]))
    progress('a', 20, 'frame-a')
    emit('queue:changed', queueOf([item('a', 'done', 1, '/img/a.png'), item('b', 'generating', 2)]))
    expect(state().previewSceneId).toBe(2)
    expect(state().previewPng).toBeNull()
    expect(state().progress).toBeNull()
    expect(state().viewingFilePath).toBe('/img/a.png')
    progress('b', 12, 'frame-b')
    expect(state().previewPng).toBe('frame-b')
    expect(state().progress?.stepIx).toBe(12)
  })

  it('따라가지 않는 장이 먼저 끝나도 도는 장의 미리보기는 지우지 않는다', () => {
    emit('queue:changed', queueOf([item('a', 'generating', 1), item('b', 'generating', 2)]))
    progress('a', 15, 'frame-a')
    emit('queue:changed', queueOf([item('a', 'generating', 1), item('b', 'done', 2, '/img/b.png')]))
    expect(state().previewSceneId).toBe(1)
    expect(state().previewPng).toBe('frame-a')
    expect(state().progress?.stepIx).toBe(15)
    expect(state().viewingFilePath).toBe('/img/b.png')
  })

  it('한 장씩 도는 평소 모드는 예전과 같다 — 끝나면 비우고 새 장의 진행을 받는다', () => {
    emit('queue:changed', queueOf([item('a', 'generating', 1), item('b', 'pending', 1)]))
    progress('a', 5, 'frame-a')
    expect(state().previewSceneId).toBe(1)
    expect(state().generatingBySceneId).toEqual({ 1: 1 })
    emit('queue:changed', queueOf([item('a', 'done', 1, '/img/a.png'), item('b', 'pending', 1)]))
    expect(state().previewPng).toBeNull()
    expect(state().progress).toBeNull()
    expect(state().previewSceneId).toBeNull()
    expect(state().generatingBySceneId).toEqual({})
    emit('queue:changed', queueOf([item('a', 'done', 1, '/img/a.png'), item('b', 'generating', 1)]))
    progress('b', 2, 'frame-b')
    expect(state().previewPng).toBe('frame-b')
  })

  it('메인 탭 항목(씬 없음)을 따라갈 때는 미리보기 씬이 없다', () => {
    emit('queue:changed', queueOf([item('a', 'generating')]))
    expect(state().previewSceneId).toBeNull()
    expect(state().generatingBySceneId).toEqual({})
    progress('a', 1, 'frame')
    expect(state().previewPng).toBe('frame')
  })

  it('진행 이벤트가 큐 알림보다 먼저 와도 그 장을 따라간다', () => {
    progress('a', 1, 'frame-a')
    expect(state().previewPng).toBe('frame-a')
    emit('queue:changed', queueOf([item('a', 'generating', 4), item('b', 'generating', 5)]))
    expect(state().previewSceneId).toBe(4)
  })
})

describe('번개 버튼 상태와 알림', () => {
  const status = (enabled: boolean, accounts: [string, boolean][]): TurboStatus => ({
    enabled,
    accounts: accounts.map(([label, excluded], index) => ({ id: `a${index}`, label, excluded }))
  })

  it('상태 이벤트가 오면 두 버튼이 보는 스토어가 함께 바뀐다', () => {
    emit(
      'turbo:status',
      status(true, [
        ['계정 1', false],
        ['계정 2', false]
      ])
    )
    const s = useTurboStore.getState().status
    expect(turboOn(s)).toBe(true)
    expect(turboActiveCount(s)).toBe(2)
  })

  it('계정이 하나면 쓸 수 없고, 켜져 있어도 켜진 것으로 보지 않는다', () => {
    const s = status(true, [['계정 1', false]])
    expect(turboUsable(s)).toBe(false)
    expect(turboOn(s)).toBe(false)
    expect(turboOn(null)).toBe(false)
  })

  it('×N 은 무료분이 없어 뺀 계정을 세지 않는다', () => {
    const s = status(true, [
      ['계정 1', false],
      ['계정 2', true],
      ['계정 3', false]
    ])
    expect(turboActiveCount(s)).toBe(2)
  })

  it('계정이 빠지면 이름·사유·남은 수를 담은 토스트, 전부 빠지면 오류 토스트', () => {
    const notices: TurboNotice[] = [
      { kind: 'dropped', label: '계정 1', reason: 'exhausted', active: 1 },
      { kind: 'dropped', label: '계정 2', reason: 'unknown', active: 1 },
      { kind: 'allDropped' }
    ]
    for (const n of notices) emit('turbo:notice', n)
    const toasts = useToastStore.getState().toasts
    expect(toasts.map((t) => [t.type, t.message])).toEqual([
      ['info', '"계정 1" 무료분 소진 — 고속 모드에서 뺐습니다 (×1)'],
      ['info', '"계정 2" 무료분 확인 불가 — 고속 모드에서 뺐습니다 (×1)'],
      [
        'error',
        '모든 계정 무료분 소진 — 고속 모드 생성을 멈췄습니다. 번개를 끄면 평소대로 이어집니다'
      ]
    ])
  })

  it('켜기 요청이 실패하면 저장된 상태로 되돌린다', async () => {
    useTurboStore.setState({
      status: status(false, [
        ['계정 1', false],
        ['계정 2', false]
      ])
    })
    ;(window.nais.invoke as ReturnType<typeof vi.fn>).mockImplementation(
      async (channel: string) => {
        if (channel === 'turbo:set') throw new Error('실패')
        if (channel === 'turbo:status')
          return status(false, [
            ['계정 1', false],
            ['계정 2', false]
          ])
        throw new Error(channel)
      }
    )
    await useTurboStore.getState().setEnabled(true)
    expect(useTurboStore.getState().status?.enabled).toBe(false)
  })
})
