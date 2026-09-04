import { describe, expect, it } from 'vitest'
import { appendPrompt, autoRolePrefix, seatSlots } from '../src/shared/scene-request'

const slots = (n: number): { x: number; y: number }[] =>
  Array.from({ length: n }, (_, i) => ({ x: (i + 1) / (n + 1), y: 0.5 }))

/**
 * 좌석 규칙 (커스텀) — 씬 배치 창과 생성이 같은 답을 내야 한다.
 * 한 자리에 둘이 앉으면 NAI가 두 인물을 한 점에 겹쳐 그린다.
 */
describe('seatSlots', () => {
  it('자리에 앉힌 캐릭터를 그대로 쓴다', () => {
    const s = seatSlots([{ id: 1 }, { id: 2 }], { slots: slots(3), slotChars: { 0: 1, 2: 2 } })
    expect(s.bySlot.get(0)).toBe(1)
    expect(s.bySlot.get(2)).toBe(2)
    expect(s.bySlots.get(1)).toEqual([0])
  })

  it('같은 캐릭터를 여러 자리에 앉힐 수 있다 (한 카드로 여러 명)', () => {
    const s = seatSlots([{ id: 7 }], { slots: slots(3), slotChars: { 0: 7, 1: 7, 2: 7 } })
    expect(s.bySlots.get(7)).toEqual([0, 1, 2])
    expect(s.bySlot.size).toBe(3)
  })

  it('자리 수를 벗어난 번호는 앉히지 않는다', () => {
    const s = seatSlots([{ id: 1 }], { slots: slots(2), slotChars: { 5: 1 } })
    expect(s.bySlot.size).toBe(0)
  })

  it('씬에 없는 캐릭터는 앉히지 않는다', () => {
    const s = seatSlots([{ id: 1 }], { slots: slots(2), slotChars: { 0: 99 } })
    expect(s.bySlot.size).toBe(0)
  })

  it('구형 slotOf도 읽는다 (캐릭터당 한 자리)', () => {
    const s = seatSlots([{ id: 4 }, { id: 5 }], { slots: slots(3), slotOf: { 4: 1, 5: 2 } })
    expect(s.bySlot.get(1)).toBe(4)
    expect(s.bySlot.get(2)).toBe(5)
  })

  it('새 배치가 구형 배정을 이긴다', () => {
    const s = seatSlots([{ id: 4 }], { slots: slots(3), slotChars: { 0: 4 }, slotOf: { 4: 2 } })
    expect(s.bySlots.get(4)).toEqual([0])
  })

  it('빈 자리는 카드 번호로 채운다 (1번 카드 → 0번 자리)', () => {
    const s = seatSlots([{ id: 7, slotNo: 1 }, { id: 8, slotNo: 3 }], { slots: slots(3) })
    expect(s.bySlot.get(0)).toBe(7)
    expect(s.bySlot.get(2)).toBe(8)
  })

  it('이미 찬 자리는 같은 번호 카드가 밀고 들어오지 못한다', () => {
    const s = seatSlots([{ id: 1, slotNo: 1 }, { id: 2 }], {
      slots: slots(2),
      slotChars: { 0: 2 }
    })
    expect(s.bySlot.get(0)).toBe(2)
    expect(s.bySlots.has(1)).toBe(false)
  })

  it('이미 어딘가 앉은 캐릭터는 번호로 또 앉지 않는다', () => {
    const s = seatSlots([{ id: 9, slotNo: 1 }], { slots: slots(2), slotChars: { 1: 9 } })
    expect(s.bySlots.get(9)).toEqual([1])
  })

  it('같은 번호를 단 카드가 여럿이면 앞선 캐릭터가 앉는다', () => {
    const s = seatSlots([{ id: 5, slotNo: 2 }, { id: 6, slotNo: 2 }], { slots: slots(3) })
    expect(s.bySlot.get(1)).toBe(5)
    expect(s.bySlots.has(6)).toBe(false)
  })

  it('자리가 없으면 아무도 앉지 않는다', () => {
    const s = seatSlots([{ id: 1, slotNo: 1 }], {})
    expect(s.bySlot.size).toBe(0)
  })

  it('0 이하 번호는 무시한다 (자리 번호는 1부터)', () => {
    const s = seatSlots([{ id: 1, slotNo: 0 }], { slots: slots(2) })
    expect(s.bySlot.size).toBe(0)
  })
})

describe('태그 층 쌓기', () => {
  it('카드 → 이 씬 태그 → 자리 태그 → 역할 태그 순으로 이어붙는다', () => {
    const built = appendPrompt(
      appendPrompt(appendPrompt('1girl, blonde', 'school uniform'), 'smile'),
      'target#sex'
    )
    expect(built).toBe('1girl, blonde, school uniform, smile, target#sex')
  })

  it('빈 층은 건너뛴다', () => {
    expect(appendPrompt(appendPrompt(appendPrompt('1girl', ''), 'smile'), '')).toBe('1girl, smile')
  })
})

describe('자리 태그의 역할 접두사', () => {
  it('자리 역할이 있으면 행위 태그에 접두사가 자동으로 붙는다', () => {
    expect(autoRolePrefix('sex, ahegao', 'target')).toBe('target#sex, ahegao')
    expect(autoRolePrefix('sex, ahegao', 'source')).toBe('source#sex, ahegao')
  })

  it('표정·포즈 같은 일반 태그는 건드리지 않는다', () => {
    expect(autoRolePrefix('smile, looking at viewer', 'target')).toBe('smile, looking at viewer')
  })

  it('이미 접두사를 적었으면 그대로 둔다', () => {
    expect(autoRolePrefix('source#sex', 'target')).toBe('source#sex')
  })

  it('같은 당하는쪽이라도 자리마다 다른 행위가 들어간다', () => {
    const seatA = appendPrompt('1girl', autoRolePrefix('fellatio, blush', 'target'))
    const seatB = appendPrompt('1girl', autoRolePrefix('sex, ahegao', 'target'))
    expect(seatA).toBe('1girl, target#fellatio, blush')
    expect(seatB).toBe('1girl, target#sex, ahegao')
  })
})
