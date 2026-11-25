import { describe, expect, it } from 'vitest'
import {
  cardFitStripRule,
  compileCardFitRules,
  fitCardToScene,
  parseCardFitRules,
  type CardFitInput
} from '../src/shared/card-fit'
import { DEFAULT_CARD_FIT_RULES } from '../src/shared/card-fit-default'
import { mapTags } from '../src/shared/futa'

/**
 * 카드 태그 씬 맞춤 — 합성 카드·합성 씬만 쓴다 (사용자 데이터는 쓰지 않는다).
 */

const RULES = compileCardFitRules(DEFAULT_CARD_FIT_RULES)

const GIRL =
  '1girl, voluptuous, 1.4::yellow eyes::, tsurime, long eyelashes, 1.4::grey hair, very long hair, parted bangs::, ' +
  'strapless, bandeau, cleavage, midriff, navel, ' +
  'A proud, fierce tribal beauty with tanned skin, sharp upturned golden eyes and a domineering, untamed presence. ' +
  'She wears only a strapless brown leather bandeau, with no other accessories.'
const BOY =
  '1boy, fat man, large penis, 1.4::brown hair, short hair, messy hair::, sanpaku, tsurime, ' +
  'A huge tribal brute with a round belly, a sly, sleazy face, narrow shifty eyes and a crooked, scheming look.'

const fit = (over: Partial<CardFitInput> & { card: string }): ReturnType<typeof fitCardToScene> =>
  fitCardToScene({
    enabled: true,
    rules: RULES,
    texts: { scene: [], source: '', target: '', own: [] },
    role: 'target',
    anyRole: true,
    drawn: 2,
    sex: 'female',
    who: { index: 0, name: '여캐' },
    ...over
  })

describe('기본 규칙표', () => {
  it('경고 없이 읽힌다', () => {
    expect(RULES.warnings).toEqual([])
    expect(RULES.rules.length).toBeGreaterThan(10)
  })

  it('옷 벗기기 규칙이 켜져 있다', () => {
    expect(cardFitStripRule(RULES)?.name).toContain('옷 벗기기')
  })
})

describe('꺼져 있으면 그대로', () => {
  it('enabled false 면 글자 하나 다르지 않다', () => {
    const r = fit({
      enabled: false,
      card: GIRL,
      texts: { scene: ['closed eyes, from behind'], source: '', target: 'rolling eyes', own: [] }
    })
    expect(r.card).toBe(GIRL)
    expect(r.notes).toEqual([])
  })

  it('근거가 없으면 그대로', () => {
    const r = fit({ card: GIRL, texts: { scene: ['bed, kiss'], source: '', target: '', own: [] } })
    expect(r.card).toBe(GIRL)
    expect(r.notes).toEqual([])
  })
})

describe('눈', () => {
  it('감은 눈 → 눈매·눈 색·눈 묘사 문장 토막을 뺀다 (가중치 묶음 안도)', () => {
    const r = fit({
      card: GIRL,
      texts: { scene: ['closed eyes'], source: '', target: '', own: [] }
    })
    expect(r.card).not.toContain('yellow eyes')
    expect(r.card).not.toContain('tsurime')
    expect(r.card).not.toContain('golden eyes')
    expect(r.card).toContain('long eyelashes')
    expect(r.card).toContain('1.4::grey hair, very long hair, parted bangs::')
    expect(r.card).toContain('untamed presence. She wears only')
    expect(r.notes.every((n) => n.topic === 'fit')).toBe(true)
  })

  it('문장으로 감은 눈(she closes her eyes)도 근거가 된다', () => {
    const r = fit({
      card: GIRL,
      texts: { scene: [], source: '', target: 'she closes her eyes tightly', own: [] }
    })
    expect(r.card).not.toContain('tsurime')
  })

  it('rolling eyes → 눈매는 빼고 눈 색은 가중치만 푼다', () => {
    const r = fit({
      card: GIRL,
      texts: { scene: [], source: '', target: 'ahegao, rolling eyes', own: [] }
    })
    expect(r.card).not.toContain('tsurime')
    expect(r.card).not.toContain('1.4::yellow eyes::')
    expect(r.card).toMatch(/(^|, )yellow eyes(,|$)/)
    expect(r.card).not.toContain('golden eyes')
    const lifted = r.notes.find((n) => n.before === '1.4::yellow eyes::')
    expect(lifted?.after).toBe('yellow eyes')
  })

  it('가중치가 1 이하인 눈 색은 풀 게 없다', () => {
    const card = '1girl, 0.8::blue eyes::, blue eyes'
    const r = fit({ card, texts: { scene: [], source: '', target: 'rolling eyes', own: [] } })
    expect(r.card).toBe(card)
  })

  it('음수 가중치로 누른 근거는 근거가 아니다', () => {
    const r = fit({
      card: GIRL,
      texts: { scene: ['-1.5::closed eyes, rolling eyes::'], source: '', target: '', own: [] }
    })
    expect(r.card).toBe(GIRL)
  })

  it('씬 전체 글은 하는쪽이 받지 않는다 (받는 캐릭터)', () => {
    const r = fit({
      card: BOY,
      role: 'source',
      sex: 'male',
      texts: { scene: ['closed eyes'], source: '', target: '', own: [] }
    })
    expect(r.card).toBe(BOY)
  })
})

