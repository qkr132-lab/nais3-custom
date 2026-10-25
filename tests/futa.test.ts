import { describe, expect, it } from 'vitest'
import {
  bodyOfSex,
  declaresFullNude,
  hasTesticleType,
  readBody,
  wantsPinkNipples,
  type BodyReading
} from '../src/shared/body'
import {
  bodyTagsFor,
  girlsTag,
  mapTags,
  planFuta,
  relationTag,
  rewriteCharTexts,
  rewriteRequestPrompt,
  rewriteSceneTexts,
  swapMalePronouns
} from '../src/shared/futa'
import { engineTagsOf } from '../src/shared/auto-expose'
import { refreshScenePrompts, scenePositivePrompt } from '../src/shared/scene-request'
import type { BodyNote, FutaPlan, GenerationRequest } from '../src/shared/types'

/**
 * 후타 자동 재조립 (합성 입력만 — 사용자 씬·카드 원문은 쓰지 않는다. 태그는 단보루 실존 태그, 문장은 지어낸 것).
 * 1) 후타 판정 2) 치환 함수 3) 합성 씬 묶음 전수 4) 불변식(몰래 바꾸기 금지·멱등) 5) refreshScenePrompts 재적용
 */

// ── 도우미 ───────────────────────────────────────────────

const plan = (
  futa: number,
  female: number,
  male = 0,
  viewFix = true,
  dedupePenis = false
): FutaPlan => ({
  counts: { futa, female, male },
  viewFix,
  dedupePenis
})
const tagsOf = (text: string): string[] => engineTagsOf(text)
/** 두 글의 태그 차이 (순서 무시, 개수 포함) — 뺀 것과 더한 것 */
function diff(before: string, after: string): { removed: string[]; added: string[] } {
  const count = (list: string[]): Map<string, number> => {
    const m = new Map<string, number>()
    for (const t of list) m.set(t, (m.get(t) ?? 0) + 1)
    return m
  }
  const a = count(tagsOf(before))
  const b = count(tagsOf(after))
  const removed: string[] = []
  const added: string[] = []
  for (const [t, n] of a) for (let i = 0; i < n - (b.get(t) ?? 0); i++) removed.push(t)
  for (const [t, n] of b) for (let i = 0; i < n - (a.get(t) ?? 0); i++) added.push(t)
  return { removed, added }
}

// ── 1) 후타 판정 ─────────────────────────────────────────

describe('후타 판정 (readBody)', () => {
  const futaOf = (card: string, role: 'source' | 'target' | null = null): boolean =>
    readBody(role, [card], true).body.futa

  it('futanari 가 든 카드는 후타다 — 가중치 묶음·밑줄·별칭·합성 표기를 푼다', () => {
    // 사용자 카드에서 실제로 쓰는 표기 모양 (묶음 · 평문 · 후타 낱말만 · 밑줄)
    const forms = [
      '1girl, 3::futanari,large penis ::',
      '2::futanari, large penis::, blue eyes',
      'huge breasts, futanari, large penis',
      'futanari',
      '1.2::futa_with_female::',
      'full-package futanari, blonde hair',
      'implied futanari',
      'intravaginal futanari',
      'futa without pussy',
      'futa without balls',
      'futa with male',
      'futa with futa',
      'futa',
      'dickgirl',
      'newhalf',
      'shemale'
    ]
    for (const f of forms) expect(futaOf(f), f).toBe(true)
  })

  it('읽지 않는 것 — 주석 · 음수·0 가중치 · 와일드카드 · 랜덤 선택지 · 남은 낱말', () => {
    const none = [
      '1girl, # futanari 는 주석\nblue eyes',
      '1girl, -1::futanari::',
      '1girl, 0::futanari::',
      '1girl, <wild>, blue eyes',
      '1girl, (futanari/blue eyes)',
      '1girl, {futanari|smile}',
      '1girl, large penis',
      '1girl, cuntboy'
    ]
    for (const f of none) expect(futaOf(f), f).toBe(false)
  })

  it('역할과 무관하다 — 하는쪽이든 당하는쪽이든 역할 없음이든 카드 글로 정한다', () => {
    for (const role of ['source', 'target', null] as const) {
      expect(futaOf('1girl, futanari', role)).toBe(true)
      expect(futaOf('1girl, blue eyes', role)).toBe(false)
    }
  })

  it('후타 몸 — 음경이 있고 가슴은 여성, 음부는 받는 몸일 때만 (하는쪽이 아니면, futa without pussy 가 아니면)', () => {
    expect(readBody('source', ['futanari'], true).body).toEqual({
      penis: true,
      pussy: false,
      chest: 'female',
      futa: true
    })
    expect(readBody('target', ['futanari'], true).body.pussy).toBe(true)
    expect(readBody(null, ['futanari'], true).body.pussy).toBe(true)
    expect(readBody('target', ['futa without pussy'], true).body.pussy).toBe(false)
    expect(readBody('target', ['newhalf'], true).body.pussy).toBe(false)
  })

  it('후타가 아니면 역할 기준 옛 몸 그대로다 (characterSex 는 바뀌지 않는다)', () => {
    expect(readBody('source', ['1boy'], true).body).toEqual(bodyOfSex('male'))
    expect(readBody('target', ['1girl'], true).body).toEqual(bodyOfSex('female'))
    expect(readBody(null, ['1boy'], true).body).toEqual(bodyOfSex('male'))
    expect(readBody('source', ['futanari'], true).sex).toBe('male')
    expect(readBody('target', ['futanari'], true).sex).toBe('female')
  })

  it('설정을 끄면 후타를 읽지 않는다', () => {
    const r = readBody('source', ['1girl, futanari'], false)
    expect(r.body).toEqual(bodyOfSex('male'))
    expect(r.flags).toEqual([])
  })

  it('1boy 와 futanari 가 같이 있으면 충돌 — 전환하지 않고 표시만', () => {
    const r = readBody('target', ['1boy, futanari'], true)
    expect(r.body.futa).toBe(false)
    expect(r.flags).toEqual(['conflict'])
    // 남성 몸 태그도 같다
    expect(readBody('target', ['trap, futanari'], true).flags).toEqual(['conflict'])
    // futa with male 의 male 은 몸 신호가 아니다
    expect(readBody('target', ['futanari, futa with male'], true).flags).toEqual([])
  })

  it('여성 카드에 음경 태그만 있으면 후타 의심 — 전환하지 않는다. 남캐는 해당 없다', () => {
    const r = readBody('target', ['1girl, large penis, erection'], true)
    expect(r.body.futa).toBe(false)
    expect(r.flags).toEqual(['suspect'])
    expect(readBody('source', ['1boy, large penis'], true).flags).toEqual([])
    expect(readBody('target', ['1boy, large penis'], true).flags).toEqual([])
  })

  it('와일드카드가 있으면 못 읽었다고 알린다', () => {
    expect(readBody('target', ['1girl, <outfit>'], true).flags).toEqual(['unreadable'])
    expect(readBody('target', ['1girl, (futanari/smile)'], true).flags).toEqual(['unreadable'])
    // 후타로 읽혔으면 알릴 필요가 없다
    expect(readBody('target', ['1girl, futanari, <outfit>'], true).flags).toEqual([])
  })

  it('자리 태그·씬별 캐릭터 태그의 futanari 도 읽는다', () => {
    expect(readBody('source', ['1girl, blue eyes', 'futanari'], true).body.futa).toBe(true)
  })

  it('가슴·girl 계열·large penis 정보를 같이 돌려준다', () => {
    const r = readBody('source', ['1girl, futanari, large penis'], true)
    expect(r.chestFemale).toBe(true)
    expect(r.hasGirl).toBe(true)
    expect(r.largePenis).toBe(true)
    const m = readBody('source', ['1boy, muscular'], true)
    expect(m.chestFemale).toBe(false)
    expect(m.hasGirl).toBe(false)
    // 당하는쪽이어도 카드에 남자 태그가 있으면 가슴은 여성이 아니다
    expect(readBody('target', ['1boy'], true).chestFemale).toBe(false)
    // 하는쪽 역할의 여성 카드는 역할 기준 남캐다 — pink nipples 대상이 아니다
    // 역할이 하는쪽이어도 카드가 girl 이고 남자 태그가 없으면 여성이다 (역할은 옷 벗기기 메뉴 몫)
    expect(readBody('source', ['1girl'], true).chestFemale).toBe(true)
    expect(readBody('source', ['red hair'], true).chestFemale).toBe(false)
    expect(readBody('source', ['1girl, 1boy'], true).chestFemale).toBe(false)
  })
})

