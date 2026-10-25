import { describe, expect, it } from 'vitest'
import type { BodyNote, ExposeNote } from '../src/shared/types'
import {
  BODY_ATTENTION,
  KIND_META,
  WHERE_LABEL,
  bodyCharBadge,
  bodyCounts,
  bodyNoteLine,
  bodyNotesOfChar,
  bodySummaryText,
  futaCardsOff,
  groupBodyRounds,
  isEyeNote,
  isFutaNote,
  isPinkNote,
  mergeBodyRows,
  mergedBodyCounts,
  opensByDefault,
  placeLabel
} from '../src/renderer/src/lib/body-notes'

/**
 * 몸·후타 자동 재조립 화면 도우미 — 요청에 실려 온 메모(BodyNote)를 이름 붙이고 묶는 순수 함수.
 * 합성 메모·실존 단보루 태그와 지어낸 문장만 쓴다 (사용자 데이터 없음).
 */

const note = (n: Partial<BodyNote> & Pick<BodyNote, 'kind' | 'where'>): BodyNote => ({
  reason: '합성 이유',
  ...n
})

const replaced = (where: BodyNote['where'], before: string, after: string): BodyNote =>
  note({ kind: 'replaced', where, before, after, reason: `${before} 를 후타 구성에 맞게 바꿈` })

const pink = (charIndex: number, name: string): BodyNote =>
  note({
    kind: 'added',
    where: 'char',
    charIndex,
    name,
    after: 'pink nipples',
    evidence: '사용자 실측',
    reason: '알몸이고 가슴이 여성이라 더함'
  })

describe('종류 이름', () => {
  it('종류 7가지 모두 정해진 한국어 이름이 있다', () => {
    expect(Object.fromEntries(Object.entries(KIND_META).map(([k, v]) => [k, v.label]))).toEqual({
      replaced: '바꿈',
      removed: '뺌',
      added: '더함',
      kept: '안 바꿈',
      unreadable: '못 읽음',
      suspect: '후타 의심',
      conflict: '충돌'
    })
    expect(WHERE_LABEL).toEqual({
      main: '메인',
      scene: '씬',
      source: '하는쪽 칸',
      target: '당하는쪽 칸',
      slot: '자리',
      char: '캐릭터'
    })
  })

  it('이름과 설명에 「당신」이 없고 설명은 비어 있지 않다', () => {
    for (const meta of Object.values(KIND_META)) {
      expect(meta.hint.length).toBeGreaterThan(5)
      expect(meta.label + meta.hint).not.toContain('당신')
    }
  })

  it('눈여겨볼 종류는 충돌·후타 의심·못 읽음이다', () => {
    expect([...BODY_ATTENTION].sort()).toEqual(['conflict', 'suspect', 'unreadable'])
  })
})

describe('위치 이름', () => {
  it('캐릭터를 모르는 메모는 메인·씬 같은 위치 이름만', () => {
    expect(placeLabel(note({ kind: 'removed', where: 'main' }))).toBe('메인')
    expect(placeLabel(note({ kind: 'removed', where: 'scene' }))).toBe('씬')
  })

  it('캐릭터 칸이면 이름을 앞에 둔다. 이름이 없으면 순서로 부른다', () => {
    expect(placeLabel(note({ kind: 'removed', where: 'source', name: '합성 카드 A' }))).toBe(
      '합성 카드 A · 하는쪽 칸'
    )
    expect(placeLabel(note({ kind: 'removed', where: 'char', name: '합성 카드 A' }))).toBe(
      '합성 카드 A'
    )
    expect(placeLabel(note({ kind: 'removed', where: 'target', charIndex: 1 }))).toBe(
      '캐릭터 2 · 당하는쪽 칸'
    )
    expect(placeLabel(note({ kind: 'removed', where: 'char', charIndex: 0, name: '  ' }))).toBe(
      '캐릭터 1'
    )
  })

  it('같은 카드가 두 자리에 앉아 이름이 겹치면 몇 번째인지 붙여 가른다', () => {
    const dup = new Set(['합성 카드 A'])
    expect(
      placeLabel(note({ kind: 'removed', where: 'source', name: '합성 카드 A', charIndex: 1 }), dup)
    ).toBe('합성 카드 A #2 · 하는쪽 칸')
    // 겹치지 않는 이름은 그대로
    expect(
      placeLabel(note({ kind: 'removed', where: 'char', name: '합성 카드 B', charIndex: 1 }), dup)
    ).toBe('합성 카드 B')
    const rows = mergeBodyRows([
      note({
        kind: 'added',
        where: 'char',
        name: '합성 카드 A',
        charIndex: 0,
        after: 'no testicles'
      }),
      note({
        kind: 'added',
        where: 'char',
        name: '합성 카드 A',
        charIndex: 1,
        after: 'no testicles'
      })
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].places).toEqual(['합성 카드 A #1', '합성 카드 A #2'])
  })
})

