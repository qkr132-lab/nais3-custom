import { describe, expect, it } from 'vitest'
import {
  copyCharacterKeys,
  decodeSetup,
  encodeSetup,
  setupHasContent,
  setupReferencedIds,
  type SceneSetup
} from '../src/shared/scene-bundle'
import { linkHasContent } from '../src/shared/character-backup'
import { seatSlots } from '../src/shared/scene-request'
import {
  hasAddition,
  useSceneExtrasStore,
  type SceneAddition
} from '../src/renderer/src/stores/scene-extras-store'

/**
 * 복제·복사·내보내기 때 씬 정보가 빠지던 문제 (1.26.0).
 * 캐릭터 창·큐 항목으로 돌리는 씬은 씬 캐릭터 목록이 비어 있고 역할·태그·복장만 걸려 있다 —
 * 그런 씬을 "빈 설정"으로 보고 버리던 곳들을 막는다.
 */

const addition = (patch: Partial<SceneAddition> = {}): SceneAddition => ({
  characterIds: [],
  charRefIds: [],
  vibeIds: [],
  ...patch
})

describe('역할·태그·복장만 걸린 씬도 설정이 있는 씬이다', () => {
  it('상대 태그만, 복장만 걸어도 생성에 쓰인다', () => {
    expect(hasAddition(addition({ partnerTags: { 7: 'glaring' } }))).toBe(true)
    expect(hasAddition(addition({ outfits: { 7: { outfitId: 3 } } }))).toBe(true)
  })

  it('파일·백업에 실을 때도 빈 구성으로 버리지 않는다', () => {
    const roleOnly: SceneSetup = { characterIds: [], roles: { 7: 'source' } }
    expect(setupHasContent(roleOnly)).toBe(true)
    expect(setupHasContent({ characterIds: [], partnerTags: { 7: 'blush' } })).toBe(true)
    expect(setupHasContent({ characterIds: [], outfits: { 7: { outfitId: 1 } } })).toBe(true)
    expect(setupHasContent({ characterIds: [], roles: {}, charTags: {} })).toBe(false)
  })

  it('역할만 걸린 카드도 파일에 실을 카드로 잡는다 — 그려질 캐릭터로 넣지는 않는다', () => {
    const setup: SceneSetup = {
      characterIds: [1],
      roles: { 7: 'source' },
      charTags: { 8: 'smile' },
      outfits: { 9: { outfitId: 2 } }
    }
    expect(setupReferencedIds(setup).sort()).toEqual([1, 7, 8, 9])
    const file = encodeSetup(setup, (id) => `c${id}`, (id) => `o${id}`)
    expect(file.characters).toEqual(['c1'])
    const back = decodeSetup(
      JSON.parse(JSON.stringify(file)),
      (uid) => Number(uid.slice(1)) + 100,
      (uid) => Number(uid.slice(1)) + 50
    ).setup
    expect(back.characterIds).toEqual([101])
    expect(back.roles).toEqual({ 107: 'source' })
    expect(back.charTags).toEqual({ 108: 'smile' })
    expect(back.outfits).toEqual({ 109: { outfitId: 52 } })
  })

  it('캐릭터 백업 연결도 역할·태그만 있으면 싣는다', () => {
    expect(linkHasContent({ characterUids: [], roles: { c7: 'source' } })).toBe(true)
    expect(linkHasContent({ characterUids: [], partnerTags: { c7: 'blush' } })).toBe(true)
    expect(linkHasContent({ characterUids: [], useCoords: false })).toBe(true)
    expect(linkHasContent({ characterUids: [], roles: {}, positions: {} })).toBe(false)
  })
})

