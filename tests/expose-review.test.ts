import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EXPOSE_ACTS,
  ENGINE_EXTRA_ACTS,
  EXPOSE_ACTS_VERSION,
  engineActs,
  exposePreview,
  neededAreas,
  readGarments,
  triggerAreas,
  withDefaultActs,
  type ExposeActs
} from '../src/shared/auto-expose'
import { analyzeText } from '../src/shared/expose-evidence'
import {
  analyzeExposure,
  finishExposure,
  pieceInfo,
  type ExposeChar,
  type ExposeField,
  type SceneExposure,
  type WornState
} from '../src/shared/expose-state'
import type { ExposeNote, ExposeStatus } from '../src/shared/types'

/**
 * 마무리 검수에서 나온 결함의 재현·잠금 시험 (합성 입력만).
 * 캐릭터: 0 = 히로인(여, 당하는쪽) · 1 = 남캐(남, 하는쪽)
 */
const acts = DEFAULT_EXPOSE_ACTS
const woman: ExposeChar = {
  index: 0,
  id: 1,
  name: '히로인',
  sex: 'female',
  role: 'target',
  faceSeat: false,
  autoOff: false,
  receivesScene: true
}
const man: ExposeChar = {
  index: 1,
  id: 2,
  name: '남캐',
  sex: 'male',
  role: 'source',
  faceSeat: false,
  autoOff: false,
  receivesScene: false
}

const read = (
  text: string,
  scope: ExposeField['scope'] = 'scene',
  chars: ExposeChar[] = [woman, man],
  list: ExposeActs = acts
): SceneExposure => analyzeExposure({ chars, fields: [{ text, scope }], acts: list })

const readFields = (fields: ExposeField[]): SceneExposure =>
  analyzeExposure({ chars: [woman, man], fields, acts })

const needs = (ex: SceneExposure): { Fl: boolean; Fc: boolean; Ml: boolean } => ({
  Fl: ex.chars[0].areas.lower.needed,
  Fc: ex.chars[0].areas.chest.needed,
  Ml: ex.chars[1].areas.lower.needed
})

const worn = (over: Partial<WornState> = {}): WornState => ({
  card: '',
  outfit: '',
  own: [],
  stripped: false,
  piece: pieceInfo(undefined, undefined, {}),
  ...over
})

const run = (
  sceneText: string,
  over: Partial<WornState>,
  index = 0
): { tags: string[]; notes: ExposeNote[] } => {
  const ex = read(sceneText)
  return finishExposure(ex.chars[index], ex, worn(over))
}
const statusOf = (notes: ExposeNote[], area: 'lower' | 'chest'): ExposeStatus | undefined =>
  notes.find((n) => n.area === area && n.status !== 'conflict' && n.status !== 'not-needed')?.status

const NONE = { Fl: false, Fc: false, Ml: false }

describe('끄면 같음 — 행위 목록을 앱이 몰래 바꾸지 않는다', () => {
  // 이 기능 전에 저장돼 있던 기본 목록 (판 4)
  const v4: ExposeActs = {
    lower: [
      ...DEFAULT_EXPOSE_ACTS.lower.filter(
        (t) => !ENGINE_EXTRA_ACTS.lower.includes(t) && t !== 'groping'
      ),
      'creampie',
      'after sex'
    ],
    chest: DEFAULT_EXPOSE_ACTS.chest.filter((t) => !ENGINE_EXTRA_ACTS.chest.includes(t))
  }

  it('기본 목록의 판은 올리지 않아 저장된 목록에 새 태그가 합쳐지지 않는다', () => {
    expect(EXPOSE_ACTS_VERSION).toBe(4)
    // 판이 같으면 withDefaultActs 가 호출되지 않는다 — 저장된 목록은 그대로
    for (const t of ENGINE_EXTRA_ACTS.lower) expect(v4.lower).not.toContain(t)
  })

  it('옛 판정(끈 상태)은 엔진 내장 행위를 모른다 — 저장된 목록 그대로 읽는다', () => {
    expect(triggerAreas(["grabbing another's breast"], v4)).toEqual({ lower: false, chest: false })
    expect(triggerAreas(['deep penetration'], v4)).toEqual({ lower: false, chest: false })
    expect(neededAreas(['internal cumshot'], v4)).toEqual({})
  })

  it('새 판정(켠 상태)은 저장된 목록에 없어도 엔진 내장 행위를 읽는다', () => {
    expect(needs(read("grabbing another's breast", 'scene', [woman, man], v4)).Fc).toBe(true)
    expect(needs(read('deep penetration', 'scene', [woman, man], v4)).Fl).toBe(true)
    expect(needs(read('internal cumshot', 'scene', [woman, man], v4)).Fl).toBe(true)
    // 같은 목록 객체에는 같은 결과 (읽기 기억의 열쇠)
    expect(engineActs(v4)).toBe(engineActs(v4))
    // 기본 목록에는 이미 있으니 합쳐도 같다
    expect(engineActs(DEFAULT_EXPOSE_ACTS)).toEqual(DEFAULT_EXPOSE_ACTS)
    // 옛 목록 객체는 바뀌지 않는다
    expect(v4.chest).not.toContain("grabbing another's breast")
    expect(withDefaultActs(v4).chest).toContain("grabbing another's breast")
  })
})

