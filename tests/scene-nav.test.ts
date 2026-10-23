import { describe, expect, it } from 'vitest'
import {
  THUMB_MIN,
  anchoredScrollTop,
  clampAnchorOffset,
  findSceneMatches,
  gridKeyAllowed,
  isRestoreEcho,
  normalizeQuery,
  parseSavedScrolls,
  resolveFindCurrent,
  sceneLabel,
  sceneOrdinal,
  sceneScrollKey,
  scrollTopForThumb,
  serializeSavedScrolls,
  stepMatch,
  thumbMetrics,
  topSceneIndex,
  topSceneIndexBy,
  type NavScene,
  type ScrollAnchor
} from '../src/renderer/src/lib/scene-nav'

const scenes: NavScene[] = [
  { id: 11, name: '교실 Window', exportNo: null },
  { id: 12, name: '옥상 노을', exportNo: 7 },
  { id: 13, name: '교실 복도', exportNo: null },
  { id: 14, name: '씬 12', exportNo: 3 },
  { id: 15, name: '  빈 교실  ', exportNo: 12 }
]

describe('찾기 일치', () => {
  it('이름 일부로 찾고, 대소문자·공백은 무시한다', () => {
    expect(findSceneMatches(scenes, '교실')).toEqual([11, 13, 15])
    expect(findSceneMatches(scenes, 'WINDOW')).toEqual([11])
    expect(findSceneMatches(scenes, 'window')).toEqual([11])
    expect(findSceneMatches(scenes, '옥 상  노 을')).toEqual([12])
    expect(findSceneMatches(scenes, '빈교실')).toEqual([15])
  })

  it('빈 검색어나 공백만이면 일치 없음', () => {
    expect(findSceneMatches(scenes, '')).toEqual([])
    expect(findSceneMatches(scenes, '   ')).toEqual([])
  })

  it('없는 이름은 빈 목록', () => {
    expect(findSceneMatches(scenes, '바다')).toEqual([])
    expect(findSceneMatches([], '교실')).toEqual([])
  })

  it('숫자만 치면 순번과 내보내기 번호도 일치로 본다 (이름 일치와 합쳐 목록 순서)', () => {
    // 순번 2 = 옥상 노을
    expect(findSceneMatches(scenes, '2')).toEqual([12, 14])
    // '12': 이름 「씬 12」, 내보내기 번호 12인 「빈 교실」
    expect(findSceneMatches(scenes, '12')).toEqual([14, 15])
    // 내보내기 번호 7 → 옥상 노을
    expect(findSceneMatches(scenes, '7')).toEqual([12])
    // 순번 5 → 빈 교실
    expect(findSceneMatches(scenes, '5')).toEqual([15])
  })

  it('앞의 0은 무시하고 숫자로 본다', () => {
    expect(findSceneMatches(scenes, '07')).toEqual([12])
    expect(findSceneMatches(scenes, '003')).toEqual([13, 14])
  })

  it('글자가 섞이면 번호로 보지 않는다', () => {
    expect(findSceneMatches(scenes, '씬2')).toEqual([])
    expect(findSceneMatches(scenes, '씬12')).toEqual([14])
  })

  it('목록 밖 순번·너무 큰 수는 이름 일치만', () => {
    expect(findSceneMatches(scenes, '99')).toEqual([])
    expect(findSceneMatches(scenes, '99999999999999999999')).toEqual([])
  })

  it('자모가 갈라진 이름도 같은 글자로 본다', () => {
    const split: NavScene[] = [{ id: 1, name: '교실'.normalize('NFD') }]
    expect(findSceneMatches(split, '교실')).toEqual([1])
    expect(normalizeQuery('A B\tc')).toBe('abc')
  })
})

describe('다음·이전 일치', () => {
  it('끝에서 처음으로, 처음에서 끝으로 돈다', () => {
    expect(stepMatch(3, 0, 1)).toBe(1)
    expect(stepMatch(3, 2, 1)).toBe(0)
    expect(stepMatch(3, 0, -1)).toBe(2)
    expect(stepMatch(3, 1, -1)).toBe(0)
  })

  it('일치가 하나면 제자리, 없으면 0', () => {
    expect(stepMatch(1, 0, 1)).toBe(0)
    expect(stepMatch(1, 0, -1)).toBe(0)
    expect(stepMatch(0, 0, 1)).toBe(0)
  })

  it('범위를 벗어난 현재 자리는 끝으로 맞춘 뒤 움직인다', () => {
    expect(stepMatch(3, 9, 1)).toBe(0)
    expect(stepMatch(3, -4, -1)).toBe(2)
  })
})

