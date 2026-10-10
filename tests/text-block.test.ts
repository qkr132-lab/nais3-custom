import { describe, expect, it } from 'vitest'
import {
  mergeQualityTags,
  quotedPhrases,
  splitQualityTags,
  textBlockStart,
  withTextBlock
} from '../src/shared/nai-presets'
import { preparePromptCaptions } from '../src/shared/nai-prompts'

describe('따옴표 → Text: 블록', () => {
  it('따옴표 문구가 없으면 그대로', () => {
    expect(withTextBlock('1girl, smile')).toBe('1girl, smile')
    expect(quotedPhrases('1girl, "" , smile')).toEqual([])
  })

  it('따옴표 문구를 끝에 Text: 블록으로 붙이고, 여럿이면 빈 줄로 나눈다 (굽은 따옴표도)', () => {
    expect(withTextBlock('1girl, speech bubble, "안녕"')).toBe(
      '1girl, speech bubble, "안녕"\nText: 안녕'
    )
    expect(withTextBlock('speech bubble, "Hello!", “World”  ')).toBe(
      'speech bubble, "Hello!", “World”\nText: Hello!\n\nWorld'
    )
  })

  it('이미 Text: 를 적었으면 손대지 않는다 (소문자 text: 포함)', () => {
    const own = '1girl, "x"\nText: 내가 쓴 글'
    expect(withTextBlock(own)).toBe(own)
    expect(textBlockStart('1girl\ntext: hi')).toBe(6)
    expect(textBlockStart('1girl, text, english text')).toBe(-1)
  })

  it('품질 태그는 Text: 블록 앞에, no text 없이 붙는다', () => {
    expect(mergeQualityTags('1girl, "hi"\nText: hi', true)).toBe(
      '1girl, "hi", very aesthetic, masterpiece\nText: hi'
    )
    expect(mergeQualityTags('1girl', true)).toBe('1girl, very aesthetic, masterpiece, no text')
    expect(mergeQualityTags('1girl\nText: hi', false)).toBe('1girl\nText: hi')
  })

  it('메타데이터 판독: 두 형태 모두 원문과 토글을 되찾는다', () => {
    expect(splitQualityTags('1girl, very aesthetic, masterpiece, no text')).toEqual({
      prompt: '1girl',
      qualityToggle: true
    })
    expect(splitQualityTags('1girl, very aesthetic, masterpiece\nText: hi')).toEqual({
      prompt: '1girl\nText: hi',
      qualityToggle: true
    })
    expect(splitQualityTags('1girl, masterpiece')).toEqual({
      prompt: '1girl, masterpiece',
      qualityToggle: false
    })
  })

  it('전송 조립: 기본·캐릭터 프롬프트 모두 바꾸고, 끄면 그대로', () => {
    const req = {
      prompt: '1girl, "hi"',
      negativePrompt: '',
      qualityToggle: true,
      ucPreset: 4 as const,
      characterPrompts: [
        { prompt: 'girl, speech bubble, "안녕"', negativePrompt: '', enabled: true }
      ]
    }
    const on = preparePromptCaptions(req)
    expect(on.positive.base).toBe('1girl, "hi", very aesthetic, masterpiece\nText: hi')
    expect(on.positive.characters).toEqual(['girl, speech bubble, "안녕"\nText: 안녕'])
    const off = preparePromptCaptions({ ...req, textHelper: false })
    expect(off.positive.base).toBe('1girl, "hi", very aesthetic, masterpiece, no text')
    expect(off.positive.characters).toEqual(['girl, speech bubble, "안녕"'])
  })
})
