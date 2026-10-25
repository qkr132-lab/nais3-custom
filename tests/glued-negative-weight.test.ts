import { describe, expect, it } from 'vitest'
import { splitPromptTokens } from '../src/shared/outfit'
import { mapTags } from '../src/shared/futa'

// 단어·마침표 바로 뒤에 붙여 쓴 음수 가중치 — 「-」가 앞 단어에 남으면 묶음이 +3 으로 읽히고,
// 재조립이 줄을 다시 이을 때 「-, 3::」이 되어 억제가 강조로 뒤집힌다
describe('붙여 쓴 음수 가중치', () => {
  it('마침표·단어 뒤의 -N:: 은 「-」까지 한 묶음으로 뗀다', () => {
    expect(splitPromptTokens('eyes half lidded.-3::smile, happy::, 3::surprised::')).toEqual([
      'eyes half lidded.',
      '-3::smile, happy::',
      '3::surprised::'
    ])
    expect(splitPromptTokens('areola slip-2::claws,gloves ::,3::mask ::')).toEqual([
      'areola slip',
      '-2::claws,gloves ::',
      '3::mask ::'
    ])
    expect(splitPromptTokens('completely empty.-4::, full body,cowboy shot ::')).toEqual([
      'completely empty.',
      '-4::, full body,cowboy shot ::'
    ])
  })

  it('소수 가중치(1.5::)·쉼표 뒤 음수 가중치는 예전과 같다', () => {
    expect(splitPromptTokens('red hair, 1.5::smile::, -2::hat::')).toEqual([
      'red hair',
      '1.5::smile::',
      '-2::hat::'
    ])
    expect(splitPromptTokens('red hair,-1.5::ponytail, braid::')).toEqual([
      'red hair',
      '-1.5::ponytail, braid::'
    ])
  })

  it('같은 줄의 다른 태그를 바꿔도 음수 가중치가 양수로 뒤집히지 않는다', () => {
    const r = mapTags(
      'hetero, eyes half lidded.-3::smile, happy::, 3::surprised, scared ::',
      (tag) => (tag === 'hetero' ? { after: '', reason: 'x' } : null)
    )
    expect(r.text).not.toMatch(/-\s*,/)
    expect(r.text).toContain('-3::smile, happy::')
    expect(r.text).toContain('3::surprised, scared ::')
    expect(r.text).not.toContain('hetero')
  })
})
