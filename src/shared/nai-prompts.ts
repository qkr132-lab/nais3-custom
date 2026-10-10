import type { UcPresetIndex } from './types'
import { mergeQualityTags, mergeUcPreset, removeComments, withTextBlock } from './nai-presets'

export interface PromptCaptionCharacter {
  prompt: string
  negativePrompt: string
  enabled: boolean
}

export interface PromptCaptionRequest<T extends PromptCaptionCharacter = PromptCaptionCharacter> {
  prompt: string
  negativePrompt: string
  qualityToggle: boolean
  ucPreset: UcPresetIndex
  characterPrompts: T[]
  /** 따옴표 문구를 `Text:` 블록으로 (커스텀). 없으면 켜진 것으로 본다 */
  textHelper?: boolean
}

export interface PreparedPromptCaptions<T extends PromptCaptionCharacter = PromptCaptionCharacter> {
  positive: { base: string; characters: string[] }
  negative: { base: string; characters: string[] }
  /** Same filtered order on both sides; keep coordinates and other card metadata. */
  activeCharacters: T[]
}

/** Final text assembly shared by the payload builder and token preview.
 * Resolve wildcards before calling this function, as generation does.
 */
export function preparePromptCaptions<T extends PromptCaptionCharacter>(
  request: PromptCaptionRequest<T>
): PreparedPromptCaptions<T> {
  const text = (prompt: string): string =>
    request.textHelper === false ? prompt : withTextBlock(prompt)
  const activeCharacters = request.characterPrompts
    .map((character) => ({
      ...character,
      prompt: text(removeComments(character.prompt)),
      negativePrompt: removeComments(character.negativePrompt)
    }))
    .filter((character) => character.enabled && character.prompt.trim())
  return {
    positive: {
      base: mergeQualityTags(text(removeComments(request.prompt)), request.qualityToggle),
      characters: activeCharacters.map((character) => character.prompt)
    },
    negative: {
      base: mergeUcPreset(removeComments(request.negativePrompt), request.ucPreset),
      characters: activeCharacters.map((character) => character.negativePrompt)
    },
    activeCharacters
  }
}
