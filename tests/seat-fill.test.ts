import { describe, expect, it } from 'vitest'
import { seatSlots } from '../src/shared/scene-request'
import { decodeSetup, encodeSetup, type SceneSetup } from '../src/shared/scene-bundle'

const slots = (n: number): { x: number; y: number }[] =>
  Array.from({ length: n }, (_, i) => ({ x: (i + 1) / (n + 1), y: 0.5 }))

describe('빈 자리 채우기 (가져온 씬처럼 배정 기록이 없을 때)', () => {
  it('배정도 역할도 없으면 캐릭터를 순서대로 앉힌다', () => {
    const s = seatSlots([{ id: 1 }, { id: 2 }], { slots: slots(2) })
    expect([...s.bySlot.entries()]).toEqual([
      [0, 1],
      [1, 2]
    ])
  })

  it('역할 자리는 역할로 먼저 채우고, 남은 자리(역할 없음)에 남은 캐릭터를 앉힌다', () => {
    // 「고간 만져짐」: 0·1 = 당하는쪽, 2 = 역할 없음(팔만 나오는 남자)
    const s = seatSlots(
      [
        { id: 101, role: 'target' },
        { id: 102, role: 'source' }
      ],
      { slots: slots(3), slotRoles: { 0: 'target', 1: 'target' } }
    )
    expect(s.bySlots.get(101)).toEqual([0, 1])
    expect(s.bySlot.get(2)).toBe(102)
  })

  it('역할이 걸린 빈 자리에 역할이 다른 캐릭터는 앉히지 않는다', () => {
    const s = seatSlots([{ id: 5, role: 'source' }], {
      slots: slots(2),
      slotRoles: { 0: 'target', 1: 'target' }
    })
    expect(s.bySlot.size).toBe(0)
  })

  it('누군가를 직접 앉힌 묶음은 빈 자리를 그대로 둔다 (일부러 비운 자리일 수 있음)', () => {
    const s = seatSlots([{ id: 1 }, { id: 2 }], { slots: slots(3), slotChars: { 1: 2 } })
    expect(s.bySlot.get(1)).toBe(2)
    expect(s.bySlot.has(0)).toBe(false)
    expect(s.bySlot.has(2)).toBe(false)
    // 카드에 자리 번호를 단 것도 배정이다
    const t = seatSlots([{ id: 1, slotNo: 2 }, { id: 2 }], { slots: slots(2) })
    expect([...t.bySlot.entries()]).toEqual([[1, 1]])
  })
})

describe('자리 배정을 카드 이름으로 싣고 돌려받기', () => {
  const setup: SceneSetup = {
    characterIds: [],
    useCoords: true,
    slots: slots(3),
    slotChars: { 0: 101, 2: 102 },
    slotRoles: { 0: 'target' }
  }
  const noCard = (): undefined => undefined
  const nameOf = (id: number): string | undefined =>
    ({ 101: '합성 카드 A', 102: '합성 카드 B' })[id as 101 | 102]

  it('카드를 싣지 않아도 자리 번호 → 이름이 남는다', () => {
    const file = encodeSetup(setup, noCard, undefined, nameOf)
    expect(file.characters).toEqual([])
    expect(file.slotChars).toBeUndefined()
    expect(file.slotCharNames).toEqual({ 0: '합성 카드 A', 2: '합성 카드 B' })
  })

  it('가져오는 쪽의 같은 이름 카드가 그 자리에 앉고, 없는 이름은 못 찾은 연결로 센다', () => {
    const file = JSON.parse(JSON.stringify(encodeSetup(setup, noCard, undefined, nameOf)))
    const r = decodeSetup(
      file,
      () => undefined,
      () => undefined,
      (name) => (name === '합성 카드 A' ? 9001 : undefined)
    )
    expect(r.setup.slotChars).toEqual({ 0: 9001 })
    expect(r.dropped).toBe(1)
    expect(r.setup.useCoords).toBe(true)
    expect(r.setup.slotRoles).toEqual({ 0: 'target' })
  })

  it('이름 없는 카드는 싣지 않는다', () => {
    const file = encodeSetup(setup, noCard, undefined, (id) => (id === 101 ? '  ' : '합성 카드 B'))
    expect(file.slotCharNames).toEqual({ 2: '합성 카드 B' })
  })
})