describe('메모 한 줄', () => {
  it('바꿈은 이전 → 이후, 더함은 +이후, 근거와 이유가 따라온다', () => {
    expect(
      bodyNoteLine(
        note({
          kind: 'replaced',
          where: 'scene',
          before: 'hetero',
          after: 'futa with female',
          evidence: '1boy',
          reason: '관계 태그를 후타 구성으로'
        })
      )
    ).toBe('씬 · 바꿈 hetero → futa with female (근거 1boy) — 관계 태그를 후타 구성으로')
    expect(bodyNoteLine(pink(0, '합성 카드 A'))).toBe(
      '합성 카드 A · 더함 +pink nipples (근거 사용자 실측) — 알몸이고 가슴이 여성이라 더함'
    )
    expect(bodyNoteLine(note({ kind: 'removed', where: 'main', before: '1boy', reason: '' }))).toBe(
      '메인 · 뺌 1boy'
    )
  })
})

describe('메모 묶기', () => {
  const notes: BodyNote[] = [
    note({ kind: 'kept', where: 'scene', before: 'leaning against him', reason: '문장 속 him' }),
    replaced('target', 'faceless male', 'faceless female'),
    replaced('source', 'faceless male', 'faceless female'),
    replaced('scene', 'hetero', 'futa with female'),
    note({ kind: 'removed', where: 'scene', before: '1boy' }),
    pink(1, '합성 카드 B')
  ]

  it('같은 바뀜이 여러 곳이면 위치만 모아 한 줄이 된다', () => {
    const rows = mergeBodyRows(notes)
    const merged = rows.find((r) => r.note.before === 'faceless male')
    expect(merged?.places).toEqual(['하는쪽 칸', '당하는쪽 칸'])
    expect(merged?.members).toHaveLength(2)
  })

  it('바뀐 것이 먼저, 그대로 둔 것은 맨 아래다', () => {
    expect(mergeBodyRows(notes).map((r) => r.note.kind)).toEqual([
      'replaced',
      'replaced',
      'removed',
      'added',
      'kept'
    ])
  })

  it('불변식: 줄에 묶인 메모를 모두 합치면 들어온 메모 전부다 (몰래 숨기는 메모가 없다)', () => {
    const rows = mergeBodyRows(notes)
    expect(rows.reduce((sum, r) => sum + r.members.length, 0)).toBe(notes.length)
    expect(mergeBodyRows([])).toEqual([])
  })
})

