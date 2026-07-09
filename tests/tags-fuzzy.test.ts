import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { englishKey, hangulKey, keySimilarity } from '../src/main/tags-fuzzy'

/**
 * 한글 태그 검색 품질 테스트.
 * 실제 앱 동작과 동일하게 1) 한글 사전 매칭 → 2) 음차 퍼지 매칭 보충 순서로 검증한다.
 * 퍼지 티어는 사전에 없는 음차어(미드리프트 등)를 잡는 게 목적.
 */

const tags = (
  JSON.parse(readFileSync(join(__dirname, '..', 'resources', 'tags.json'), 'utf8')) as {
    value: string
    count: number
  }[]
)
  .sort((a, b) => b.count - a.count)
  .slice(0, 60000)

const ko = JSON.parse(
  readFileSync(join(__dirname, '..', 'resources', 'tags-ko.json'), 'utf8')
) as Record<string, string>

const pool = tags
  .map((t) => ({ tag: t.value, count: t.count, key: englishKey(t.value) }))
  .filter((p) => p.key.length >= 2)

/** 앱과 동일한 파이프라인: 사전 매칭 → 퍼지 보충 */
function search(query: string, limit = 8): string[] {
  const dictHits = tags.filter((t) => ko[t.value]?.includes(query)).map((t) => t.value)
  const hits = dictHits.slice(0, limit)
  if (hits.length < limit) {
    const qk = hangulKey(query)
    const seen = new Set(hits)
    const fuzzy = pool
      .filter((p) => !seen.has(p.tag) && Math.abs(p.key.length - qk.length) <= 4)
      .map((p) => ({ tag: p.tag, count: p.count, score: keySimilarity(qk, p.key) }))
      .filter((p) => p.score >= 0.55)
      .sort((a, b) => b.score - a.score || b.count - a.count)
      .slice(0, limit - hits.length)
      .map((p) => p.tag)
    hits.push(...fuzzy)
  }
  return hits
}

describe('korean tag search (dict + transliteration fuzzy)', () => {
  it('사전에 없는 음차어: 미드리프 → midriff', () => {
    expect(search('미드리프')).toContain('midriff')
  })
  it('사전에 없는 음차어: 아호게 발음 유사', () => {
    expect(search('아호게')).toContain('ahoge')
  })
  it('사전 매칭: 트윈테일 → twintails', () => {
    expect(search('트윈테일')).toContain('twintails')
  })
  it('사전 매칭: 세라복 → serafuku', () => {
    expect(search('세라복')).toContain('serafuku')
  })
  it('사전 매칭: 가슴골 → cleavage', () => {
    expect(search('가슴골')).toContain('cleavage')
  })
  it('사전 매칭: 홍채 → 색상 눈 태그들', () => {
    expect(search('홍채')).toContain('blue eyes')
  })
  it('키 정규화: 유/무성음·중복 통합', () => {
    expect(englishKey('midriff')).toBe(englishKey('midrif'))
    expect(keySimilarity(hangulKey('미드리프트'), englishKey('midriff'))).toBeGreaterThanOrEqual(
      0.55
    )
  })
})
