import { describe, expect, it } from 'vitest'
import {
  EYE_CAUSE_LABEL,
  EYE_LOOK_LABEL,
  hiddenEyesEvidence,
  eyeLookKind,
  eyeReason,
  openEyesExpression,
  stripEyesWhenClosed,
  type EyeContexts
} from '../src/shared/eyes'
import { engineTagsOf } from '../src/shared/auto-expose'

/**
 * 눈이 안 보이면(눈 감음·잠듦·눈 가림) 카드의 눈 외형 태그를 뺀다 — 순수 계산 시험.
 * 합성 카드·합성 장면 글만 쓴다 (사용자 데이터 없음). 태그는 단보루 실존 태그, 문장은 지어낸 것.
 */

type Sex = 'male' | 'female' | null
const who = { index: 0, name: '합성 카드', id: 7 }
const strip = (
  card: string,
  contexts: string[] | EyeContexts,
  sex: Sex = 'female',
  extra: { outfit?: string; faceSeat?: boolean } = {}
): ReturnType<typeof stripEyesWhenClosed> =>
  stripEyesWhenClosed({ enabled: true, card, contexts, sex, who, ...extra })
const tagsOf = (text: string): string[] => engineTagsOf(text)
/** 눈 감음 근거만 — 다른 까닭으로 읽히면 「!까닭」 으로 돌려줘 시험이 알아챈다 */
const closedEvidence = (contexts: string[], sex: Sex): string | null => {
  const e = hiddenEyesEvidence(contexts, sex)
  return e ? (e.cause === 'closed' ? e.text : `!${e.cause}`) : null
}
/** 어떤 까닭이든 근거 — 「까닭:글」 */
const evidenceOf = (
  contexts: string[] | EyeContexts,
  sex: Sex = 'female',
  outfit?: string
): string => {
  const e = hiddenEyesEvidence(contexts, sex, outfit)
  return e ? `${e.cause}:${e.text}` : '-'
}

describe('감은 눈 읽기 — 태그', () => {
  it('closed eyes · eyes closed · closed_eyes 를 감은 눈으로 읽고 근거를 원문 그대로 돌려준다', () => {
    for (const text of ['closed eyes', 'eyes closed', 'closed_eyes', 'Closed Eyes']) {
      expect(closedEvidence([text], 'female'), text).toBe(text)
    }
    expect(closedEvidence(['smile, closed eyes, blush'], 'female')).toBe('closed eyes')
    // 가중치 묶음 안, 여러 글 중 뒤쪽 글, 역할 접두사
    expect(closedEvidence(['1.3::closed eyes, blush::'], 'female')).toBe('closed eyes')
    expect(closedEvidence(['smile', 'blush, eyes closed'], 'female')).toBe('eyes closed')
    expect(closedEvidence(['target#closed eyes'], 'female')).toBe('target#closed eyes')
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
      expect(closedEvidence([text], 'female'), text).toBeNull()
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
      expect(closedEvidence([text], 'female'), text).toBeNull()
    }
  })

  it('글이 없거나 감은 눈 이야기가 없으면 null', () => {
    expect(closedEvidence([], 'female')).toBeNull()
    expect(closedEvidence(['', '  '], 'female')).toBeNull()
    expect(closedEvidence(['1girl, blue eyes, smile'], 'female')).toBeNull()
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
      expect(closedEvidence([text], 'female'), text).toBe(text)
    }
    // 쉼표로 이어진 문장 속 한 토막
    expect(closedEvidence(['she moans, eyes tightly closed, trembling'], 'female')).toBe(
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
      expect(closedEvidence([text], 'female'), text).toBeNull()
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
      expect(closedEvidence([text], 'female'), text).toBeNull()
    }
    // 눈이 감겼다는 말은 그대로 읽는다
    expect(closedEvidence(['closed eyes blush'], 'female')).toBe('closed eyes blush')
    expect(closedEvidence(['eyes closed, mouth open'], 'female')).toBe('eyes closed')
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
      expect(closedEvidence([text], 'female'), text).toBeNull()
    }
  })

  it('her/his 는 이 캐릭터 몸과 맞을 때만 — 후타(null)는 거르지 않고 상대의 눈은 읽지 않는다', () => {
    expect(closedEvidence(['his eyes are closed'], 'female')).toBeNull()
    expect(closedEvidence(['his eyes are closed'], 'male')).toBe('his eyes are closed')
    expect(closedEvidence(['her eyes are closed'], 'male')).toBeNull()
    expect(closedEvidence(['her eyes are closed'], 'female')).toBe('her eyes are closed')
    expect(closedEvidence(['her eyes are closed'], null)).toBe('her eyes are closed')
    expect(closedEvidence(['his eyes are closed'], null)).toBe('his eyes are closed')
    // 주어로 가른다
    expect(closedEvidence(['he keeps eyes closed'], 'female')).toBeNull()
    expect(closedEvidence(['she keeps eyes closed'], 'female')).toBe('she keeps eyes closed')
    // 누구 눈인지 안 밝힌 문장은 누구에게나
    expect(closedEvidence(['with eyes closed'], 'male')).toBe('with eyes closed')
    // 상대의 눈
    expect(closedEvidence(["her partner's eyes are closed"], 'female')).toBeNull()
    expect(closedEvidence(["another's eyes closed"], 'male')).toBeNull()
  })
})

describe('눈이 안 보임 읽기 — 눈 감음 기호', () => {
  it('^_^ · >_< · u_u · ^q^ · x3 · xd · dx 는 완전히 감은 눈이다 — 가중치 묶음·쉼표 목록·역할 접두사 안에서도', () => {
    for (const text of ['^_^', '^ ^', '>_<', '> <', 'u_u', '^q^', 'x3', 'xd', 'dx']) {
      expect(evidenceOf([text]), text).toBe(`closed:${text}`)
    }
    expect(evidenceOf(['smile, >_<, blush'])).toBe('closed:>_<')
    expect(evidenceOf(['1.2::>_<, blush::'])).toBe('closed:>_<')
    expect(evidenceOf(['1.2::^_^::'])).toBe('closed:^_^')
    expect(evidenceOf(['target#>_<'])).toBe('closed:target#>_<')
    expect(evidenceOf(['1.2::xd, blush::'])).toBe('closed:xd')
  })

  it('반쯤 뜬 기호(=_=)·윙크(>_o)·울음(T_T)·한쪽 눈 기호는 감은 눈이 아니다', () => {
    for (const text of [
      '=_=',
      '= =',
      '>_o',
      ';)',
      ';d',
      ':q',
      'T_T',
      't t',
      '^^^',
      '^_o',
      '@_@',
      'o_o',
      // 눈 하나만 감은 윙크 이모티콘 · 입 모양만 있는 이모티콘 · 낱말 속 xd
      ';p',
      ';o',
      ';q',
      ':d',
      ':3',
      'xdd',
      'the xd file',
      'dx11'
    ]) {
      expect(evidenceOf([text]), text).toBe('-')
    }
  })

  it('실제로 보내지 않는 글의 기호는 신호가 아니다 — 음수 가중치 · 주석 · 와일드카드', () => {
    for (const text of ['-1::^_^::', '0::>_<::', '# ^_^', 'smile # >_<', '<a>_<b>', 'x3/x4']) {
      expect(evidenceOf([text]), text).toBe('-')
    }
  })
})

