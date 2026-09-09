import { expect, it } from 'vitest'
import { mergeTagRecommendations, type TagSuggestion } from '../src/shared/tag-search'
const tag = (name: string): TagSuggestion => ({ tag: name, count: 1, type: 'general' })
it('keeps relevance before personal history in one bounded deduplicated list', () => {
  const result = mergeTagRecommendations(
    [tag('exact'), tag('related')],
    [tag('exact'), tag('recent')],
    [tag('frequent'), tag('recent')],
    10
  )
  expect(result.map((t) => t.tag)).toEqual(['exact', 'related', 'frequent', 'recent'])
  expect(result.slice(2).every((t) => t.match === 'history')).toBe(true)
})
it('reserves history slots after the strongest matches and never duplicates a match', () => {
  const matches = Array.from({ length: 10 }, (_, i) => tag('match' + i))
  const result = mergeTagRecommendations(
    matches,
    [tag('recent'), tag('match0')],
    [tag('frequent')],
    10
  )
  expect(result).toHaveLength(10)
  expect(result[0].tag).toBe('match0')
  expect(result.slice(-2).map((t) => t.tag)).toEqual(['recent', 'frequent'])
  expect(new Set(result.map((t) => t.tag)).size).toBe(10)
})
it('empty input uses the same list for recent and frequent tags', () => {
  expect(mergeTagRecommendations([], [tag('recent')], [tag('frequent')]).map((t) => t.tag)).toEqual(
    ['recent', 'frequent']
  )
})
