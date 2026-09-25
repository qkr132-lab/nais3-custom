import { describe, expect, it } from 'vitest'
import {
  decodeSetup,
  encodeSetup,
  isSceneBundle,
  pruneSceneExtras,
  setupHasContent,
  withShared,
  type SceneSetup
} from '../src/shared/scene-bundle'
import { seatSlots } from '../src/shared/scene-request'

const uidOf = (id: number): string | undefined => (id === 999 ? undefined : `c${id}`)

/** 파일로 갔다가 새 id(원래 id + 1000)로 돌아온다 — 다른 PC에서 가져온 상황 */
function roundTrip(setup: SceneSetup): { setup: SceneSetup; dropped: number } {
  const file = JSON.parse(JSON.stringify(encodeSetup(setup, uidOf)))
  return decodeSetup(file, (uid) => (uid.startsWith('c') ? Number(uid.slice(1)) + 1000 : undefined))
}

describe('씬 구성 왕복', () => {
  it('씬별 캐릭터·위치·역할·좌표 사용이 살아서 돌아온다', () => {
    const { setup } = roundTrip({
      characterIds: [1, 2],
      useCoords: true,
      positions: { 1: { x: 0.2, y: 0.3 } },
      roles: { 1: 'source', 2: 'target' }
    })
    expect(setup.characterIds).toEqual([1001, 1002])
    expect(setup.useCoords).toBe(true)
    expect(setup.positions).toEqual({ 1001: { x: 0.2, y: 0.3 } })
    expect(setup.roles).toEqual({ 1001: 'source', 1002: 'target' })
  })

  it('한 카드가 두 자리에 앉은 배치와 자리마다 다른 태그가 그대로 돌아온다', () => {
    const { setup } = roundTrip({
      characterIds: [1, 2],
      slots: [
        { x: 0.2, y: 0.8 },
        { x: 0.7, y: 0.5 }
      ],
      slotChars: { 0: 2, 1: 2 },
      slotRoles: { 0: 'target', 1: 'target' },
      slotTags: { 0: 'sitting, from side', 1: 'close-up, smile' },
      charTags: { 1: 'standing' }
    })
    expect(setup.slots).toHaveLength(2)
    expect(setup.slotChars).toEqual({ 0: 1002, 1: 1002 })
    expect(setup.slotRoles).toEqual({ 0: 'target', 1: 'target' })
    expect(setup.slotTags).toEqual({ 0: 'sitting, from side', 1: 'close-up, smile' })
    expect(setup.charTags).toEqual({ 1001: 'standing' })
  })

  it('돌아온 배치로 앉혀도 같은 자리에 같은 캐릭터가 앉는다', () => {
    const before: SceneSetup = {
      characterIds: [1, 2],
      slots: [
        { x: 0.2, y: 0.8 },
        { x: 0.7, y: 0.5 }
      ],
      slotChars: { 0: 2, 1: 2 }
    }
    const { setup: after } = roundTrip(before)
    const seatBefore = seatSlots([{ id: 1 }, { id: 2 }], before)
    const seatAfter = seatSlots([{ id: 1001 }, { id: 1002 }], after)
    expect(seatAfter.bySlots.get(1002)).toEqual(seatBefore.bySlots.get(2))
  })

  it('구형 배정(slotOf)은 새 방식으로 정리돼 실린다', () => {
    const { setup } = roundTrip({
      characterIds: [1, 2],
      slots: [
        { x: 0.3, y: 0.5 },
        { x: 0.7, y: 0.5 }
      ],
      slotOf: { 1: 0, 2: 1 }
    })
    expect(setup.slotChars).toEqual({ 0: 1001, 1: 1002 })
    expect(setup.slotOf).toBeUndefined()
  })

  it('구형 배정은 이미 찬 자리를 밀어내지 않는다 (seatSlots와 같은 규칙)', () => {
    const { setup } = roundTrip({
      characterIds: [1, 2],
      slots: [{ x: 0.5, y: 0.5 }],
      slotChars: { 0: 1 },
      slotOf: { 2: 0 }
    })
    expect(setup.slotChars).toEqual({ 0: 1001 })
  })

  it('자리 수를 넘는 번호의 역할·태그·좌석은 싣지 않는다', () => {
    const { setup } = roundTrip({
      characterIds: [1],
      slots: [{ x: 0.5, y: 0.5 }],
      slotChars: { 3: 1 },
      slotRoles: { 3: 'target' },
      slotTags: { 3: 'smile' }
    })
    expect(setup.slotChars).toBeUndefined()
    expect(setup.slotRoles).toBeUndefined()
    expect(setup.slotTags).toBeUndefined()
  })

  it('파일에 없는 캐릭터를 가리키는 연결은 그것만 빠지고 센다', () => {
    const { setup, dropped } = decodeSetup(
      { characters: ['c1', 'ghost'], charTags: { ghost: 'x' }, slots: [{ x: 0, y: 0 }], slotChars: { 0: 'ghost' } },
      (uid) => (uid === 'c1' ? 11 : undefined)
    )
    expect(setup.characterIds).toEqual([11])
    expect(setup.slotChars).toBeUndefined()
    expect(dropped).toBe(3)
  })

  it('빈 태그와 빈 맵은 싣지 않는다', () => {
    const file = encodeSetup(
      { characterIds: [1], slots: [], slotTags: { 0: '  ' }, charTags: { 1: '' }, positions: {} },
      uidOf
    )
    expect(file).toEqual({ characters: ['c1'] })
  })

  it('바이브·캐릭레퍼 연결은 파일에 없으니 빈 채로 돌아온다', () => {
    const { setup } = roundTrip({ characterIds: [1], charRefIds: [5], vibeIds: [6] })
    expect(setup.charRefIds).toEqual([])
    expect(setup.vibeIds).toEqual([])
  })

  it('자리만 잡아둔 구성도 내용이 있는 것으로 본다', () => {
    expect(setupHasContent({ characterIds: [], slots: [{ x: 0.5, y: 0.5 }] })).toBe(true)
    expect(setupHasContent({ characterIds: [] })).toBe(false)
  })
})

