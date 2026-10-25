import { describe, expect, it } from 'vitest'
import { readBody, riskyWildcard, wantsPinkNipples } from '../src/shared/body'
import {
  flagNotes,
  mapTags,
  planFuta,
  rewriteCharTexts,
  rewriteSceneTexts
} from '../src/shared/futa'
import { engineTagsOf } from '../src/shared/auto-expose'
import type { FutaPlan } from '../src/shared/types'

/**
 * 후타 마무리 수정 시험 — 검수에서 나온 결함의 재발 방지 (합성 입력만).
 * 와일드카드 오탐 · 관계 태그 오독 · 근거 표시 · 계획에 실리는 카드 정보 · 깨진 :: · 역할 접두사 · 남자가 따로 있는 씬의 후타 칸
 */

const plan = (futa: number, female: number, male = 0, extra: Partial<FutaPlan> = {}): FutaPlan => ({
  counts: { futa, female, male },
  viewFix: true,
  dedupePenis: false,
  ...extra
})

describe('못 읽음 — 앱이 실제로 뽑는 와일드카드만', () => {
  it('얼굴 기호·작품명·공백 든 슬래시 같은 평범한 태그는 와일드카드가 아니다', () => {
    for (const card of [
      '1girl, adult, >_<, blush',
      '1girl, :>, ;<',
      '1girl, <3',
      '1girl, w/ hat',
      '1girl, artoria pendragon (fate), fate/grand order',
      '1girl, >_<, blush, >_<',
      '1girl, |_|',
      '1girl, {red hair}',
      '1girl, # <outfit> 는 주석'
    ]) {
      expect(riskyWildcard(card), card).toBeNull()
      expect(readBody('target', [card], true).flags, card).toEqual([])
    }
  })

  it('뽑힌 값에 후타가 들어올 수 있는 것만 알린다 — 조각 <이름>, 선택지에 후타가 든 것', () => {
    expect(riskyWildcard('1girl, <outfit>')).toBe('<outfit>')
    expect(riskyWildcard('1girl, <*의상/casual>')).toBe('<*의상/casual>')
    expect(riskyWildcard('1girl, (futanari/smile)')).toBe('(futanari/smile)')
    expect(riskyWildcard('1girl, <futanari|smile>')).toBe('<futanari|smile>')
    expect(riskyWildcard('1girl, futanari/solo')).toBe('futanari/solo')
    const r = readBody('target', ['1girl, <outfit>'], true)
    expect(r.flags).toEqual(['unreadable'])
    expect(r.evidence.unreadable).toBe('<outfit>')
  })

  it('선택지가 다 보이고 후타가 없으면 읽을 수 있다 — 알리지 않는다', () => {
    for (const card of [
      '1girl, <red|blue>',
      '1girl, (red/blue)',
      '1girl, short/long',
      '1girl, -1::<x>::'
    ])
      expect(riskyWildcard(card), card).toBeNull()
  })

  it('후타로 읽혔으면 와일드카드가 있어도 알리지 않는다', () => {
    expect(readBody('target', ['1girl, futanari, <outfit>'], true).flags).toEqual([])
  })
})

describe('후타 판정 — 관계 태그는 카드에서만 몸 신호', () => {
  it('자리·씬별 태그에 적은 futa with … / futa on … 는 상대와의 관계라 후타로 읽지 않는다', () => {
    expect(readBody('target', ['1girl', 'futa with female'], true).body.futa).toBe(false)
    expect(readBody('target', ['1girl', '', 'futa on male'], true).body.futa).toBe(false)
    // 카드에 있으면 몸 신호다
    expect(readBody('target', ['1girl, futa with female'], true).body.futa).toBe(true)
  })

  it('자리·씬별 태그의 futanari · futa without pussy 는 몸 신호다', () => {
    expect(readBody('target', ['1girl', 'futanari'], true).body.futa).toBe(true)
    expect(readBody('target', ['1girl', 'futa without pussy'], true).body.pussy).toBe(false)
  })
})

describe('하는쪽 역할의 여성 카드 — 사람 수와 가슴은 카드로 본다', () => {
  it('역할이 하는쪽이어도 카드가 girl 이고 남자 태그가 없으면 여성이다', () => {
    const girl = readBody('source', ['1girl, red hair'], true)
    expect(girl.chestFemale).toBe(true)
    // 역할 기준 성별(옷 벗기기 메뉴용)은 그대로다
    expect(girl.sex).toBe('male')
    expect(readBody('source', ['red hair'], true).chestFemale).toBe(false)
    expect(readBody('source', ['1boy, 1girl'], true).chestFemale).toBe(false)
  })

  it('후타 설정을 꺼도 몸 판정은 같다 (알몸 pink nipples 는 별도 설정)', () => {
    expect(readBody('source', ['1girl'], false).chestFemale).toBe(true)
  })

  it('pink nipples — 하는쪽 역할의 여성 카드도 붙고, 알몸이 아니면 안 붙는다', () => {
    const r = readBody('source', ['1girl'], true)
    expect(wantsPinkNipples({ chestFemale: r.chestFemale, nude: true, texts: ['1girl'] })).toBe(
      true
    )
    expect(wantsPinkNipples({ chestFemale: r.chestFemale, nude: false, texts: ['1girl'] })).toBe(
      false
    )
  })
})