// ── 2) 계획 · 관계 · 인원수 ─────────────────────────────────

describe('후타 계획', () => {
  it('후타가 없으면 계획도 없다', () => {
    expect(planFuta([{ kind: 'female' }, { kind: 'male' }], true)).toBeNull()
    expect(planFuta([], true)).toBeNull()
  })

  it('구성별 관계 태그와 인원수 — 후타는 girl 로 센다', () => {
    const c = (futa: number, female: number, male: number): FutaPlan['counts'] => ({
      futa,
      female,
      male
    })
    expect(relationTag(c(1, 1, 0))).toBe('futa with female')
    expect(girlsTag(c(1, 1, 0))).toBe('2girls')
    expect(relationTag(c(2, 0, 0))).toBe('futa with futa')
    expect(girlsTag(c(2, 0, 0))).toBe('2girls')
    expect(relationTag(c(1, 0, 1))).toBe('futa with male')
    expect(girlsTag(c(1, 0, 1))).toBeNull()
    expect(relationTag(c(1, 0, 0))).toBeNull()
    expect(girlsTag(c(1, 0, 0))).toBeNull()
    expect(girlsTag(c(1, 2, 0))).toBe('3girls')
    expect(girlsTag(c(3, 4, 0))).toBe('6+girls')
  })

  it('하는쪽 역할의 후타가 있을 때만 sourceFuta — 당하는쪽·역할 없음·후타 아님은 아니다', () => {
    const counts = { futa: 1, female: 1, male: 0 }
    const base = { counts, viewFix: true, dedupePenis: false }
    expect(planFuta([{ kind: 'futa', role: 'source' }, { kind: 'female' }], true)).toEqual({
      ...base,
      sourceFuta: true
    })
    expect(planFuta([{ kind: 'futa', role: 'target' }, { kind: 'female' }], true)).toEqual(base)
    expect(planFuta([{ kind: 'futa', role: null }, { kind: 'female' }], true)).toEqual(base)
    expect(planFuta([{ kind: 'futa' }, { kind: 'female' }], true)).toEqual(base)
    // 하는쪽 역할이어도 후타가 아니면(남·여) 세지 않는다
    expect(
      planFuta(
        [
          { kind: 'futa', role: 'target' },
          { kind: 'female', role: 'source' }
        ],
        true
      )
    ).toEqual(base)
    // 후타가 둘이고 하나만 하는쪽이어도 켠다
    expect(
      planFuta(
        [
          { kind: 'futa', role: 'target' },
          { kind: 'futa', role: 'source' }
        ],
        true
      )?.sourceFuta
    ).toBe(true)
  })

  it('large penis 가 카드에 있는 후타가 있으면 dedupePenis', () => {
    const p = planFuta([{ kind: 'futa', largePenis: true }, { kind: 'female' }], false)
    expect(p).toEqual({
      counts: { futa: 1, female: 1, male: 0 },
      viewFix: false,
      dedupePenis: true
    })
  })
})

// ── 3) 치환 함수 (mapTags · 규칙) ─────────────────────────────