describe('순번과 말풍선 글자', () => {
  it('목록 순서 1부터', () => {
    const ids = scenes.map((s) => s.id)
    expect(sceneOrdinal(ids, 11)).toBe(1)
    expect(sceneOrdinal(ids, 15)).toBe(5)
    expect(sceneOrdinal(ids, 999)).toBe(0)
  })

  it('「순번 · 이름」, 이름이 비면 대신 글자', () => {
    expect(sceneLabel(0, '교실')).toBe('1 · 교실')
    expect(sceneLabel(41, '옥상 노을')).toBe('42 · 옥상 노을')
    expect(sceneLabel(2, '   ')).toBe('3 · 이름 없음')
  })
})

describe('화면 맨 위 씬', () => {
  // 3열, 줄 높이 100 — 아래 끝 100,100,100,200,200,200,300
  const bottoms = [100, 100, 100, 200, 200, 200, 300]

  it('맨 위면 첫 씬', () => {
    expect(topSceneIndex(bottoms, 0)).toBe(0)
    expect(topSceneIndex(bottoms, 99)).toBe(0)
  })

  it('한 줄을 지나면 다음 줄 맨 왼쪽 카드', () => {
    expect(topSceneIndex(bottoms, 100)).toBe(3)
    expect(topSceneIndex(bottoms, 150)).toBe(3)
    expect(topSceneIndex(bottoms, 200)).toBe(6)
  })

  it('끝을 넘으면 마지막, 빈 목록은 −1', () => {
    expect(topSceneIndex(bottoms, 300)).toBe(6)
    expect(topSceneIndex(bottoms, 9999)).toBe(6)
    expect(topSceneIndex([], 10)).toBe(-1)
  })

  it('한 줄짜리 목록 보기에서도 한 장씩', () => {
    const rows = [40, 84, 128, 172]
    expect(topSceneIndex(rows, 0)).toBe(0)
    expect(topSceneIndex(rows, 84)).toBe(2)
  })

  it('칸을 필요한 만큼만 재도 같은 답이고, 재는 횟수는 로그 수준', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => (Math.floor(i / 3) + 1) * 100)
    for (const offset of [0, 99, 100, 150, 20000, 33300, 33400, 99999]) {
      let reads = 0
      const index = topSceneIndexBy(
        rows.length,
        (i) => {
          reads++
          return rows[i]
        },
        offset
      )
      expect(index).toBe(topSceneIndex(rows, offset))
      expect(reads).toBeLessThanOrEqual(12)
    }
    expect(topSceneIndexBy(0, () => 0, 5)).toBe(-1)
  })
})

describe('빠른 이동 막대 손잡이', () => {
  it('내용이 안 넘치면 숨긴다', () => {
    expect(thumbMetrics(0, 500, 500, 480).visible).toBe(false)
    expect(thumbMetrics(0, 500.5, 500, 480).visible).toBe(false)
    expect(thumbMetrics(0, 400, 500, 480).visible).toBe(false)
  })

  it('길이 없거나 보이는 높이가 없으면 숨긴다', () => {
    expect(thumbMetrics(0, 2000, 500, 0).visible).toBe(false)
    expect(thumbMetrics(0, 2000, 0, 480).visible).toBe(false)
  })

  it('손잡이 높이 = 보이는 비율', () => {
    const m = thumbMetrics(0, 2000, 500, 400)
    expect(m.visible).toBe(true)
    expect(m.size).toBeCloseTo(100)
    expect(m.top).toBe(0)
  })

  it('아주 길면 최소 높이', () => {
    const m = thumbMetrics(0, 500000, 500, 400)
    expect(m.size).toBe(THUMB_MIN)
  })

  it('맨 아래 스크롤이면 손잡이도 길 맨 아래', () => {
    const m = thumbMetrics(1500, 2000, 500, 400)
    expect(m.top + m.size).toBeCloseTo(400)
  })

  it('중간 위치는 비율대로', () => {
    const m = thumbMetrics(750, 2000, 500, 400) // 절반
    expect(m.top).toBeCloseTo((400 - m.size) / 2)
  })

  it('범위를 벗어난 scrollTop도 길 안에 가둔다', () => {
    const over = thumbMetrics(9999, 2000, 500, 400)
    expect(over.top + over.size).toBeCloseTo(400)
    const under = thumbMetrics(-50, 2000, 500, 400)
    expect(under.top).toBe(0)
  })

  it('길이가 손잡이 최소보다 짧아도 길을 넘지 않는다', () => {
    const m = thumbMetrics(0, 90000, 500, 20)
    expect(m.size).toBe(20)
    expect(m.top).toBe(0)
  })
})