describe('얼굴 안 보임', () => {
  it('씬 전체 글의 head out of frame 은 둘이 그려지면 믿지 않는다', () => {
    const r = fit({
      card: GIRL,
      texts: { scene: ['head out of frame'], source: '', target: '', own: [] }
    })
    expect(r.card).toBe(GIRL)
  })

  it('혼자 그려지면 얼굴 태그를 뺀다', () => {
    const r = fit({
      card: GIRL,
      drawn: 1,
      texts: { scene: ['head out of frame'], source: '', target: '', own: [] }
    })
    expect(r.card).not.toContain('tsurime')
    expect(r.card).not.toContain('long eyelashes')
    expect(r.card).toContain('very long hair')
  })

  it('하는쪽 칸의 his head out of frame 은 하는쪽 얼굴을 뺀다', () => {
    const r = fit({
      card: BOY,
      role: 'source',
      sex: 'male',
      texts: { scene: [], source: '1boy, his head out of frame', target: '', own: [] }
    })
    expect(r.card).not.toContain('sanpaku')
    expect(r.card).not.toContain('sleazy face')
    expect(r.card).toContain('fat man')
  })
})

describe('뒷모습', () => {
  it('from behind 라고 카드 태그를 빼지 않는다 (기본표에 뒷모습 규칙 없음)', () => {
    const r = fit({
      card: GIRL,
      texts: { scene: ['from behind, doggystyle'], source: '', target: '', own: [] }
    })
    expect(r.card).toBe(GIRL)
    expect(r.notes).toEqual([])
  })
})

describe('pov', () => {
  it('하는쪽만 머리·눈·얼굴 묘사를 뺀다 — 몸은 남긴다', () => {
    const r = fit({
      card: BOY,
      role: 'source',
      sex: 'male',
      texts: { scene: ['pov, from above'], source: '', target: '', own: [] }
    })
    expect(r.card).not.toMatch(
      /brown hair|short hair|messy hair|sanpaku|tsurime|shifty eyes|sleazy face/
    )
    expect(r.card).toContain('fat man')
    expect(r.card).toContain('large penis')
    expect(r.card).toContain('round belly')
  })

  it('얼굴을 가리는 머리(hair over eyes)는 남긴다 — faceless 카드의 설계', () => {
    const card = '1boy, 2::faceless male, hair over eyes, shadow over eyes::, short hair'
    const r = fit({
      card,
      role: 'source',
      sex: 'male',
      texts: { scene: ['pov'], source: '', target: '', own: [] }
    })
    expect(r.card).toBe('1boy, 2::faceless male, hair over eyes, shadow over eyes::')
  })

  it('당하는쪽은 pov 로 얼굴을 빼지 않는다', () => {
    const r = fit({ card: GIRL, texts: { scene: ['pov'], source: '', target: '', own: [] } })
    expect(r.card).toContain('tsurime')
  })
})

describe('실루엣', () => {
  it('눈·머리 색·피부 색을 빼고 남은 태그의 색 낱말을 뺀다', () => {
    const card = '1girl, 1.4::grey hair, very long hair::, blue eyes, tan, white shirt, black skirt'
    const r = fit({ card, texts: { scene: ['silhouette'], source: '', target: '', own: [] } })
    expect(r.card).toBe('1girl, 1.4::very long hair::, shirt, skirt')
  })
})