describe('mapTags — 안전하게 바꾸는 법', () => {
  const swap = (text: string): ReturnType<typeof mapTags> =>
    mapTags(text, (t) => (t === 'hetero' ? { after: 'futa with female', reason: 'r' } : null))

  it('주석 안·음수 가중치·와일드카드·랜덤 선택지·따옴표 대사·Text: 꼬리는 그대로', () => {
    const text = [
      '1girl, # hetero 는 주석',
      '-2::hetero::, <hetero>, (hetero/yuri), {hetero|solo}, "hetero said",',
      'smile, hetero'
    ].join('\n')
    const r = swap(text)
    expect(r.text.split('\n')[0]).toBe('1girl, # hetero 는 주석')
    expect(r.text.split('\n')[1]).toBe(
      '-2::hetero::, <hetero>, (hetero/yuri), {hetero|solo}, "hetero said",'
    )
    expect(r.text.split('\n')[2]).toBe('smile, futa with female')
    expect(r.edits).toHaveLength(1)
    const tail = swap('hetero, Text: "hetero hello"')
    expect(tail.text).toBe('futa with female\nText: "hetero hello"')
  })

  it('가중치 묶음은 안쪽만 바꾸고 가중치 숫자는 그대로, 남는 게 없으면 묶음째 뺀다', () => {
    expect(swap('3::hetero::, smile').text).toBe('3::futa with female::, smile')
    expect(swap('2::kiss, hetero::').text).toBe('2::kiss, futa with female::')
    const gone = mapTags('2::hetero::, smile', () => ({ after: '', reason: 'r' }))
    expect(gone.text).toBe('')
    const pair = mapTags('2::a, b::, smile', (t) => (t === 'a' ? { after: '', reason: 'r' } : null))
    expect(pair.text).toBe('2::b::, smile')
  })

  it('바뀐 게 없으면 같은 문자열을 돌려준다', () => {
    const text = '1girl, smile,\nblue eyes # 메모'
    expect(swap(text).text).toBe(text)
    expect(swap(text).edits).toEqual([])
  })

  it('원래 줄 끝의 쉼표와 줄바꿈을 지킨다', () => {
    expect(swap('hetero,\nkiss').text).toBe('futa with female,\nkiss')
  })

  it('두 번 적용해도 같다 (멱등)', () => {
    const once = swap('1girl, hetero, 3::hetero, kiss::').text
    expect(swap(once).text).toBe(once)
  })
})

describe('문장 속 남성 지칭', () => {
  it('he/his/him/the man 을 the futanari 로 — 문장 첫머리 대문자와 소유격을 지킨다', () => {
    expect(swapMalePronouns('in front of him')).toBe('in front of the futanari')
    expect(swapMalePronouns('his hard cock')).toBe("the futanari's hard cock")
    expect(swapMalePronouns('His head out of frame')).toBe("The futanari's head out of frame")
    expect(swapMalePronouns('He holds her waist')).toBe('The futanari holds her waist')
    expect(swapMalePronouns("the man's hand on her head")).toBe("the futanari's hand on her head")
    expect(swapMalePronouns('she and the heroine')).toBe('she and the heroine')
  })
})

// ── 규칙 하나씩 ───────────────────────────────────────────

