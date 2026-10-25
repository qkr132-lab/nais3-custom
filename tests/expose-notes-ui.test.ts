import { describe, expect, it } from 'vitest'
import type { ExposeNote } from '../src/shared/types'
import {
  AREA_LABEL,
  STATUS_META,
  attachedTags,
  autoAreasFromNotes,
  charBadge,
  displayReason,
  garmentsOf,
  groupByChar,
  groupRounds,
  isQuietNote,
  mergeRows,
  mergedCounts,
  noteLine,
  noteMeta,
  notesOfChar,
  readCardWear,
  statusCounts,
  summaryText
} from '../src/renderer/src/lib/expose-notes'

/**
 * 입은 옷 자동 젖힘 화면 도우미 — 요청에 실려 온 메모를 이름 붙이고 묶는 순수 함수.
 * 합성 메모·합성 태그만 쓴다 (사용자 데이터 없음).
 */

const note = (
  n: Partial<ExposeNote> & Pick<ExposeNote, 'charIndex' | 'area' | 'status'>
): ExposeNote => ({
  charId: null,
  name: '',
  tags: [],
  garments: [],
  evidence: [],
  reason: '',
  ...n
})

describe('상태 이름', () => {
  it('상태 13가지 모두 정해진 한국어 이름이 있다', () => {
    expect(Object.fromEntries(Object.entries(STATUS_META).map(([k, v]) => [k, v.label]))).toEqual({
      added: '붙음',
      already: '이미 있음',
      piece: '조각이 맡음',
      nude: '알몸',
      'over-clothes': '옷 위',
      'off-frame': '화면 밖',
      negated: '부정문',
      after: '섹스 뒤',
      'no-garment': '옷 못 읽음',
      unknown: '판단 못 함',
      conflict: '충돌',
      vetoed: '막음',
      'not-needed': '근거 없음'
    })
    expect(AREA_LABEL).toEqual({ lower: '아래', chest: '가슴' })
  })

  it('이름과 설명에 「당신」이 없고 설명은 비어 있지 않다', () => {
    for (const meta of Object.values(STATUS_META)) {
      expect(meta.hint.length).toBeGreaterThan(5)
      expect(meta.label + meta.hint).not.toContain('당신')
    }
  })
})

describe('메모 묶기', () => {
  const notes: ExposeNote[] = [
    note({ charIndex: 1, charId: 20, name: 'B', area: 'chest', status: 'unknown' }),
    note({
      charIndex: 0,
      charId: 10,
      name: 'A',
      area: 'chest',
      status: 'added',
      tags: ['shirt lift', 'bra lift'],
      garments: ['shirt', 'bra']
    }),
    note({
      charIndex: 0,
      charId: 10,
      name: 'A',
      area: 'lower',
      status: 'added',
      tags: ['skirt lift'],
      garments: ['skirt']
    }),
    note({ charIndex: 1, charId: 20, name: 'B', area: 'lower', status: 'not-needed' })
  ]

  it('그림에 나오는 순서로 캐릭터를 묶고 캐릭터 안에서는 아래가 가슴보다 먼저다', () => {
    const groups = groupByChar(notes)
    expect(groups.map((g) => [g.charIndex, g.name])).toEqual([
      [0, 'A'],
      [1, 'B']
    ])
    expect(groups[0].notes.map((n) => n.area)).toEqual(['lower', 'chest'])
  })

  it('붙은 태그는 붙음 메모에서만, 중복 없이 모은다', () => {
    expect(attachedTags(notes)).toEqual(['shirt lift', 'bra lift', 'skirt lift'])
    expect(attachedTags([...notes, notes[1]])).toEqual(['shirt lift', 'bra lift', 'skirt lift'])
    expect(
      attachedTags([note({ charIndex: 0, area: 'lower', status: 'vetoed', tags: ['skirt lift'] })])
    ).toEqual([])
  })

  it('붙음은 캐릭터마다 붙은 태그 수의 합(개)으로, 나머지는 그 상태가 있는 캐릭터 수(명)로 세고 요약에서 근거 없음은 뺀다', () => {
    expect(statusCounts(notes)).toEqual([
      { status: 'added', count: 3 },
      { status: 'unknown', count: 1 },
      { status: 'not-needed', count: 1 }
    ])
    expect(summaryText(notes)).toBe('붙음 3개 · 판단 못 함 1명')
    expect(summaryText([])).toBe('')
  })

  it('같은 태그가 두 캐릭터에 붙으면 둘 다 센다 — 캐릭터 배지의 「자동 +N」 합과 같다', () => {
    const two = [
      note({ charIndex: 0, area: 'lower', status: 'added', tags: ['skirt lift', 'panties aside'] }),
      note({ charIndex: 1, area: 'lower', status: 'added', tags: ['skirt lift'] }),
      note({ charIndex: 1, area: 'chest', status: 'nude' }),
      note({ charIndex: 1, area: 'lower', status: 'nude' })
    ]
    const sum = groupByChar(two).reduce((n, g) => n + charBadge(g.notes).added, 0)
    expect(statusCounts(two)).toContainEqual({ status: 'added', count: 3 })
    expect(sum).toBe(3)
    // 알몸은 부위가 둘이어도 한 명
    expect(statusCounts(two)).toContainEqual({ status: 'nude', count: 1 })
  })

  it('카드 id 로 한 캐릭터의 메모만 고른다 (없으면 빈 목록)', () => {
    expect(notesOfChar(notes, 20).map((n) => n.area)).toEqual(['chest', 'lower'])
    expect(notesOfChar(undefined, 20)).toEqual([])
    expect(notesOfChar(notes, 99)).toEqual([])
  })

  it('읽은 옷은 중복 없이 모은다', () => {
    expect(garmentsOf(notes)).toEqual(['shirt', 'bra', 'skirt'])
  })
})