describe('같은 갈래는 씬이 이김', () => {
  it('씬이 표정을 정하면 카드 표정을 뺀다', () => {
    const r = fit({
      card: '1girl, shy, smile, blush',
      texts: { scene: [], source: '', target: 'angry', own: [] }
    })
    expect(r.card).toBe('1girl, blush')
  })

  it('구도·배경은 하는쪽 카드에서도 뺀다', () => {
    const r = fit({
      card: '1boy, portrait, pink background',
      role: 'source',
      sex: 'male',
      texts: { scene: ['upper body, simple background'], source: '', target: '', own: [] }
    })
    expect(r.card).toBe('1boy')
  })
})

describe('복장도 같은 규칙으로', () => {
  it('입은 복장의 눈 태그도 뺀다', () => {
    const r = fit({
      card: '1girl',
      outfit: 'crop top, tsurime, blue eyes',
      texts: { scene: ['closed eyes'], source: '', target: '', own: [] }
    })
    expect(r.outfit).toBe('crop top')
    expect(r.notes.some((n) => n.reason.startsWith('복장 · '))).toBe(true)
  })
})

describe('규칙표 파일', () => {
  it('JSON 문법이 깨지면 규칙을 쓰지 않고 오류를 알린다', () => {
    const r = parseCardFitRules('{ "규칙": [ ')
    expect(r.error).toMatch(/JSON/)
    expect(r.rules).toEqual([])
  })

  it('모르는 묶음·내장 판정은 경고로 알린다', () => {
    const r = compileCardFitRules({
      규칙: [{ 이름: '시험', 근거: ['@없는 묶음', '#없는 판정'], 빼기: ['x'] }]
    })
    expect(r.warnings.join(' ')).toMatch(/없는 묶음/)
    expect(r.warnings.join(' ')).toMatch(/없는 판정/)
  })

  it('더하기·네거티브에 더하기', () => {
    const rules = compileCardFitRules({
      규칙: [
        {
          이름: '시험',
          근거: ['closed eyes'],
          더하기: 'closed eyes',
          '네거티브에 더하기': 'open eyes'
        }
      ]
    })
    const r = fitCardToScene({
      enabled: true,
      rules,
      card: '1girl',
      texts: { scene: ['closed eyes'], source: '', target: '', own: [] },
      role: 'target',
      anyRole: true,
      drawn: 1,
      sex: 'female',
      who: { index: 0, name: 'x' }
    })
    expect(r.add).toBe('closed eyes')
    expect(r.addNegative).toBe('open eyes')
    expect(r.notes.filter((n) => n.kind === 'added')).toHaveLength(2)
  })

  it('켬 false 인 규칙은 쓰지 않는다 (기본표의 씬이 누른 태그)', () => {
    const r = fit({
      card: '1girl, looking at viewer',
      texts: { scene: ['-1.5::looking at viewer::'], source: '', target: '', own: [] }
    })
    expect(r.card).toBe('1girl, looking at viewer')
  })

  it('씬이 누른 태그 규칙을 켜면 카드에서 뺀다', () => {
    const file = structuredClone(DEFAULT_CARD_FIT_RULES)
    for (const rule of file.규칙 ?? []) if (rule.이름.startsWith('씬이 누른')) rule.켬 = true
    const r = fit({
      rules: compileCardFitRules(file),
      card: '1girl, looking at viewer, smile',
      texts: { scene: ['-1.5::looking at viewer::'], source: '', target: '', own: [] }
    })
    expect(r.card).toBe('1girl, smile')
  })
})

describe('mapTags 가중치 풀기 (lift)', () => {
  it('센 묶음 안의 태그만 묶음 뒤로 꺼낸다', () => {
    const r = mapTags('a, 1.3::b, c::, d', (t) =>
      t === 'b' || t === 'd' ? { after: t, reason: 'x', lift: true } : null
    )
    expect(r.text).toBe('a, 1.3::c::, b, d')
    expect(r.edits).toEqual([{ before: 'b', after: 'b', reason: 'x', liftedFrom: '1.3' }])
  })
})