describe('휴지통 흔적 정리', () => {
  const extras = {
    additionsEnabled: true,
    additions: {
      '1': {
        '10': { characterIds: [1, 2], slots: [{ x: 0, y: 0 }], slotChars: { 0: 2 }, charTags: { 2: 'x' } },
        '11': { characterIds: [1] }
      }
    },
    entries: [{ id: 'e', name: '반복', enabled: true, characterIds: [1, 2], roles: { 2: 'target' as const } }]
  }
  const pruned = pruneSceneExtras(
    extras,
    (sid) => sid !== 11,
    (cid) => cid !== 2
  )

  it('지운 씬의 씬별 추가 설정을 뺀다', () => {
    expect(Object.keys(pruned.additions!['1'])).toEqual(['10'])
  })

  it('지운 캐릭터를 가리키는 좌석·태그·목록을 걷어낸다', () => {
    const s = pruned.additions!['1']['10']
    expect(s.characterIds).toEqual([1])
    expect(s.slotChars).toEqual({})
    expect(s.charTags).toEqual({})
    expect(s.slots).toHaveLength(1) // 자리 자체는 남긴다 — 빈 자리일 뿐
  })

  it('큐 항목에서도 걷어낸다', () => {
    expect(pruned.entries![0].characterIds).toEqual([1])
    expect(pruned.entries![0].roles).toEqual({})
  })
})

describe('씬 JSON 포맷 감지', () => {
  it('v2만 번들로 본다', () => {
    expect(isSceneBundle({ version: 2, characters: [], scenes: [] })).toBe(true)
    expect(isSceneBundle({ version: 1, scenes: [] })).toBe(false)
    expect(isSceneBundle({ version: 2, scenes: [] })).toBe(false)
  })
})

describe('한 캐릭터는 씬별 추가, 다른 캐릭터는 캐릭터 창에서 켜둔 구성', () => {
  // 원래 PC: 캐릭터 1만 씬별 추가(하는쪽), 캐릭터 2는 캐릭터 창에서 켜져 있고 카드 역할이 당하는쪽
  const scene: SceneSetup = {
    characterIds: [1],
    roles: { 1: 'source' },
    slots: [
      { x: 0.25, y: 0.75 },
      { x: 0.75, y: 0.5 }
    ],
    slotRoles: { 0: 'target', 1: 'target' },
    slotTags: { 0: '1girl, sitting, from side', 1: '1girl, close-up, smile' },
    charTags: { 1: '1boy, standing' }
  }
  const uid = (id: number): string => `c${id}`
  const file = JSON.parse(JSON.stringify(encodeSetup(scene, uid)))
  // 다른 PC에서 새 id로: 1 → 7, 2 → 8
  const newId = (u: string): number | undefined => ({ c1: 7, c2: 8 })[u]
  const imported = withShared(decodeSetup(file, newId).setup, [8])

  it('공용으로 실린 여자가 씬에 들어온다', () => {
    expect(imported.characterIds).toEqual([7, 8])
  })

  it('여자가 당하는쪽 자리 둘에 알아서 앉아 인물이 셋 나온다', () => {
    const seating = seatSlots(
      [
        { id: 7, role: 'source' },
        { id: 8, role: 'target' }
      ],
      imported
    )
    expect(seating.bySlots.get(8)).toEqual([0, 1])
    expect(seating.bySlots.has(7)).toBe(false) // 남자는 자리 없이 따로 — 인물 1 + 여자 2 = 3
  })

  it('자리 태그·씬 태그가 그대로 따라온다', () => {
    expect(imported.slotTags).toEqual(scene.slotTags)
    expect(imported.charTags).toEqual({ 7: '1boy, standing' })
    expect(imported.roles).toEqual({ 7: 'source' })
  })

  it('공용 카드는 씬에서 고른 캐릭터 뒤에 붙고 중복되지 않는다', () => {
    expect(withShared({ characterIds: [8, 3] }, [8, 9]).characterIds).toEqual([8, 3, 9])
  })
})