describe('판정 보조', () => {
  it('pink nipples 더함만 따로 센다 (여캐도 받는 고정 규칙)', () => {
    expect(isPinkNote(pink(0, 'A'))).toBe(true)
    expect(
      isPinkNote(note({ kind: 'added', where: 'char', after: 'nude, pink nipples, 1girl' }))
    ).toBe(true)
    // 가중치 묶음 안의 태그도 읽는다
    expect(
      isPinkNote(note({ kind: 'added', where: 'char', after: '1.2::nude, pink nipples::' }))
    ).toBe(true)
    expect(isPinkNote(note({ kind: 'added', where: 'char', after: 'no testicles' }))).toBe(false)
    expect(isPinkNote(note({ kind: 'replaced', where: 'char', after: 'pink nipples' }))).toBe(false)
    expect(isPinkNote(note({ kind: 'added', where: 'char', after: 'pink nipples ring' }))).toBe(
      false
    )
  })

  it('후타 메모는 pink nipples 와 눈여겨볼 종류를 뺀 것이다', () => {
    expect(isFutaNote(replaced('scene', 'hetero', 'futa with female'))).toBe(true)
    expect(isFutaNote(note({ kind: 'kept', where: 'scene', before: 'him' }))).toBe(true)
    expect(isFutaNote(pink(0, 'A'))).toBe(false)
    expect(isFutaNote(note({ kind: 'suspect', where: 'char', charIndex: 0 }))).toBe(false)
    expect(isFutaNote(note({ kind: 'conflict', where: 'char', charIndex: 0 }))).toBe(false)
    expect(isFutaNote(note({ kind: 'unreadable', where: 'char', charIndex: 0 }))).toBe(false)
  })
})

describe('한 줄 요약', () => {
  it('후타 명수 · 바꿈 · 더함 · pink nipples · 안 바꿈을 센다', () => {
    const notes: BodyNote[] = [
      note({ ...replaced('scene', '1boy', '2girls'), charIndex: 0, name: '합성 카드 A' }),
      replaced('scene', 'hetero', 'futa with female'),
      replaced('source', 'faceless male', 'faceless female'),
      note({ kind: 'kept', where: 'scene', before: 'leaning against him' }),
      note({ kind: 'kept', where: 'scene', before: 'his hard cock' }),
      note({
        kind: 'added',
        where: 'char',
        charIndex: 0,
        name: '합성 카드 A',
        after: 'no testicles'
      }),
      pink(0, '합성 카드 A')
    ]
    // 후타 명수는 요청의 재조립 계획이 알려 준다 (bodyCounts 의 둘째 인자)
    expect(bodySummaryText(notes)).toBe('바꿈 3 · 더함 1 · pink nipples 1 · 안 바꿈 2')
    expect(
      bodyCounts(notes, 1)
        .map((c) => c.label)
        .join(' · ')
    ).toBe('후타 1명 · 바꿈 3 · 더함 1 · pink nipples 1 · 안 바꿈 2')
  })

  it('후타 명수는 메모로 짐작하지 않는다 — 후타의 상대 여캐에 붙은 글 바꿈 메모는 후타가 아니다', () => {
    const partner = [
      note({
        ...replaced('target', 'looking at male', 'looking at another'),
        charIndex: 1,
        name: '여'
      })
    ]
    expect(bodyCounts(partner).map((c) => c.label)).toEqual(['바꿈 1'])
    expect(bodyCounts(partner, 1).map((c) => c.label)).toEqual(['후타 1명', '바꿈 1'])
  })

  it('요청이 그려지는 후타 수를 알려 주면 메모 개수와 상관없이 그 수를 쓴다', () => {
    const scene = [replaced('scene', 'hetero', 'futa with female')]
    expect(bodyCounts(scene, 2).map((c) => c.label)).toEqual(['후타 2명', '바꿈 1'])
    // 후타 수가 있으면 pink nipples 만 있어도 후타가 그려진다는 것을 알린다
    expect(bodyCounts([pink(1, '여캐')], 1).map((c) => c.label)).toEqual([
      '후타 1명',
      'pink nipples 1'
    ])
    // 메모가 없어도 후타가 그려지면 후타 칸은 있다 (「바꾼 것 없음」 줄이 이것을 쓴다)
    expect(bodyCounts([], 1).map((c) => c.label)).toEqual(['후타 1명'])
    // 0 이나 모르면 후타를 말하지 않는다
    expect(bodyCounts(scene, 0).map((c) => c.label)).toEqual(['바꿈 1'])
    expect(bodyCounts(scene, undefined).map((c) => c.label)).toEqual(['바꿈 1'])
  })

  it('후타가 없고 pink nipples 만 있으면 후타를 말하지 않는다', () => {
    expect(bodySummaryText([pink(0, 'A'), pink(1, 'B')])).toBe('pink nipples 2')
    expect(bodySummaryText([])).toBe('')
  })

  it('눈여겨볼 종류는 그대로 둔 것보다 앞에 오고 색으로 눈에 띈다', () => {
    const notes: BodyNote[] = [
      note({ kind: 'kept', where: 'scene', before: 'him' }),
      note({ kind: 'conflict', where: 'char', charIndex: 0, name: 'A' }),
      note({ kind: 'suspect', where: 'char', charIndex: 1, name: 'B' }),
      note({ kind: 'unreadable', where: 'char', charIndex: 2, name: 'C' })
    ]
    const counts = bodyCounts(notes)
    expect(counts.map((c) => c.label)).toEqual(['충돌 1', '후타 의심 1', '못 읽음 1', '안 바꿈 1'])
    expect(counts.find((c) => c.id === 'kept')?.loud).toBe(false)
    expect(counts.find((c) => c.id === 'conflict')?.loud).toBe(true)
  })
})

