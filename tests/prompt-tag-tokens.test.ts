import { describe, expect, it } from 'vitest'
import {
  NAI_KNOWN_TAG,
  promptTagTokens,
  tagLookupKey,
  unknownTagRanges
} from '../src/shared/prompt-tag-tokens'

/** 사전에 없는 태그를 빨갛게 — 어느 글자를 태그로 보고 어디까지 칠하는지 (커스텀) */
describe('프롬프트 태그 덩어리', () => {
  it('콤마·줄바꿈으로 나누고 가중치·괄호·역할 접두사는 벗긴다', () => {
    const v = '1girl, 1.3::blue eyes, smile::, {{red hair}}, target#sex, -1::hat ::\nlong hair'
    const t = promptTagTokens(v)
    expect(t.map((x) => x.text)).toEqual([
      '1girl',
      'blue eyes',
      'smile',
      'red hair',
      'sex',
      'hat',
      'long hair'
    ])
    for (const x of t) expect(v.slice(x.start, x.end)).toBe(x.text)
  })

  it('조각·와일드카드·주석·Text: 줄은 보지 않는다', () => {
    const v =
      '<a1>, sky/sea, {a|b}, blue eyes # memo, red\nText: hello world\n# whole comment\nsmile'
    expect(promptTagTokens(v).map((x) => x.text)).toEqual(['blue eyes', 'smile'])
  })

  it('NAI 전용 태그는 사전에 없어도 아는 것으로 친다', () => {
    for (const k of [
      'best quality',
      'very aesthetic',
      'year 2024',
      'rating:general',
      'high complexity',
      'no text',
      'peace sign',
      'neutral face',
      'bar eyes',
      'square bikini',
      'fur dataset',
      'meta:golden era',
      'visual novel cg'
    ])
      expect(NAI_KNOWN_TAG.test(k)).toBe(true)
    expect(NAI_KNOWN_TAG.test('blue eyes')).toBe(false)
  })

  it('모르는 것만 범위로 돌려주고, 조회 전(undefined)은 칠하지 않는다', () => {
    const dict: Record<string, boolean> = {
      '1girl': true,
      'blue eyes': true,
      'she smiles warmly': false
    }
    const v = '1girl, blue eyes, she smiles warmly, blu eyes, best quality'
    const r = unknownTagRanges(v, (k) => dict[k])
    expect(r.map((x) => x.text)).toEqual(['she smiles warmly'])
    expect(v.slice(r[0].start, r[0].end)).toBe('she smiles warmly')
    expect(tagLookupKey(' Blue_Eyes  ')).toBe('blue eyes')
  })
})
