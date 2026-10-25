import { describe, expect, it } from 'vitest'
import { DEFAULT_EXPOSE_ACTS as acts } from '../src/shared/auto-expose'
import { analyzeText } from '../src/shared/expose-evidence'
import {
  analyzeExposure,
  finishExposure,
  pieceInfo,
  receivesSceneText,
  type ExposeChar,
  type ExposeField,
  type SceneExposure,
  type WornState
} from '../src/shared/expose-state'
import type { Outfit } from '../src/shared/outfit'
import type { ExposeNote, ExposeStatus } from '../src/shared/types'

/**
 * 입은 옷 자동 젖힘 — 증거 읽기·주인 배정·상태 합성 (합성 입력만, 실제 씬 글은 쓰지 않는다).
 * 캐릭터: 0 = 히로인(여, 당하는쪽) · 1 = 남캐(남, 하는쪽)
 */
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
  chars: ExposeChar[] = [woman, man]
): SceneExposure => analyzeExposure({ chars, fields: [{ text, scope }], acts })

/** 히로인 아래·가슴, 남캐 아래가 드러나야 하는지 */
const needs = (ex: SceneExposure): { Fl: boolean; Fc: boolean; Ml: boolean } => ({
  Fl: ex.chars[0].areas.lower.needed,
  Fc: ex.chars[0].areas.chest.needed,
  Ml: ex.chars[1].areas.lower.needed
})

describe('증거 읽기 — 오탐을 막는다 (설계서 ⑥)', () => {
  const none = { Fl: false, Fc: false, Ml: false }
  it.each([
    ['presenting food', none],
    ['3::cooking, holding plate, presenting food::', none],
    ['no sex', none],
    ['after sex, after vaginal, puffy nipples', none],
    ['her pussy is not shown', none],
    ['she is seen from the side, her pussy is not shown at all', none],
    ['with her hands on the wall', none],
    ['bulge in her neck', none],
    ['sex toy, sex education', none]
  ])('%s → 아무것도 안 열림', (text, expected) => {
    expect(needs(read(text))).toEqual(expected)
  })

  it('부정·사후 어구·옷 위·화면 밖은 안 붙은 이유로 남는다', () => {
    const status = (text: string, area: 'lower' | 'chest' = 'lower'): ExposeStatus | undefined =>
      read(text).chars[0].areas[area].status
    expect(status('no sex')).toBe('negated')
    expect(status('her pussy is not shown')).toBe('negated')
    expect(status('after sex, after vaginal, puffy nipples', 'chest')).toBe('after')
    expect(status("grabbing another's breast, outer side of her breast", 'chest')).toBe(
      'over-clothes'
    )
    expect(status('pussy, pussy juice stain')).toBe('over-clothes')
    expect(status('upper body, pussy juice')).toBe('off-frame')
    expect(read('penis out of frame').chars[1].areas.lower.status).toBe(undefined)
    expect(read('pussy, her pussy out of frame').chars[0].areas.lower.status).toBe('off-frame')
  })

  it('강한 행위는 옷 위 표지가 있어도 유지하고, 약한 신호는 옷 위면 무시한다', () => {
    expect(needs(read('pussy juice stain, vaginal')).Fl).toBe(true)
    expect(needs(read('covered nipples, paizuri')).Fc).toBe(true)
    expect(needs(read('covered nipples, nipples')).Fc).toBe(false)
    // 그 토막 자체가 옷 위 접촉이면 행위여도 옷 위
    expect(needs(read('fingering through panties')).Fl).toBe(false)
    expect(needs(read('masturbation through clothes')).Fl).toBe(false)
    // 가슴·사타구니와 상관없는 가림은 옷 위 표지가 아니다
    expect(needs(read('covered eyes, covered navel, pussy')).Fl).toBe(true)
  })

  it('약한 신호만 있으면 열리고, 몸 부위 이름만 있는 문장은 신호가 아니다', () => {
    expect(needs(read('nipples')).Fc).toBe(true)
    expect(needs(read("grabbing another's breast")).Fc).toBe(true)
    expect(needs(read('groping')).Fl).toBe(true)
    expect(needs(read('her large breasts')).Fc).toBe(false)
    expect(needs(read('large breasts, medium breasts, wide hips')).Fc).toBe(false)
  })

  it('구도 태그(upper body · portrait)는 그 부위를 화면 밖으로', () => {
    expect(needs(read('upper body, sex')).Fl).toBe(false)
    expect(needs(read('upper body, paizuri')).Fc).toBe(true)
    expect(needs(read('portrait, paizuri')).Fc).toBe(false)
    expect(needs(read('cowboy shot, sex')).Fl).toBe(true)
  })

  it('Text: 블록과 따옴표 대사는 묘사가 아니라 읽지 않는다', () => {
    expect(needs(read('standing, Text: "suck my cock", vaginal')).Fl).toBe(false)
    expect(needs(read('standing, "harder, deeper", and she says "vaginal sex"'))).toEqual({
      Fl: false,
      Fc: false,
      Ml: false
    })
    expect(needs(read('vaginal, Text: hello')).Fl).toBe(true)
  })

  it('주석·랜덤 선택지·음수 가중치 안의 신호는 읽지 않는다', () => {
    expect(needs(read('standing # vaginal'))).toEqual({ Fl: false, Fc: false, Ml: false })
    expect(needs(read('(vaginal/standing)')).Fl).toBe(false)
    expect(needs(read('-1::sex::, kiss')).Fl).toBe(false)
    expect(needs(read('kiss, 1.2::sex::')).Fl).toBe(true)
  })
})

