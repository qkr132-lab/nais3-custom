import { stripBackgroundTags } from './background-tags'
import { appendPrompt, mergePromptParts } from './scene-request'
import { modelCaps } from './nai-models'
import type { GenerationRequest } from './types'

/** Build the actual send copy for the V5 Transparent BG toggle. */
export function withTransparentBackground(
  request: GenerationRequest,
  enabled: boolean
): GenerationRequest {
  if (!modelCaps(request.model).transparency) {
    if (request.transparentBackground === undefined) return request
    const rest = { ...request }
    delete rest.transparentBackground
    return rest
  }
  if (!enabled) return { ...request, transparentBackground: false }

  if (request.promptParts) {
    const promptParts = {
      base: stripBackgroundTags(request.promptParts.base),
      additional: stripBackgroundTags(request.promptParts.additional),
      detail: appendPrompt(
        stripBackgroundTags(request.promptParts.detail),
        'transparent background'
      )
    }
    return {
      ...request,
      prompt: mergePromptParts(promptParts),
      promptParts,
      transparentBackground: true
    }
  }

  return {
    ...request,
    prompt: appendPrompt(stripBackgroundTags(request.prompt), 'transparent background'),
    transparentBackground: true
  }
}
