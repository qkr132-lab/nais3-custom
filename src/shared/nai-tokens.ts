import type { GenerationRequest } from './types'

/** NovelAI public client, 2026-09-09: module 41179 (F4 / d$).
 * https://docs.novelai.net/en/image/models/
 * Each sign has its own budget, shared by its base and enabled character captions.
 */
export function promptTokenLimit(model: string): number {
  if (model.startsWith('nai-diffusion-5-curated')) return 703
  if (model.startsWith('nai-diffusion-5')) return 1471
  return 512
}

export function promptTokenizer(model: string): 'qwen' | 't5' {
  return model.startsWith('nai-diffusion-5') ? 'qwen' : 't5'
}

/** NovelAI UI vhx + Bk: estimate ||alternatives|| by longest UTF-16 text
 * (last wins ties), then count up to six |mixing parts| separately, without trim.
 * This is distinct from tokenization: Qwen itself still counts a literal pipe.
 */
export function promptTokenParts(text: string): string[] {
  const sampled = text
    .split('||')
    .map((part, index) =>
      index % 2 === 0 ? part : part.split('|').reduce((a, b) => (a.length > b.length ? a : b))
    )
    .join('')
  const pieces = sampled.split('|')
  return pieces.length <= 6 ? pieces : [...pieces.slice(0, 5), pieces.slice(5).join('|')]
}

export type PromptTokenRequest = Pick<
  GenerationRequest,
  'model' | 'prompt' | 'negativePrompt' | 'qualityToggle' | 'ucPreset' | 'characterPrompts'
>

/** Keep image data, queue metadata and generation settings out of token IPC/cache keys. */
export function promptTokenRequest(request: PromptTokenRequest): PromptTokenRequest {
  return {
    model: request.model,
    prompt: request.prompt,
    negativePrompt: request.negativePrompt,
    qualityToggle: request.qualityToggle,
    ucPreset: request.ucPreset,
    characterPrompts: request.characterPrompts.map((c) => ({
      prompt: c.prompt,
      negativePrompt: c.negativePrompt,
      enabled: c.enabled
    }))
  }
}

export interface PromptTokenReport {
  model: string
  limit: number
  positive: number
  negative: number
  characters: { positive: number; negative: number }[]
  /** A wildcard/fragment was sampled; actual generation can choose another expansion. */
  estimated: boolean
}