describe('화면 밖 구절 (R6)', () => {
  it.each([
    'sex, lower body out of frame',
    'sex, legs out of frame',
    'sex, hips out of frame',
    'sex, cut off at the waist',
    'sex, crotch out of frame'
  ])('%s → 아래가 안 열리고 화면 밖으로 남는다', (text) => {
    const ex = read(text)
    expect(ex.chars[0].areas.lower.needed).toBe(false)
    expect(ex.chars[0].areas.lower.status).toBe('off-frame')
    expect(ex.chars[1].areas.lower.needed).toBe(false)
  })

  it('upper body out of frame 은 가슴을 막는다', () => {
    const ex = read('paizuri, upper body out of frame')
    expect(ex.chars[0].areas.chest.needed).toBe(false)
    expect(ex.chars[0].areas.chest.status).toBe('off-frame')
  })

  it('다른 절의 부위는 화면 밖의 영향을 받지 않는다', () => {
    expect(needs(read('his face is out of frame as he thrusts his cock into her pussy'))).toEqual({
      Fl: true,
      Fc: false,
      Ml: true
    })
    expect(needs(read('her head is out of frame while he licks her pussy')).Fl).toBe(true)
    // 같은 절의 부위는 막는다
    expect(needs(read('her pussy is out of frame while he rubs her thigh')).Fl).toBe(false)
  })

  it('하는쪽 칸의 화면 밖은 하는쪽(남캐)만 막는다', () => {
    const ex = readFields([
      { text: 'sex', scope: 'scene' },
      { text: 'lower body out of frame', scope: 'source' }
    ])
    expect(ex.chars[1].areas.lower.status).toBe('off-frame')
    expect(ex.chars[0].areas.lower.needed).toBe(true)
  })
})

describe('역할 칸의 벗음·젖힘 태그는 그 글을 받는 캐릭터 사이에서만 모호하다', () => {
  it('당하는쪽 칸의 panties aside · skirt lift 는 남캐 아래를 판단 못 함으로 만들지 않는다', () => {
    for (const tag of ['panties aside', 'skirt lift', 'clothing aside']) {
      const ex = readFields([
        { text: 'sex', scope: 'scene' },
        { text: tag, scope: 'target' }
      ])
      const m = finishExposure(ex.chars[1], ex, worn({ card: 'pants, shirt' }))
      expect(m.tags, tag).toEqual(['pants pull', 'open fly'])
      expect(statusOf(m.notes, 'lower'), tag).toBe('added')
    }
  })

  it('하는쪽 칸의 nude male 은 남캐만 벗은 것 — 히로인 아래는 그대로 젖힌다', () => {
    const ex = readFields([
      { text: 'sex', scope: 'scene' },
      { text: 'nude male', scope: 'source' }
    ])
    const f = finishExposure(ex.chars[0], ex, worn({ card: 'skirt, panties' }))
    expect(f.tags).toEqual(['skirt lift', 'panties aside'])
    const m = finishExposure(ex.chars[1], ex, worn({ card: 'pants' }))
    expect(m.tags).toEqual([])
    expect(statusOf(m.notes, 'lower')).toBe('nude')
  })

  it('씬 글의 topless male · open fly 는 히로인의 벗음·젖힘으로 읽지 않는다', () => {
    const topless = run('paizuri, topless male', { card: 'white shirt, bra' })
    expect(topless.tags).toEqual(['shirt lift', 'bra lift'])
    expect(statusOf(topless.notes, 'chest')).toBe('added')
    const fly = run('sex, open fly', { card: 'skirt, panties' })
    expect(fly.tags).toEqual(['skirt lift', 'panties aside'])
  })

  it('옷 낱말로 주인을 짐작한다 — 치마·팬티는 여성 쪽', () => {
    const kinds = (text: string): string[] =>
      analyzeText(text, { actor: 'male' }, acts).evidence.map(
        (e) => `${e.owner}/${e.area}/${e.kind}${e.guess ? '?' : ''}`
      )
    expect(kinds('panties aside')).toEqual(['female/lower/open'])
    expect(kinds('nude male')).toEqual(['male/lower/open', 'male/chest/open'])
    // 바지는 누구 것인지 모른다 — 칸의 행위자로 짐작
    expect(kinds('pants down')).toEqual(['male/lower/open?'])
  })
})

