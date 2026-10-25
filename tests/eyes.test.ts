import { describe, expect, it } from 'vitest'
import {
  EYE_LOOK_LABEL,
  closedEyesEvidence,
  eyeLookKind,
  eyeReason,
  stripEyesWhenClosed
} from '../src/shared/eyes'
import { engineTagsOf } from '../src/shared/auto-expose'

/**
 * 눈 감음이면 카드의 눈 외형 태그를 뺀다 — 순수 계산 시험.
 * 합성 카드·합성 장면 글만 쓴다 (사용자 데이터 없음). 태그는 단보루 실존 태그, 문장은 지어낸 것.
 */

const who = { index: 0, name: '합성 카드', id: 7 }
const strip = (
  card: string,
  contexts: string[],
  sex: 'male' | 'female' | null = 'female'
): ReturnType<typeof stripEyesWhenClosed> => stripEyesWhenClosed({ card, contexts, sex, who })
const tagsOf = (text: string): string[] => engineTagsOf(text)

describe('감은 눈 읽기 — 태그', () => {
  it('closed eyes · eyes closed · closed_eyes 를 감은 눈으로 읽고 근거를 원문 그대로 돌려준다', () => {
    for (const text of ['closed eyes', 'eyes closed', 'closed_eyes', 'Closed Eyes']) {
      expect(closedEyesEvidence([text], 'female'), text).toBe(text)
    }
    expect(closedEyesEvidence(['smile, closed eyes, blush'], 'female')).toBe('closed eyes')
    // 가중치 묶음 안, 여러 글 중 뒤쪽 글, 역할 접두사
    expect(closedEyesEvidence(['1.3::closed eyes, blush::'], 'female')).toBe('closed eyes')
    expect(closedEyesEvidence(['smile', 'blush, eyes closed'], 'female')).toBe('eyes closed')
    expect(closedEyesEvidence(['target#closed eyes'], 'female')).toBe('target#closed eyes')
  })

  it('눈이 보이는 표현은 감은 눈이 아니다 — one eye closed · wink · half-closed eyes · 한쪽 눈', () => {
    for (const text of [
      'one eye closed',
      'left eye closed',
      'wink',
      ';)',
      'half-closed eyes',
      'half closed eyes',
      'eyes half closed',
      'eyes slightly closed',
      'eyes barely closed',
      'jitome',
      'narrowed eyes',
      'wide-eyed',
      'open eyes',
      'eyes open',
      'eyes wide open',
      'mouth closed',
      'closed mouth',
      'closed door'
    ]) {
      expect(closedEyesEvidence([text], 'female'), text).toBeNull()
    }
  })

  it('실제로 보내지 않는 글은 신호가 아니다 — 음수·0 가중치, 주석, 와일드카드, 랜덤 선택지, Text: 꼬리, 따옴표 대사', () => {
    for (const text of [
      '-1::closed eyes::',
      '0::closed eyes::',
      '-2::closed eyes, blush::',
      '# closed eyes',
      'smile # closed eyes',
      '<closed eyes>',
      '(closed eyes/open eyes)',
      'closed eyes/open eyes',
      'smile\nText: closed eyes',
      '"close your eyes" she says'
    ]) {
      expect(closedEyesEvidence([text], 'female'), text).toBeNull()
    }
  })

  it('글이 없거나 감은 눈 이야기가 없으면 null', () => {
    expect(closedEyesEvidence([], 'female')).toBeNull()
    expect(closedEyesEvidence(['', '  '], 'female')).toBeNull()
    expect(closedEyesEvidence(['1girl, blue eyes, smile'], 'female')).toBeNull()
  })
})

