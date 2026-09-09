import type { GenerationRequest, PromptParts } from './types'
import { mergePromptParts } from './scene-request'

export function normalizePromptParts(value: unknown, fallback = ''): PromptParts {
  const parts = value && typeof value === 'object' ? (value as Partial<PromptParts>) : {}
  return {
    base: typeof parts.base === 'string' ? parts.base : fallback,
    additional: typeof parts.additional === 'string' ? parts.additional : '',
    detail: typeof parts.detail === 'string' ? parts.detail : ''
  }
}

/** Visible edits are authoritative; never retain hidden, contradictory parts. */
export function patchPromptRequest(
  previous: GenerationRequest,
  patch: Partial<GenerationRequest>
): GenerationRequest {
  const next = { ...previous, ...patch }
  if (patch.promptParts !== undefined) {
    next.promptParts = normalizePromptParts(patch.promptParts, next.prompt)
    next.prompt = mergePromptParts(next.promptParts)
  } else if (patch.prompt !== undefined && previous.promptParts) {
    const parts = normalizePromptParts(previous.promptParts)
    next.promptParts =
      mergePromptParts(parts) === patch.prompt ? parts : normalizePromptParts(null, patch.prompt)
  }
  return next
}

/** Normalize legacy saves. Split-on restores parts; split-off preserves visible text. */
export function restorePromptRequest(
  request: GenerationRequest,
  split: boolean
): GenerationRequest {
  if (!request.promptParts)
    return split
      ? patchPromptRequest(request, { promptParts: normalizePromptParts(null, request.prompt) })
      : request
  return patchPromptRequest(
    request,
    split
      ? { promptParts: normalizePromptParts(request.promptParts, request.prompt) }
      : { prompt: request.prompt }
  )
}

export function requestForPromptMode(
  request: GenerationRequest,
  split: boolean
): GenerationRequest {
  const next = restorePromptRequest(request, split)
  return split ? next : { ...next, promptParts: undefined }
}