describe('옷 위·접촉이 아닌 위치 설명을 노출로 읽지 않는다', () => {
  it.each([
    'her large breasts strain against her tight shirt',
    'she holds a pillow against her breasts',
    'a necklace rests between her breasts',
    'sweat drips between her breasts',
    'her breasts press against the window glass'
  ])('%s → 가슴이 안 열림', (text) => {
    expect(needs(read(text)).Fc).toBe(false)
  })

  it('손·입이 닿는 접촉은 그대로 약한 신호', () => {
    expect(needs(read('his hand on her breast')).Fc).toBe(true)
    expect(needs(read('his hands on her breasts')).Fc).toBe(true)
    expect(needs(read('the tip of his cock pressed against her pussy')).Fl).toBe(true)
  })
})

describe('행위가 아닌 말', () => {
  it.each([
    'presenting a gift',
    'presenting a bouquet of flowers, smiling',
    'presenting a plate of food',
    'sex slave',
    'sex appeal'
  ])('%s → 안 열림', (text) => {
    expect(needs(read(text))).toEqual(NONE)
  })

  it('presenting 단독·몸을 내보이는 말은 행위', () => {
    expect(needs(read('presenting')).Fl).toBe(true)
    expect(needs(read('presenting herself')).Fl).toBe(true)
  })
})

describe('부정어가 든 관용구는 노출 부정이 아니다', () => {
  it.each([
    'she never stops rubbing her pussy',
    'she does not stop rubbing her pussy',
    'sex without condom',
    'vaginal without a condom, creampie'
  ])('%s → 열림', (text) => {
    expect(needs(read(text)).Fl).toBe(true)
    expect(read(text).chars[0].areas.lower.status).toBeUndefined()
  })

  it("she doesn't hide her pussy 는 부정이 아니다", () => {
    expect(read("she doesn't hide her pussy").chars[0].areas.lower.status).not.toBe('negated')
  })

  it('진짜 부정은 그대로 부정', () => {
    expect(read('no sex').chars[0].areas.lower.status).toBe('negated')
    expect(read('her pussy is not shown').chars[0].areas.lower.status).toBe('negated')
  })
})

describe('낱말 일치 — 몸이 아닌 쓰임', () => {
  it.each([
    'her hands on his chest while she shouts',
    'she opens a treasure chest',
    'a long side slit on her dress, showing her legs',
    'her eyes open with slit pupils',
    'balls of light float around her',
    'a shaft of light shows on her face'
  ])('%s → 아무것도 안 열림', (text) => {
    expect(needs(read(text))).toEqual(NONE)
  })
})

describe('가리는 글이 있으면 약한 신호만으로는 안 연다', () => {
  it('covering crotch + pussy → 아래 부정', () => {
    const ex = read('covering crotch, pussy')
    expect(ex.chars[0].areas.lower.needed).toBe(false)
    expect(ex.chars[0].areas.lower.status).toBe('negated')
  })
  it('가려도 삽입 같은 강한 행위는 그대로', () => {
    expect(needs(read('covering crotch, vaginal')).Fl).toBe(true)
  })
})

describe('옷 읽기 경계', () => {
  const names = (text: string): string[] => readGarments(text).map((g) => g.rule.nouns[0])

  it('벗었거나 손에 든 옷은 입은 게 아니다', () => {
    expect(names('panties removed')).toEqual([])
    expect(names('holding panties')).toEqual([])
    expect(names('bra between breasts')).toEqual([])
  })
  it('nothing but panties 는 그 옷만 입은 것', () => {
    expect(names('wearing nothing but panties')).toEqual(['panties'])
  })
  it('0 가중치는 빼달라는 뜻 — 입은 옷도 이미 있는 태그도 아니다', () => {
    expect(names('skirt, 0::panties::')).toEqual(['skirt'])
    const r = run('vaginal', { card: 'skirt', own: ['0::skirt lift::'] })
    expect(r.tags).toEqual([])
    expect(statusOf(r.notes, 'lower')).toBe('vetoed')
  })
  it('씬 글의 no panties 는 씬 글을 받는 캐릭터의 팬티를 뺀다', () => {
    const r = run('sex, no panties', { card: 'skirt, panties' })
    expect(r.tags).toEqual(['skirt lift'])
  })
  it('낱말표에 cardigan · fundoshi · g-string 을 더했다', () => {
    expect(exposePreview('cardigan, shirt, bra').chest).toEqual([
      'open cardigan',
      'shirt lift',
      'bra lift'
    ])
    expect(exposePreview('fundoshi').lower).toEqual(['fundoshi aside'])
    expect(exposePreview('g-string').lower).toEqual(['thong aside'])
  })
})