describe('눈이 안 보임 읽기 — 잠듦', () => {
  it('sleeping · sleeping upright · sleeping on person · sleeping on desk · sleep molestation · asleep 태그', () => {
    for (const text of [
      'sleeping',
      'Sleeping',
      'sleeping upright',
      'sleeping on person',
      'sleeping on desk',
      'sleep molestation',
      'asleep',
      'fast asleep',
      '1.2::sleeping::'
    ]) {
      expect(evidenceOf([text]).startsWith('asleep:'), text).toBe(true)
    }
  })

  it('영어 문장 — she is asleep · she is sleeping soundly · she sleeps · while she sleeps', () => {
    for (const text of [
      'she is asleep',
      'she is fast asleep',
      "she's asleep",
      'she is sleeping soundly',
      'she sleeps',
      'while she sleeps',
      'her sleeping face',
      'the girl is sleeping'
    ]) {
      expect(evidenceOf([text]), text).toBe(`asleep:${text}`)
    }
  })

  it('잠든 게 아니거나 이 캐릭터가 아니면 읽지 않는다 — half-asleep · sleepy · waking up · 잠들려는 참 · 침낭 · 잠옷 · 부정문 · 상대', () => {
    for (const text of [
      'half-asleep',
      'she is half asleep',
      'sleepy',
      'she is sleepy',
      'waking up',
      'she is waking up',
      'she is about to fall asleep',
      'she falls asleep',
      'sleeping bag',
      'sleepwear',
      'sleepover',
      'she is not sleeping',
      "she isn't asleep",
      'feigning sleep',
      'she pretends to be asleep',
      'unconscious',
      'fainting',
      'messy sleeper',
      'sleeping animal',
      'sleeping cat',
      'her sleeping partner',
      'her partner is asleep',
      'he is asleep',
      'sleep'
    ]) {
      expect(evidenceOf([text]), text).toBe('-')
    }
  })

  it('her/his 는 이 캐릭터 몸에 맞을 때만 — 후타(null)는 거르지 않는다', () => {
    expect(evidenceOf(['he is asleep'], 'male')).toBe('asleep:he is asleep')
    expect(evidenceOf(['he is asleep'], 'female')).toBe('-')
    expect(evidenceOf(['he is asleep'], null)).toBe('asleep:he is asleep')
    expect(evidenceOf(['she is asleep'], 'male')).toBe('-')
  })
})

describe('눈이 안 보임 읽기 — 눈 가림', () => {
  it('blindfold 계열 — 색·재질이 붙은 것 · blindfolded · covered eyes · covering own eyes · 양쪽 눈 붕대', () => {
    for (const text of [
      'blindfold',
      'black blindfold',
      'white blindfold',
      'red blindfold',
      'blindfolded',
      'she is blindfolded',
      'covered eyes',
      'covering own eyes',
      'bandages over eyes',
      // 단보루 실존 태그 — 눈 위를 음경이 덮음 (한쪽 눈은 아래 제외 목록)
      'penis over eyes'
    ]) {
      expect(evidenceOf([text]), text).toBe(`covered:${text}`)
    }
  })

  it('영어 문장 — 눈이 덮였다 · 제 눈을 가렸다 · 손으로 가렸다', () => {
    for (const text of [
      'her eyes are covered',
      'with her eyes covered',
      'she covers her eyes with her hands',
      'she covered her eyes',
      'covering her eyes',
      'her hands over her eyes',
      'sleep mask over her eyes',
      'wearing a sleep mask'
    ]) {
      expect(evidenceOf([text]), text).toBe(`covered:${text}`)
    }
  })

  it('눈가리개를 들어 올렸거나 벗었거나 비치는 것 · 한쪽 눈 · 손가락 사이 · 머리카락 · 상대의 눈은 아니다', () => {
    for (const text of [
      'blindfold lift',
      'blindfold lifted',
      'blindfold removed',
      'removing blindfold',
      'blindfold around neck',
      'blindfold on head',
      'blindfold on her forehead',
      'unworn blindfold',
      'no blindfold',
      'holding blindfold',
      'see-through blindfold',
      'sleep mask on head',
      'mask on head',
      'eye mask',
      'eyepatch',
      'one eye covered',
      'covering one eye',
      'bandage over one eye',
      'hand over eye',
      'shading eyes',
      'peeking through fingers',
      'she covers her eyes peeking through her fingers',
      'hair over eyes',
      'hair covering her eyes',
      'hat over one eye',
      'penis over one eye',
      'eyes in shadow',
      'eyes out of frame',
      "covering another's eyes",
      "her partner's eyes are covered",
      'eyes covered in tears',
      'her eyes are not covered',
      'covering face',
      'facepalm',
      'blind',
      'his blindfold'
    ]) {
      expect(evidenceOf([text]), text).toBe('-')
    }
  })

  it('눈가리개를 들어 올렸다는 글이 어디에라도 있으면 같은 눈가리개는 근거로 치지 않는다', () => {
    expect(evidenceOf(['blindfold, blindfold lift'])).toBe('-')
    expect(evidenceOf({ scene: ['blindfold'], char: ['blindfold lift'] })).toBe('-')
    expect(evidenceOf(['sleep mask, mask on head'])).toBe('-')
    // 그냥 mask on head 는 무슨 마스크인지 모른다 — 수면 안대만 지우고 눈가리개는 그대로 근거
    expect(evidenceOf(['gas mask on head, blindfold'])).toBe('covered:blindfold')
    expect(evidenceOf({ scene: ['blindfold'], char: ['mask on head'] })).toBe('covered:blindfold')
    expect(evidenceOf({ scene: ['sleep mask'], char: ['mask on head'] })).toBe('-')
    expect(evidenceOf([], 'female', 'black blindfold, mask on head')).toBe(
      'covered:black blindfold'
    )
    expect(evidenceOf([], 'female', 'black blindfold')).toBe('covered:black blindfold')
    expect(evidenceOf({ char: ['blindfold removed'] }, 'female', 'black blindfold')).toBe('-')
  })

  it('her/his 는 눈 주인이 이 캐릭터 몸일 때만', () => {
    expect(evidenceOf(['his eyes are covered'], 'female')).toBe('-')
    expect(evidenceOf(['his eyes are covered'], 'male')).toBe('covered:his eyes are covered')
    expect(evidenceOf(['his eyes are covered'], null)).toBe('covered:his eyes are covered')
    expect(evidenceOf(['he is blindfolded'], 'female')).toBe('-')
  })
})