describe('pink nipples — 유두 색을 정한 태그는 areola 색·colored 도 존중', () => {
  const want = (extra: string): boolean =>
    wantsPinkNipples({ chestFemale: true, nude: true, texts: [`1girl, nude, ${extra}`] })

  it('색을 정한 태그가 있으면 안 붙인다', () => {
    for (const t of [
      'dark areolae',
      'light areolae',
      'colored nipples',
      'brown areolae',
      'pink areolae',
      'light brown nipples'
    ])
      expect(want(t), t).toBe(false)
  })

  it('색이 아닌 꾸밈은 그대로 붙인다', () => {
    for (const t of ['puffy nipples', 'puffy areolae', 'large areolae'])
      expect(want(t), t).toBe(true)
  })
})

describe('충돌·의심 근거', () => {
  it('충돌은 후타 태그와 남자 태그를, 의심은 음경 태그를 근거로 보인다 (카드 id 도 실린다)', () => {
    const conflict = readBody('target', ['1boy, adult, futanari'], true)
    expect(conflict.evidence.conflict).toBe('futanari + 1boy')
    const suspect = readBody('target', ['1girl, large penis'], true)
    expect(suspect.evidence.suspect).toBe('large penis')
    expect(flagNotes(conflict, 2, '카드', 7)).toEqual([
      expect.objectContaining({
        kind: 'conflict',
        charIndex: 2,
        charId: 7,
        name: '카드',
        evidence: 'futanari + 1boy'
      })
    ])
    expect(flagNotes(suspect, 0, '카드')[0]).toEqual(
      expect.objectContaining({ kind: 'suspect', evidence: 'large penis' })
    )
    const wild = readBody('target', ['1girl, <outfit>'], true)
    expect(flagNotes(wild, 0, '카드')[0]).toEqual(
      expect.objectContaining({ kind: 'unreadable', evidence: '<outfit>' })
    )
  })
})

describe('계획에 실리는 카드 정보', () => {
  it('후타로 읽힌 카드의 순서·id·이름과 고환 유형을 싣는다 (없으면 키 자체가 없다)', () => {
    const p = planFuta(
      [
        { kind: 'female', index: 0, id: 11, name: '여' },
        { kind: 'futa', index: 1, id: 12, name: '후타', testicleType: true }
      ],
      true
    )
    expect(p).toEqual({
      counts: { futa: 1, female: 1, male: 0 },
      viewFix: true,
      dedupePenis: false,
      keepTesticles: true,
      chars: [{ index: 1, id: 12, name: '후타' }]
    })
    expect(planFuta([{ kind: 'futa' }, { kind: 'female' }], true)).toEqual({
      counts: { futa: 1, female: 1, male: 0 },
      viewFix: true,
      dedupePenis: false
    })
  })

  it('카드가 고환 유형을 정했으면 씬 글의 고환 태그를 빼지 않는다 (R5)', () => {
    const text = 'sucking testicles, smile'
    const cut = rewriteSceneTexts(plan(1, 1), { base: '', prompt: text })
    expect(cut.prompt).toBe('smile')
    const kept = rewriteSceneTexts(plan(1, 1, 0, { keepTesticles: true }), {
      base: '',
      prompt: text
    })
    expect(kept.prompt).toBe(text)
    expect(kept.notes).toEqual([])
  })
})

describe('mapTags — 깨진 :: 와 역할 접두사', () => {
  const swap = (text: string): ReturnType<typeof mapTags> =>
    mapTags(text, (t) =>
      t === 'lipstick mark on testicles'
        ? { after: '', reason: 'r' }
        : t === 'hetero'
          ? { after: 'futa with female', reason: 'r' }
          : null
    )

  it('가중치 짝이 맞지 않는 줄은 줄째 건드리지 않고 안 바꿈으로 알린다 (-2:: 억제가 사라지지 않고 쉼표도 끼지 않는다)', () => {
    const broken =
      'cum, hetero, lipstick mark on testicles::-2::multiple boys,cum::,-1::long penis::'
    const text = ['hetero, kiss', broken, '2::after fellatio, hetero::'].join('\n')
    const r = swap(text)
    // 깨진 줄은 글자 그대로
    expect(r.text.split('\n')[1]).toBe(broken)
    // 짝이 맞는 다른 줄은 바뀐다
    expect(r.text.split('\n')[0]).toBe('futa with female, kiss')
    expect(r.text.split('\n')[2]).toBe('2::after fellatio, futa with female::')
    expect(r.edits.map((e) => e.before)).toEqual(['hetero', 'hetero'])
    expect(r.kept.map((k) => k.reason).join()).toContain('::')
    // 짝이 맞는 줄만 있는 글은 예전과 같이 동작한다
    expect(swap('1girl, hetero').text).toBe('1girl, futa with female')
  })

  it('짝이 맞는 가중치 묶음은 여전히 안쪽만 바꾼다', () => {
    expect(swap('3::hetero, kiss::').text).toBe('3::futa with female, kiss::')
  })

  it('역할 접두사(source# · target# · mutual#)가 붙은 태그를 바꾸면 접두사를 이어 붙인다', () => {
    const r = mapTags('source#faceless male, target#hetero, smile', (t) =>
      t === 'faceless male'
        ? { after: 'faceless female', reason: 'r' }
        : t === 'hetero'
          ? { after: 'futa with female', reason: 'r' }
          : null
    )
    expect(r.text).toBe('source#faceless female, target#futa with female, smile')
    // 뺀 것은 접두사도 함께 빠진다
    const gone = mapTags('source#faceless male, smile', (t) =>
      t === 'faceless male' ? { after: '', reason: 'r' } : null
    )
    expect(gone.text).toBe('smile')
  })
})