describe('설계로 열린 옷은 그 겹만 열려 있다', () => {
  it('crotchless panties 위에 치마를 입었으면 치마는 젖힌다', () => {
    const r = run('sex', { card: 'crotchless panties, skirt' })
    expect(r.tags).toEqual(['skirt lift'])
  })
  it('cupless bra 위에 셔츠를 입었으면 셔츠는 젖힌다', () => {
    const r = run('paizuri', { card: 'cupless bra, shirt' })
    expect(r.tags).toEqual(['shirt lift'])
  })
  it('설계로 열린 옷뿐이면 이미 열림', () => {
    const r = run('sex', { card: 'crotchless panties' })
    expect(r.tags).toEqual([])
    expect(statusOf(r.notes, 'lower')).toBe('already')
  })
})

describe('지시어·사후 어구·신체 낱말 없는 삽입', () => {
  const statuses = (text: string): (ExposeStatus | undefined)[] => {
    const ex = read(text)
    return [ex.chars[0].areas.lower.status, ex.chars[1].areas.lower.status]
  }
  it('일상 문장의 head·it 은 판단 못 함이 아니다', () => {
    expect(statuses('she is stroking the head of the cat')).toEqual([undefined, undefined])
    expect(statuses('he is pushing her toward it')).toEqual([undefined, undefined])
  })
  it('음경 쪽 지시어 접촉은 판단 못 함', () => {
    expect(statuses('the tip presses against her')[1]).toBe('unknown')
  })
  it('post-coital · after-sex 는 사후 어구', () => {
    expect(read('post-coital, nipples').chars[0].areas.chest.status).toBe('after')
    expect(read('after-sex, nipples').chars[0].areas.chest.status).toBe('after')
  })
  it('he thrusts into her · he cums inside her', () => {
    expect(needs(read('he thrusts into her')).Fl).toBe(true)
    expect(needs(read('he pounds into her from behind'))).toEqual({ Fl: true, Fc: false, Ml: true })
    expect(needs(read('he cums inside her')).Fl).toBe(true)
  })
})

describe('알몸·충돌·근거 없음 표시', () => {
  it('알몸인데 착의 단서가 있으면 같은 부위는 충돌 한 줄 (알몸 줄을 따로 두지 않는다)', () => {
    const r = run('fingering, paizuri', {
      card: 'nude, completely nude',
      own: ['clothing aside'],
      stripped: true,
      strippedBy: '옷 벗기기 둘 다'
    })
    const lower = r.notes.filter((n) => n.area === 'lower')
    expect(lower.map((n) => n.status)).toEqual(['conflict'])
    expect(lower[0].reason).toContain('옷 벗기기 둘 다')
    expect(lower[0].reason).toContain('안 벗김')
    // 충돌이 없는 부위는 알몸 한 줄
    expect(r.notes.filter((n) => n.area === 'chest').map((n) => n.status)).toEqual(['nude'])
  })

  it('알몸 이유는 옷 벗기기 이름을 한 번만 말한다', () => {
    const r = run('vaginal', { card: 'nude', stripped: true, strippedBy: '옷 벗기기 남캐만' })
    const nude = r.notes.find((n) => n.status === 'nude')
    expect(nude?.reason.match(/옷 벗기기/g)).toHaveLength(1)
  })

  it('드러내라는 근거가 없는 부위는 「근거 없음」으로 남는다 (말없이 비지 않는다)', () => {
    const r = run('standing', { card: 'skirt, shirt' })
    expect(r.tags).toEqual([])
    expect(r.notes.map((n) => `${n.area}/${n.status}`)).toEqual([
      'lower/not-needed',
      'chest/not-needed'
    ])
    expect(r.notes.every((n) => n.reason)).toBe(true)
  })

  it('옷 글이 아예 없으면 제안 없이 조용히, 옷 이야기는 있으나 못 읽으면 제안과 함께', () => {
    const none = run('vaginal', { card: '1girl, long hair' })
    expect(none.notes.find((n) => n.area === 'lower')).toMatchObject({
      status: 'no-garment',
      tags: [],
      garments: []
    })
    const armor = run('vaginal', { card: '1girl, silver armor' })
    expect(armor.notes.find((n) => n.area === 'lower')).toMatchObject({
      status: 'no-garment',
      tags: ['clothing aside']
    })
  })
})