describe('씬 글 재조립 (rewriteSceneTexts) — 후타+여', () => {
  const rw = (prompt: string, p: FutaPlan = plan(1, 1)): ReturnType<typeof rewriteSceneTexts> =>
    rewriteSceneTexts(p, { base: '', prompt })

  it('R1·R2 인원수·관계 — 1boy 를 빼고 1girl 을 2girls 로 합치고 hetero 를 futa with female 로', () => {
    const r = rw('1girl, 1boy, hetero, kiss')
    expect(r.prompt).toBe('2girls, futa with female, kiss')
    expect(r.notes.map((n) => [n.kind, n.before ?? '', n.after ?? ''])).toEqual(
      expect.arrayContaining([
        ['removed', '1boy', ''],
        ['replaced', '1girl', '2girls'],
        ['replaced', 'hetero', 'futa with female']
      ])
    )
  })

  it('hetero 없이 1boy 만 있던 씬도 관계 태그를 더한다 (자리는 1boy 가 있던 글의 끝)', () => {
    const r = rw('1girl, 1boy, fellatio')
    expect(r.prompt).toBe('2girls, fellatio, futa with female')
    expect(r.notes).toContainEqual(
      expect.objectContaining({ kind: 'added', after: 'futa with female', where: 'scene' })
    )
  })

  it('남성 표지가 없으면 1girl 단독 씬은 건드리지 않는다', () => {
    const r = rw('1girl, solo focus, kiss')
    expect(r.prompt).toBe('1girl, solo focus, kiss')
    expect(r.notes).toEqual([])
  })

  it('음수 가중치·multiple boys 는 — 음수는 유지, 긍정 multiple boys 는 뺀다', () => {
    // 음수 가중치의 1boy 는 남성 표지가 아니다 (hetero 가 표지라 1girl 은 합친다)
    expect(rw('1girl, -2::1boy::, hetero').prompt).toBe('2girls, -2::1boy::, futa with female')
    expect(rw('1girl, -2::1boy::, kiss').prompt).toBe('1girl, -2::1boy::, kiss')
    expect(rw('1girl, multiple boys, hetero').prompt).toBe('2girls, futa with female')
  })

  it('R3 남자 묘사 — faceless male 은 faceless female 로, 나머지는 뺀다', () => {
    expect(rw('2::peach skin male, nude male, faceless male::, hetero').prompt).toBe(
      '2::faceless female::, futa with female'
    )
    expect(rw('muscular male, fat man, male pubic hair, smile').prompt).toBe('smile')
    // male focus 는 남자 장면 선언이라 빼고, 관계 태그를 맞춘다
    expect(rw('male focus, smile').prompt).toBe('smile, futa with female')
  })

  it('R4 male 구절 — 알려진 구절은 바꾸고 나머지는 구절째 뺀다', () => {
    const r = rw(
      "another's male hand, male head between female thighs, male sucking her breast, looking at male, other male arm around waist, male on bottom, male licking pussy, smile"
    )
    expect(tagsOf(r.prompt)).toEqual([
      "another's hand",
      'head between thighs',
      'breast sucking',
      'looking at another',
      'arm around waist',
      'smile'
    ])
    // 그 밖의 male 구절은 구절째 뺀다
    expect(rw('male standing behind female, smile').prompt).toBe('smile')
    // futa 태그 안의 male 은 건드리지 않는다
    expect(rw('futa with male, smile').prompt).toBe('futa with male, smile')
  })

  it('R5 고환 — testicles 계열은 빼고 no testicles 는 남긴다', () => {
    expect(rw('sucking testicles, lipstick mark on testicles, no testicles, smile').prompt).toBe(
      'no testicles, smile'
    )
  })

  it('R7 시점 — pov 계열을 from side 하나로 (이미 있으면 뺌만)', () => {
    expect(rw('pov, fellatio').prompt).toBe('from side, fellatio')
    expect(rw('pov hands, pov crotch, disembodied hand, kiss').prompt).toBe('from side, kiss')
    expect(rw('from side, pov, fellatio').prompt).toBe('from side, fellatio')
    // 설정으로 끄면 시점·구도는 그대로
    expect(rw('pov, penis focus, kiss', plan(1, 1, 0, false)).prompt).toBe('pov, penis focus, kiss')
  })

  it('R7·R8 은 남자 시점 씬(남자 선언이나 음경 행위)에서만 — 입맞춤·무릎베개의 pov 는 그대로', () => {
    expect(rw('pov, imminent kiss').prompt).toBe('pov, imminent kiss')
    expect(rw('3::pov, from below, looking up::, lap pillow').prompt).toBe(
      '3::pov, from below, looking up::, lap pillow'
    )
    // 남자 선언이 있으면 한다
    expect(rw('1boy, 1girl, pov, kiss').prompt).toBe('2girls, from side, kiss, futa with female')
  })

  it('다른 앵글 태그(from behind · from below · from above · front view)가 있으면 pov 는 뺄 뿐 from side 를 더하지 않는다', () => {
    for (const angle of ['from behind', 'from below', 'from above', 'front view']) {
      const r = rw(`pov, ${angle}, fellatio`)
      expect(r.prompt, angle).toBe(`${angle}, fellatio`)
      expect(
        r.notes.map((n) => [n.kind, n.before]),
        angle
      ).toEqual([['removed', 'pov']])
    }
  })

  it('R8 구도 — P 의 penis focus 를 뺀다, 하는쪽 칸의 head out of frame·lower body 는 캐릭터 칸에서', () => {
    expect(rw('penis focus, kiss').prompt).toBe('kiss')
    // 남자 시점 씬이어야 한다 (음경 행위 태그가 있음)
    const state = rw('handjob').state
    const c = rewriteCharTexts(
      plan(1, 1),
      { source: 'head out of frame, lower body, smile', target: 'head out of frame' },
      { index: 0, name: '카드', role: 'source', hasGirl: true },
      state
    )
    expect(c.texts.source).toBe('smile')
    // 당하는쪽 칸의 head out of frame 은 하는쪽만 뺀다는 규칙이라 그대로
    expect(c.texts.target).toBe('head out of frame')
  })

  it('R10 중복 — 카드에 large penis 가 있으면 씬의 large penis 를 뺀다', () => {
    expect(rw('large penis, kiss', plan(1, 1, 0, true, true)).prompt).toBe('kiss')
    expect(rw('large penis, kiss').prompt).toBe('large penis, kiss')
  })

  it('R11 접두 표정은 경고만 — 안 바꾼다', () => {
    const r = rw('girl blush, she trembling, girl on top, kiss')
    expect(r.prompt).toBe('girl blush, she trembling, girl on top, kiss')
    const kept = r.notes.filter((n) => n.kind === 'kept')
    expect(kept.map((n) => n.before)).toEqual(['girl blush', 'she trembling'])
  })

  it('R12 유지 — 음수 가중치와 Text: 꼬리, 주석', () => {
    const r = rw('1girl, 1boy, hetero, -2::1boy, male::, # 1boy 는 주석\nText: "hetero 1boy"')
    expect(r.prompt).toBe(
      '2girls, futa with female, -2::1boy, male::, # 1boy 는 주석\nText: "hetero 1boy"'
    )
  })

  it('R6 문장 — he/his/him/the man 을 the futanari 로, 못 바꾼 남성 낱말은 kept 로 알린다', () => {
    const r = rw(
      "in front of him, the man's hand on her head, a man stands behind her slowly and quietly in the dark room tonight, smile"
    )
    expect(r.prompt).toBe(
      "in front of the futanari, the futanari's hand on her head, a man stands behind her slowly and quietly in the dark room tonight, smile"
    )
    const kept = r.notes.filter((n) => n.kind === 'kept')
    expect(kept.map((n) => n.before)).toEqual([
      'a man stands behind her slowly and quietly in the dark room tonight'
    ])
  })

  it('R6 화면 밖·잘림·보임을 말하는 문장은 바꾸지 않고 안 바꿈으로 알린다 (후타를 잘라 내라는 뜻이 되지 않게)', () => {
    const sentences = [
      'his upper body cut off by the top of the frame',
      'of him only his hand on his cock and his hips behind her are visible',
      'the rest of him cut off',
      'his body otherwise cut off',
      'the man already gone',
      'His head out of frame'
    ]
    for (const s of sentences) {
      const r = rw(`${s}, smile`)
      expect(r.prompt, s).toBe(`${s}, smile`)
      const kept = r.notes.filter((n) => n.kind === 'kept')
      expect(
        kept.map((n) => n.before),
        s
      ).toEqual([s])
      expect(
        r.notes.filter((n) => n.kind !== 'kept'),
        s
      ).toEqual([])
    }
  })

  it('R6 바꾼 뒤에도 남성 낱말이 남는 문장은 치환 없이 안 바꿈만 남긴다 (바꿈과 못 바꿈이 같이 뜨지 않게)', () => {
    const s = 'the man pushes the boy and he smiles'
    const r = rw(s)
    expect(r.prompt).toBe(s)
    expect(r.notes.map((n) => n.kind)).toEqual(['kept'])
  })

  it('3인 이상은 girl 수로 센다 (후타 1 + 여 2 = 3girls)', () => {
    expect(rw('1girl, 1boy, hetero', plan(1, 2)).prompt).toBe('3girls, futa with female')
  })

  it('후타+후타는 futa with futa, 후타 혼자는 관계 태그 없이 hetero 만 뺀다', () => {
    expect(rw('1girl, 1boy, hetero', plan(2, 0)).prompt).toBe('2girls, futa with futa')
    expect(rw('1girl, 1boy, hetero', plan(1, 0)).prompt).toBe('1girl')
  })
})