describe('메모 한 줄과 캐릭터 배지', () => {
  it('붙은 태그는 + 로, 옷·근거·이유와 함께 한 줄로 쓴다', () => {
    const n = note({
      charIndex: 0,
      area: 'lower',
      status: 'added',
      tags: ['shorts pull'],
      garments: ['shorts'],
      evidence: ['sex'],
      reason: '삽입 행위'
    })
    expect(noteLine(n)).toBe('아래 · 붙음 +shorts pull (옷 shorts · 근거 sex) — 삽입 행위')
  })

  it('안 붙은 메모는 이유만 쓰고 태그에 + 를 달지 않는다', () => {
    const n = note({
      charIndex: 0,
      area: 'chest',
      status: 'over-clothes',
      evidence: ['stain'],
      tags: ['shirt lift'],
      reason: '옷 위: stain'
    })
    expect(noteLine(n)).toBe('가슴 · 옷 위 (근거 stain) — 옷 위: stain')
  })

  it('붙은 태그가 있으면 「자동 +N」, 충돌·판단 못 함·옷 못 읽음은 따로 알린다', () => {
    const badge = charBadge([
      note({ charIndex: 0, area: 'lower', status: 'added', tags: ['skirt lift'] }),
      note({
        charIndex: 0,
        area: 'chest',
        status: 'conflict',
        reason: '옷 벗기기=켬 / clothing aside 있음'
      })
    ])
    expect(badge.added).toBe(1)
    expect(badge.attention).toEqual([{ status: 'conflict', areas: ['chest'] }])
    expect(badge.title.split('\n')[0]).toBe('입은 옷 자동 젖힘')
    expect(badge.title).toContain('아래 · 붙음 +skirt lift')
    expect(badge.title).toContain('가슴 · 충돌')
  })

  it('안 붙은 이유만 있어도 호버 글이 있고, 근거 없음뿐이면 비어 있다', () => {
    const only = charBadge([
      note({ charIndex: 0, area: 'lower', status: 'nude', reason: '알몸 (nude)' })
    ])
    expect(only.added).toBe(0)
    expect(only.title).toContain('아래 · 알몸')
    expect(charBadge([note({ charIndex: 0, area: 'lower', status: 'not-needed' })]).title).toBe('')
    expect(charBadge([]).title).toBe('')
  })
})

