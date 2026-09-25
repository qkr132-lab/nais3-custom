import { describe, expect, it } from 'vitest'
import { fingerprint } from '../src/shared/character-backup'
import { decodeSetup, encodeSetup, stripDeadCharacters } from '../src/shared/scene-bundle'
import { partnerTagsFor, withPartnerTags } from '../src/shared/scene-request'

/**
 * 상대 태그 (커스텀) — 하는쪽 카드에 "상대는 이런 표정"을 적어두면
 * 그 캐릭터가 나오는 그림에서 당하는쪽이 받는다.
 */
describe('partnerTagsFor', () => {
  const a = { id: 1, role: 'source' as const, partnerTags: 'glaring, blush' }
  const b = { id: 2, role: 'source' as const, partnerTags: 'smile' }
  const her = { id: 3, role: 'target' as const, partnerTags: 'looking away' }

  it('하는쪽이 적어둔 태그를 당하는쪽이 받는다', () => {
    expect(partnerTagsFor('target', [a, her], 3)).toBe('glaring, blush')
  })

  it('상대가 바뀌면 받는 태그도 바뀐다', () => {
    expect(partnerTagsFor('target', [b, her], 3)).toBe('smile')
  })

  it('하는쪽이 둘이면 둘 다 받는다', () => {
    expect(partnerTagsFor('target', [a, b, her], 3)).toBe('glaring, blush, smile')
  })

  it('반대도 같다 — 당하는쪽이 적은 건 하는쪽이 받는다', () => {
    expect(partnerTagsFor('source', [a, her], 1)).toBe('looking away')
  })

  it('같은 역할끼리는 주고받지 않는다', () => {
    expect(partnerTagsFor('source', [a, b], 1)).toBe('')
  })

  it('역할이 없으면 받지 않는다', () => {
    expect(partnerTagsFor(null, [a], 9)).toBe('')
  })

  it('역할 없는 캐릭터는 주지 않는다', () => {
    expect(partnerTagsFor('target', [{ id: 5, role: null, partnerTags: 'smile' }], 3)).toBe('')
  })

  it('자기 자신에게는 주지 않는다 (한 캐릭터가 두 역할 자리에 앉아도)', () => {
    expect(partnerTagsFor('target', [{ id: 3, role: 'source', partnerTags: 'smile' }], 3)).toBe('')
  })

  it('빈 태그와 끝 쉼표는 걸러낸다', () => {
    expect(
      partnerTagsFor('target', [
        { id: 1, role: 'source', partnerTags: '  ' },
        { id: 2, role: 'source', partnerTags: 'smile, ' }
      ])
    ).toBe('smile')
  })
})

describe('withPartnerTags', () => {
  it('프롬프트 뒤에 붙는다', () => {
    expect(
      withPartnerTags('1girl', 'target', [{ id: 1, role: 'source', partnerTags: 'blush' }], 2)
    ).toBe('1girl, blush')
  })

  it('행위 태그는 받는 쪽 역할로 접두사가 붙는다', () => {
    expect(
      withPartnerTags('1girl', 'target', [{ id: 1, role: 'source', partnerTags: 'hug, blush' }], 2)
    ).toBe('1girl, target#hug, blush')
  })

  it('받을 게 없으면 프롬프트 그대로', () => {
    expect(withPartnerTags('1girl', 'target', [], 2)).toBe('1girl')
  })
})

describe('상대 태그 저장·백업', () => {
  it('씬 전용 상대 태그가 파일로 갔다 돌아온다', () => {
    const file = JSON.parse(
      JSON.stringify(
        encodeSetup({ characterIds: [1, 2], partnerTags: { 1: 'glaring' } }, (id) => `c${id}`)
      )
    )
    const { setup } = decodeSetup(file, (u) => Number(u.slice(1)) + 100)
    expect(setup.partnerTags).toEqual({ 101: 'glaring' })
  })

  it('지운 캐릭터의 상대 태그는 걷어낸다', () => {
    const s = stripDeadCharacters(
      { characterIds: [1, 2], partnerTags: { 1: 'glaring', 2: 'smile' } },
      (id) => id !== 2
    )
    expect(s.partnerTags).toEqual({ 1: 'glaring' })
  })

  it('상대 태그만 다른 카드는 같은 카드로 보지 않는다 (백업 복원 때 덮어써 잃지 않게)', () => {
    const base = { name: 'A', prompt: '1boy', negativePrompt: '', role: 'source' as const }
    expect(fingerprint({ ...base, partnerTags: 'glaring' })).not.toBe(
      fingerprint({ ...base, partnerTags: 'smile' })
    )
    // 상대 태그가 없는 예전 백업은 빈 값과 같게 본다
    expect(fingerprint(base)).toBe(fingerprint({ ...base, partnerTags: '' }))
  })
})