describe('눈이 안 보임 읽기 — 복장 · 범위', () => {
  it('입은 복장에서는 눈 가림 물건만 근거가 된다 — blindfold · 눈을 덮은 sleep mask', () => {
    const e = hiddenEyesEvidence([], 'female', 'black blindfold, white dress')
    expect(e).toMatchObject({ cause: 'covered', text: 'black blindfold', outfit: true })
    expect(evidenceOf([], 'female', 'sleep mask')).toBe('covered:sleep mask')
    // 복장 글의 감은 눈·잠듦은 근거가 아니다
    expect(evidenceOf([], 'female', 'closed eyes, sleeping')).toBe('-')
    expect(evidenceOf([], 'female', 'glasses, eyepatch, mask on head')).toBe('-')
  })

  it('같은 글에 잠듦이 먼저, 눈 감음이 나중에 적혀 있어도 눈 감음을 보여 준다', () => {
    expect(evidenceOf(['bed, sleeping, closed eyes'])).toBe('closed:closed eyes')
    expect(evidenceOf(['bed, blindfold', 'sleeping, closed eyes'])).toBe('closed:closed eyes')
    expect(evidenceOf(['bed, blindfold, sleeping'])).toBe('asleep:sleeping')
  })

  it('근거가 여럿이면 눈 감음 > 잠듦 > 눈 가림 순으로 보여 준다 — 같은 까닭이면 넓은 범위부터', () => {
    expect(
      hiddenEyesEvidence({ scene: ['sleeping'], role: ['closed eyes'] }, 'female')
    ).toMatchObject({
      cause: 'closed',
      text: 'closed eyes',
      scope: 'role',
      narrowest: 'role'
    })
    expect(
      hiddenEyesEvidence({ scene: ['blindfold'], char: ['sleeping'] }, 'female')
    ).toMatchObject({
      cause: 'asleep',
      scope: 'char',
      narrowest: 'char'
    })
    expect(hiddenEyesEvidence({ scene: ['closed eyes'], role: ['^_^'] }, 'female')).toMatchObject({
      text: 'closed eyes',
      scope: 'scene',
      narrowest: 'role'
    })
  })

  it('근거가 놓인 범위 — 보여 주는 근거는 넓은 쪽부터, narrowest 는 가장 좁은 쪽', () => {
    expect(hiddenEyesEvidence({ scene: ['closed eyes'] }, 'female')).toMatchObject({
      cause: 'closed',
      scope: 'scene',
      narrowest: 'scene'
    })
    expect(hiddenEyesEvidence({ scene: ['smile'], role: ['closed eyes'] }, 'female')).toMatchObject(
      {
        scope: 'role',
        narrowest: 'role'
      }
    )
    expect(
      hiddenEyesEvidence({ scene: ['closed eyes'], char: ['sleeping'] }, 'female')
    ).toMatchObject({ cause: 'closed', scope: 'scene', narrowest: 'char' })
    // 복장은 이 캐릭터만의 글과 같은 범위
    expect(hiddenEyesEvidence({ scene: ['closed eyes'] }, 'female', 'blindfold')).toMatchObject({
      scope: 'scene',
      narrowest: 'char'
    })
    // 글 목록만 주면 씬 전체 글
    expect(hiddenEyesEvidence(['sleeping'], 'female')).toMatchObject({ scope: 'scene' })
  })

  it('눈 뜬 표현 — 가장 좁은 범위의 것을 돌려준다 (눈 색·빛나는 눈은 눈 뜸이 분명하지 않다)', () => {
    expect(
      openEyesExpression({ scene: ['looking at viewer'], char: ['rolling eyes'] }, 'female')
    ).toEqual({
      text: 'rolling eyes',
      scope: 'char'
    })
    for (const text of [
      'looking at viewer',
      'wide-eyed',
      'half-closed eyes',
      'heart-shaped pupils',
      '@_@',
      'open eyes',
      'eyes wide open',
      'her eyes are wide open',
      'she opens her eyes',
      'jitome'
    ]) {
      expect(openEyesExpression([text], 'female'), text).toMatchObject({ scope: 'scene' })
    }
    for (const text of [
      'blue eyes',
      'glowing eyes',
      'black sclera',
      'closed eyes',
      'one eye closed',
      'facing viewer',
      'looking back',
      'her eyes are not open',
      'his eyes are wide open',
      '-1::looking at viewer::',
      '# rolling eyes',
      '(rolling eyes/wide-eyed)'
    ]) {
      expect(openEyesExpression([text], 'female'), text).toBeNull()
    }
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

  it('기호 눈 — 눈 자리에 만화 기호가 그려진 눈 (@_@ · +_+ · x_x · o_o · 하트 모양 눈 · 단색 원/타원 눈)', () => {
    for (const tag of [
      'heart-shaped eyes',
      'heart shaped eyes',
      'spiral-only eyes',
      '@_@',
      '@ @',
      '+_+',
      'x_x',
      'o_o',
      '0_0',
      '._.',
      'solid circle eyes',
      'solid oval eyes',
      'solid eyes',
      'wide oval eyes',
      'wavy eyes',
      'dashed eyes',
      'pac-man eyes',
      // 옛 이름(spiral-only eyes 의 앞 이름 · star-shaped pupils 로 모인 이름)도 같은 뜻
      'spiral eyes',
      'star-shaped eyes'
    ]) {
      expect(eyeLookKind(tag.replace(/_/g, ' ')), tag).toBe('symbol')
    }
  })

  it('눈 상태 — 눈을 떠야 성립하는 모양·표정 (반쯤 뜬 눈 · 가늘게 뜬 눈 · 공허한 눈 · 광기 어린 눈 · 눈을 크게 뜬 · 눈알 굴리기 · 사팔뜨기 · jitome · sanpaku)', () => {
    for (const tag of [
      'half-closed eyes',
      'half closed eyes',
      'half-closed eye',
      'narrowed eyes',
      'jitome',
      'sanpaku',
      'empty eyes',
      'hollow eyes',
      'blank eyes',
      'crazy eyes',
      'wide-eyed',
      'rolling eyes',
      'cross-eyed',
      'wall-eyed',
      'unusually open eyes',
      'uneven eyes',
      'bulging eyes',
      'squinting',
      'crying with eyes open',
      'open eyes',
      'opening eyes',
      'eyes wide open',
      'cross eye',
      // 눈이 위로 돌아간 모양 (rolling eyes 와 같은 뜻)
      'eyes rolled back',
      'eyes rolling back',
      'eyes half rolled back',
      'eyes rolled back showing mostly whites',
      'rolled up eyes',
      '= =',
      '3 3'
    ]) {
      expect(eyeLookKind(tag), tag).toBe('state')
    }
    // 눈과 상관없는 rolled · 문장은 건드리지 않는다
    for (const tag of [
      'rolled up sleeves',
      'sleeves rolled up',
      'hair rolled up',
      'her eyes rolled back in pleasure as she lost herself in the moment'
    ]) {
      expect(eyeLookKind(tag), tag).toBeNull()
    }
  })

  it('시선 — looking … 태그 · eye contact · staring · glaring — 얼굴 방향(facing viewer)과 고개 돌림(looking back)은 남긴다', () => {
    for (const tag of [
      'looking at viewer',
      'looking_at_viewer',
      'looking at another',
      'looking away',
      'looking down',
      'looking up',
      'looking to the side',
      'looking ahead',
      'looking past viewer',
      'looking at hand',
      'eye contact',
      'sideways glance',
      'glance',
      'staring',
      'glaring',
      'averting eyes',
      'blank stare',
      'downturned eyes',
      'upturned eyes'
    ]) {
      expect(eyeLookKind(tag.replace(/_/g, ' ')), tag).toBe('gaze')
    }
    for (const tag of [
      'facing viewer',
      'facing away',
      'looking back',
      'looking at viewer with a smile and a blush',
      'she is looking at the viewer while smiling'
    ]) {
      expect(eyeLookKind(tag), tag).toBeNull()
    }
  })

  it('분류표 — 단보루 눈 관련 태그(사용 수 150 이상) 전수: 뺌 / 남김이 늘 같다', () => {
    const REMOVE: Record<string, string[]> = {
      color: [
        'blue eyes',
        'red eyes',
        'heterochromia',
        'multicolored eyes',
        'white eyes',
        'alternate eye color',
        'two-tone eyes',
        'gradient eyes',
        'official alternate eye color',
        'rainbow eyes',
        'no heterochromia'
      ],
      pupil: [
        'symbol-shaped pupils',
        'bright pupils',
        'heart-shaped pupils',
        'slit pupils',
        'no pupils',
        'constricted pupils',
        'dilated pupils',
        'glowing pupils',
        'dot pupils',
        'small pupils',
        'solid circle pupils',
        'extra pupils'
      ],
      sclera: ['colored sclera', 'black sclera', 'no sclera', 'mismatched sclera', 'red sclera'],
      glow: [
        'glowing eyes',
        'glowing eye',
        'sparkling eyes',
        'shiny eyes',
        'bloodshot eyes',
        'flaming eyes',
        'flaming eye'
      ],
      iris: [
        'ringed eyes',
        'symbol in eye',
        'star in eye',
        'heart in eye',
        'flower in eye',
        'clock eyes',
        'text in eyes',
        'sharingan',
        'byakugan',
        'rinnegan'
      ],
      symbol: [
        'spiral eyes',
        'star-shaped eyes',
        '@ @',
        '+ +',
        'x x',
        'o o',
        '0 0',
        '. .',
        'solid oval eyes',
        'solid circle eyes',
        'solid eyes',
        'wavy eyes',
        'dashed eyes',
        'heart-shaped eyes',
        'wide oval eyes',
        'spiral-only eyes',
        'pac-man eyes'
      ],
      state: [
        'half-closed eyes',
        'half-closed eye',
        'crying with eyes open',
        'jitome',
        'empty eyes',
        'wide-eyed',
        'rolling eyes',
        'blank eyes',
        'sanpaku',
        'uneven eyes',
        'crazy eyes',
        'narrowed eyes',
        'unusually open eyes',
        'squinting',
        'opening eyes',
        'eyes rolled back',
        'hollow eyes',
        'bulging eyes',
        'cross-eyed',
        'lazy eye',
        'wall-eyed',
        'evil eyes',
        'eye pop',
        'pleading eyes',
        'creepy eyes',
        '= =',
        '3 3',
        'lowered eyelids'
      ],
      gaze: [
        'looking at viewer',
        'looking at another',
        'looking to the side',
        'looking down',
        'looking up',
        'eye contact',
        'looking ahead',
        'sideways glance',
        'looking afar',
        'looking at object',
        'glaring',
        'averting eyes',
        'staring',
        'looking over eyewear',
        'upturned eyes',
        'blank stare',
        'looking outside',
        'looking through own legs',
        'downturned eyes',
        'looking past viewer',
        'glance'
      ]
    }
    for (const [kind, tags] of Object.entries(REMOVE)) {
      for (const tag of tags) expect(eyeLookKind(tag), tag).toBe(kind)
    }
    // 남기는 것 — 눈매 윤곽 · 속눈썹 · 눈썹 · 화장 · 안경류 · 가면 · 눈 주변 무늬 · 눈물 · 감은 눈에도 그려지는 것 · 눈 수·종 특징 · 구도
    const KEEP = [
      'tsurime',
      'tareme',
      'thick eyebrows',
      'curly eyebrows',
      'v-shaped eyebrows',
      'raised eyebrows',
      'long eyelashes',
      'thick eyelashes',
      'white eyelashes',
      'lower eyelashes only',
      'mismatched eyelashes',
      'eyelashes',
      'colored eyelashes',
      'eyeshadow',
      'red eyeshadow',
      'eyeliner',
      'mascara',
      'glasses',
      'sunglasses',
      'eyepatch',
      'goggles',
      'monocle',
      'mask',
      'eye mask',
      'blindfold',
      'sleep mask',
      'mole under eye',
      'scar across eye',
      'bags under eyes',
      'tears',
      'crying',
      'tearing up',
      'closed eyes',
      'one eye closed',
      'one eye covered',
      'covered eyes',
      'covering own eyes',
      'one-eyed',
      'no eyes',
      'third eye',
      'extra eyes',
      'cephalopod eyes',
      'compound eyes',
      'button eyes',
      'lens eye',
      'v-shaped eyes',
      'mature eyes',
      'very big eyes',
      'large eyes',
      'hair between eyes',
      'hair over one eye',
      'hair over eyes',
      'eyes visible through hair',
      'eyes visible through eyewear',
      'eye focus',
      'eye reflection',
      'ahegao',
      'facing viewer',
      'looking back',
      'closed mouth',
      'blush',
      // 눈을 가리거나 감은 표현 자체 — 근거로는 읽어도 눈 외형은 아니다
      '^ ^',
      '> <',
      'u u',
      'xd',
      'sleeping',
      'sleepy',
      'blindfold',
      'hat over eyes',
      'helmet over eyes',
      'penis over eyes',
      'eyes in shadow',
      'eyes out of frame',
      'eyes visible through hair',
      'unconscious',
      'fainting',
      'eyelid pull',
      'blood from eyes',
      'eye trail',
      '| |',
      '<|> <|>',
      '<o> <o>',
      't t'
    ]
    for (const tag of KEEP) expect(eyeLookKind(tag), tag).toBeNull()
  })

  it('눈 모양 · 속눈썹 · 화장 · 안경류 · 눈 주변 흉터 · 감은 눈에도 그려지는 것은 눈 외형이 아니다', () => {
    for (const tag of [
      'tsurime',
      'tareme',
      'one eye closed',
      'closed eyes',
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

  it('갈래마다 한국어 이름이 있고 이유 문구는 「까닭 — 갈래 뺌」이다', () => {
    for (const label of Object.values(EYE_LOOK_LABEL)) expect(label).toMatch(/[가-힣]/)
    for (const label of Object.values(EYE_CAUSE_LABEL)) expect(label).toMatch(/[가-힣]/)
    expect(eyeReason('color')).toBe('눈 감음 — 눈 색 뺌')
    expect(eyeReason('pupil')).toBe('눈 감음 — 동공 뺌')
    expect(eyeReason('sclera')).toBe('눈 감음 — 흰자 뺌')
    expect(eyeReason('symbol', 'asleep')).toBe('잠듦 — 기호 눈 뺌')
    expect(eyeReason('gaze', 'covered')).toBe('눈 가림 — 시선 뺌')
    expect(eyeReason('state', 'closed')).toBe('눈 감음 — 눈 상태 뺌')
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

  it('눈매 윤곽 · 속눈썹 · 눈썹 · 화장 · 안경 · 안대 · 고글 · 가면 · 눈 주변 흉터·점 · 눈물은 남긴다', () => {
    const keep = [
      'tsurime',
      'tareme',
      'long eyelashes',
      'thick eyebrows',
      'eyeshadow',
      'eyeliner',
      'mascara',
      'glasses',
      'eyepatch',
      'goggles',
      'eye mask',
      'scar across eye',
      'mole under eye',
      'bags under eyes',
      'tears',
      'one eye covered',
      'facing viewer'
    ]
    const card = `1girl, blue eyes, ${keep.join(', ')}, slit pupils, red hair`
    const r = strip(card, ['closed eyes'])
    expect(tagsOf(r.text)).toEqual(['1girl', ...keep, 'red hair'])
    expect(r.notes.map((n) => n.before)).toEqual(['blue eyes', 'slit pupils'])
  })

  it('기호 눈 · 눈 상태 · 시선도 뺀다 — 눈을 떠야만 보이는 것은 카드에서 전부', () => {
    const card = [
      '1girl',
      'blue eyes',
      'heart-shaped eyes',
      '@_@',
      'solid circle eyes',
      'half-closed eyes',
      'jitome',
      'sanpaku',
      'empty eyes',
      'crazy eyes',
      'wide-eyed',
      'rolling eyes',
      'looking at viewer',
      'eye contact',
      'tsurime',
      'facing viewer',
      'red hair'
    ].join(', ')
    const r = strip(card, ['closed eyes'])
    expect(r.text).toBe('1girl, tsurime, facing viewer, red hair')
    expect(r.notes.map((n) => [n.before, n.reason])).toEqual([
      ['blue eyes', '눈 감음 — 눈 색 뺌'],
      ['heart-shaped eyes', '눈 감음 — 기호 눈 뺌'],
      ['@_@', '눈 감음 — 기호 눈 뺌'],
      ['solid circle eyes', '눈 감음 — 기호 눈 뺌'],
      ['half-closed eyes', '눈 감음 — 눈 상태 뺌'],
      ['jitome', '눈 감음 — 눈 상태 뺌'],
      ['sanpaku', '눈 감음 — 눈 상태 뺌'],
      ['empty eyes', '눈 감음 — 눈 상태 뺌'],
      ['crazy eyes', '눈 감음 — 눈 상태 뺌'],
      ['wide-eyed', '눈 감음 — 눈 상태 뺌'],
      ['rolling eyes', '눈 감음 — 눈 상태 뺌'],
      ['looking at viewer', '눈 감음 — 시선 뺌'],
      ['eye contact', '눈 감음 — 시선 뺌']
    ])
  })

  it('xd 의 감은 눈이 근거이면 위로 돌아간 눈 · 눈 뜨는 중 · 나선 눈 · 별 모양 눈도 뺀다', () => {
    const card =
      '1girl, green eyes, eyes rolled back, opening eyes, spiral eyes, star-shaped eyes, xd, red hair'
    const r = strip(card, ['xd'])
    expect(r.text).toBe('1girl, xd, red hair')
    expect(r.notes.map((n) => [n.before, n.reason])).toEqual([
      ['green eyes', '눈 감음 — 눈 색 뺌'],
      ['eyes rolled back', '눈 감음 — 눈 상태 뺌'],
      ['opening eyes', '눈 감음 — 눈 상태 뺌'],
      ['spiral eyes', '눈 감음 — 기호 눈 뺌'],
      ['star-shaped eyes', '눈 감음 — 기호 눈 뺌']
    ])
    expect(r.notes.every((n) => n.evidence === 'xd' && n.cause === undefined)).toBe(true)
  })

  it('까닭마다 이유에 까닭이 보이고, 눈 감음이 아니면 메모에 cause 가 붙는다', () => {
    const card = '1girl, blue eyes, heart-shaped eyes, looking at viewer'
    const closed = strip(card, ['closed eyes'])
    expect(closed.notes.every((n) => !('cause' in n))).toBe(true)
    const asleep = strip(card, ['sleeping'])
    expect(asleep.text).toBe('1girl')
    expect(asleep.notes.map((n) => [n.cause, n.evidence, n.reason])).toEqual([
      ['asleep', 'sleeping', '잠듦 — 눈 색 뺌'],
      ['asleep', 'sleeping', '잠듦 — 기호 눈 뺌'],
      ['asleep', 'sleeping', '잠듦 — 시선 뺌']
    ])
    const covered = strip(card, ['black blindfold'])
    expect(covered.text).toBe('1girl')
    expect(covered.notes.map((n) => [n.cause, n.evidence, n.reason])).toEqual([
      ['covered', 'black blindfold', '눈 가림 — 눈 색 뺌'],
      ['covered', 'black blindfold', '눈 가림 — 기호 눈 뺌'],
      ['covered', 'black blindfold', '눈 가림 — 시선 뺌']
    ])
  })

  it('복장에 눈 가림 물건이 있으면 근거 — 「복장 …」으로 보이고, 복장의 감은 눈·잠듦은 근거가 아니다', () => {
    const r = strip('1girl, blue eyes, red hair', [], 'female', {
      outfit: 'black blindfold, white dress'
    })
    expect(r.text).toBe('1girl, red hair')
    expect(r.notes).toEqual([
      {
        kind: 'removed',
        where: 'char',
        topic: 'eyes',
        cause: 'covered',
        charIndex: 0,
        name: '합성 카드',
        charId: 7,
        before: 'blue eyes',
        evidence: '복장 black blindfold',
        reason: '눈 가림 — 눈 색 뺌'
      }
    ])
    expect(
      strip('1girl, blue eyes', [], 'female', { outfit: 'closed eyes, sleeping' }).notes
    ).toEqual([])
    // 눈가리개를 들어 올린 장면이면 복장의 눈가리개도 근거가 아니다
    expect(
      strip('1girl, blue eyes', { char: ['blindfold lift'] }, 'female', {
        outfit: 'black blindfold'
      }).notes
    ).toEqual([])
  })

  it('card 자체 글의 감음·잠듦·가림 태그는 근거로 쓰지 않는다', () => {
    for (const card of [
      '1girl, blue eyes, closed eyes',
      '1girl, blue eyes, sleeping',
      '1girl, blue eyes, blindfold'
    ]) {
      const r = strip(card, ['smile'])
      expect(r.text, card).toBe(card)
      expect(r.notes, card).toEqual([])
    }
  })
})

describe('더 좁은 글의 말이 이긴다', () => {
  const CARD = '1girl, blue eyes, slit pupils, red hair'

  it('근거가 씬 전체 글인데 이 캐릭터의 글에 눈 뜬 표현이 분명하면 빼지 않고 안 바꿈으로 알린다', () => {
    const r = strip(CARD, { scene: ['bed, closed eyes'], char: ['smile, rolling eyes'] })
    expect(r.text).toBe(CARD)
    expect(r.notes.map((n) => [n.kind, n.before, n.evidence, n.reason])).toEqual([
      [
        'kept',
        'blue eyes',
        'closed eyes',
        '눈 감음 — 이 캐릭터의 글에 눈 뜬 표현(rolling eyes)이 있어 그대로 둠'
      ],
      [
        'kept',
        'slit pupils',
        'closed eyes',
        '눈 감음 — 이 캐릭터의 글에 눈 뜬 표현(rolling eyes)이 있어 그대로 둠'
      ]
    ])
    expect(r.notes.every((n) => n.topic === 'eyes' && n.where === 'char')).toBe(true)
  })

  it('얼굴 인셋 자리면 이유에 「인셋 자리」가 보인다', () => {
    const r = strip(CARD, { scene: ['closed eyes'], seat: ['close-up, wide-eyed'] }, 'female', {
      faceSeat: true
    })
    expect(r.text).toBe(CARD)
    expect(r.notes[0].reason).toBe('눈 감음 — 인셋 자리에 눈 뜬 표현(wide-eyed)이 있어 그대로 둠')
  })

  it('역할 칸의 눈 뜬 표현도 씬 전체 글보다 좁다', () => {
    const r = strip(CARD, { scene: ['closed eyes'], role: ['looking at viewer'] })
    expect(r.text).toBe(CARD)
    expect(r.notes[0].reason).toBe(
      '눈 감음 — 하는쪽·당하는쪽 칸에 눈 뜬 표현(looking at viewer)이 있어 그대로 둠'
    )
  })

  it('눈 뜬 표현이 더 넓은 글에 있고 근거가 더 좁으면 근거를 따른다 — 말도 안 한다', () => {
    const r = strip(CARD, { scene: ['looking at viewer, wide-eyed'], char: ['closed eyes'] })
    expect(r.text).toBe('1girl, red hair')
    expect(r.notes.map((n) => n.reason)).toEqual(['눈 감음 — 눈 색 뺌', '눈 감음 — 동공 뺌'])
  })

  it('근거와 눈 뜬 표현이 같은 범위에 있으면(모순) 근거를 따르되 메모에 둘 다 보인다', () => {
    const r = strip(CARD, ['bed, closed eyes, looking at viewer'])
    expect(r.text).toBe('1girl, red hair')
    expect(r.notes.map((n) => [n.evidence, n.reason])).toEqual([
      [
        'closed eyes',
        '눈 감음 — 눈 색 뺌 · 같은 범위에 눈 뜬 표현(looking at viewer)도 있으나 근거를 따름'
      ],
      [
        'closed eyes',
        '눈 감음 — 동공 뺌 · 같은 범위에 눈 뜬 표현(looking at viewer)도 있으나 근거를 따름'
      ]
    ])
  })

  it('복장의 눈가리개는 이 캐릭터의 글과 같은 범위라 — 이 캐릭터 글의 시선과는 모순으로 보고 뺀다', () => {
    const r = strip(CARD, { char: ['looking at viewer'] }, 'female', { outfit: 'black blindfold' })
    expect(r.text).toBe('1girl, red hair')
    expect(r.notes[0].reason).toContain('같은 범위에 눈 뜬 표현(looking at viewer)')
    // 씬 전체 글의 시선은 복장보다 넓어서 지고, 이 캐릭터 글의 눈 뜬 표현이 복장보다 좁을 수는 없다
    expect(
      strip(CARD, { scene: ['looking at viewer'] }, 'female', {
        outfit: 'black blindfold'
      }).notes.map((n) => n.reason)
    ).toEqual(['눈 가림 — 눈 색 뺌', '눈 가림 — 동공 뺌'])
  })

  it('눈 뜬 표현 때문에 아무것도 안 빼는 경우, 짝 안 맞는 줄·랜덤 선택지 안내는 따로 하지 않는다', () => {
    const r = strip('1girl, (blue eyes/red eyes), 1.2::slit pupils', {
      scene: ['closed eyes'],
      char: ['rolling eyes']
    })
    expect(r.notes).toEqual([])
  })
})

describe('카드에서 눈 외형 빼기 — 나머지', () => {
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
      enabled: true,
      card: 'blue eyes',
      contexts: ['closed eyes'],
      sex: null,
      who: { index: 2, name: '이름' }
    })
    expect(r.notes[0]).not.toHaveProperty('charId')
    expect(r.notes[0].charIndex).toBe(2)
  })

  it('설정이 꺼져 있으면(enabled false) 감은 눈이어도 카드 글 그대로, 메모 없음 — 이 기능이 없을 때와 같다', () => {
    const cards = [
      '1girl, blue eyes, red hair',
      '1girl, blue eyes, slit pupils, black sclera, glowing eyes, ringed eyes',
      '1.2::blue eyes, red hair::, smile',
      '1girl, 1.2::blue eyes, red hair, slit pupils\ngreen eyes',
      '1girl, (blue eyes/red eyes), red hair',
      ''
    ]
    for (const card of cards) {
      const off = stripEyesWhenClosed({
        enabled: false,
        card,
        contexts: ['closed eyes', 'her eyes are closed'],
        sex: 'female',
        who
      })
      expect(off.text, card).toBe(card)
      expect(off.notes, card).toEqual([])
    }
    // 같은 입력을 켜면 뺀다 — 끈 것과 켠 것이 갈린다
    expect(strip('1girl, blue eyes', ['closed eyes']).text).toBe('1girl')
  })

  it('her/his 문장은 이 캐릭터 몸에 맞을 때만, 후타(null)는 어느 쪽이든', () => {
    const card = '1girl, blue eyes'
    expect(strip(card, ['his eyes are closed'], 'female').text).toBe(card)
    expect(strip(card, ['her eyes are closed'], 'female').text).toBe('1girl')
    expect(strip(card, ['his eyes are closed'], null).text).toBe('1girl')
    expect(strip('1boy, brown eyes', ['her eyes are closed'], 'male').text).toBe('1boy, brown eyes')
  })
})

describe('검수 반영 — 눈 가림 주인 · 풀기 판정', () => {
  const cases: [string, Sex, 'covered' | '-'][] = [
    // 눈가리개 문장은 쓴 사람이 이 캐릭터일 때만 — 씌우는 쪽·반대 성별은 건너뛴다
    ['his eyes are covered by a blindfold', 'female', '-'],
    ['his eyes are covered by a blindfold', 'male', 'covered'],
    ['her eyes are covered by a blindfold', 'female', 'covered'],
    ['he puts a blindfold on her', 'male', '-'],
    ['he puts a blindfold on her', 'female', 'covered'],
    ['she puts the blindfold on him', 'female', '-'],
    ['she puts the blindfold on him', 'male', 'covered'],
    ['he blindfolds her', 'male', '-'],
    ['he blindfolds her', 'female', 'covered'],
    ['she blindfolds him', 'female', '-'],
    ['she blindfolds him', 'male', 'covered'],
    ['he blindfolded her', 'female', 'covered'],
    ['he blindfolded her', 'male', '-'],
    ['blindfolded man', 'female', '-'],
    ['blindfolded woman', 'female', 'covered'],
    ['he wears a blindfold', 'female', '-'],
    ['she wears a blindfold', 'female', 'covered'],
    ['sleep mask over his eyes', 'female', '-'],
    ['a black blindfold tied around her head', 'female', 'covered'],
    // 주인을 못 정하면 거르지 않는다
    ['blindfolded', 'male', 'covered'],
    ['black blindfold', 'male', 'covered'],
    ['wearing a sleep mask', 'male', 'covered'],
    // 후타(null)는 성별로 거르지 않는다
    ['he blindfolds her', null, 'covered']
  ]

  it('눈가리개 문장은 쓴 사람이 이 캐릭터 몸일 때만 — 씌우는 쪽과 반대 성별은 거른다', () => {
    for (const [text, sex, want] of cases) {
      expect(evidenceOf([text], sex), `${sex} ${text}`).toBe(want === '-' ? '-' : `covered:${text}`)
    }
  })

  it('눈가리개를 푼 말은 그 물건 앞뒤 낱말에서만 읽는다 — 다른 낱말이 있다고 근거를 지우지 않는다', () => {
    // 흔한 낱말(up · tied · hold)이 같은 글 어딘가에 있어도 풀었다는 뜻이 아니다
    expect(evidenceOf(['she is blindfolded and tied up'])).toBe(
      'covered:she is blindfolded and tied up'
    )
    // 푼 것으로 오해해 전역 취소가 되면 별개의 근거까지 지워진다
    expect(evidenceOf(['black blindfold', 'she is blindfolded and tied up'])).toBe(
      'covered:black blindfold'
    )
    expect(evidenceOf(['she is blindfolded and tied up', 'black blindfold'])).toBe(
      'covered:she is blindfolded and tied up'
    )
    expect(
      evidenceOf({ char: ['she is blindfolded and tied up'] }, 'female', 'black blindfold')
    ).toBe('covered:she is blindfolded and tied up')
    // 눈가리개를 쓴 가장 흔한 묘사 — 머리를 감싸 묶었다
    expect(evidenceOf(['a black blindfold tied around her head'])).toBe(
      'covered:a black blindfold tied around her head'
    )
    expect(evidenceOf(['blindfold tied behind her head'])).toBe(
      'covered:blindfold tied behind her head'
    )
    // 머리 위·이마·목은 벗어서 걸친 것
    for (const text of [
      'blindfold on head',
      'blindfold on her head',
      'blindfold pushed up onto her forehead',
      'blindfold around neck',
      'blindfold above her head'
    ]) {
      expect(evidenceOf([text]), text).toBe('-')
    }
    // 눈 위로 끌어내린 것은 덮은 것이고, 눈 말이 없는 끌어내림은 벗은 것이다
    expect(evidenceOf(['blindfold pulled over her eyes'])).toBe(
      'covered:blindfold pulled over her eyes'
    )
    expect(evidenceOf(['blindfold pulled down'])).toBe('-')
    // 같은 글에 푼 눈가리개가 따로 있으면 이쪽도 근거가 아니다 (전역 취소는 그대로)
    expect(evidenceOf(['blindfold', 'blindfold removed'])).toBe('-')
    expect(evidenceOf(['blindfold', 'she holds the blindfold in her hand'])).toBe('-')
  })

  it('푸는 동작의 변형도 푼 것이다 — untying · undoing · undone · unwrapped · unfastened · raised · sliding', () => {
    for (const text of [
      'untying the blindfold',
      'untied blindfold',
      'undoing the blindfold',
      'blindfold undone',
      'unwrapped blindfold',
      'unfastened blindfold',
      'raised blindfold',
      'raising the blindfold',
      'blindfold sliding off',
      'blindfold up',
      'blindfold down'
    ]) {
      expect(evidenceOf([text]), text).toBe('-')
    }
  })

  it('음경·모자·투구가 두 눈을 덮은 것(penis/hat/helmet over eyes)은 눈 가림 — dick/cock/arm over eyes 는 단보루에 없는 표기라 지원하지 않는다', () => {
    expect(evidenceOf(['penis over eyes'])).toBe('covered:penis over eyes')
    expect(evidenceOf(['hat over eyes'])).toBe('covered:hat over eyes')
    expect(evidenceOf(['helmet over eyes'])).toBe('covered:helmet over eyes')
    expect(evidenceOf(['hat over one eye'])).toBe('-')
    for (const text of ['dick over eyes', 'cock over eyes', 'arm over eyes']) {
      expect(evidenceOf([text]), text).toBe('-')
    }
  })
})

describe('검수 반영 — 잠듦 · 눈 감음 보강', () => {
  it('성관계를 뜻하는 sleeping with · sleeps with · sleep together 는 잠듦이 아니다', () => {
    for (const text of [
      'she is sleeping with him',
      'she sleeps with him',
      'she is sleeping with her boyfriend',
      'she is sleeping with her',
      'they sleep together',
      'she is asleep with the man'
    ]) {
      expect(evidenceOf([text]), text).toBe('-')
    }
    // 같이 자는 사람이 아니면 잠든 것이고, 눈 감음이 따라오면 눈 감음이 먼저 보인다
    expect(evidenceOf(['she sleeps with a teddy bear'])).toBe('asleep:she sleeps with a teddy bear')
    expect(evidenceOf(['she is sleeping with her eyes closed'])).toBe(
      'closed:she is sleeping with her eyes closed'
    )
  })

  it('her/his sleeping + 사람 — 자는 것은 소유자가 아니라 그 사람이다 (몸 낱말만 소유자)', () => {
    const rows: [string, Sex][] = [
      ['her sleeping sister', 'female'],
      ['her sleeping girlfriend', 'female'],
      ['her sleeping daughter', 'female'],
      ['her sleeping habit', 'female'],
      ['his sleeping girlfriend', 'male'],
      ['his sleeping mother', 'male'],
      ['his sleeping wife', 'male'],
      ['his sleeping brother', 'male']
    ]
    for (const [text, sex] of rows) expect(evidenceOf([text], sex), text).toBe('-')
    expect(evidenceOf(['her sleeping face'], 'female')).toBe('asleep:her sleeping face')
    expect(evidenceOf(['his sleeping face'], 'male')).toBe('asleep:his sleeping face')
    expect(evidenceOf(['her sleeping body'], 'female')).toBe('asleep:her sleeping body')
  })

  it('sleep molestation 은 자는 쪽(받는 쪽)의 태그다 — 하는쪽 캐릭터에게는 근거가 아니다', () => {
    expect(hiddenEyesEvidence(['sleep molestation'], 'female')).toMatchObject({ cause: 'asleep' })
    for (const contexts of [
      { role: ['sleep molestation'] },
      { char: ['sleep molestation'] },
      { scene: ['sleep molestation'] },
      { char: ['target#sleep molestation'] }
    ]) {
      expect(
        hiddenEyesEvidence(contexts, 'male', undefined, true),
        JSON.stringify(contexts)
      ).toBeNull()
    }
    // 받는 쪽(하는쪽이 아님)에는 칸 어디에 있든 근거
    expect(hiddenEyesEvidence({ role: ['sleep molestation'] }, 'female')).toMatchObject({
      cause: 'asleep',
      scope: 'role'
    })
    // 하는쪽이라도 sleeping 처럼 자는 사람이 따로 없는 말은 그대로 읽는다
    expect(hiddenEyesEvidence({ role: ['sleeping'] }, 'male', undefined, true)).toMatchObject({
      cause: 'asleep'
    })
    // 카드 글까지 거쳐도 하는쪽 카드의 눈은 남고, 받는 쪽 카드의 눈은 빠진다
    const src = stripEyesWhenClosed({
      enabled: true,
      card: '1boy, brown eyes',
      contexts: { role: ['sleep molestation'] },
      sex: 'male',
      giver: true,
      who
    })
    expect(src.text).toBe('1boy, brown eyes')
    expect(src.notes).toEqual([])
    const dst = stripEyesWhenClosed({
      enabled: true,
      card: '1girl, blue eyes',
      contexts: { role: ['sleep molestation'] },
      sex: 'female',
      who
    })
    expect(dst.text).toBe('1girl')
  })

  it('he kisses her with eyes closed — 목적어 her 를 눈의 소유격으로 읽지 않는다 (감은 쪽은 주어)', () => {
    expect(closedEvidence(['he kisses her with eyes closed'], 'female')).toBeNull()
    expect(closedEvidence(['he kisses her with eyes closed'], 'male')).toBe(
      'he kisses her with eyes closed'
    )
    expect(closedEvidence(['she kisses him with eyes closed'], 'female')).toBe(
      'she kisses him with eyes closed'
    )
    // 소유격은 그대로 — with her eyes closed · her closed eyes
    expect(closedEvidence(['he kisses her, her eyes closed'], 'female')).toBe('her eyes closed')
    expect(closedEvidence(['she kisses him with her eyes closed'], 'female')).toBe(
      'she kisses him with her eyes closed'
    )
  })

  it('쉼표 없이 이어 쓴 글 — 입이 열린 쪽이 감은 눈이고, 열린 눈·닫힌 입은 아니다', () => {
    for (const text of [
      'closed eyes open mouth',
      'eyes closed mouth open',
      'mouth closed eyes closed'
    ]) {
      expect(closedEvidence([text], 'female'), text).toBe(text)
    }
    for (const text of [
      'open eyes closed mouth',
      'mouth closed eyes wide open',
      'mouth closed eyes open',
      'eyes closed halfway',
      'eyes closed wide open'
    ]) {
      expect(closedEvidence([text], 'female'), text).toBeNull()
    }
  })
})

describe('검수 반영 — 기호 눈 표기 · 안 바꿈 이유', () => {
  it('swirl eyes · swirling eyes · heart eyes · star eyes 도 기호 눈이다 (단보루 밖 표기 — 사용자가 쓰는 말)', () => {
    for (const tag of ['swirl eyes', 'swirling eyes', 'heart eyes', 'star eyes']) {
      expect(eyeLookKind(tag), tag).toBe('symbol')
    }
    const r = strip('1girl, swirl eyes, heart eyes, red hair', ['closed eyes'])
    expect(r.text).toBe('1girl, red hair')
    // 좁은 글의 swirl eyes 는 눈 뜬 표현이다
    expect(openEyesExpression({ char: ['swirl eyes'] }, 'female')).toMatchObject({
      text: 'swirl eyes',
      scope: 'char'
    })
  })

  it('「인셋 자리」는 눈 뜬 표현이 자리 태그에서 왔을 때만 — 다른 이 캐릭터 글에서 왔으면 「이 캐릭터의 글」', () => {
    const card = '1girl, blue eyes'
    const reasonOf = (contexts: EyeContexts, faceSeat: boolean): string =>
      strip(card, contexts, 'female', { faceSeat }).notes[0].reason
    // 자리 태그
    expect(
      reasonOf({ scene: ['closed eyes'], char: ['smile'], seat: ['close-up, wide-eyed'] }, true)
    ).toBe('눈 감음 — 인셋 자리에 눈 뜬 표현(wide-eyed)이 있어 그대로 둠')
    // 얼굴 자리가 아닌 자리의 태그
    expect(reasonOf({ scene: ['closed eyes'], seat: ['wide-eyed'] }, false)).toBe(
      '눈 감음 — 자리 태그에 눈 뜬 표현(wide-eyed)이 있어 그대로 둠'
    )
    // 씬별 캐릭터 태그·상대 태그에서 온 눈 뜬 표현은 인셋 자리라고 하지 않는다
    expect(
      reasonOf({ scene: ['closed eyes'], char: ['looking at viewer'], seat: ['close-up'] }, true)
    ).toBe('눈 감음 — 이 캐릭터의 글에 눈 뜬 표현(looking at viewer)이 있어 그대로 둠')
    // 자리 태그의 근거도 읽는다 — 자리 태그가 눈 감음이면 몸 자리와 같이 뺀다
    expect(strip(card, { seat: ['close-up, closed eyes'] }).text).toBe('1girl')
  })
})
