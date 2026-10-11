import { describe, expect, it } from 'vitest'
import {
  appendPromptPiece,
  mergeQualityTags,
  splitTextTail,
  textBlockStart
} from '../src/shared/nai-presets'
import { withCensorTags } from '../src/shared/censor-tags'
import { mergePromptParts, scenePositivePrompt } from '../src/shared/scene-request'
import { preparePromptCaptions } from '../src/shared/nai-prompts'

const SCENE =
  '1.3::singing::, 1.2::musical note::, spoken musical note, closed eyes, smile, upper body, He sings his own silly song happily., Text: PIZZA MOZZARELLA♪'

describe('Text: 블록은 어디에 적어도 전송 프롬프트 맨 끝으로', () => {
  it('콤마 뒤·공백 뒤·줄 처음의 Text:를 모두 알아본다', () => {
    expect(textBlockStart('a, Text: hi')).toBe(3)
    expect(textBlockStart('a. Text: hi')).toBe(3)
    expect(textBlockStart('a\ntext: hi')).toBe(2)
    expect(textBlockStart('text, english text, context')).toBe(-1)
    expect(splitTextTail(SCENE)).toEqual({
      body: SCENE.slice(0, SCENE.indexOf(', Text:')),
      text: 'PIZZA MOZZARELLA♪'
    })
  })

  it('뒤에 붙는 덩어리는 Text: 앞으로 들어간다', () => {
    expect(appendPromptPiece('1girl, Text: hi', 'detail tags')).toBe('1girl, detail tags\nText: hi')
    expect(appendPromptPiece('1girl', 'smile, Text: hi')).toBe('1girl, smile\nText: hi')
    expect(appendPromptPiece('a, Text: one', 'b, Text: two')).toBe('a, b\nText: one\n\ntwo')
    expect(appendPromptPiece('', 'Text: only')).toBe('Text: only')
    expect(appendPromptPiece('base,', ', scene')).toBe('base, scene')
  })

  it('3분할: 가변 칸의 씬 프롬프트에 Text:가 있어도 디테일 뒤로 간다', () => {
    const r = scenePositivePrompt(
      '',
      { prompt: SCENE },
      {
        base: 'fixed',
        additional: 'variable',
        detail: 'quality detail'
      }
    )
    expect(r.prompt).toBe(
      `fixed, variable, ${SCENE.slice(0, SCENE.indexOf(', Text:'))}, quality detail\nText: PIZZA MOZZARELLA♪`
    )
    expect(mergePromptParts(r.promptParts!)).toBe(r.prompt)
    // 3분할 표시(메타데이터)도 전송과 같은 자리: 가변엔 Text: 없음, 디테일 끝에
    expect(r.promptParts!.additional).not.toMatch(/text:/i)
    expect(r.promptParts!.detail).toBe('quality detail\nText: PIZZA MOZZARELLA♪')
    // 검열 태그가 가변에 붙어도 Text:는 디테일 끝
    const c = scenePositivePrompt(
      '',
      { prompt: SCENE, censorKinds: ['penis'] },
      {
        base: '',
        additional: '',
        detail: ''
      }
    )
    expect(c.promptParts!.additional).toMatch(/completely white censored penis$/)
    expect(c.promptParts!.detail).toBe('Text: PIZZA MOZZARELLA♪')
    expect(c.prompt).toMatch(/completely white censored penis\nText: PIZZA MOZZARELLA♪$/)
  })

  it('검열 태그도 Text: 앞에 붙는다', () => {
    expect(withCensorTags('1girl, Text: hi', ['penis'])).toBe(
      '1girl, completely white censored penis\nText: hi'
    )
  })

  it('품질 태그는 콤마 뒤 Text:라도 그 앞에 no text 없이', () => {
    expect(mergeQualityTags('1girl, Text: hi', true)).toBe(
      '1girl, very aesthetic, masterpiece\nText: hi'
    )
    const sent = preparePromptCaptions({
      prompt: 'fixed, variable, Text: PIZZA MOZZARELLA♪',
      negativePrompt: '',
      qualityToggle: true,
      ucPreset: 4,
      characterPrompts: []
    })
    expect(sent.positive.base).toBe(
      'fixed, variable, very aesthetic, masterpiece\nText: PIZZA MOZZARELLA♪'
    )
  })
})