describe('처음 펼침', () => {
  it('바뀐 것이나 눈여겨볼 것이 있으면 펴고, pink nipples 만 있거나 그대로 둔 것뿐이면 접는다', () => {
    const open = (notes: BodyNote[]): boolean => opensByDefault(bodyCounts(notes))
    expect(open([replaced('scene', 'hetero', 'futa with female')])).toBe(true)
    expect(open([note({ kind: 'suspect', where: 'char', charIndex: 0, name: 'A' })])).toBe(true)
    expect(open([pink(0, 'A'), pink(1, 'B')])).toBe(false)
    expect(open([note({ kind: 'kept', where: 'scene', before: 'him' })])).toBe(false)
    expect(open([])).toBe(false)
  })

  it('못 읽음뿐이면 접힌 줄의 색으로 알리고 처음부터 펴지는 않는다 (조각을 쓰는 카드가 쓰이는 모든 씬에서 매번 열리지 않게)', () => {
    const only = bodyCounts([note({ kind: 'unreadable', where: 'char', charIndex: 0, name: 'A' })])
    expect(only.find((c) => c.id === 'unreadable')?.loud).toBe(true)
    expect(opensByDefault(only)).toBe(false)
    // 충돌·후타 의심은 여전히 편다
    expect(
      opensByDefault(
        bodyCounts([
          note({ kind: 'unreadable', where: 'char', charIndex: 0, name: 'A' }),
          note({ kind: 'conflict', where: 'char', charIndex: 1, name: 'B' })
        ])
      )
    ).toBe(true)
  })
})