describe('감은 눈 읽기 — 영어 문장', () => {
  it('her eyes are closed · with eyes closed · closes her eyes 처럼 눈이 감겼다고 말하는 문장', () => {
    for (const text of [
      'her eyes are closed',
      'Her eyes are closed.',
      'with her eyes closed',
      'with eyes closed',
      'with closed eyes',
      'her eyes are tightly closed',
      'eyes squeezed shut',
      'she squeezes her eyes shut',
      'her eyes are shut',
      'she closes her eyes',
      'she closed her eyes tightly',
      'closing her eyes in pleasure',
      'she keeps her eyes closed',
      'eyes remain closed',
      'both eyes closed'
    ]) {
      expect(closedEyesEvidence([text], 'female'), text).toBe(text)
    }
    // 쉼표로 이어진 문장 속 한 토막
    expect(closedEyesEvidence(['she moans, eyes tightly closed, trembling'], 'female')).toBe(
      'eyes tightly closed'
    )
  })

  it('부정·반대 문장은 아니다 — not closed · without closing · never closes · opens her eyes', () => {
    for (const text of [
      'her eyes are not closed',
      'her eyes are not tightly closed',
      'she does not close her eyes',
      "she doesn't close her eyes",
      'without closing her eyes',
      'she never closes her eyes',
      'no closed eyes',
      'she opens her eyes',
      'her eyes are open',
      'her eyes are wide open',
      'she refuses to close her eyes'
    ]) {
      expect(closedEyesEvidence([text], 'female'), text).toBeNull()
    }
  })

  it('쉼표 없이 이어 쓴 글에서도 눈이 보이거나 닫힌 것이 눈이 아니면 감은 눈이 아니다', () => {
    for (const text of [
      'mouth closed eyes wide open',
      'open eyes closed mouth',
      'eyes closed halfway',
      'her eyes are closed halfway',
      'she closes her eyes partway',
      'closed eyes wide open'
    ]) {
      expect(closedEyesEvidence([text], 'female'), text).toBeNull()
    }
    // 눈이 감겼다는 말은 그대로 읽는다
    expect(closedEyesEvidence(['closed eyes blush'], 'female')).toBe('closed eyes blush')
    expect(closedEyesEvidence(['eyes closed, mouth open'], 'female')).toBe('eyes closed')
  })

  it('한쪽 눈·반쯤 감은 눈 문장은 눈이 보인다', () => {
    for (const text of [
      'her left eye is closed',
      'she closes one eye',
      'she winks',
      'her eyes are half closed',
      'her eyes are half-closed',
      'her eyes are slightly closed',
      'half closed eyes'
    ]) {
      expect(closedEyesEvidence([text], 'female'), text).toBeNull()
    }
  })

  it('her/his 는 이 캐릭터 몸과 맞을 때만 — 후타(null)는 거르지 않고 상대의 눈은 읽지 않는다', () => {
    expect(closedEyesEvidence(['his eyes are closed'], 'female')).toBeNull()
    expect(closedEyesEvidence(['his eyes are closed'], 'male')).toBe('his eyes are closed')
    expect(closedEyesEvidence(['her eyes are closed'], 'male')).toBeNull()
    expect(closedEyesEvidence(['her eyes are closed'], 'female')).toBe('her eyes are closed')
    expect(closedEyesEvidence(['her eyes are closed'], null)).toBe('her eyes are closed')
    expect(closedEyesEvidence(['his eyes are closed'], null)).toBe('his eyes are closed')
    // 주어로 가른다
    expect(closedEyesEvidence(['he keeps eyes closed'], 'female')).toBeNull()
    expect(closedEyesEvidence(['she keeps eyes closed'], 'female')).toBe('she keeps eyes closed')
    // 누구 눈인지 안 밝힌 문장은 누구에게나
    expect(closedEyesEvidence(['with eyes closed'], 'male')).toBe('with eyes closed')
    // 상대의 눈
    expect(closedEyesEvidence(["her partner's eyes are closed"], 'female')).toBeNull()
    expect(closedEyesEvidence(["another's eyes closed"], 'male')).toBeNull()
  })
})