describe('주인 배정 — 누구 몸이 열리나', () => {
  it('삽입은 여 아래와 남 아래, 핥기·핑거링은 여 아래만, 펠라·핸드잡은 남 아래만', () => {
    expect(needs(read('sex'))).toEqual({ Fl: true, Fc: false, Ml: true })
    expect(needs(read('deep penetration'))).toEqual({ Fl: true, Fc: false, Ml: true })
    expect(needs(read('cunnilingus'))).toEqual({ Fl: true, Fc: false, Ml: false })
    expect(needs(read('fingering'))).toEqual({ Fl: true, Fc: false, Ml: false })
    expect(needs(read('fellatio, kiss'))).toEqual({ Fl: false, Fc: false, Ml: true })
    expect(needs(read('handjob'))).toEqual({ Fl: false, Fc: false, Ml: true })
    expect(needs(read('footjob'))).toEqual({ Fl: false, Fc: false, Ml: true })
    expect(needs(read('irrumatio, thigh sex'))).toEqual({ Fl: false, Fc: false, Ml: true })
    expect(needs(read('penis on ass, large penis'))).toEqual({ Fl: false, Fc: false, Ml: true })
  })

  it('파이즈리는 여 가슴과 남 아래', () => {
    expect(needs(read('paizuri'))).toEqual({ Fl: false, Fc: true, Ml: true })
    expect(needs(read('nursing handjob'))).toEqual({ Fl: false, Fc: true, Ml: true })
  })

  it('하는쪽 칸에 적은 상대 몸 행위는 하는쪽 몸을 열지 않는다 (예전에는 남캐 몸이 열렸다)', () => {
    expect(needs(read('fingering, nipple tweak', 'source'))).toEqual({
      Fl: true,
      Fc: true,
      Ml: false
    })
    expect(needs(read('cunnilingus', 'source'))).toEqual({ Fl: true, Fc: false, Ml: false })
    // 남캐의 가슴은 열리지 않는다 (nipples 가 하는쪽 칸에 있어도 여성 가슴 이야기)
    const ex = read('nipples, nipple tweak', 'source')
    expect(ex.chars[1].areas.chest.needed).toBe(false)
    expect(ex.chars[0].areas.chest.needed).toBe(true)
  })

  it('자위·presenting 같은 자기 몸 행위는 칸의 행위자 몸', () => {
    expect(needs(read('masturbation', 'source'))).toEqual({ Fl: false, Fc: false, Ml: true })
    expect(needs(read('masturbation', 'target'))).toEqual({ Fl: true, Fc: false, Ml: false })
    expect(needs(read('masturbation'))).toEqual({ Fl: true, Fc: false, Ml: false })
    expect(needs(read('female masturbation', 'source'))).toEqual({ Fl: true, Fc: false, Ml: false })
    expect(needs(read('presenting', 'target')).Fl).toBe(true)
  })

  it('항문 핥기는 단서가 있으면 그 몸, 없으면 판단 못 함', () => {
    const none = read('anilingus')
    expect(needs(none)).toEqual({ Fl: false, Fc: false, Ml: false })
    expect(none.chars[0].areas.lower.status).toBe('unknown')
    expect(none.chars[1].areas.lower.status).toBe('unknown')
    expect(needs(read("anilingus, male's lower body"))).toEqual({ Fl: false, Fc: false, Ml: true })
    expect(needs(read('anilingus, her ass'))).toEqual({ Fl: true, Fc: false, Ml: false })
  })

  it('문장은 소유 표현으로 주인을 정한다', () => {
    expect(needs(read('he thrusts his cock into her pussy'))).toEqual({
      Fl: true,
      Fc: false,
      Ml: true
    })
    expect(needs(read('she grips both of her large breasts'))).toEqual({
      Fl: false,
      Fc: true,
      Ml: false
    })
    expect(needs(read('he grabs her breasts from behind'))).toEqual({
      Fl: false,
      Fc: true,
      Ml: false
    })
    expect(needs(read('she sucks his cock'))).toEqual({ Fl: false, Fc: false, Ml: true })
    expect(needs(read('he licks her pussy'))).toEqual({ Fl: true, Fc: false, Ml: false })
    expect(needs(read("hand on another's ass, penis between breasts"))).toEqual(
      expect.objectContaining({ Fc: true, Ml: true })
    )
  })

  it('음경이 들어가는 문장은 여성 아래도 열린다', () => {
    expect(needs(read('penis in pussy'))).toEqual({ Fl: true, Fc: false, Ml: true })
    expect(needs(read('penis inside pussy, penis on pussy'))).toEqual({
      Fl: true,
      Fc: false,
      Ml: true
    })
  })

  it('지시어 문장은 판단 못 함 — 켜지도 닫지도 않는다', () => {
    const ex = read('her legs shake as the tip presses against her.')
    expect(needs(ex)).toEqual({ Fl: false, Fc: false, Ml: false })
    // tip 은 음경 쪽 낱말이라 남성 쪽이 모호
    expect(ex.chars[1].areas.lower.status).toBe('unknown')
    // it 만 있으면 누구 것인지도 모른다
    const it = read('his hand pushes her mouth down over it.')
    expect(it.chars[0].areas.lower.status).toBe('unknown')
    expect(it.chars[1].areas.lower.status).toBe('unknown')
    // 접촉 동사가 없는 묘사나 몸과 상관없는 it 은 신호가 아니다
    expect(
      read('staring at the tip, a drop of precum on the tip').chars[0].areas.lower.status
    ).toBe(undefined)
    expect(read('He almost cums but holds it in.').chars[0].areas.lower.status).toBe(undefined)
  })

  it('몰래 만지기는 모호', () => {
    const ex = read('They secretly kiss in a quiet hallway. He rubs her breasts.')
    expect(ex.chars[0].areas.chest.needed).toBe(false)
    expect(ex.chars[0].areas.chest.status).toBe('unknown')
  })

  it('같은 성별 둘 이상이면 문장의 지칭어로는 못 가른다 — 태그 표는 그 성별 전원', () => {
    const second: ExposeChar = { ...woman, index: 2, id: 3, name: '둘째' }
    const chars = [woman, man, second]
    const sentence = read('he thrusts his cock into her pussy', 'scene', chars)
    expect(sentence.chars[0].areas.lower.needed).toBe(false)
    expect(sentence.chars[0].areas.lower.status).toBe('unknown')
    expect(sentence.chars[2].areas.lower.status).toBe('unknown')
    expect(sentence.chars[1].areas.lower.needed).toBe(true)
    const tag = read('sex', 'scene', chars)
    expect(tag.chars[0].areas.lower.needed).toBe(true)
    expect(tag.chars[2].areas.lower.needed).toBe(true)
    // 칸으로 가르면 된다: 둘째 캐릭터의 칸에 적은 자기 몸 이야기는 둘째에게만
    const own = analyzeExposure({
      chars,
      fields: [{ text: 'pussy', scope: 'char', index: 2 }],
      acts
    })
    expect(own.chars[2].areas.lower.needed).toBe(true)
    expect(own.chars[0].areas.lower.needed).toBe(false)
  })

  it('캐릭터 칸에 적은 하는쪽의 상대 몸 행위는 상대(반대 성별)에게 간다', () => {
    const ex = analyzeExposure({
      chars: [woman, man],
      fields: [{ text: 'fingering', scope: 'char', index: 1 }],
      acts
    })
    expect(ex.chars[0].areas.lower.needed).toBe(true)
    expect(ex.chars[1].areas.lower.needed).toBe(false)
  })

  it('역할 없는 여캐도 씬 글을 받는다 — 남녀는 characterSex 가 가른다', () => {
    expect(receivesSceneText(null, 'female', true)).toBe(true)
    expect(receivesSceneText(null, 'male', true)).toBe(false)
    expect(receivesSceneText('source', 'male', true)).toBe(false)
    expect(receivesSceneText('target', 'female', true)).toBe(true)
    expect(receivesSceneText(null, 'male', false)).toBe(true)
    const roleless: ExposeChar = { ...woman, role: null }
    const ex = read('vaginal', 'scene', [roleless, man])
    expect(ex.chars[0].areas.lower.needed).toBe(true)
    expect(ex.chars[1].areas.lower.needed).toBe(true)
  })

  it('얼굴만 나오는 자리는 몸 증거를 받지 않는다', () => {
    const face: ExposeChar = { ...woman, faceSeat: true }
    const ex = analyzeExposure({
      chars: [face, man],
      fields: [
        { text: 'sex, nipples', scope: 'scene' },
        { text: 'pink inset, pussy', scope: 'char', index: 0 }
      ],
      acts
    })
    expect(ex.chars[0].auto).toEqual({ lower: false, chest: false })
    expect(ex.chars[0].areas.lower.status).toBe('off-frame')
    // 같은 카드가 몸 자리에 있으면 그 자리가 받는다
    expect(ex.chars[1].areas.lower.needed).toBe(true)
  })

  it('씬에서 자동 젖힘을 끄면 근거가 있어도 켜지지 않고 이유가 남는다', () => {
    const off: ExposeChar = { ...woman, autoOff: true }
    const ex = read('sex', 'scene', [off, man])
    expect(ex.chars[0].auto).toEqual({ lower: false, chest: false })
    expect(ex.chars[0].areas.lower.status).toBe('vetoed')
  })

  it('벗은 상태 서술은 부위를 가른다 — ass nude 는 아래만, nude 는 둘 다', () => {
    const kinds = (text: string): string[] =>
      analyzeText(text, { actor: null }, acts).evidence.map((e) => `${e.area}/${e.kind}`)
    expect(kinds('ass nude')).toEqual(['lower/open'])
    expect(kinds('she is completely naked')).toEqual(['lower/open', 'chest/open'])
    expect(kinds('topless')).toEqual(['chest/open'])
    expect(kinds('bottomless')).toEqual(['lower/open'])
    // 부정이면 벗은 게 아니다
    expect(kinds('she is not naked')).toEqual([])
    // dressed up 같은 말은 옷 상태 변화가 아니다
    expect(kinds('dressed up in a maid dress')).toEqual([])
    expect(kinds('she pulls her panties aside')).toEqual(['lower/open'])
    expect(kinds('skirt lifted')).toEqual(['lower/open'])
  })

  it('씬 전체 글에 적은 주인 없는 벗음 서술은 씬 글을 받는 캐릭터(당하는쪽)의 것', () => {
    const ex = read('ass nude, sex')
    expect(ex.chars[0].areas.lower.opens).not.toHaveLength(0)
    expect(ex.chars[1].areas.lower.opens).toHaveLength(0)
    const r = finishExposure(ex.chars[0], ex, plainWorn({ card: 'skirt, panties' }))
    expect(r.tags).toEqual([])
    expect(statusOf(r.notes, 'lower')).toBe('nude')
  })

  it('한글 토막은 읽지 않는다', () => {
    expect(analyzeText('음부를 보여주며 노출한채', { actor: null }, acts).evidence).toEqual([])
  })
})