describe('캐릭터 찾기', () => {
  const card = { id: 10, name: '합성 카드 A' }
  const body: BodyNote[] = [
    note({ kind: 'added', where: 'char', charIndex: 2, name: '다른 이름', after: 'no testicles' }),
    note({ kind: 'removed', where: 'source', name: '합성 카드 A', before: '1boy' }),
    note({ kind: 'removed', where: 'scene', before: '1boy' }),
    note({ kind: 'suspect', where: 'char', charIndex: 5, name: '합성 카드 B' })
  ]
  const expose: ExposeNote[] = [
    {
      charIndex: 2,
      charId: 10,
      name: '합성 카드 A',
      area: 'lower',
      status: 'nude',
      tags: [],
      garments: [],
      evidence: [],
      reason: ''
    }
  ]

  it('자동 젖힘 메모가 있으면 그 charIndex 로, 이름이 같으면 이름으로 찾는다', () => {
    expect(bodyNotesOfChar(body, card, expose)).toHaveLength(2)
    expect(bodyNotesOfChar(body, card)).toHaveLength(1)
  })

  it('메모에 카드 id 가 실려 있으면 이름이 같은 다른 카드와 섞이지 않는다', () => {
    const withId: BodyNote[] = [
      note({
        kind: 'added',
        where: 'char',
        charIndex: 0,
        charId: 10,
        name: '같은 이름',
        after: 'a'
      }),
      note({
        kind: 'added',
        where: 'char',
        charIndex: 1,
        charId: 11,
        name: '같은 이름',
        after: 'b'
      })
    ]
    expect(bodyNotesOfChar(withId, { id: 10, name: '같은 이름' }).map((n) => n.after)).toEqual([
      'a'
    ])
    expect(bodyNotesOfChar(withId, { id: 11, name: '같은 이름' }).map((n) => n.after)).toEqual([
      'b'
    ])
    // 자동 젖힘이 꺼져 있어도 id 로 찾는다
    expect(bodyNotesOfChar(withId, { id: 12, name: '같은 이름' })).toEqual([])
  })

  it('캐릭터를 모르는 메모와 이름이 비어 있는 메모는 어느 카드에도 붙지 않는다', () => {
    expect(bodyNotesOfChar(body, { id: 99, name: '' }, expose)).toEqual([])
    expect(bodyNotesOfChar(undefined, card, expose)).toEqual([])
  })
})

describe('캐릭터 배지', () => {
  it('후타 · 후타 의심 · 충돌 · pink nipples 를 가려내고 호버 글에 메모가 한 줄씩 있다', () => {
    const own = [
      note({ kind: 'added', where: 'char', charIndex: 0, name: 'A', after: 'no testicles' }),
      pink(0, 'A')
    ]
    // 후타인지는 부모가 계획으로 알려 준다 — 메모만으로는 후타 배지가 달리지 않는다
    const futa = bodyCharBadge(own, true)
    expect(futa).toMatchObject({ futa: true, pink: true, attention: [] })
    expect(futa.title.split('\n')).toHaveLength(3)
    expect(futa.title.startsWith('몸·후타\n')).toBe(true)
    expect(bodyCharBadge(own).futa).toBe(false)
    // 배지마다 자기 메모만 호버 글에 든다
    expect(futa.titleOf('pink').split('\n')).toHaveLength(2)
    expect(futa.titleOf('futa')).toContain('no testicles')
    expect(futa.titleOf('futa')).not.toContain('pink nipples')

    const weak = bodyCharBadge([note({ kind: 'suspect', where: 'char', charIndex: 1, name: 'B' })])
    expect(weak).toMatchObject({ futa: false, pink: false, attention: ['suspect'] })

    expect(
      bodyCharBadge([
        note({ kind: 'unreadable', where: 'char' }),
        note({ kind: 'conflict', where: 'char' })
      ]).attention
    ).toEqual(['conflict', 'unreadable'])
    expect(bodyCharBadge([]).title).toBe('')
  })
})