describe('손잡이 자리 → scrollTop', () => {
  const total = 2000
  const view = 500
  const track = 400
  const size = thumbMetrics(0, total, view, track).size // 100

  it('맨 위·맨 아래·중간', () => {
    expect(scrollTopForThumb(0, total, view, track)).toBe(0)
    expect(scrollTopForThumb(track - size, total, view, track)).toBeCloseTo(total - view)
    expect(scrollTopForThumb((track - size) / 2, total, view, track)).toBeCloseTo(
      (total - view) / 2
    )
  })

  it('길 밖으로 끌어도 양 끝에 멈춘다', () => {
    expect(scrollTopForThumb(-80, total, view, track)).toBe(0)
    expect(scrollTopForThumb(10_000, total, view, track)).toBeCloseTo(total - view)
  })

  it('thumbMetrics와 오간다 (손잡이 자리 → scrollTop → 손잡이 자리)', () => {
    for (const thumbTop of [0, 37, 150, 299, 300]) {
      const scrollTop = scrollTopForThumb(thumbTop, total, view, track)
      expect(thumbMetrics(scrollTop, total, view, track).top).toBeCloseTo(thumbTop)
    }
  })

  it('안 넘치거나 길이 없으면 0', () => {
    expect(scrollTopForThumb(50, 500, 500, 400)).toBe(0)
    expect(scrollTopForThumb(50, 2000, 500, 0)).toBe(0)
    expect(scrollTopForThumb(50, 2000, 500, 20)).toBe(0)
  })
})

describe('스크롤 위치 기억', () => {
  const at = (id: number | null, offset: number, top: number): ScrollAnchor => ({ id, offset, top })

  it('열쇠는 「종류:프리셋 id」', () => {
    expect(sceneScrollKey('scene', 3)).toBe('scene:3')
    expect(sceneScrollKey('background', 12)).toBe('background:12')
  })

  it('저장 → 읽기 (맨 위 씬 + 오프셋 + 보조 scrollTop)', () => {
    const raw = serializeSavedScrolls({
      'scene:1': at(33, -41.6, 9000.4),
      'scene:2': at(5, 12, 0),
      'background:1': at(301, 12, 88)
    })
    // 맨 위(top 0)는 적지 않고, 소수는 반올림한다
    expect(JSON.parse(raw)).toEqual({
      'scene:1': { id: 33, offset: -42, top: 9000 },
      'background:1': { id: 301, offset: 12, top: 88 }
    })
    expect(parseSavedScrolls(raw)).toEqual({
      'scene:1': at(33, -42, 9000),
      'background:1': at(301, 12, 88)
    })
  })

  it('옛 형식(열쇠: 숫자 하나)도 읽는다 — 씬 id 없이 scrollTop 만', () => {
    const raw = JSON.stringify({ 'scene:1': 1235, 'background:1': 88 })
    expect(parseSavedScrolls(raw)).toEqual({
      'scene:1': at(null, 0, 1235),
      'background:1': at(null, 0, 88)
    })
  })

  it('옛 형식과 새 형식이 한 파일에 섞여 있어도 읽는다', () => {
    const raw = JSON.stringify({ a: 500, b: { id: 7, offset: 3, top: 70 } })
    expect(parseSavedScrolls(raw)).toEqual({ a: at(null, 0, 500), b: at(7, 3, 70) })
  })

  it('없거나 깨진 값은 빈 맵', () => {
    expect(parseSavedScrolls(null)).toEqual({})
    expect(parseSavedScrolls('')).toEqual({})
    expect(parseSavedScrolls('{깨짐')).toEqual({})
    expect(parseSavedScrolls('[1,2]')).toEqual({})
    expect(parseSavedScrolls('"abc"')).toEqual({})
    expect(parseSavedScrolls('null')).toEqual({})
  })

  it('숫자가 아니거나 0 이하인 옛 항목만 버린다', () => {
    const raw = JSON.stringify({ a: 10, b: '20', c: -5, d: null, e: 0, f: 7.5 })
    expect(parseSavedScrolls(raw)).toEqual({ a: at(null, 0, 10), f: at(null, 0, 7.5) })
  })

  it('새 형식에서 돌아갈 곳이 없거나 값이 이상하면 버리거나 기본값으로', () => {
    const raw = JSON.stringify({
      noPlace: { id: null, offset: 5, top: 0 },
      badId: { id: 1.5, offset: 5, top: 40 },
      badOffset: { id: 9, offset: 'x', top: 40 },
      onlyId: { id: 9 },
      array: [1, 2],
      text: 'abc'
    })
    expect(parseSavedScrolls(raw)).toEqual({
      badId: at(null, 5, 40),
      badOffset: at(9, 0, 40),
      onlyId: at(9, 0, 0)
    })
  })
})

