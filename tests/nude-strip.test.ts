import { describe, expect, it } from 'vitest'
import { nudeTrigger, promptTags, stripClothing, undressForNude } from '../src/shared/nude-strip'
import type { TagKind } from '../src/shared/outfit'

/** 테스트용 옷 분류 — 실제 앱은 메인의 태그 자료로 나눈다 */
const CLOTH = new Set([
  'school uniform',
  'pleated skirt',
  'white shirt',
  'black thighhighs',
  'red ribbon hat',
  'blazer',
  'black dress',
  'eyepatch',
  'red hair ribbon'
])
const kindOf = (tag: string): TagKind =>
  CLOTH.has(tag) ? 'cloth' : tag === 'nude' ? 'bare' : 'body'

describe('누드 태그 찾기', () => {
  it('nude·completely nude·naked 한 가지를 장면 태그에서 찾는다', () => {
    expect(nudeTrigger(['1girl, bathing, nude, steam'])).toBe('nude')
    expect(nudeTrigger(['', '1.2::completely nude::'])).toBe('completely nude')
    expect(nudeTrigger(['onsen, naked towel'])).toBe('naked towel')
    expect(nudeTrigger(['target#nude'])).toBe('nude')
  })

  it('주석 처리한 누드·랜덤 선택지 안의 누드는 신호가 아니다', () => {
    expect(nudeTrigger(['onsen, steam\n# alt: towel, nude'])).toBeNull()
    expect(nudeTrigger(['onsen, steam # nude, blush'])).toBeNull()
    expect(nudeTrigger(['(bath, nude, steam/beach, swimsuit)'])).toBeNull()
    expect(nudeTrigger(['nude/swimsuit'])).toBeNull()
    expect(nudeTrigger(['onsen # 나중에\nnude'])).toBe('nude')
  })

  it('빼달라는 음수 가중치나 누드가 아닌 노출 태그는 신호가 아니다', () => {
    expect(nudeTrigger(['-1::nude::, school uniform'])).toBeNull()
    expect(nudeTrigger(['topless female, bottomless'])).toBeNull()
    expect(nudeTrigger(['nude filter'])).toBeNull()
  })
})

describe('카드에서 옷 태그 걷어내기', () => {
  it('옷 태그만 빼고 몸 태그는 원래 순서로 남긴다', () => {
    expect(
      stripClothing(
        '1girl, long hair, school uniform, blue eyes, pleated skirt, large breasts',
        kindOf
      )
    ).toBe('1girl, long hair, blue eyes, large breasts')
  })

  it('머리끈·머리 장식·가면·안대는 옷으로 분류돼도 남긴다', () => {
    const all = (): TagKind => 'cloth'
    expect(stripClothing('red hair tie, eye mask, blindfold, mouth veil, white dress', all)).toBe(
      'red hair tie, eye mask, blindfold, mouth veil'
    )
    expect(stripClothing('scrunchie, kanzashi, headband, hairclip, shirt', all)).toBe(
      'scrunchie, kanzashi, headband, hairclip'
    )
  })

  it('가중치 묶음 안의 옷도 빼고, 남은 게 없으면 묶음째 뺀다', () => {
    expect(stripClothing('1.2::white shirt, blue eyes::, 1.1::black thighhighs::', kindOf)).toBe(
      '1.2::blue eyes::'
    )
  })

  it('음수 가중치·문장은 건드리지 않고, 뺀 게 없으면 원문 그대로', () => {
    expect(stripClothing('-1::blazer::, 1girl', kindOf)).toBe('-1::blazer::, 1girl')
    const sentence = 'She wears a black blazer over a white shirt and pleated skirt'
    expect(stripClothing(`1girl, ${sentence}`, kindOf)).toBe(`1girl, ${sentence}`)
    expect(stripClothing('1girl,\nlong hair', kindOf)).toBe('1girl,\nlong hair')
  })

  it('줄바꿈과 주석을 지킨다 — 주석이 뒤 태그를 삼키거나 주석 속 태그가 살아나지 않게', () => {
    expect(
      stripClothing('1girl, school uniform\n# TODO hat later\nblue eyes, long hair', kindOf)
    ).toBe('1girl\n# TODO hat later\nblue eyes, long hair')
    expect(stripClothing('1girl, blue eyes\n# school uniform, twintails', kindOf)).toBe(
      '1girl, blue eyes\n# school uniform, twintails'
    )
    expect(stripClothing('long hair, pleated skirt # 나중에 바꿈', kindOf)).toBe(
      'long hair # 나중에 바꿈'
    )
    // 한 줄이 통째로 옷이면 그 줄만 빠지고, 다음 줄과 잇던 쉼표는 남는다
    expect(stripClothing('1girl,\nschool uniform, pleated skirt\nblue eyes', kindOf)).toBe(
      '1girl,\nblue eyes'
    )
  })

  it('와일드카드·조각 문법은 건드리지 않는다', () => {
    expect(stripClothing('1girl, <의상/casual>, blazer/school uniform', kindOf)).toBe(
      '1girl, <의상/casual>, blazer/school uniform'
    )
  })
})

