import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  hasAddition,
  useSceneExtrasStore,
  type SceneAddition
} from '../src/renderer/src/stores/scene-extras-store'

const addition = (patch: Partial<SceneAddition> = {}): SceneAddition => ({
  characterIds: [],
  charRefIds: [],
  vibeIds: [],
  ...patch
})

describe('씬별 설정 적용 여부', () => {
  it('실제로 빈 설정은 적용하지 않는다', () => {
    expect(hasAddition(undefined)).toBe(false)
    expect(hasAddition(null)).toBe(false)
    expect(hasAddition(addition({ positions: {}, roles: {}, charTags: {}, slots: [] }))).toBe(false)
  })

  it('기본 캐릭터의 좌표만 바꿔도 씬 생성에 포함할 설정으로 남긴다', () => {
    expect(hasAddition(addition({ positions: { 19: { x: 0.25, y: 0.75 } } }))).toBe(true)
  })

  it('캐릭터를 추가로 고르지 않아도 이 씬 태그와 역할을 적용한다', () => {
    expect(hasAddition(addition({ charTags: { 19: 'smile' } }))).toBe(true)
    expect(hasAddition(addition({ roles: { 19: 'source' } }))).toBe(true)
  })

  it('다른 선택이 없어도 명시적인 위치 ON과 OFF를 보존한다', () => {
    expect(hasAddition(addition({ useCoords: true }))).toBe(true)
    expect(hasAddition(addition({ useCoords: false }))).toBe(true)
    expect(hasAddition(addition({ useCoords: undefined }))).toBe(false)
  })

  it('큐에서 물려받은 태그를 빈 값으로 덮는 설정도 버리지 않는다', () => {
    expect(hasAddition(addition({ charTags: { 19: '' } }))).toBe(true)
  })

  it('캐릭터 없이 자리만 미리 잡은 씬과 기존 추가 선택도 유지한다', () => {
    expect(hasAddition(addition({ slots: [{ x: 0.5, y: 0.5 }] }))).toBe(true)
    expect(hasAddition(addition({ characterIds: [19] }))).toBe(true)
    expect(hasAddition(addition({ charRefIds: [7] }))).toBe(true)
    expect(hasAddition(addition({ vibeIds: [5] }))).toBe(true)
  })

  it('씬별 Transparent BG override도 씬 복사·이동과 함께 보존한다', () => {
    useSceneExtrasStore.setState({
      loaded: false,
      transparentBackgrounds: { 1: { 10: false } }
    })
    useSceneExtrasStore
      .getState()
      .copyAdditions([
        { sourcePresetId: 1, sourceSceneId: 10, targetPresetId: 2, targetSceneId: 20 }
      ])
    expect(useSceneExtrasStore.getState().transparentBackgrounds).toEqual({
      1: { 10: false },
      2: { 20: false }
    })

    useSceneExtrasStore
      .getState()
      .moveAdditions([
        { sourcePresetId: 2, sourceSceneId: 20, targetPresetId: 3, targetSceneId: 30 }
      ])
    expect(useSceneExtrasStore.getState().transparentBackgrounds).toEqual({
      1: { 10: false },
      2: {},
      3: { 30: false }
    })
  })
})

describe('씬별 옷 벗기기 값', () => {
  const transfer = (
    sourcePresetId: number,
    sourceSceneId: number,
    targetPresetId: number,
    targetSceneId: number
  ): {
    sourcePresetId: number
    sourceSceneId: number
    targetPresetId: number
    targetSceneId: number
  } => ({
    sourcePresetId,
    sourceSceneId,
    targetPresetId,
    targetSceneId
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('둘 다·안 벗김·남캐만·여캐만 값도 씬 복사·이동과 함께 옮긴다', () => {
    useSceneExtrasStore.setState({
      loaded: false,
      nudeStrips: { 1: { 10: 'male', 11: 'female', 12: true, 13: false } }
    })
    useSceneExtrasStore.getState().copyAdditions([
      transfer(1, 10, 2, 20),
      transfer(1, 11, 2, 21),
      transfer(1, 12, 2, 22),
      transfer(1, 13, 2, 23),
      // 값이 없는 씬은 건너뛴다
      transfer(1, 14, 2, 24)
    ])
    expect(useSceneExtrasStore.getState().nudeStrips).toEqual({
      1: { 10: 'male', 11: 'female', 12: true, 13: false },
      2: { 20: 'male', 21: 'female', 22: true, 23: false }
    })

    useSceneExtrasStore.getState().moveAdditions([transfer(2, 20, 3, 30), transfer(2, 21, 3, 31)])
    expect(useSceneExtrasStore.getState().nudeStrips).toEqual({
      1: { 10: 'male', 11: 'female', 12: true, 13: false },
      2: { 22: true, 23: false },
      3: { 30: 'male', 31: 'female' }
    })
  })

  it('여러 씬에 한 번에 쓰고, undefined 로 지우면 전체 설정 따름으로 돌아간다', () => {
    const invoke = vi.fn(async () => ({}))
    vi.stubGlobal('window', { nais: { invoke } })
    useSceneExtrasStore.setState({ loaded: true, nudeStrips: { 1: { 9: true } } })
    const store = useSceneExtrasStore.getState()
    store.setSceneNudeStrip(1, [10, 11], 'male')
    store.setSceneNudeStrip(1, [12], 'female')
    store.setSceneNudeStrip(1, [9], undefined)
    expect(useSceneExtrasStore.getState().nudeStrips).toEqual({
      1: { 10: 'male', 11: 'male', 12: 'female' }
    })
    // 저장은 문자열 값 그대로 — 옛 true/false 도 같은 자리에 같은 모양으로 남는다
    const calls = invoke.mock.calls as unknown as [string, { key: string; value: string }][]
    const saved = JSON.parse(calls[calls.length - 1][1].value)
    expect(saved.nudeStrips).toEqual({ 1: { 10: 'male', 11: 'male', 12: 'female' } })
  })

  it('저장된 옛 true/false 는 그대로 읽고 새 문자열도 읽고, 모르는 값은 버린다', async () => {
    const stored = JSON.stringify({
      nudeStrips: {
        1: { 10: true, 11: false, 12: 'male', 13: 'female', 14: 'both', 15: 'x', 16: 3 },
        2: 'broken'
      }
    })
    vi.stubGlobal('window', { nais: { invoke: vi.fn(async () => ({ value: stored })) } })
    useSceneExtrasStore.setState({ loaded: false, nudeStrips: {} })
    await useSceneExtrasStore.getState().load()
    expect(useSceneExtrasStore.getState().nudeStrips).toEqual({
      1: { 10: true, 11: false, 12: 'male', 13: 'female', 14: true }
    })
  })
})