describe('깨진 :: 가 든 씬 글', () => {
  it('가중치 표기(::)가 홀수인 글은 줄째 건드리지 않고, 더하는 관계 태그는 닫히지 않은 묶음 밖(글 앞)에 둔다', () => {
    const r = rewriteSceneTexts(plan(1, 1), { base: '', prompt: '1boy, 1girl, full body ::' })
    expect(r.prompt).toBe('futa with female, 1boy, 1girl, full body ::')
    expect(r.notes).toEqual([expect.objectContaining({ kind: 'added', after: 'futa with female' })])
    // 멀쩡한 글은 예전처럼 끝에 더한다
    expect(rewriteSceneTexts(plan(1, 1), { base: '', prompt: '1boy, fellatio' }).prompt).toBe(
      'fellatio, futa with female'
    )
  })
})

describe('남자가 따로 있는 씬 — 후타가 받은 칸 글만 남자 낱말을 정리한다', () => {
  const who = { index: 0, name: '후타', role: 'source' as const, hasGirl: true }
  const state = { relation: true, fromSide: false, viewScene: true, angle: false }
  const male = plan(1, 0, 1)

  it('후타 하는쪽 칸의 1boy · male · faceless male 을 정리한다 (한 줄에 모순된 girl + boy 를 두지 않는다)', () => {
    const r = rewriteCharTexts(
      male,
      { source: '1boy, male, faceless male, smile' },
      { ...who, futa: true, id: 5 },
      state
    )
    expect(r.texts.source).toBe('faceless female, smile')
    expect(r.notes.every((n) => n.charIndex === 0 && n.charId === 5 && n.where === 'source')).toBe(
      true
    )
    expect(r.notes.map((n) => n.kind)).toEqual(['removed', 'removed', 'replaced'])
  })

  it('후타가 아닌 캐릭터(남)가 받은 글은 그대로다', () => {
    const r = rewriteCharTexts(
      male,
      { source: '1boy, male, faceless male, smile' },
      { index: 1, name: '남', role: 'source', hasGirl: false },
      state
    )
    expect(r.texts.source).toBe('1boy, male, faceless male, smile')
    expect(r.notes).toEqual([])
  })

  it('후타가 받은 글이어도 서술·시점·고환·hetero 는 건드리지 않는다 (남자 몫일 수 있다)', () => {
    const text = "he smiles, pov, head out of frame, testicles, hetero, the man's hand"
    const r = rewriteCharTexts(male, { source: text }, { ...who, futa: true }, state)
    expect(r.texts.source).toBe(text)
  })

  it('1boy 를 지웠는데 카드에 girl 이 없으면 1girl 로 바꾼다', () => {
    const r = rewriteCharTexts(
      male,
      { source: '1boy, smile' },
      { ...who, futa: true, hasGirl: false },
      state
    )
    expect(r.texts.source).toBe('1girl, smile')
  })
})

describe('시점 정리는 남자 시점 씬에서만', () => {
  const rw = (prompt: string, p = plan(1, 1)): ReturnType<typeof rewriteSceneTexts> =>
    rewriteSceneTexts(p, { base: '', prompt })

  it('후타 혼자 씬의 입맞춤·무릎베개 pov 는 그대로다', () => {
    const solo = plan(1, 0)
    expect(rw('2.5::pov, imminent kiss::', solo).prompt).toBe('2.5::pov, imminent kiss::')
    expect(rw('3::pov, from_below, looking_up::, lap pillow', solo).prompt).toBe(
      '3::pov, from_below, looking_up::, lap pillow'
    )
  })

  it('남자 선언이 있으면 한다 — 같은 글에 앵글 태그가 있으면 pov 만 뺀다', () => {
    expect(rw('hetero, pov, kiss').prompt).toBe('futa with female, from side, kiss')
    const angled = rw('1boy, 1girl, pov, from behind, kiss')
    expect(engineTagsOf(angled.prompt)).not.toContain('from side')
    expect(engineTagsOf(angled.prompt)).toContain('from behind')
    expect(engineTagsOf(angled.prompt)).not.toContain('pov')
  })
})