describe('R8 구도 — 하는쪽 후타가 그려지면 씬 전체 글의 head out of frame 도 뺀다', () => {
  const src: FutaPlan = { ...plan(1, 1), sourceFuta: true }
  const rw = (prompt: string, p: FutaPlan = src): ReturnType<typeof rewriteSceneTexts> =>
    rewriteSceneTexts(p, { base: '', prompt })

  it('씬 글의 head out of frame 을 빼고 메모에 이유를 남긴다', () => {
    const r = rw('1girl, 1boy, hetero, head out of frame, pov, kiss')
    expect(r.prompt).toBe('2girls, futa with female, from side, kiss')
    const note = r.notes.find((n) => n.before === 'head out of frame')
    expect(note).toEqual({
      kind: 'removed',
      where: 'scene',
      before: 'head out of frame',
      reason: '하는쪽 후타의 얼굴이 보이게 씬 전체 글의 head out of frame 을 뺌'
    })
  })

  it('메인 프롬프트(3분할 포함)의 head out of frame 도 같다 — 메모의 위치는 main', () => {
    const r = rewriteSceneTexts(src, {
      base: '',
      parts: { base: '1girl, masterpiece', additional: 'head out of frame', detail: 'hetero' },
      prompt: '1boy, kiss'
    })
    expect(r.parts?.additional).toBe('')
    expect(r.notes.find((n) => n.before === 'head out of frame')?.where).toBe('main')
  })

  it('가중치 묶음 안이면 그 태그만 뺀다 (가중치 숫자는 그대로, 비면 묶음째)', () => {
    expect(rw('1boy, hetero, 1.2::head out of frame, sweat::, kiss').prompt).toBe(
      'futa with female, 1.2::sweat::, kiss'
    )
    expect(rw('1boy, hetero, 1.2::head out of frame::, kiss').prompt).toBe('futa with female, kiss')
  })

  it('하는쪽 후타가 아니면 그대로 — 당하는쪽·역할 없음·옛 계획(sourceFuta 없음)', () => {
    const text = '1girl, 1boy, hetero, head out of frame, pov, kiss'
    const keep = '2girls, futa with female, head out of frame, from side, kiss'
    expect(rw(text, plan(1, 1)).prompt).toBe(keep)
    expect(rw(text, { ...plan(1, 1), sourceFuta: false }).prompt).toBe(keep)
  })

  it('시점·구도 정리를 끄면 그대로, 남자가 같이 그려져도 그대로', () => {
    expect(rw('1boy, hetero, head out of frame, kiss', { ...src, viewFix: false }).prompt).toBe(
      'futa with female, head out of frame, kiss'
    )
    const withMale: FutaPlan = { ...plan(1, 0, 1), sourceFuta: true }
    expect(rw('1girl, 1boy, hetero, head out of frame, kiss', withMale).prompt).toBe(
      '1girl, 1boy, futa with male, head out of frame, kiss'
    )
  })

  it('남자 시점 씬이 아니면(입맞춤 등) 그대로 — 다른 시점·구도 정리와 같은 조건', () => {
    expect(rw('1girl, head out of frame, imminent kiss').prompt).toBe(
      '1girl, head out of frame, imminent kiss'
    )
  })

  it('다른 구도 태그와 문장은 건드리지 않는다 — lower body 는 씬 글에서 그대로, 화면 밖 문장은 안 바꿈', () => {
    const r = rw('1boy, hetero, lower body, His head out of frame, kiss')
    expect(r.prompt).toBe('futa with female, lower body, His head out of frame, kiss')
    expect(r.notes.filter((n) => n.kind === 'kept').map((n) => n.before)).toEqual([
      'His head out of frame'
    ])
  })

  it('하는쪽 칸의 head out of frame 은 이 값과 상관없이 뺀다 (예전과 같음)', () => {
    const state = rw('handjob').state
    for (const p of [plan(1, 1), src]) {
      const c = rewriteCharTexts(
        p,
        { source: 'head out of frame, smile' },
        { index: 0, name: '카드', role: 'source', hasGirl: true },
        state
      )
      expect(c.texts.source).toBe('smile')
    }
  })

  it('멱등 — 같은 계획으로 다시 적용해도 결과가 같고 새 메모가 없다', () => {
    const once = rw('1girl, 1boy, hetero, head out of frame, pov, penis focus, kiss')
    const twice = rw(once.prompt)
    expect(twice.prompt).toBe(once.prompt)
    expect(twice.notes.filter((n) => n.kind !== 'kept')).toEqual([])
  })
})

describe('후타+남 — 남자는 그려지니 hetero 만 바꾼다', () => {
  it('hetero → futa with male, 1boy·male 구절·pov 는 그대로', () => {
    const r = rewriteSceneTexts(plan(1, 0, 1), {
      base: '',
      prompt: '1girl, 1boy, hetero, male head between female thighs, pov, testicles'
    })
    expect(r.prompt).toBe(
      '1girl, 1boy, futa with male, male head between female thighs, pov, testicles'
    )
    expect(r.notes).toHaveLength(1)
  })

  it('캐릭터 칸 글도 바꾸지 않는다', () => {
    const state = { relation: true, fromSide: false }
    const c = rewriteCharTexts(
      plan(1, 0, 1),
      { source: '1boy, male, faceless male', slot: 'pov' },
      { index: 0, name: '남', role: 'source', hasGirl: false },
      state
    )
    expect(c.texts).toEqual({ source: '1boy, male, faceless male', slot: 'pov' })
    expect(c.notes).toEqual([])
  })
})