describe('눈 감음 메모 — 카드의 눈 외형 태그를 뺀 것', () => {
  const eye = (charIndex: number, name: string, before: string, charId = charIndex + 1): BodyNote =>
    note({
      kind: 'removed',
      where: 'char',
      topic: 'eyes',
      charIndex,
      charId,
      name,
      before,
      evidence: 'closed eyes',
      reason: '눈 감음 — 눈 색 뺌'
    })

  it('후타 메모와 따로 센다 — 후타 때문에 뺀 것과 섞이지 않고, 태그 수가 아니라 카드 수로 센다', () => {
    const notes = [
      eye(0, 'A', 'blue eyes'),
      eye(0, 'A', 'slit pupils'),
      eye(1, 'B', 'red eyes'),
      note({ kind: 'removed', where: 'scene', before: '1boy' })
    ]
    expect(isEyeNote(notes[0])).toBe(true)
    expect(isEyeNote(notes[3])).toBe(false)
    expect(bodyCounts(notes).map((c) => c.label)).toEqual(['뺌 1', '눈 감음 2명'])
    expect(
      bodyCounts([eye(0, 'A', 'blue eyes'), eye(0, 'A', 'slit pupils')]).map((c) => c.label)
    ).toEqual(['눈 감음 1명'])
    // 메모가 없으면 말하지 않는다
    expect(bodyCounts([]).map((c) => c.label)).toEqual([])
  })

  it('눈 감음만 있으면 처음부터 펴지 않고 접힌 줄의 색으로 알린다 (감은 눈 씬마다 매번 열리지 않게)', () => {
    const counts = bodyCounts([eye(0, 'A', 'blue eyes')])
    expect(counts.find((c) => c.id === 'eyes')).toMatchObject({ tone: 'ok', loud: false })
    expect(opensByDefault(counts)).toBe(false)
    // 후타 때문에 바뀐 것이 같이 있으면 평소처럼 편다
    expect(
      opensByDefault(
        bodyCounts([eye(0, 'A', 'blue eyes'), replaced('scene', 'hetero', 'futa with female')])
      )
    ).toBe(true)
  })

  it('후타 배지의 호버에는 들지 않고, 「눈 감음」 배지가 따로 달린다', () => {
    const own = [
      note({ kind: 'added', where: 'char', charIndex: 0, name: 'A', after: 'no testicles' }),
      eye(0, 'A', 'blue eyes'),
      eye(0, 'A', 'slit pupils')
    ]
    expect(isFutaNote(own[1])).toBe(false)
    const badge = bodyCharBadge(own, true)
    expect(badge).toMatchObject({ futa: true, pink: false, eyes: true, attention: [] })
    expect(badge.titleOf('futa')).toContain('no testicles')
    expect(badge.titleOf('futa')).not.toContain('blue eyes')
    const lines = badge.titleOf('eyes').split('\n')
    expect(lines[0]).toBe('눈 감음')
    expect(lines).toHaveLength(3)
    expect(lines.join('\n')).toContain('blue eyes')
    expect(lines.join('\n')).toContain('(근거 closed eyes)')
    expect(lines.join('\n')).toContain('눈 감음 — 눈 색 뺌')
    // 종류 배지(뺌)에는 눈 감음 메모가 들지 않는다
    expect(badge.titleOf('removed')).toBe('')
    expect(bodyCharBadge([eye(0, 'A', 'blue eyes')]).eyes).toBe(true)
    expect(bodyCharBadge([pink(0, 'A')]).eyes).toBe(false)
    expect(bodyCharBadge([]).eyes).toBe(false)
  })

  it('뺄 수 없어 둔 눈 외형은 「안 바꿈」으로 세고, 「눈 감음 N명」·배지는 실제로 뺀 카드만', () => {
    const kept = note({
      kind: 'kept',
      where: 'char',
      topic: 'eyes',
      charIndex: 0,
      charId: 1,
      name: 'A',
      before: '(blue eyes/red eyes)',
      evidence: 'closed eyes',
      reason:
        '눈 감음 — 눈 외형이 있으나 랜덤 선택지·와일드카드라 뽑힐 값을 미리 알 수 없어 그대로 둠'
    })
    expect(isEyeNote(kept)).toBe(true)
    expect(bodyCounts([kept]).map((c) => c.label)).toEqual(['안 바꿈 1'])
    expect(bodyCounts([kept, eye(1, 'B', 'blue eyes')]).map((c) => c.label)).toEqual([
      '눈 감음 1명',
      '안 바꿈 1'
    ])
    // 뺀 것이 없는 카드에는 「눈 감음」 배지를 달지 않는다 — 호버(안 바꿈)에는 보인다
    const badge = bodyCharBadge([kept])
    expect(badge.eyes).toBe(false)
    expect(badge.titleOf('kept')).toContain('(blue eyes/red eyes)')
    expect(isFutaNote(kept)).toBe(false)
    expect(opensByDefault(bodyCounts([kept]))).toBe(false)
  })

  it('같은 태그를 뺀 줄은 위치를 모아 한 줄로 보인다', () => {
    const rows = mergeBodyRows([eye(0, 'A', 'blue eyes'), eye(1, 'B', 'blue eyes')])
    expect(rows).toHaveLength(1)
    expect(rows[0].places).toEqual(['A', 'B'])
    expect(bodyNoteLine(eye(0, 'A', 'blue eyes'))).toBe(
      'A · 뺌 blue eyes (근거 closed eyes) — 눈 감음 — 눈 색 뺌'
    )
  })
})

