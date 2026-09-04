import { describe, expect, it } from 'vitest'
import { appendPrompt, assignSlots } from '../src/shared/scene-request'

/**
 * 자리 배정 규칙 (커스텀) — 씬 배치 창과 생성이 같은 답을 내야 한다.
 * 한 자리에 둘이 앉으면 NAI가 두 인물을 한 점에 겹쳐 그린다.
 */
describe('assignSlots', () => {
  it('명시 배정을 그대로 쓴다', () => {
    const m = assignSlots([{ id: 1 }, { id: 2 }], { 1: 0, 2: 2 })
    expect(m.get(1)).toBe(0)
    expect(m.get(2)).toBe(2)
  })

  it('배정이 없으면 카드 번호로 앉힌다 (1번 카드 → 0번 자리)', () => {
    const m = assignSlots([{ id: 7, slotNo: 1 }, { id: 8, slotNo: 3 }])
    expect(m.get(7)).toBe(0)
    expect(m.get(8)).toBe(2)
  })

  it('명시 배정이 찬 자리는 같은 번호 카드가 밀고 들어오지 못한다', () => {
    const m = assignSlots([{ id: 1, slotNo: 1 }, { id: 2, slotNo: 1 }], { 2: 0 })
    expect(m.get(2)).toBe(0)
    expect(m.has(1)).toBe(false)
  })

  it('같은 번호를 단 카드가 여럿이면 앞선 캐릭터가 앉는다', () => {
    const m = assignSlots([{ id: 5, slotNo: 2 }, { id: 6, slotNo: 2 }])
    expect(m.get(5)).toBe(1)
    expect(m.has(6)).toBe(false)
  })

  it('번호도 배정도 없으면 앉지 않는다', () => {
    const m = assignSlots([{ id: 1 }, { id: 2, slotNo: null }])
    expect(m.size).toBe(0)
  })

  it('0 이하 번호는 무시한다 (자리 번호는 1부터)', () => {
    const m = assignSlots([{ id: 1, slotNo: 0 }])
    expect(m.size).toBe(0)
  })
})

describe('자리 태그 합치기', () => {
  it('카드 태그 → 자리 태그 → 역할 태그 순으로 이어붙는다', () => {
    expect(appendPrompt(appendPrompt('1girl, blonde', 'smile'), 'target#sex')).toBe(
      '1girl, blonde, smile, target#sex'
    )
  })

  it('자리 태그가 비면 카드 태그가 그대로 남는다', () => {
    expect(appendPrompt(appendPrompt('1girl', ''), '')).toBe('1girl')
  })
})