describe('캐릭터 칸 글 (rewriteCharTexts)', () => {
  const who = { index: 1, name: '후타', role: 'source' as const, hasGirl: true }
  const state = (): { relation: boolean; fromSide: boolean } => ({
    relation: true,
    fromSide: false
  })

  it("R1' 하는쪽 칸의 1boy·male 을 빼고, 카드에 girl 이 없으면 1girl 로", () => {
    const a = rewriteCharTexts(
      plan(1, 1),
      { source: '1boy, male, faceless male, smile' },
      who,
      state()
    )
    expect(a.texts.source).toBe('faceless female, smile')
    const b = rewriteCharTexts(
      plan(1, 1),
      { source: '1boy, male, smile' },
      { ...who, hasGirl: false },
      state()
    )
    expect(b.texts.source).toBe('1girl, smile')
    expect(b.notes[0]).toEqual(
      expect.objectContaining({ kind: 'replaced', where: 'source', charIndex: 1, name: '후타' })
    )
  })

  it('pov 의 from side 는 캐릭터마다 겹쳐 붙지 않는다', () => {
    const s = { ...state(), viewScene: true }
    const first = rewriteCharTexts(plan(1, 1), { slot: 'pov' }, who, s)
    const second = rewriteCharTexts(plan(1, 1), { slot: 'pov hands' }, who, s)
    expect(first.texts.slot).toBe('from side')
    expect(second.texts.slot).toBe('')
  })

  it('자리·캐릭터·상대 태그도 같은 규칙으로 바뀐다', () => {
    const c = rewriteCharTexts(
      plan(1, 1),
      { slot: 'male pubic hair, close-up', char: 'testicles, smile', partner: 'looking at male' },
      who,
      state()
    )
    expect(c.texts).toEqual({
      slot: 'close-up',
      char: 'smile',
      partner: 'looking at another'
    })
  })
})

// ── 불변식 ───────────────────────────────────────────────

/** 합성 씬 묶음 — 실제 씬에 나오는 모양(조합·표기)을 지어낸 글로. 실존 단보루 태그만 쓴다 */
const SYNTHETIC: string[] = [
  '1girl, 1boy, hetero, kiss',
  '1girl, 1boy, hetero, standing, from behind',
  'hetero, fellatio',
  '1girl, 1boy, fellatio, 3::pov, penis focus::',
  '1girl, solo focus, hetero, male focus, sweat',
  '1girl, 1boy, -2::multiple boys::, hetero',
  '2::peach skin male, nude male, faceless male::, hetero, 1girl',
  "hetero, another's male hand, looking at male, pov hands",
  '1girl, 1boy, hetero, sucking testicles, large penis',
  '1girl, solo, kiss',
  '1girl, 1boy, hetero, "hetero said", Text: "1boy"',
  '1girl, hetero, in front of him, his hard cock, He holds her waist',
  '3::1boy, hetero::, 1girl, # 1boy 는 주석\nsweat',
  '1girl, 1boy, hetero, <outfit>, (1boy/2boys), smile',
  '1boy, hetero, disembodied hand, from side',
  'multiple boys, 1girl, hetero, girl blush',
  '1girl, 1boy, hetero, head out of frame, pov, fellatio',
  '1girl, hetero, 2::head out of frame, lower body::, sweat'
]

describe('불변식 — 몰래 바꾸기 금지 · 멱등', () => {
  const plans = [
    plan(1, 1),
    plan(1, 0),
    plan(2, 0),
    plan(1, 2),
    plan(1, 1, 0, false, true),
    { ...plan(1, 1), sourceFuta: true }
  ]

  it('치환 전후의 태그 차이는 전부 메모에 있다', () => {
    for (const p of plans) {
      for (const text of SYNTHETIC) {
        const r = rewriteSceneTexts(p, { base: '', prompt: text })
        const { removed, added } = diff(text, r.prompt)
        // 메모가 말하는 뺀 것·더한 것 (문장 바꿈은 통째로 한 태그라 before/after 가 그 토막이다)
        const noted = {
          removed: r.notes
            .filter((n) => n.kind === 'removed' || n.kind === 'replaced')
            .flatMap((n) =>
              tagsOf(n.before ?? '').concat(
                n.before && tagsOf(n.before).length === 0 ? [n.before] : []
              )
            ),
          added: r.notes
            .filter((n) => n.kind === 'added' || n.kind === 'replaced')
            .flatMap((n) => tagsOf(n.after ?? ''))
        }
        for (const t of removed) expect(noted.removed, `${text} / 뺌 ${t}`).toContain(t)
        for (const t of added) expect(noted.added, `${text} / 더함 ${t}`).toContain(t)
        // 메모마다 한국어 한 줄 이유가 있다
        for (const n of r.notes) expect(n.reason, text).toMatch(/[가-힣]/)
      }
    }
  })

  it('같은 글에 두 번 적용해도 결과가 같다', () => {
    for (const p of plans) {
      for (const text of SYNTHETIC) {
        const once = rewriteSceneTexts(p, { base: '', prompt: text })
        const twice = rewriteSceneTexts(p, { base: '', prompt: once.prompt })
        expect(twice.prompt, text).toBe(once.prompt)
        expect(
          twice.notes.filter((n) => n.kind !== 'kept'),
          text
        ).toEqual([])
      }
    }
  })

  it('남성 선언이 하나도 없는 글은 한 글자도 바뀌지 않는다', () => {
    for (const text of ['1girl, solo, kiss', 'smile, blue eyes # 메모', '']) {
      const r = rewriteSceneTexts(plan(1, 1), { base: '', prompt: text })
      expect(r.prompt).toBe(text)
      expect(r.notes).toEqual([])
    }
  })

  it('3분할도 같다 — 어느 칸에 남성 선언이 있든 1girl 은 합치고 관계 태그는 하나만', () => {
    const r = rewriteSceneTexts(plan(1, 1), {
      base: '',
      parts: { base: '1girl, masterpiece', additional: 'hetero', detail: 'best quality' },
      prompt: '1boy, kiss'
    })
    expect(r.parts).toEqual({
      base: '2girls, masterpiece',
      additional: 'futa with female',
      detail: 'best quality'
    })
    expect(r.prompt).toBe('kiss')
    const all = [r.parts?.base, r.parts?.additional, r.parts?.detail, r.prompt].join(', ')
    expect(tagsOf(all).filter((t) => t === 'futa with female')).toHaveLength(1)
    // 메인 글의 변경은 where 'main', 씬 글의 변경은 where 'scene'
    expect(r.notes.filter((n) => n.where === 'main').length).toBeGreaterThan(0)
    expect(r.notes.filter((n) => n.where === 'scene').length).toBeGreaterThan(0)
  })

  it('rewriteRequestPrompt — 바뀐 게 없으면 요청 객체 그대로', () => {
    const req = { prompt: '1girl, kiss' }
    expect(rewriteRequestPrompt(plan(1, 1), req).request).toBe(req)
    const changed = rewriteRequestPrompt(plan(1, 1), { prompt: '1girl, 1boy, hetero' })
    expect(changed.request.prompt).toBe('2girls, futa with female')
    const split = rewriteRequestPrompt(plan(1, 1), {
      prompt: 'x',
      promptParts: { base: '1girl, 1boy', additional: '', detail: 'hetero' }
    })
    expect(split.request.promptParts).toEqual({
      base: '2girls',
      additional: '',
      detail: 'futa with female'
    })
    expect(split.request.prompt).toBe('2girls, futa with female')
  })
})