// ── 입은 옷에 맞춰 붙이기 ──────────────────────────────────────

const plainWorn = (over: Partial<WornState> = {}): WornState => ({
  card: '',
  outfit: '',
  own: [],
  stripped: false,
  piece: pieceInfo(undefined, undefined, {}),
  ...over
})

/** 장면 글 → 히로인(또는 index 번째) 캐릭터의 결과 */
const run = (
  sceneText: string,
  worn: Partial<WornState>,
  options: { chars?: ExposeChar[]; index?: number; scope?: ExposeField['scope'] } = {}
): { tags: string[]; notes: ExposeNote[] } => {
  const chars = options.chars ?? [woman, man]
  const ex = read(sceneText, options.scope ?? 'scene', chars)
  return finishExposure(ex.chars[options.index ?? 0], ex, plainWorn(worn))
}

/** 판정이 있는 메모 — 「근거 없음(not-needed)」은 빼고 */
const real = (notes: ExposeNote[]): ExposeNote[] => notes.filter((n) => n.status !== 'not-needed')

const statusOf = (notes: ExposeNote[], area: 'lower' | 'chest'): ExposeStatus | undefined =>
  notes.find((n) => n.area === area && n.status !== 'conflict' && n.status !== 'not-needed')?.status

describe('입은 옷에 맞춘 젖힘 태그', () => {
  it('카드에 적은 옷도 읽어 붙인다 — 필요한 부위의 옷만, 겉에서 속으로', () => {
    const r = run('vaginal', { card: '1girl, pleated skirt, white panties, white shirt, bra' })
    expect(r.tags).toEqual(['skirt lift', 'panties aside'])
    expect(real(r.notes)).toHaveLength(1)
    expect(r.notes[0]).toMatchObject({
      charIndex: 0,
      charId: 1,
      name: '히로인',
      area: 'lower',
      status: 'added',
      tags: ['skirt lift', 'panties aside'],
      garments: ['skirt', 'panties']
    })
    expect(r.notes[0].evidence.length).toBeGreaterThan(0)
    expect(r.notes[0].reason).toContain('skirt lift, panties aside')
    // 가슴이 필요하면 가슴 옷만 — 반대 부위 태그는 안 붙인다
    const chest = run('paizuri', { card: 'pleated skirt, white shirt, bra' })
    expect(chest.tags).toEqual(['shirt lift', 'bra lift'])
  })

  it('복장 조각에서 읽은 옷과 카드 옷을 함께 읽는다', () => {
    const r = run('vaginal', { card: 'pelvic curtain', outfit: 'red dress' })
    expect(r.tags).toEqual(['pelvic curtain lift', 'dress lift'])
  })

  it('부위당 최대 3개', () => {
    const r = run('sex', { card: 'coat, jacket, shirt, bra, skirt, pantyhose, panties' })
    // 가장 안쪽 속옷(panties aside)이 병기 태그에 밀려 빠지지 않는다
    expect(r.tags.slice(0, 3)).toEqual(['skirt lift', 'pantyhose pull', 'panties aside'])
    const lower = r.notes.find((n) => n.area === 'lower')
    expect(lower?.tags).toHaveLength(3)
  })

  it('이미 같은 태그가 글에 있으면 안 붙이고, 일부만 있으면 빠진 것만 붙인다', () => {
    const some = run('vaginal', { card: 'skirt, panties', own: ['skirt lift'] })
    expect(some.tags).toEqual([])
    expect(statusOf(some.notes, 'lower')).toBe('already')
    const part = run('vaginal', { card: 'skirt, thong, pantyhose', own: ['pantyhose pull'] })
    // 같은 부위에 이미 젖힘이 있으면 그 부위는 건드리지 않는다
    expect(part.tags).toEqual([])
    expect(statusOf(part.notes, 'lower')).toBe('already')
    // 비교는 소문자·밑줄·역할 접두를 무시한다
    const prefixed = run('vaginal', { card: 'skirt', own: ['Skirt_Lift'] })
    expect(prefixed.tags).toEqual([])
  })

  it('같은 부위에 직접 적은 젖힘·벗음 선언이 있으면 안 붙인다', () => {
    for (const declared of ['clothing aside', 'breasts out', 'panties around one leg']) {
      const area = declared === 'breasts out' ? 'chest' : 'lower'
      const need = area === 'chest' ? 'paizuri' : 'vaginal'
      const r = run(need, { card: 'skirt, shirt, panties', own: [declared] })
      expect(r.tags, declared).toEqual([])
      expect(statusOf(r.notes, area), declared).toBe('already')
    }
    // 남성 하의 젖힘(open fly)은 남캐의 것 — 씬 글을 받는 히로인의 아래를 열린 것으로 치지 않는다
    expect(run('vaginal', { card: 'skirt, panties', own: ['open fly'] }).tags).toEqual([
      'skirt lift',
      'panties aside'
    ])
    const flyMan = run('fellatio', { card: 'pants', own: ['open fly'] }, { index: 1 })
    expect(flyMan.tags).toEqual([])
    expect(statusOf(flyMan.notes, 'lower')).toBe('already')
    // 알몸 선언
    for (const [declared, area] of [
      ['nude', 'lower'],
      ['completely nude', 'chest'],
      ['bottomless', 'lower'],
      ['topless female', 'chest']
    ] as const) {
      const need = area === 'chest' ? 'paizuri' : 'vaginal'
      const r = run(need, { card: 'skirt, shirt', own: [declared] })
      expect(r.tags, declared).toEqual([])
      expect(statusOf(r.notes, area), declared).toBe('nude')
    }
    // 앞이 열린 겉옷(open jacket)은 속에 입은 옷이 없을 때만 「이미 젖힘」 — 셔츠·브라를 입었으면 속옷 태그도 같이 나가야 뜻이 맞다
    const jacket = run('paizuri', { card: 'jacket, shirt, bra', own: ['open jacket'] })
    expect(jacket.tags).toEqual(['shirt lift', 'bra lift'])
    expect(run('paizuri', { card: 'jacket', own: ['open jacket'] }).tags).toEqual([])
    expect(statusOf(run('paizuri', { card: 'jacket', own: ['open jacket'] }).notes, 'chest')).toBe(
      'already'
    )
    // bottomless 는 아래만 — 가슴 옷은 그대로 젖힌다
    const chestOnly = run('vaginal, paizuri', { card: 'skirt, shirt', own: ['bottomless'] })
    expect(chestOnly.tags).toEqual(['shirt lift'])
    expect(statusOf(chestOnly.notes, 'lower')).toBe('nude')
  })

  it('씬 전체 글에 적은 벗음 선언도 그 글을 받는 캐릭터에게 적용된다', () => {
    const r = run('vaginal, bottomless', { card: 'skirt' })
    expect(r.tags).toEqual([])
    expect(statusOf(r.notes, 'lower')).toBe('nude')
    // 글을 못 받는 하는쪽은 해당 없음
    const m = run('vaginal, bottomless', { card: 'pants' }, { index: 1 })
    expect(m.tags).toEqual(['pants pull', 'open fly'])
  })

  it('음수 가중치는 거부권', () => {
    const all = run('vaginal', { card: 'skirt, panties, -1::skirt lift::, -1::panties aside::' })
    expect(all.tags).toEqual([])
    expect(statusOf(all.notes, 'lower')).toBe('vetoed')
    expect(all.notes[0].tags).toEqual(['skirt lift', 'panties aside'])
    const some = run('vaginal', { card: 'skirt, panties', own: ['-1::skirt lift::'] })
    expect(some.tags).toEqual(['panties aside'])
    expect(some.notes[0].reason).toContain('skirt lift')
  })

  it('입지 않은 옷은 읽지 않는다 (no panties · dress shirt · cupless bra · bikini tan)', () => {
    const r = run('vaginal', { card: 'skirt, no panties' })
    expect(r.tags).toEqual(['skirt lift'])
    const shirt = run('paizuri', { card: 'dress shirt, dress shoes' })
    expect(shirt.tags).toEqual(['shirt lift'])
    const cup = run('paizuri', { card: 'cupless bra' })
    expect(cup.tags).toEqual([])
    expect(statusOf(cup.notes, 'chest')).toBe('already')
    const tan = run('paizuri', { card: 'bikini tan, tan lines' })
    expect(tan.tags).toEqual([])
    expect(statusOf(tan.notes, 'chest')).toBe('no-garment')
  })

  it('naked apron 은 그 한 겹만 입은 것', () => {
    const r = run('vaginal', { card: 'naked apron, panties' })
    expect(r.tags).toEqual(['apron lift'])
  })

  it('옷을 못 읽으면 붙이지 않고 제안만 한다', () => {
    const r = run('vaginal', { card: '1girl, long hair, blue eyes' })
    expect(r.tags).toEqual([])
    expect(real(r.notes)).toHaveLength(1)
    // 옷 글이 아예 없으면 경고가 아니라 조용한 상태 — 제안도 하지 않는다
    expect(r.notes[0]).toMatchObject({ status: 'no-garment', tags: [], garments: [] })
    expect(r.notes[0].reason).toContain('입은 옷이 적혀 있지 않음')
    // 옷 이야기는 있는데 낱말표가 못 읽는 경우는 경고 (제안 있음)
    const armor = run('vaginal', { card: '1girl, silver armor, red cape' })
    expect(armor.notes[0]).toMatchObject({ status: 'no-garment', tags: ['clothing aside'] })
    // 그 부위를 가린 옷이 아니면 (셔츠만 입고 아래가 필요) 역시 못 읽음
    const shirt = run('vaginal', { card: 'white shirt' })
    expect(statusOf(shirt.notes, 'lower')).toBe('no-garment')
    expect(shirt.notes[0].garments).toEqual(['shirt'])
    const chest = run('paizuri', { card: 'skirt' })
    expect(chest.notes.find((n) => n.area === 'chest')).toMatchObject({
      area: 'chest',
      status: 'no-garment',
      tags: ['breasts out']
    })
  })

  it('알몸(옷 벗기기)이면 자동층이 통째로 빠진다', () => {
    const r = run('vaginal, paizuri', {
      card: '1girl, nude, completely nude',
      stripped: true,
      strippedBy: '씬의 옷 벗기기'
    })
    expect(r.tags).toEqual([])
    expect(statusOf(r.notes, 'lower')).toBe('nude')
    expect(statusOf(r.notes, 'chest')).toBe('nude')
  })

  it('알몸인데 착의 단서가 있으면 자동으로 풀지 않고 충돌로 표시한다', () => {
    const r = run('fingering', {
      card: 'nude, completely nude',
      own: ['clothing aside', 'pussy juice stain'],
      stripped: true,
      strippedBy: '씬의 옷 벗기기'
    })
    expect(r.tags).toEqual([])
    const conflict = r.notes.filter((n) => n.status === 'conflict')
    expect(conflict.map((n) => n.area)).toContain('lower')
    expect(conflict[0].reason).toContain('clothing aside')
    // 필요 없는 씬에서도 충돌은 알린다
    const quiet = run('standing', {
      card: 'nude',
      own: ['open clothes'],
      stripped: true
    })
    expect(quiet.notes.some((n) => n.status === 'conflict')).toBe(true)
    // 알몸이 아니면 충돌이 아니다
    expect(
      run('fingering', { card: 'skirt', own: ['clothing aside'] }).notes.some(
        (n) => n.status === 'conflict'
      )
    ).toBe(false)
  })

  it('복장의 nsfw 조각이 켜져 있으면 그 부위는 조각이 맡는다 · 끄면 막힘으로', () => {
    const outfit: Outfit = {
      id: 9,
      name: '교복',
      negative: '',
      pieces: [
        { id: 'a', name: '치마', tags: 'pleated skirt, white panties', on: true },
        {
          id: 'b',
          name: '젖히기(아래)',
          tags: 'skirt lift, panties aside',
          on: false,
          when: 'nsfw-lower'
        }
      ]
    }
    const ex = read('vaginal, paizuri')
    const piece = pieceInfo(outfit, undefined, ex.chars[0].auto)
    expect(piece.state).toEqual({ lower: 'on', chest: 'none' })
    const on = finishExposure(
      ex.chars[0],
      ex,
      plainWorn({
        card: 'white shirt',
        outfit: 'pleated skirt, white panties, skirt lift, panties aside',
        piece
      })
    )
    expect(statusOf(on.notes, 'lower')).toBe('piece')
    expect(on.notes.find((n) => n.area === 'lower')?.tags).toEqual(['skirt lift', 'panties aside'])
    // 가슴은 조각이 없으니 입은 옷(셔츠)에 맞춰 붙는다
    expect(on.tags).toEqual(['shirt lift'])
    // 이 씬에서 조각을 껐으면 자동층도 끼어들지 않는다
    const offPiece = pieceInfo(outfit, { off: ['b'] }, ex.chars[0].auto)
    expect(offPiece.state.lower).toBe('off')
    const off = finishExposure(
      ex.chars[0],
      ex,
      plainWorn({ card: 'white shirt', outfit: 'pleated skirt, white panties', piece: offPiece })
    )
    expect(statusOf(off.notes, 'lower')).toBe('vetoed')
    expect(off.tags).toEqual(['shirt lift'])
  })

  it('벗음·젖힘 단서의 주인이 모호하면 붙이지 않고 판단 못 함', () => {
    // 하는쪽 칸의 「open clothes」는 누구 옷인지 모른다 — 그 태그는 하는쪽(남캐) 프롬프트에만 가므로 남캐가 판단 못 함
    const ex = analyzeExposure({
      chars: [woman, man],
      fields: [
        { text: 'sex', scope: 'scene' },
        { text: 'open clothes', scope: 'source' }
      ],
      acts
    })
    const m = finishExposure(ex.chars[1], ex, plainWorn({ card: 'pants, shirt' }))
    expect(m.tags).toEqual([])
    expect(m.notes.map((n) => n.status)).toContain('unknown')
    // 당하는쪽(히로인)은 그 칸의 글을 받지 않으니 영향이 없다
    expect(finishExposure(ex.chars[0], ex, plainWorn({ card: 'skirt, shirt' })).tags).toEqual([
      'skirt lift'
    ])
    // 캐릭터 자기 칸의 「clothing aside」는 그 캐릭터 것
    const own = analyzeExposure({
      chars: [woman, man],
      fields: [
        { text: 'sex', scope: 'scene' },
        { text: 'clothing aside', scope: 'char', index: 0 }
      ],
      acts
    })
    const mine = finishExposure(
      own.chars[0],
      own,
      plainWorn({ card: 'skirt', own: ['clothing aside'] })
    )
    expect(statusOf(mine.notes, 'lower')).toBe('already')
  })

  it('남캐도 자기 옷을 읽는다 — 펠라치오는 남 아래만 (여 아래는 안 열림)', () => {
    const male = run('fellatio', { card: 'pants, shirt' }, { index: 1 })
    expect(male.tags).toEqual(['pants pull', 'open fly'])
    const female = run('fellatio', { card: 'skirt, shirt' }, { index: 0 })
    expect(female.tags).toEqual([])
    expect(real(female.notes)).toEqual([])
  })

  it('붙은 태그는 반드시 notes 에 있고, notes 의 added 가 아닌 태그는 붙지 않는다', () => {
    const scenes = [
      'vaginal',
      'paizuri',
      'sex, nipples',
      'fingering',
      'cunnilingus, nipple tweak',
      'masturbation',
      'fellatio, handjob'
    ]
    const wears = [
      'skirt, panties, shirt, bra',
      'bikini',
      'maid dress, apron, pantyhose',
      'jacket, shirt, pants',
      'leotard',
      '1girl'
    ]
    const owns: string[][] = [[], ['clothing aside'], ['-1::skirt lift::'], ['breasts out']]
    for (const s of scenes)
      for (const w of wears)
        for (const own of owns)
          for (const index of [0, 1]) {
            const r = run(s, { card: w, own }, { index })
            const noted = r.notes.filter((n) => n.status === 'added').flatMap((n) => n.tags)
            expect(new Set(r.tags), `${s} | ${w} | ${own} | ${index}`).toEqual(new Set(noted))
            for (const n of r.notes) {
              expect(n.reason).toBeTruthy()
              if (n.status !== 'added') expect(n.status).not.toBe('added')
            }
          }
  })
})