describe('위치 복원 계산', () => {
  const PAD = 12

  it('카드 위쪽 끝이 저장한 오프셋에 오도록 scrollTop 을 맞춘다', () => {
    // 지금 scrollTop 0, 영역 위쪽 100, 카드 위쪽 화면 1100 (= 영역 안 1000), 오프셋 −30 → 1000 + 30
    expect(anchoredScrollTop(0, 1100, 100, 300, -30, PAD)).toBe(1030)
    // 지금 scrollTop 500 이면 카드는 같은 내용 자리에서 화면 600 → 500 + 500 + 30
    expect(anchoredScrollTop(500, 600, 100, 300, -30, PAD)).toBe(1030)
  })

  it('맨 위 오프셋(여백만큼)이면 카드가 여백 아래에 선다', () => {
    expect(anchoredScrollTop(0, 112, 100, 300, PAD, PAD)).toBe(0)
    expect(anchoredScrollTop(0, 1112, 100, 300, PAD, PAD)).toBe(1000)
  })

  it('낮아진 카드(이름 목록)에는 오프셋을 가둬 그 씬이 맨 위로 남게 한다', () => {
    // 카드 보기에서 −200 으로 저장 → 높이 40 인 줄에서는 −27 까지만 (아래 끝이 여백보다 1px 아래)
    expect(clampAnchorOffset(-200, 40, PAD)).toBe(-27)
    expect(clampAnchorOffset(-200, 300, PAD)).toBe(-200)
    expect(clampAnchorOffset(-10, 40, PAD)).toBe(-10)
    expect(anchoredScrollTop(0, 2000, 0, 40, -200, PAD)).toBe(2027)
  })

  it('보기가 바뀌어도 같은 카드가 맨 위에 남는다 (가둔 오프셋에서 아래 끝이 여백 밖)', () => {
    const height = 40
    const offset = clampAnchorOffset(-250, height, PAD)
    expect(offset + height).toBeGreaterThan(PAD)
  })

  it('복원이 일으킨 scroll 이벤트만 알아본다', () => {
    expect(isRestoreEcho(4598, 4598)).toBe(true)
    expect(isRestoreEcho(4598, 4597.2)).toBe(true)
    expect(isRestoreEcho(4598, 4700)).toBe(false)
    expect(isRestoreEcho(null, 0)).toBe(false)
  })
})

describe('격자 키 이동 범위', () => {
  it('포커스가 격자 안이면 허용, 격자 밖 요소면 거절', () => {
    expect(gridKeyAllowed('inside', false)).toBe(true)
    expect(gridKeyAllowed('inside', true)).toBe(true)
    expect(gridKeyAllowed('outside', true)).toBe(false)
    expect(gridKeyAllowed('outside', false)).toBe(false)
  })

  it('포커스가 body 면 마지막 pointerdown 이 격자 안일 때만 허용', () => {
    expect(gridKeyAllowed('neutral', true)).toBe(true)
    expect(gridKeyAllowed('neutral', false)).toBe(false)
  })
})