// ── 5) refreshScenePrompts 가 치환을 다시 적용한다 ──────────────

describe('실행 직전 재합성 (refreshScenePrompts)', () => {
  const futaPlan = plan(1, 1)
  const baseRequest = (extra: Partial<GenerationRequest> = {}): GenerationRequest =>
    ({
      prompt: '',
      negativePrompt: '',
      model: 'nai-diffusion-5-full',
      width: 832,
      height: 1216,
      steps: 28,
      cfgScale: 5,
      cfgRescale: 0,
      sampler: 'k_euler_ancestral',
      noiseSchedule: 'karras',
      seed: 1,
      variety: false,
      qualityToggle: false,
      ucPreset: 0,
      characterPrompts: [],
      useCoords: false,
      sceneId: 1,
      sceneBasePrompt: 'masterpiece',
      sceneBaseNegativePrompt: '',
      ...extra
    }) as GenerationRequest

  const scene = { prompt: '1girl, 1boy, hetero, pov', negativePrompt: '' }

  it('계획이 없으면 예전과 똑같이 원본 씬 글로 합친다', () => {
    const r = refreshScenePrompts(baseRequest(), scene)
    expect(r.prompt).toBe('masterpiece, 1girl, 1boy, hetero, pov')
    expect('bodyNotes' in r).toBe(false)
  })

  it('계획이 있으면 씬 글에 같은 치환을 다시 적용한다 — 조립 때와 같은 결과', () => {
    const built = scenePositivePrompt('masterpiece', scene, undefined, undefined, futaPlan)
    expect(built.prompt).toBe('masterpiece, 2girls, futa with female, from side')
    const queued = baseRequest({ futaPlan, prompt: built.prompt, bodyNotes: built.bodyNotes })
    const refreshed = refreshScenePrompts(queued, scene)
    expect(refreshed.prompt).toBe(built.prompt)
    // 두 번 해도 같다
    expect(refreshScenePrompts(refreshed, scene).prompt).toBe(built.prompt)
    expect(refreshScenePrompts(refreshed, scene).bodyNotes).toEqual(refreshed.bodyNotes)
  })

  it('예약 뒤에 씬 글을 고쳐도 고친 글에 치환이 적용된다', () => {
    const queued = baseRequest({ futaPlan })
    const edited = { ...scene, prompt: '1girl, hetero, fellatio' }
    const r = refreshScenePrompts(queued, edited)
    expect(r.prompt).toBe('masterpiece, 2girls, futa with female, fellatio')
    // 메모도 새 글에 맞게 바뀐다
    expect(r.bodyNotes?.some((n) => n.after === '2girls')).toBe(true)
    expect(r.bodyNotes?.some((n) => n.before === 'pov')).toBe(false)
  })

  it('캐릭터 칸 메모는 조립 때 것을 지킨다 (메인·씬 메모만 새로)', () => {
    const charNote: BodyNote = {
      kind: 'added',
      where: 'char',
      charIndex: 0,
      after: 'no testicles',
      reason: '이유'
    }
    const queued = baseRequest({
      futaPlan,
      bodyNotes: [{ kind: 'removed', where: 'scene', before: 'stale', reason: '옛 메모' }, charNote]
    })
    const r = refreshScenePrompts(queued, scene)
    expect(r.bodyNotes).toContainEqual(charNote)
    expect(r.bodyNotes?.some((n) => n.before === 'stale')).toBe(false)
  })

  it('3분할을 쓰는 요청도 같다', () => {
    const parts = { base: '1girl', additional: '', detail: 'detail' }
    const queued = baseRequest({
      futaPlan,
      promptParts: parts,
      sceneBasePromptParts: parts,
      sceneBaseAdditionalPrompt: ''
    })
    // 메인 칸의 1girl 도 씬 글의 남성 선언을 보고 합친다
    const r = refreshScenePrompts(queued, { ...scene, prompt: '1boy, hetero, pov' })
    expect(r.promptParts).toEqual({
      base: '2girls',
      additional: '',
      detail: 'detail, futa with female, from side'
    })
    expect(r.prompt).toBe('2girls, detail, futa with female, from side')
  })
})

// ── 몸에 맞춰 더하는 태그 ───────────────────────────────────

