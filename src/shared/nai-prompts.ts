import type { UcPresetIndex } from './types'
import { mergeQualityTags, mergeUcPreset, removeComments } from './nai-presets'

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
  const activeCharacters = request.characterPrompts
    .map((character) => ({
      ...character,
      prompt: removeComments(character.prompt),
      negativePrompt: removeComments(character.negativePrompt)
    }))
    .filter((character) => character.enabled && character.prompt.trim())
  return {
    positive: {
      base: mergeQualityTags(removeComments(request.prompt), request.qualityToggle),
      characters: activeCharacters.map((character) => character.prompt)
    },
    negative: {
      base: mergeUcPreset(removeComments(request.negativePrompt), request.ucPreset),
      characters: activeCharacters.map((character) => character.negativePrompt)
    },
    activeCharacters
  }
}