describe('눈 외형 태그 분류', () => {
  it('눈 색 — <색> eyes · 밝기 수식 · 여러 색 · multicolored · gradient · heterochromia', () => {
    for (const tag of [
      'blue eyes',
      'aqua eyes',
      'red eyes',
      'grey eyes',
      'gray eyes',
      'pink eyes',
      'white eyes',
      'black eyes',
      'light blue eyes',
      'dark red eyes',
      'blue-green eyes',
      'red and blue eyes',
      'golden eyes',
      'multicolored eyes',
      'gradient eyes',
      'two-tone eyes',
      'rainbow eyes',
      'heterochromia',
      'no heterochromia',
      'alternate eye color',
      'official alternate eye color'
    ]) {
      expect(eyeLookKind(tag), tag).toBe('color')
    }
  })

  it('동공 · 흰자 · 눈빛 효과 · 눈동자 무늬', () => {
    for (const tag of [
      'slit pupils',
      'symbol-shaped pupils',
      'heart-shaped pupils',
      'star-shaped pupils',
      'bright pupils',
      'white pupils',
      'no pupils',
      'dilated pupils',
      'extra pupils'
    ])
      expect(eyeLookKind(tag), tag).toBe('pupil')
    for (const tag of ['black sclera', 'colored sclera', 'yellow sclera', 'no sclera'])
      expect(eyeLookKind(tag), tag).toBe('sclera')
    for (const tag of [
      'glowing eyes',
      'glowing eye',
      'glowing red eyes',
      'sparkling eyes',
      'shiny eyes',
      'bloodshot eyes'
    ])
      expect(eyeLookKind(tag), tag).toBe('glow')
    for (const tag of [
      'ringed eyes',
      'symbol in eye',
      'star in eye',
      'heart in eye',
      'sharingan',
      'byakugan',
      'rinnegan'
    ])
      expect(eyeLookKind(tag), tag).toBe('iris')
  })

  it('눈 모양 · 속눈썹 · 화장 · 안경류 · 눈 주변 흉터 · 눈이 보이는 표현은 눈 외형이 아니다', () => {
    for (const tag of [
      'tsurime',
      'tareme',
      'jitome',
      'sanpaku',
      'narrowed eyes',
      'half-closed eyes',
      'one eye closed',
      'closed eyes',
      'empty eyes',
      'crazy eyes',
      'wide-eyed',
      'cross-eyed',
      'eyelashes',
      'long eyelashes',
      'thick eyelashes',
      'colored eyelashes',
      'eyeshadow',
      'eyeliner',
      'mascara',
      'makeup',
      'glasses',
      'eyepatch',
      'goggles',
      'monocle',
      'eye mask',
      'blindfold',
      'scar across eye',
      'tattoo',
      'facial mark',
      'one eye covered',
      'hair between eyes',
      'hair over eyes',
      'eyes visible through hair',
      'blue hair',
      'blue sky',
      'blue dress',
      'bedroom eyes',
      'tears',
      // 문장은 건드리지 않는다
      'her bright blue eyes sparkle with golden flecks in the soft morning light'
    ]) {
      expect(eyeLookKind(tag), tag).toBeNull()
    }
  })

  it('갈래마다 한국어 이름이 있고 이유 문구는 「눈 감음 — … 뺌」이다', () => {
    for (const label of Object.values(EYE_LOOK_LABEL)) expect(label).toMatch(/[가-힣]/)
    expect(eyeReason('color')).toBe('눈 감음 — 눈 색 뺌')
    expect(eyeReason('pupil')).toBe('눈 감음 — 동공 뺌')
    expect(eyeReason('sclera')).toBe('눈 감음 — 흰자 뺌')
  })
})