describe('회차', () => {
  const a = [replaced('scene', 'hetero', 'futa with female'), pink(0, 'A')]
  const b = [replaced('scene', 'hetero', 'futa with female')]

  it('회차마다 결과가 같으면 한 묶음, 다르면 회차별로', () => {
    expect(groupBodyRounds([{ label: '기본', notes: a }])).toEqual([{ label: null, notes: a }])
    expect(
      groupBodyRounds([
        { label: '기본', notes: a },
        { label: '조합 2', notes: [...a] }
      ])
    ).toEqual([{ label: null, notes: a }])
    expect(
      groupBodyRounds([
        { label: '기본', notes: a },
        { label: '조합 2', notes: b }
      ]).map((g) => g.label)
    ).toEqual(['기본', '조합 2'])
  })

  it('회차마다 그려지는 후타 수가 다르면 따로 보인다', () => {
    expect(
      groupBodyRounds([
        { label: '기본', notes: b, futa: 1 },
        { label: '조합 2', notes: [...b], futa: 2 }
      ]).map((g) => [g.label, g.futa])
    ).toEqual([
      ['기본', 1],
      ['조합 2', 2]
    ])
    expect(
      mergedBodyCounts([
        { label: '기본', notes: b, futa: 1 },
        { label: '조합 2', notes: b, futa: 2 }
      ]).map((c) => c.label)
    ).toEqual(['후타 2명', '바꿈 1'])
  })

  it('여러 회차의 요약은 같은 조각의 가장 큰 값으로 합친다', () => {
    const merged = mergedBodyCounts([
      { notes: b },
      { notes: [...a, replaced('main', '1boy', '2girls')] }
    ])
    expect(merged.map((c) => c.label)).toEqual(['바꿈 2', 'pink nipples 1'])
  })
})

describe('후타 자동 재조립이 꺼져 있을 때', () => {
  it('요청에 실린 캐릭터 가운데 카드에 futanari 가 있는 카드 수를 센다 (같은 카드는 한 장)', () => {
    expect(
      futaCardsOff([
        { prompt: '1girl, futanari, long hair', name: '합성 카드 A' },
        { prompt: '1girl, red hair', name: '합성 카드 B' },
        { prompt: '1girl, futanari, long hair, close-up', name: '합성 카드 A' },
        { prompt: '1girl, 1boy, futanari', name: '합성 카드 C' }
      ])
    ).toBe(1)
    expect(futaCardsOff([{ prompt: '1girl' }])).toBe(0)
    expect(futaCardsOff(undefined)).toBe(0)
  })

  it('후타 카드가 있으면 요약이 「재조립 꺼짐」을 알린다 — 후타를 못 알아본 것과 구분된다', () => {
    expect(bodyCounts([], undefined, 2).map((c) => c.label)).toEqual([
      '후타 카드 2장 · 재조립 꺼짐'
    ])
    expect(bodyCounts([], undefined, 0)).toEqual([])
    // 회차 묶음에도 실린다
    expect(
      mergedBodyCounts(groupBodyRounds([{ label: '기본', notes: [], futaOff: 1 }])).map(
        (c) => c.label
      )
    ).toEqual(['후타 카드 1장 · 재조립 꺼짐'])
    // 눈에 띄는 색은 아니고 처음부터 펴지도 않는다
    expect(opensByDefault(bodyCounts([], undefined, 1))).toBe(false)
  })
})