describe('누드면 옷 벗기기', () => {
  const base = {
    card: '1girl, long hair, school uniform',
    outfit: 'black bikini, gold trim',
    outfitNegative: 'halterneck',
    kindOf
  }

  it('장면에 누드가 있으면 기본 복장을 빼고 카드 옷 태그를 걷어낸다', () => {
    expect(undressForNude({ ...base, contexts: ['bathing, nude'], enabled: true })).toEqual({
      card: '1girl, long hair',
      outfit: '',
      outfitNegative: '',
      nude: 'nude'
    })
  })

  it('기본 복장을 벗길 때 안대·가면·머리 장식은 남긴다', () => {
    const r = undressForNude({
      ...base,
      outfit: 'eyepatch, black dress, red hair ribbon, She wears a long black dress.',
      contexts: ['nude'],
      enabled: true
    })
    expect(r.outfit).toBe('eyepatch, red hair ribbon')
    expect(r.outfitNegative).toBe('')
  })

  it('씬·큐 항목에서 직접 고른 복장은 누드 씬에서도 그대로 둔다', () => {
    const r = undressForNude({
      ...base,
      outfit: 'black thighhighs, choker',
      explicitOutfit: true,
      contexts: ['bed, nude'],
      enabled: true
    })
    expect(r.outfit).toBe('black thighhighs, choker')
    expect(r.outfitNegative).toBe('halterneck')
    expect(r.card).toBe('1girl, long hair')
  })

  it('설정을 끄거나 누드가 없으면 그대로', () => {
    expect(undressForNude({ ...base, contexts: ['nude'], enabled: false })).toEqual({
      card: base.card,
      outfit: base.outfit,
      outfitNegative: base.outfitNegative,
      nude: null
    })
    expect(undressForNude({ ...base, contexts: ['sitting'], enabled: true }).outfit).toBe(
      base.outfit
    )
  })

  it('누드 복장(복장에 nude가 적힌 것)은 복장을 그대로 두고 카드만 벗긴다', () => {
    const r = undressForNude({
      ...base,
      outfit: 'nude, completely nude, pink nipples',
      contexts: ['completely nude'],
      enabled: true
    })
    expect(r.outfit).toBe('nude, completely nude, pink nipples')
    expect(r.card).toBe('1girl, long hair')
  })
})

describe('옷 분류를 물어볼 태그', () => {
  it('묶음을 풀고 중복·문장·주석은 뺀다', () => {
    expect(
      promptTags([
        '1girl, 1.2::White_Shirt, 1girl::\n# blazer',
        'She wears a black blazer over a white shirt'
      ])
    ).toEqual(['1girl', 'white shirt'])
  })
})
