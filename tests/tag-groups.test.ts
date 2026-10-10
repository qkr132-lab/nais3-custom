import { describe, expect, it } from 'vitest'
import { TAG_GROUPS, tagGroupsFor } from '../src/shared/tag-groups'

/** 한글 묶음 이름으로 태그 묶음 찾기 (커스텀) */
describe('태그 묶음', () => {
  it('묶음 이름과 같으면 exact, 앞부분이면 prefix', () => {
    expect(tagGroupsFor('뒷머리').map((g) => [g.group.names[0], g.exact])).toEqual([
      ['뒷머리', true]
    ])
    expect(tagGroupsFor('뒷머').map((g) => [g.group.names[0], g.exact])).toEqual([
      ['뒷머리', false]
    ])
    expect(tagGroupsFor('머리 길이')[0].group.tags).toContain('very long hair')
  })

  it('한글이 아니거나 한 글자면 묶음으로 보지 않는다', () => {
    expect(tagGroupsFor('bangs')).toEqual([])
    expect(tagGroupsFor('앞')).toEqual([])
  })

  it('부위별로 나뉜다 — 앞머리엔 뱅, 옆머리엔 사이드락, 뒷머리엔 포니테일·번', () => {
    const tags = (name: string): string[] => tagGroupsFor(name)[0].group.tags
    expect(tags('앞머리')).toContain('blunt bangs')
    expect(tags('옆머리')).toContain('sidelocks')
    expect(tags('뒷머리')).toEqual(
      expect.arrayContaining(['ponytail', 'hair bun', 'lone nape hair'])
    )
    expect(tags('앞머리')).not.toContain('ponytail')
  })

  it('묶음 이름이 겹치지 않는다', () => {
    const names = TAG_GROUPS.flatMap((g) => g.names)
    expect(new Set(names).size).toBe(names.length)
  })
})
