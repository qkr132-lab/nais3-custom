import { describe, expect, it } from 'vitest'
import {
  NUDE_STRIP_CHOICES,
  characterSex,
  hasMaleTag,
  isNudePiece,
  normalizeNudeStrip,
  nudeStripFor,
  nudeStripLabel,
  nudeStripOn,
  nudeTrigger,
  promptTags,
  stripClothing,
  undressForNude,
  undressOutfit,
  wornOutfitTags
} from '../src/shared/nude-strip'
import type { Outfit, TagKind } from '../src/shared/outfit'

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

  it('음수 가중치는 건드리지 않고, 옷 문장은 문장째 빼고, 옷 얘기가 아닌 문장·뺄 게 없는 글은 그대로', () => {
    expect(stripClothing('-1::blazer::, 1girl', kindOf)).toBe('-1::blazer::, 1girl')
    const clothes = 'She wears a black blazer over a white shirt and pleated skirt'
    expect(stripClothing(`1girl, ${clothes}`, kindOf)).toBe('1girl')
    const other = 'She holds a sword in both hands and looks down on everyone'
    expect(stripClothing(`1girl, ${other}`, kindOf)).toBe(`1girl, ${other}`)
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
    // 캐릭터 태그 끝에 누드 태그도 붙인다 — 여러 명 그림에서 누가 벗었는지 알게
    expect(undressForNude({ ...base, contexts: ['bathing, nude'], enabled: true })).toEqual({
      card: '1girl, long hair, nude, completely nude',
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
    expect(r.card).toBe('1girl, long hair, nude, completely nude')
  })

  it('naked towel처럼 한 가지만 걸친 알몸은 그 태그를, 이미 있는 누드 태그는 다시 붙이지 않는다', () => {
    expect(undressForNude({ ...base, contexts: ['bath, naked towel'], enabled: true }).card).toBe(
      '1girl, long hair, naked towel'
    )
    expect(
      undressForNude({
        ...base,
        card: '1girl, nude, school uniform',
        contexts: ['completely nude'],
        enabled: true
      }).card
    ).toBe('1girl, nude, completely nude')
  })

  it('색·재질이 붙은 긴 옷 이름(5~7단어)도 옷으로 보고 걷어낸다 — 문장은 그대로', () => {
    const kinds: Record<string, 'cloth' | 'body'> = {
      'white and black maid dress': 'cloth',
      'red and white striped bikini top': 'cloth',
      'maid headdress': 'cloth',
      'gold glasses': 'cloth'
    }
    const r = undressForNude({
      card: 'black hair, gold glasses, maid headdress, white and black maid dress, red and white striped bikini top, She looks down on everyone with a proud face.',
      outfit: '',
      outfitNegative: '',
      contexts: ['nude, completely nude'],
      enabled: true,
      kindOf: (tag) => kinds[tag] ?? 'unknown'
    })
    // 머리 장식·안경은 얼굴 장비라 남고, 긴 옷 이름은 빠지고, 문장은 그대로
    expect(r.card).toBe(
      'black hair, gold glasses, maid headdress, She looks down on everyone with a proud face., nude, completely nude'
    )
  })

  it('옷 낱말이 든 긴 문장은 문장째로 빼고, 옷 얘기가 아닌 문장은 그대로 둔다', () => {
    const kinds: Record<string, 'cloth' | 'body'> = {
      dress: 'cloth',
      gown: 'cloth',
      gloves: 'cloth',
      hat: 'cloth',
      sword: 'body',
      hair: 'body'
    }
    const r = undressForNude({
      card: 'red hair, She wears a long black evening gown with white gloves., She holds a sword in both hands and looks down on everyone., She wears a wide straw hat that shades her face.',
      outfit: '',
      outfitNegative: '',
      contexts: ['nude'],
      enabled: true,
      kindOf: (tag) => kinds[tag] ?? 'unknown'
    })
    // 모자 문장은 얼굴 장비라 남는다
    expect(r.card).toBe(
      'red hair, She holds a sword in both hands and looks down on everyone., She wears a wide straw hat that shades her face., nude, completely nude'
    )
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

describe('복장의 nsfw(누드) 조각', () => {
  const kinds: Record<string, TagKind> = {
    'military uniform': 'cloth',
    'black gloves': 'cloth',
    'combat boots': 'cloth',
    'hooded cloak': 'cloth',
    'gas mask': 'cloth',
    helmet: 'cloth',
    'witch hat': 'cloth',
    'black thighhighs': 'cloth',
    nude: 'bare'
  }
  const kind = (t: string): TagKind => kinds[t] ?? 'body'
  const outfit: Outfit = {
    id: 7,
    name: '위장복',
    negative: '',
    pieces: [
      { id: 'a', name: '군복', tags: 'military uniform, black gloves, combat boots', on: true },
      { id: 'b', name: '위장', tags: 'hooded cloak, gas mask, helmet', on: true },
      { id: 'c', name: '무기', tags: 'holding rifle', on: true },
      { id: 'd', name: '누드', tags: 'nude, black thighhighs', on: false }
    ]
  }

  it('누드 태그가 든 조각을 알아본다', () => {
    expect(isNudePiece('nude, black thighhighs')).toBe(true)
    expect(isNudePiece('completely nude')).toBe(true)
    expect(isNudePiece('skirt lift')).toBe(false)
    expect(isNudePiece('# nude')).toBe(false)
  })

  it('누드 조각을 켜면 다른 조각의 몸 옷만 빼고, 얼굴·머리 장비와 소품은 남긴다', () => {
    const worn = undressOutfit(outfit, { on: ['d'] }, true, kind)
    expect(worn).toBe('gas mask, helmet, holding rifle, nude, black thighhighs')
  })

  it('누드 조각이 꺼져 있거나 설정을 끄면 평소대로', () => {
    expect(undressOutfit(outfit, undefined, true, kind)).toBe(
      'military uniform, black gloves, combat boots, hooded cloak, gas mask, helmet, holding rifle'
    )
    expect(undressOutfit(outfit, { on: ['d'] }, false, kind)).toContain('military uniform')
  })

  it('nsfw 아래·가슴 조각에 적힌 누드도 장면이 맞아 켜지면 똑같이 벗긴다', () => {
    const triggered: Outfit = {
      ...outfit,
      pieces: outfit.pieces.map((p) => (p.id === 'd' ? { ...p, when: 'nsfw-lower' } : p))
    }
    expect(undressOutfit(triggered, undefined, true, kind, { lower: true })).toBe(
      'gas mask, helmet, holding rifle, nude, black thighhighs'
    )
    // 장면이 아니거나, 씬에서 그 조각을 끄면 평소대로
    expect(undressOutfit(triggered, undefined, true, kind, { chest: true })).toContain(
      'military uniform'
    )
    expect(undressOutfit(triggered, { off: ['d'] }, true, kind, { lower: true })).toContain(
      'military uniform'
    )
    const outfits = new Map([[7, triggered]])
    expect(wornOutfitTags(7, undefined, outfits, true, kind, { lower: true })).not.toContain(
      'military uniform'
    )
    expect(wornOutfitTags(7, undefined, outfits, true, kind)).toContain('military uniform')
  })

  it('카드 기본 복장에서도 같고, 카드의 옷 태그도 함께 걷어낸다', () => {
    const outfits = new Map([
      [7, { ...outfit, pieces: outfit.pieces.map((p) => ({ ...p, on: true })) }]
    ])
    const worn = wornOutfitTags(7, undefined, outfits, true, kind)
    expect(worn).not.toContain('military uniform')
    const dressed = undressForNude({
      card: '1girl, witch hat, black thighhighs, long hair',
      outfit: worn,
      outfitNegative: '',
      contexts: ['standing', worn],
      enabled: true,
      kindOf: kind
    })
    // 모자는 머리 장비라 남고, 스타킹은 카드에서 빠진다 (누드 조각에 적은 스타킹은 복장 쪽에 남음)
    expect(dressed.card).toBe('1girl, witch hat, long hair')
    expect(dressed.outfit).toBe(worn)
  })
})

describe('옷 분류를 물어볼 태그', () => {
  it('묶음을 풀고 중복·문장·주석은 뺀다', () => {
    expect(
      promptTags([
        '1girl, 1.2::White_Shirt, 1girl::\n# blazer',
        'She wears a black blazer over a white shirt'
      ])
    ).toEqual(expect.arrayContaining(['1girl', 'white shirt', 'blazer', 'wears']))
    // 문장은 통째로가 아니라 낱말로만 (옷 문장인지 보려고)
    expect(promptTags(['She wears a black blazer over a white shirt'])).not.toContain(
      'she wears a black blazer over a white shirt'
    )
  })
})

describe('옷 벗기기 값 — 둘 다·안 벗김·남캐만·여캐만', () => {
  it('옛 true/false 는 그대로, 새 값은 male·female 만 받고, 모르는 값은 버린다', () => {
    expect(normalizeNudeStrip(true)).toBe(true)
    expect(normalizeNudeStrip(false)).toBe(false)
    expect(normalizeNudeStrip('male')).toBe('male')
    expect(normalizeNudeStrip('female')).toBe('female')
    // both 는 옛 true 와 같은 뜻으로만 받는다
    expect(normalizeNudeStrip('both')).toBe(true)
    for (const bad of [undefined, null, 0, 1, '', 'MALE', 'all', {}, []]) {
      expect(normalizeNudeStrip(bad)).toBeUndefined()
    }
  })

  it('메뉴는 전체 설정 따름 · 안 벗김 · 둘 다 · 남캐만 · 여캐만 순서', () => {
    expect(NUDE_STRIP_CHOICES.map((c) => c.label)).toEqual([
      '전체 설정 따름',
      '안 벗김',
      '둘 다',
      '남캐만',
      '여캐만'
    ])
    expect(NUDE_STRIP_CHOICES.map((c) => c.value)).toEqual([
      undefined,
      false,
      true,
      'male',
      'female'
    ])
    expect(nudeStripLabel(undefined)).toBe('전체 설정 따름')
    expect(nudeStripLabel(true)).toBe('둘 다')
    expect(nudeStripLabel('male')).toBe('남캐만')
  })

  it('한 명이라도 켜질 수 있는지 — 씬 값이 없으면 전체 설정, 있으면 안 벗김만 꺼짐', () => {
    expect(nudeStripOn(undefined, true)).toBe(true)
    expect(nudeStripOn(undefined, false)).toBe(false)
    expect(nudeStripOn(false, true)).toBe(false)
    expect(nudeStripOn(true, false)).toBe(true)
    expect(nudeStripOn('male', false)).toBe(true)
    expect(nudeStripOn('female', false)).toBe(true)
  })

  it('캐릭터마다 판정을 켤지·태그 없이 알몸으로 만들지', () => {
    // 값 없음 = 전체 설정 (태그 판정만, 강제는 없음)
    expect(nudeStripFor(undefined, true, 'male')).toEqual({ enabled: true, force: false })
    expect(nudeStripFor(undefined, false, 'female')).toEqual({ enabled: false, force: false })
    // 둘 다 · 안 벗김
    expect(nudeStripFor(true, false, 'male')).toEqual({ enabled: true, force: true })
    expect(nudeStripFor(true, false, 'female')).toEqual({ enabled: true, force: true })
    expect(nudeStripFor(false, true, 'male')).toEqual({ enabled: false, force: false })
    expect(nudeStripFor(false, true, 'female')).toEqual({ enabled: false, force: false })
    // 한쪽만 — 반대쪽은 판정도 끈다
    expect(nudeStripFor('male', true, 'male')).toEqual({ enabled: true, force: true })
    expect(nudeStripFor('male', true, 'female')).toEqual({ enabled: false, force: false })
    expect(nudeStripFor('female', false, 'female')).toEqual({ enabled: true, force: true })
    expect(nudeStripFor('female', false, 'male')).toEqual({ enabled: false, force: false })
  })
})

describe('남캐 판정 — 역할 먼저, 역할이 없으면 카드의 boy·male 태그', () => {
  it('boy·male 계열 태그를 찾는다', () => {
    for (const prompt of [
      '1boy',
      '2boys, solo',
      '6+boys',
      'boy, blue eyes',
      'male',
      'mature male, beard',
      'male focus',
      'man',
      'men',
      'old man',
      'multiple boys',
      'faceless male',
      'Male_Focus',
      'blue eyes, 1boy, muscular'
    ]) {
      expect(hasMaleTag(prompt), prompt).toBe(true)
    }
  })

  it('가중치 묶음 안의 태그도 태그 단위로 본다', () => {
    expect(hasMaleTag('1.2::mature male::, suit')).toBe(true)
    expect(hasMaleTag('0.9::muscular, 1boy::')).toBe(true)
    expect(hasMaleTag('1.1::male focus, muscular::')).toBe(true)
  })

  it('여자·비슷한 낱말·빼달라는 가중치·주석·랜덤 선택지는 남캐가 아니다', () => {
    for (const prompt of [
      '',
      '1girl, long hair',
      'female',
      '1girl, tomboy',
      'woman, mature female',
      'man bun',
      'boyfriend shirt',
      'snowman',
      '-1::1boy::',
      '# 1boy\n1girl',
      '1girl # 1boy',
      '(1boy/1girl), blue eyes',
      '1boy/1girl',
      '<wildcard male>'
    ]) {
      expect(hasMaleTag(prompt), prompt).toBe(false)
    }
  })

  it('끝 낱말만 man 인 긴 문장과 가중치 0 묶음은 남캐의 근거가 아니다', () => {
    for (const prompt of [
      '1girl, she is with a man',
      'standing next to a tall man',
      '0::1boy::, 1girl',
      '0.0::mature male::'
    ]) {
      expect(hasMaleTag(prompt), prompt).toBe(false)
    }
    // 짧은 수식어가 붙은 남자 태그는 그대로 남캐
    expect(hasMaleTag('muscular older man')).toBe(true)
    expect(hasMaleTag('0.5::1boy::')).toBe(true)
  })

  it('역할이 있으면 카드 태그와 상관없이 하는쪽 = 남캐, 당하는쪽 = 여캐', () => {
    expect(characterSex('source', '1girl')).toBe('male')
    expect(characterSex('target', '1boy')).toBe('female')
  })

  it('역할이 없으면 카드의 남자 태그로 — 없으면 여캐', () => {
    expect(characterSex(null, '1boy, short hair')).toBe('male')
    expect(characterSex(undefined, 'mature male')).toBe('male')
    expect(characterSex(null, '1girl, long hair')).toBe('female')
    expect(characterSex(undefined, 'blue eyes')).toBe('female')
  })
})