describe('씬 복제는 씬 설정을 통째로 떠 간다', () => {
  it('상대 태그·복장까지 사본으로, 사본을 고쳐도 원본은 그대로', () => {
    useSceneExtrasStore.setState({
      loaded: false,
      transparentBackgrounds: {},
      additions: {
        1: {
          10: addition({
            characterIds: [5],
            roles: { 5: 'source', 6: 'target' },
            partnerTags: { 5: 'disgust' },
            outfits: { 6: { outfitId: 3, off: ['p1'] } },
            slots: [{ x: 0.3, y: 0.5 }],
            slotTags: { 0: 'smile' }
          })
        }
      }
    })
    useSceneExtrasStore
      .getState()
      .copyAdditions([{ sourcePresetId: 1, sourceSceneId: 10, targetPresetId: 1, targetSceneId: 11 }])
    const { additions } = useSceneExtrasStore.getState()
    expect(additions[1][11]).toEqual(additions[1][10])
    additions[1][11].outfits![6].off!.push('p2')
    additions[1][11].partnerTags![5] = 'smile'
    expect(additions[1][10].outfits![6].off).toEqual(['p1'])
    expect(additions[1][10].partnerTags![5]).toBe('disgust')
  })
})

describe('카드 복제 — 원본에 걸린 씬 설정을 사본에도', () => {
  const setup = {
    characterIds: [5],
    roles: { 5: 'target' as const },
    charTags: { 5: 'crying' },
    partnerTags: { 5: 'smirk' },
    outfits: { 5: { outfitId: 3 } },
    positions: { 5: { x: 0.7, y: 0.5 } },
    slots: [{ x: 0.3, y: 0.5 }, { x: 0.7, y: 0.5 }],
    slotChars: { 1: 5 }
  }

  it('역할·씬 태그·상대 태그·복장·위치를 사본 id로도 걸고, 그려질 목록은 건드리지 않는다', () => {
    const next = copyCharacterKeys(setup, 5, 9)
    expect(next.characterIds).toEqual([5])
    expect(next.slotChars).toEqual({ 1: 5 })
    expect(next.roles).toEqual({ 5: 'target', 9: 'target' })
    expect(next.charTags).toEqual({ 5: 'crying', 9: 'crying' })
    expect(next.partnerTags).toEqual({ 5: 'smirk', 9: 'smirk' })
    expect(next.outfits).toEqual({ 5: { outfitId: 3 }, 9: { outfitId: 3 } })
    expect(next.positions![9]).toEqual({ x: 0.7, y: 0.5 })
    expect(next.slotOf).toEqual({ 9: 1 })
  })

  it('원본이 앉던 자리는 사본만 있을 때 사본이 앉고, 둘 다 있으면 원본이 앉는다', () => {
    const next = copyCharacterKeys(setup, 5, 9)
    const onlyCopy = seatSlots([{ id: 9, role: 'target' }], next)
    expect(onlyCopy.bySlot.get(1)).toBe(9)
    const both = seatSlots(
      [
        { id: 5, role: 'target' },
        { id: 9, role: 'target' }
      ],
      next
    )
    expect(both.bySlot.get(1)).toBe(5)
    expect(both.bySlots.get(9)).toBeUndefined()
  })

  it('원본이 안 걸린 씬은 그대로 둔다', () => {
    const other = { characterIds: [1], roles: { 1: 'source' as const } }
    expect(copyCharacterKeys(other, 5, 9)).toBe(other)
  })

  it('스토어 — 모든 씬과 큐 항목에 걸린다', () => {
    useSceneExtrasStore.setState({
      loaded: false,
      additions: { 1: { 10: addition({ roles: { 5: 'target' } }), 11: addition({ roles: { 1: 'source' } }) } },
      entries: [
        {
          id: 'e1',
          name: '기본',
          characterIds: [5],
          charRefIds: [],
          vibeIds: [],
          enabled: true,
          roles: { 5: 'target' },
          charTags: { 5: 'blush' }
        }
      ]
    })
    useSceneExtrasStore.getState().copyCharacterSettings(5, 9)
    const s = useSceneExtrasStore.getState()
    expect(s.additions[1][10].roles).toEqual({ 5: 'target', 9: 'target' })
    expect(s.additions[1][11].roles).toEqual({ 1: 'source' })
    expect(s.entries[0].characterIds).toEqual([5])
    expect(s.entries[0].roles).toEqual({ 5: 'target', 9: 'target' })
    expect(s.entries[0].charTags).toEqual({ 5: 'blush', 9: 'blush' })
  })
})
