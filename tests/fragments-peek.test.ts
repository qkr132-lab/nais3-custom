import { describe, it, expect, beforeEach } from 'vitest'
import {
  processWildcards,
  resetSequentialCounters,
  type FragmentSource
} from '../src/main/fragments/processor'

const source: FragmentSource = {
  getLines: (path) => {
    if (path === 'a1') return ['1girl, blue eyes, smile']
    if (path === 'seq') return ['first', 'second', 'third']
    if (path === 'nested') return ['<a1>, outdoors']
    return null
  }
}

describe('processWildcards — 토큰 세기용 확장 (peek)', () => {
  beforeEach(() => resetSequentialCounters())

  it('<a1>은 조각 내용으로 펼쳐진다 (원문 그대로가 아님)', () => {
    const out = processWildcards('masterpiece, <a1>', source, () => 0, { peek: true })
    expect(out).toBe('masterpiece, 1girl, blue eyes, smile')
  })

  it('중첩 조각도 재귀로 펼친다', () => {
    const out = processWildcards('<nested>', source, () => 0, { peek: true })
    expect(out).toBe('1girl, blue eyes, smile, outdoors')
  })

  it('없는 조각은 원문 유지', () => {
    const out = processWildcards('<unknown>', source, () => 0, { peek: true })
    expect(out).toBe('<unknown>')
  })

  it('rng=0이면 항상 첫 줄 — 카운트가 흔들리지 않는다', () => {
    const multi: FragmentSource = { getLines: () => ['short', 'a much longer line here'] }
    const a = processWildcards('<x>', multi, () => 0, { peek: true })
    const b = processWildcards('<x>', multi, () => 0, { peek: true })
    expect(a).toBe('short')
    expect(a).toBe(b)
  })

  it('peek은 <*순차> 카운터를 진행시키지 않는다 (실제 생성 순서 보존)', () => {
    // peek 3번 → 전부 첫 항목
    for (let i = 0; i < 3; i++) {
      expect(processWildcards('<*seq>', source, () => 0, { peek: true })).toBe('first')
    }
    // 실제 생성(비-peek)은 이어서 first부터 순서대로
    expect(processWildcards('<*seq>', source, () => 0)).toBe('first')
    expect(processWildcards('<*seq>', source, () => 0)).toBe('second')
  })

  it('비-peek(생성)은 기존대로 순차 진행', () => {
    expect(processWildcards('<*seq>', source, () => 0)).toBe('first')
    expect(processWildcards('<*seq>', source, () => 0)).toBe('second')
    expect(processWildcards('<*seq>', source, () => 0)).toBe('third')
    expect(processWildcards('<*seq>', source, () => 0)).toBe('first')
  })
})