describe('줄에 보일 이유', () => {
  it('앞의 부위 이름은 떼고 붙은 태그를 되풀이할 뿐인 말은 비운다', () => {
    const added = note({
      charIndex: 0,
      area: 'lower',
      status: 'added',
      tags: ['skirt lift'],
      reason: '아래: skirt lift 붙임'
    })
    expect(displayReason(added)).toBe('')
    expect(
      displayReason({ ...added, reason: '아래: skirt lift 붙임 (막힌 태그: dress lift)' })
    ).toBe('skirt lift 붙임 (막힌 태그: dress lift)')
    expect(
      displayReason(
        note({
          charIndex: 0,
          area: 'chest',
          status: 'piece',
          reason: '가슴: 복장의 nsfw 조각이 이 부위를 맡음'
        })
      )
    ).toBe('복장의 nsfw 조각이 이 부위를 맡음')
  })
})

describe('회차 묶기', () => {
  const a = [note({ charIndex: 0, area: 'lower', status: 'added', tags: ['skirt lift'] })]
  const b = [note({ charIndex: 0, area: 'lower', status: 'nude' })]

  it('회차마다 결과가 같으면 한 묶음, 다르면 회차별로 보인다', () => {
    expect(groupRounds([{ label: '기본 설정', notes: a }])).toEqual([{ label: null, notes: a }])
    expect(
      groupRounds([
        { label: '기본 설정', notes: a },
        { label: '조합 2', notes: [...a] }
      ])
    ).toEqual([{ label: null, notes: a }])
    expect(
      groupRounds([
        { label: '기본 설정', notes: a },
        { label: '조합 2', notes: b }
      ]).map((g) => g.label)
    ).toEqual(['기본 설정', '조합 2'])
  })
})

describe('카드 글에서 옷 읽기', () => {
  it('카드에 직접 적은 옷 이름과 젖힘 후보를 돌려준다', () => {
    const wear = readCardWear('1girl, adult, long hair, skirt, shirt')
    expect(wear.garments).toContain('skirt')
    expect(wear.lower.length).toBeGreaterThan(0)
    expect(wear.chest.length).toBeGreaterThan(0)
  })

  it('옷이 없는 카드는 비어 있다', () => {
    expect(readCardWear('1girl, adult, long hair, smile')).toEqual({
      garments: [],
      lower: [],
      chest: []
    })
  })
})

describe('줄 묶기 — 같은 말을 부위마다 되풀이하지 않는다', () => {
  const nudeBoth = [
    note({
      charIndex: 0,
      area: 'lower',
      status: 'nude',
      reason: '아래: 알몸이라 젖힐 옷이 없음 (옷 벗기기 둘 다)'
    }),
    note({
      charIndex: 0,
      area: 'chest',
      status: 'nude',
      reason: '가슴: 알몸이라 젖힐 옷이 없음 (옷 벗기기 둘 다)'
    })
  ]

  it('알몸 아래·가슴은 한 줄로 합치고 이유는 한 번만 보인다', () => {
    const rows = mergeRows(nudeBoth)
    expect(rows).toHaveLength(1)
    expect(rows[0].areas).toEqual(['lower', 'chest'])
    expect(displayReason(rows[0].note)).toBe('알몸이라 젖힐 옷이 없음 (옷 벗기기 둘 다)')
  })

  it('근거 없음은 이유 없이 부위만 합쳐 맨 끝에', () => {
    const rows = mergeRows([
      note({
        charIndex: 0,
        area: 'lower',
        status: 'not-needed',
        reason: '아래: 드러내라는 근거 없음'
      }),
      note({
        charIndex: 0,
        area: 'chest',
        status: 'not-needed',
        reason: '가슴: 드러내라는 근거 없음'
      }),
      note({ charIndex: 0, area: 'chest', status: 'added', tags: ['shirt lift'] })
    ])
    expect(rows.map((r) => [r.note.status, r.areas.join('+')])).toEqual([
      ['added', 'chest'],
      ['not-needed', 'lower+chest']
    ])
    expect(displayReason(rows[1].note)).toBe('')
  })

  it('다른 상태·태그는 합치지 않는다', () => {
    const rows = mergeRows([
      note({ charIndex: 0, area: 'lower', status: 'added', tags: ['skirt lift'] }),
      note({ charIndex: 0, area: 'chest', status: 'added', tags: ['shirt lift'] })
    ])
    expect(rows).toHaveLength(2)
  })
})