describe('카드에서 눈 외형 빼기', () => {
  it('눈 색을 빼고 나머지는 순서·표기 그대로 둔다', () => {
    const r = strip('1girl, blue eyes, red hair, long eyelashes', ['closed eyes'])
    expect(r.text).toBe('1girl, red hair, long eyelashes')
    expect(r.notes).toEqual([
      {
        kind: 'removed',
        where: 'char',
        topic: 'eyes',
        charIndex: 0,
        name: '합성 카드',
        charId: 7,
        before: 'blue eyes',
        evidence: 'closed eyes',
        reason: '눈 감음 — 눈 색 뺌'
      }
    ])
  })

  it('눈 색 · heterochromia · 동공 · 흰자 · 빛나는 눈 · 눈동자 무늬를 전부 빼고, 갈래마다 이유를 단다', () => {
    const card = [
      '1girl',
      'aqua eyes',
      'multicolored eyes',
      'gradient eyes',
      'heterochromia',
      'slit pupils',
      'symbol-shaped pupils',
      'heart-shaped pupils',
      'black sclera',
      'colored sclera',
      'glowing eyes',
      'ringed eyes',
      'red hair'
    ].join(', ')
    const r = strip(card, ['eyes closed'])
    expect(r.text).toBe('1girl, red hair')
    expect(r.notes.map((n) => [n.before, n.reason])).toEqual([
      ['aqua eyes', '눈 감음 — 눈 색 뺌'],
      ['multicolored eyes', '눈 감음 — 눈 색 뺌'],
      ['gradient eyes', '눈 감음 — 눈 색 뺌'],
      ['heterochromia', '눈 감음 — 눈 색 뺌'],
      ['slit pupils', '눈 감음 — 동공 뺌'],
      ['symbol-shaped pupils', '눈 감음 — 동공 뺌'],
      ['heart-shaped pupils', '눈 감음 — 동공 뺌'],
      ['black sclera', '눈 감음 — 흰자 뺌'],
      ['colored sclera', '눈 감음 — 흰자 뺌'],
      ['glowing eyes', '눈 감음 — 눈빛 효과 뺌'],
      ['ringed eyes', '눈 감음 — 눈동자 무늬 뺌']
    ])
    for (const n of r.notes) {
      expect(n.evidence).toBe('eyes closed')
      expect(n.topic).toBe('eyes')
    }
  })

  it('눈 모양 · 속눈썹 · 화장 · 안경 · 안대 · 고글 · 가면 · 눈 주변 흉터 · 반쯤 감은 눈은 남긴다', () => {
    const keep = [
      'tsurime',
      'tareme',
      'jitome',
      'long eyelashes',
      'eyeshadow',
      'eyeliner',
      'mascara',
      'glasses',
      'eyepatch',
      'goggles',
      'eye mask',
      'scar across eye',
      'half-closed eyes',
      'one eye covered'
    ]
    const card = `1girl, blue eyes, ${keep.join(', ')}, slit pupils, red hair`
    const r = strip(card, ['closed eyes'])
    expect(tagsOf(r.text)).toEqual(['1girl', ...keep, 'red hair'])
    expect(r.notes.map((n) => n.before)).toEqual(['blue eyes', 'slit pupils'])
  })

  it('가중치 묶음은 그 태그만 빼고 가중치는 그대로, 비면 묶음째 뺀다', () => {
    expect(strip('1.3::blue eyes, red hair::, smile', ['closed eyes']).text).toBe(
      '1.3::red hair::, smile'
    )
    expect(strip('1.2::blue eyes::, smile', ['closed eyes']).text).toBe('smile')
    expect(strip('1.2::blue eyes, slit pupils::, smile', ['closed eyes']).text).toBe('smile')
    const r = strip('0.8::blue eyes, red hair::, smile', ['closed eyes'])
    expect(r.text).toBe('0.8::red hair::, smile')
    expect(r.notes.map((n) => n.before)).toEqual(['blue eyes'])
  })

  it('빼달라는 음수 가중치(-1::blue eyes::)와 0 가중치는 그대로 둔다', () => {
    const card = '1girl, -1::blue eyes::, 0::red eyes::, -2::slit pupils, green eyes::, smile'
    const r = strip(card, ['closed eyes'])
    expect(r.text).toBe(card)
    expect(r.notes).toEqual([])
  })

  it('주석 · 와일드카드 · Text: 꼬리 · 따옴표 대사는 손대지 않는다', () => {
    const r = strip('1girl, blue eyes, # memo blue eyes\n<eyes>, red eyes/green eyes, smile', [
      'closed eyes'
    ])
    expect(r.text).toBe('1girl, # memo blue eyes\n<eyes>, red eyes/green eyes, smile')
    // 랜덤 선택지(red eyes/green eyes)는 건드리지 않고 안 바꿈으로 알린다
    expect(r.notes.map((n) => [n.kind, n.before])).toEqual([
      ['removed', 'blue eyes'],
      ['kept', 'red eyes/green eyes']
    ])
    const tail = strip('1girl, blue eyes\nText: "blue eyes"', ['closed eyes'])
    expect(tail.text).toBe('1girl\nText: "blue eyes"')
  })

  it('색 앞에 꾸밈말이 붙어도 뺀다 (light blue eyes) — 모양 말이 붙은 태그는 남긴다', () => {
    const r = strip('1girl, light blue eyes, large eyes, round blue eyes, smile', ['closed eyes'])
    expect(r.text).toBe('1girl, large eyes, round blue eyes, smile')
  })

  it('감은 눈 이야기가 없으면 원문 그대로 — 같은 문자열이고 메모도 없다', () => {
    const card = '1girl, blue eyes, red hair'
    for (const ctx of [[], ['smile, blush'], ['wink'], ['half-closed eyes'], ['one eye closed']]) {
      const r = strip(card, ctx)
      expect(r.text).toBe(card)
      expect(r.notes).toEqual([])
    }
  })

  it('카드에 눈 외형 태그가 없으면 원문 그대로', () => {
    const card = '1girl, red hair, long eyelashes, tsurime'
    const r = strip(card, ['closed eyes'])
    expect(r.text).toBe(card)
    expect(r.notes).toEqual([])
    expect(strip('', ['closed eyes']).text).toBe('')
  })

  it('같은 일을 두 번 해도 결과가 같다 (멱등)', () => {
    const once = strip('1girl, blue eyes, slit pupils, red hair', ['closed eyes'])
    const twice = strip(once.text, ['closed eyes'])
    expect(twice.text).toBe(once.text)
    expect(twice.notes).toEqual([])
  })

  it('뺄 수 없는 곳에 눈 외형이 있으면 말없이 두지 않고 안 바꿈 메모를 남긴다 — 짝 안 맞는 :: 줄·랜덤 선택지', () => {
    // 가중치 짝이 안 맞는 줄은 줄째 그대로 (다른 줄의 눈 색은 평소대로 빠진다)
    const broken = strip('1girl, 1.2::blue eyes, red hair, slit pupils\ngreen eyes', [
      'closed eyes'
    ])
    expect(broken.text).toBe('1girl, 1.2::blue eyes, red hair, slit pupils')
    expect(broken.notes.map((n) => [n.kind, n.before])).toEqual([
      ['removed', 'green eyes'],
      ['kept', '1girl, 1.2::blue eyes, red hair, slit pupils']
    ])
    const k = broken.notes[1]
    expect(k).toMatchObject({
      where: 'char',
      topic: 'eyes',
      charIndex: 0,
      charId: 7,
      evidence: 'closed eyes'
    })
    expect(k.reason).toContain('눈 감음')
    expect(k.reason).toContain('::')
    // 랜덤 선택지 — 뽑힐 값을 알 수 없어 그대로 두고 알린다
    const wild = strip('1girl, (blue eyes/red eyes), red hair', ['closed eyes'])
    expect(wild.text).toBe('1girl, (blue eyes/red eyes), red hair')
    expect(wild.notes).toHaveLength(1)
    expect(wild.notes[0]).toMatchObject({ kind: 'kept', topic: 'eyes' })
    expect(wild.notes[0].before).toContain('blue eyes')
    expect(wild.notes[0].reason).toContain('랜덤 선택지')
    const curly = strip('1girl, {green eyes}', ['closed eyes'])
    expect(curly.text).toBe('1girl, {green eyes}')
    expect(curly.notes.map((n) => n.kind)).toEqual(['kept'])
  })

  it('눈 외형이 없는 깨진 줄·와일드카드·빼달라는 음수 가중치·따옴표 대사는 알리지도 않는다', () => {
    for (const card of [
      '1.2::red hair, long eyelashes',
      '1girl, (red hair/blue hair)',
      '1girl, <조각>',
      '1girl, -1::blue eyes::',
      '1girl, "her blue eyes are closed"'
    ]) {
      const r = strip(card, ['closed eyes'])
      expect(r.text, card).toBe(card)
      expect(r.notes, card).toEqual([])
    }
    // 감은 눈이 아니면 깨진 줄이어도 아무 말도 하지 않는다
    expect(strip('1.2::blue eyes, red hair', ['smile']).notes).toEqual([])
  })

  it('카드 id 가 없으면 메모에도 charId 가 없다', () => {
    const r = stripEyesWhenClosed({
      card: 'blue eyes',
      contexts: ['closed eyes'],
      sex: null,
      who: { index: 2, name: '이름' }
    })
    expect(r.notes[0]).not.toHaveProperty('charId')
    expect(r.notes[0].charIndex).toBe(2)
  })

  it('her/his 문장은 이 캐릭터 몸에 맞을 때만, 후타(null)는 어느 쪽이든', () => {
    const card = '1girl, blue eyes'
    expect(strip(card, ['his eyes are closed'], 'female').text).toBe(card)
    expect(strip(card, ['her eyes are closed'], 'female').text).toBe('1girl')
    expect(strip(card, ['his eyes are closed'], null).text).toBe('1girl')
    expect(strip('1boy, brown eyes', ['her eyes are closed'], 'male').text).toBe('1boy, brown eyes')
  })
})