describe('찾기 현재 일치(씬 id)', () => {
  // 씬 순서 1..8, 일치는 2·4·6·8
  const order = [1, 2, 3, 4, 5, 6, 7, 8]
  const base = { prevOrder: order, order, reset: false }

  it('일치가 없으면 null', () => {
    expect(resolveFindCurrent({ ...base, prevId: 4, matches: [] })).toEqual({
      id: null,
      moved: false
    })
  })

  it('현재 id 가 아직 일치 안에 있으면 그대로 — 순번이 달라져도 옮기지 않는다', () => {
    // 앞쪽 일치(2)가 지워져도 4 는 4
    const after = order.filter((id) => id !== 2)
    expect(
      resolveFindCurrent({
        prevId: 4,
        prevOrder: order,
        order: after,
        matches: [4, 6, 8],
        reset: false
      })
    ).toEqual({ id: 4, moved: false })
  })

  it('현재가 없었으면 첫 일치 (옮긴 것으로 치지 않는다)', () => {
    expect(resolveFindCurrent({ ...base, prevId: null, matches: [2, 4, 6, 8] })).toEqual({
      id: 2,
      moved: false
    })
  })

  it('처음부터(프리셋·라이브러리 전환)이면 첫 일치, 옮긴 것으로 치지 않는다', () => {
    expect(resolveFindCurrent({ ...base, prevId: 6, matches: [2, 4, 6, 8], reset: true })).toEqual({
      id: 2,
      moved: false
    })
  })

  it('현재 일치가 지워지면 바로 뒤의 일치로 옮긴다', () => {
    const after = order.filter((id) => id !== 4)
    expect(
      resolveFindCurrent({
        prevId: 4,
        prevOrder: order,
        order: after,
        matches: [2, 6, 8],
        reset: false
      })
    ).toEqual({ id: 6, moved: true })
  })

  it('현재 일치와 그 뒤 일치가 함께 지워져도 남은 다음 일치로', () => {
    const after = order.filter((id) => id !== 4 && id !== 6)
    expect(
      resolveFindCurrent({
        prevId: 4,
        prevOrder: order,
        order: after,
        matches: [2, 8],
        reset: false
      })
    ).toEqual({ id: 8, moved: true })
  })

  it('마지막 일치가 지워지면 첫 일치로 돌아온다', () => {
    const after = order.filter((id) => id !== 8)
    expect(
      resolveFindCurrent({
        prevId: 8,
        prevOrder: order,
        order: after,
        matches: [2, 4, 6],
        reset: false
      })
    ).toEqual({ id: 2, moved: true })
  })

  it('이름이 바뀌어 일치에서 빠졌으면 그 씬 자리 바로 뒤의 일치로', () => {
    // 4 가 아직 목록에 있지만 일치 아님 → 4 뒤의 6
    expect(resolveFindCurrent({ ...base, prevId: 4, matches: [2, 6, 8] })).toEqual({
      id: 6,
      moved: true
    })
  })

  it('끌어서 순서가 바뀌어도 현재 id 는 그대로', () => {
    const moved = [1, 4, 2, 3, 5, 6, 7, 8]
    expect(
      resolveFindCurrent({
        prevId: 4,
        prevOrder: order,
        order: moved,
        matches: [4, 2, 6, 8],
        reset: false
      })
    ).toEqual({ id: 4, moved: false })
  })

  it('이전 순서에 없던 id 면 첫 일치', () => {
    expect(
      resolveFindCurrent({ prevId: 99, prevOrder: order, order, matches: [2, 4], reset: false })
    ).toEqual({ id: 2, moved: true })
  })

  it('새로 일치가 된 씬이 현재 자리 바로 뒤에 있으면 그 씬으로 (이전 일치 목록에 없어도)', () => {
    // 4 가 지워지고, 5 의 이름이 바뀌어 일치가 됨 → 4 의 뒤에 있던 5
    const after = order.filter((id) => id !== 4)
    expect(
      resolveFindCurrent({
        prevId: 4,
        prevOrder: order,
        order: after,
        matches: [2, 5, 6, 8],
        reset: false
      })
    ).toEqual({ id: 5, moved: true })
  })
})