describe('옷 글이 없는 「옷 못 읽음」은 조용한 상태', () => {
  const quiet = note({ charIndex: 0, area: 'lower', status: 'no-garment' })
  const loud = note({
    charIndex: 0,
    area: 'lower',
    status: 'no-garment',
    tags: ['clothing aside'],
    garments: ['shirt']
  })

  it('제안도 읽은 옷도 없으면 경고가 아니라 「옷 글 없음」', () => {
    expect(isQuietNote(quiet)).toBe(true)
    expect(isQuietNote(loud)).toBe(false)
    expect(noteMeta(quiet).label).toBe('옷 글 없음')
    expect(noteMeta(quiet).tone).toBe('mute')
    expect(noteMeta(loud).label).toBe('옷 못 읽음')
  })

  it('요약·배지의 경고에서 조용한 것은 빠진다', () => {
    expect(charBadge([quiet]).attention).toEqual([])
    expect(summaryText([quiet])).toBe('')
    expect(charBadge([loud]).attention).toEqual([{ status: 'no-garment', areas: ['lower'] }])
    expect(summaryText([loud])).toBe('옷 못 읽음 1명')
  })
})

describe('배지는 부위 이름을 보인다', () => {
  it('붙은 게 없으면 「자동 0」 없이 경고만, 경고는 부위와 함께', () => {
    const badge = charBadge([
      note({ charIndex: 0, area: 'chest', status: 'unknown' }),
      note({ charIndex: 0, area: 'lower', status: 'unknown' })
    ])
    expect(badge.added).toBe(0)
    expect(badge.attention).toEqual([{ status: 'unknown', areas: ['lower', 'chest'] }])
  })
})

describe('여러 회차 요약', () => {
  it('접힌 줄에 모든 회차의 눈여겨볼 상태가 합쳐진다', () => {
    const r1 = [note({ charIndex: 0, area: 'lower', status: 'added', tags: ['skirt lift'] })]
    const r2 = [
      note({ charIndex: 0, area: 'lower', status: 'added', tags: ['skirt lift'] }),
      note({ charIndex: 1, area: 'lower', status: 'conflict' })
    ]
    expect(mergedCounts([{ notes: r1 }, { notes: r2 }])).toEqual([
      { status: 'added', count: 1 },
      { status: 'conflict', count: 1 }
    ])
  })
})

describe('복장 선택의 자동 표시는 생성과 같은 판정을 따른다', () => {
  it('드러내야 하는 부위 = 붙음·조각·알몸·이미 있음·옷 못 읽음·막음이 남은 부위', () => {
    expect(
      autoAreasFromNotes(
        [
          note({ charIndex: 0, area: 'lower', status: 'piece' }),
          note({ charIndex: 0, area: 'chest', status: 'over-clothes' })
        ],
        true
      )
    ).toEqual({ lower: true, chest: false })
    // 근거 없음·사후·부정문·화면 밖·판단 못 함은 켜지지 않는다
    for (const status of ['not-needed', 'after', 'negated', 'off-frame', 'unknown'] as const)
      expect(autoAreasFromNotes([note({ charIndex: 0, area: 'lower', status })], true).lower).toBe(
        false
      )
    for (const status of ['added', 'nude', 'already', 'no-garment', 'vetoed'] as const)
      expect(autoAreasFromNotes([note({ charIndex: 0, area: 'lower', status })], true).lower).toBe(
        true
      )
  })

  it('이 씬에서 자동 젖힘을 껐으면 어느 부위도 켜지지 않는다', () => {
    expect(
      autoAreasFromNotes([note({ charIndex: 0, area: 'lower', status: 'piece' })], false)
    ).toEqual({ lower: false, chest: false })
  })
})