describe('몸에 맞춘 태그 (no testicles · pink nipples)', () => {
  const read = (role: 'source' | 'target' | null, card: string, futaOn = true): BodyReading =>
    readBody(role, [card], futaOn)
  // pinkNipples 는 설정 「알몸일 때 pink nipples」 — 기본 꺼짐이라, 아래 시험은 켠 채 시험하고 끈 경우는 맨 아래 시험이 맡는다
  const tagsFor = (
    reading: BodyReading,
    nude: boolean,
    texts: string[],
    futaOn = true,
    pinkNipples = true
  ): string[] =>
    bodyTagsFor({ reading, futaOn, pinkNipples, nude, texts, index: 0, name: '카드' }).tags

  it('후타에 고환 유형 태그가 없으면 no testicles 를 더한다', () => {
    const r = read('source', '1girl, futanari')
    expect(tagsFor(r, false, ['1girl, futanari'])).toEqual(['no testicles'])
  })

  it('고환 유형이 정해져 있으면 더하지 않는다', () => {
    for (const card of [
      '1girl, futanari, no testicles',
      '1girl, futanari, testicles',
      'full-package futanari',
      'futa without pussy',
      'futa without balls'
    ])
      expect(tagsFor(read('source', card), false, [card]), card).toEqual([])
    // 씬 태그에 있어도 같다
    expect(hasTesticleType(['1girl, futanari', 'large testicles'])).toBe(true)
  })

  it('후타가 아니면 no testicles 는 없다. 재조립을 끄면 후타 판정도 없다', () => {
    expect(tagsFor(read('target', '1girl'), false, ['1girl'])).toEqual([])
    expect(
      tagsFor(read('source', '1girl, futanari', false), false, ['1girl, futanari'], false)
    ).toEqual([])
  })

  it('pink nipples — 알몸인 여캐에', () => {
    const r = read('target', '1girl, blue eyes')
    expect(tagsFor(r, true, ['1girl, blue eyes, nude, completely nude'])).toEqual(['pink nipples'])
    // 알몸이 아니면 없다
    expect(tagsFor(r, false, ['1girl, blue eyes'])).toEqual([])
  })

  it('pink nipples — 하는쪽 후타(가슴이 여성 몸)에도 붙고, 후타는 no testicles 와 같이', () => {
    const r = read('source', '1girl, futanari')
    expect(tagsFor(r, true, ['1girl, futanari, nude'])).toEqual(['no testicles', 'pink nipples'])
  })

  it('pink nipples — 남캐는 제외 (역할이 하는쪽이거나 카드에 남자 태그가 있으면)', () => {
    expect(tagsFor(read('source', '1boy'), true, ['1boy, nude'])).toEqual([])
    expect(tagsFor(read('target', '1boy'), true, ['1boy, nude'])).toEqual([])
    expect(tagsFor(read(null, '1boy, muscular'), true, ['1boy, nude'])).toEqual([])
    // 하는쪽 역할이어도 여성 카드(girl 이 있고 남자 태그가 없음)는 몸 가슴이 여성이라 붙는다
    expect(tagsFor(read('source', '1girl'), true, ['1girl, nude'])).toEqual(['pink nipples'])
    // girl 도 남자 태그도 없는 하는쪽은 역할 기준 남캐다
    expect(tagsFor(read('source', 'red hair'), true, ['red hair, nude'])).toEqual([])
  })

  it('pink nipples — 카드에 유두 색 태그가 있으면 존중해 안 붙이고, 이미 있으면 중복하지 않는다', () => {
    const r = read('target', '1girl')
    for (const t of [
      'dark nipples',
      'puffy nipples, purple nipples',
      '-1::pink nipples::',
      'pink nipples'
    ])
      expect(tagsFor(r, true, [`1girl, nude, ${t}`]), t).toEqual([])
    // puffy nipples 는 색이 아니다
    expect(tagsFor(r, true, ['1girl, nude, puffy nipples'])).toEqual(['pink nipples'])
    // 가중치 묶음 속 색도 읽는다
    expect(tagsFor(r, true, ['1girl, 1.2::nude, brown nipples::'])).toEqual([])
  })

  it('pink nipples — 알몸 판정은 온몸 알몸 선언만 (naked towel 같은 것·topless 는 아니다)', () => {
    expect(declaresFullNude(['1girl, nude'])).toBe(true)
    expect(declaresFullNude(['1girl, completely nude'])).toBe(true)
    expect(declaresFullNude(['1girl, 1.2::nude, completely nude::'])).toBe(true)
    expect(declaresFullNude(['1girl, naked towel'])).toBe(false)
    expect(declaresFullNude(['1girl, topless'])).toBe(false)
    expect(declaresFullNude(['1girl, -1::nude::'])).toBe(false)
    expect(declaresFullNude(['1girl, # nude\nsmile'])).toBe(false)
    expect(wantsPinkNipples({ chestFemale: true, nude: true, texts: ['1girl'] })).toBe(true)
    expect(wantsPinkNipples({ chestFemale: false, nude: true, texts: ['1boy'] })).toBe(false)
  })

  it('메모 — 더한 태그마다 added 메모가 캐릭터 순서·이름과 함께 있다', () => {
    const r = read('source', '1girl, futanari')
    const out = bodyTagsFor({
      reading: r,
      futaOn: true,
      pinkNipples: true,
      nude: true,
      texts: ['1girl, futanari, nude'],
      index: 2,
      name: '후타 카드'
    })
    expect(out.notes.map((n) => [n.kind, n.where, n.charIndex, n.name, n.after])).toEqual([
      ['added', 'char', 2, '후타 카드', 'no testicles'],
      ['added', 'char', 2, '후타 카드', 'pink nipples']
    ])
    for (const n of out.notes) expect(n.reason).toMatch(/[가-힣]/)
  })

  it('설정 「알몸일 때 pink nipples」가 꺼져 있으면 알몸이어도 더하지 않고 메모도 없다 (no testicles 는 후타 재조립 몫)', () => {
    const girl = read('target', '1girl, blue eyes')
    const nudeTexts = ['1girl, blue eyes, nude, completely nude']
    expect(tagsFor(girl, true, nudeTexts, true, false)).toEqual([])
    expect(tagsFor(girl, true, nudeTexts, false, false)).toEqual([])
    // 하는쪽 후타: no testicles 는 그대로 붙고 pink nipples 만 빠진다
    const futa = read('source', '1girl, futanari')
    expect(tagsFor(futa, true, ['1girl, futanari, nude'], true, false)).toEqual(['no testicles'])
    expect(tagsFor(futa, true, ['1girl, futanari, nude'], true, true)).toEqual([
      'no testicles',
      'pink nipples'
    ])
    const off = bodyTagsFor({
      reading: girl,
      futaOn: true,
      pinkNipples: false,
      nude: true,
      texts: nudeTexts,
      index: 0,
      name: '카드'
    })
    expect(off).toEqual({ tags: [], notes: [] })
    // 켜면 지금과 똑같이 붙는다
    expect(tagsFor(girl, true, nudeTexts, true, true)).toEqual(['pink nipples'])
  })
})
