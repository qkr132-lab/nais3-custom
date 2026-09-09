import { describe, expect, it } from 'vitest'
import { hasAddition, type SceneAddition } from '../src/renderer/src/stores/scene-extras-store'

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
})
