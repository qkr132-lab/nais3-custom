import { describe, expect, it } from 'vitest'
import {
  patchPromptRequest,
  requestForPromptMode,
  restorePromptRequest
} from '../src/shared/prompt-state'
import { mergePromptParts, scenePositivePrompt } from '../src/shared/scene-request'
import { removeComments } from '../src/shared/nai-presets'
import type { GenerationRequest } from '../src/shared/types'

const request = {
  prompt: 'sky, smile, detail',
  promptParts: { base: 'sky', additional: 'smile', detail: 'detail' },
  seed: 42
} as GenerationRequest
describe('split prompt source of truth', () => {
  it('plain editing replaces stale hidden parts and scene generation uses visible text', () => {
    const edited = patchPromptRequest(request, { prompt: 'new visible prompt' })
    expect(edited.promptParts).toEqual({ base: 'new visible prompt', additional: '', detail: '' })
    const sent = requestForPromptMode(edited, false)
    expect(sent.promptParts).toBeUndefined()
    expect(scenePositivePrompt(sent.prompt, { prompt: 'scene' }, sent.promptParts).prompt).toBe(
      'new visible prompt, scene'
    )
  })
  it('toggling without plain edits preserves all three fields', () => {
    expect(restorePromptRequest(restorePromptRequest(request, false), true)).toEqual(request)
  })
  it('parts edits and preset restoration always rebuild merged text', () => {
    const next = patchPromptRequest(request, {
      prompt: 'stale',
      promptParts: { base: 'new', additional: '', detail: 'fine' }
    })
    expect(next.prompt).toBe('new, fine')
    expect(next.seed).toBe(42)
  })
  it('legacy inconsistent saved state honors the visible editing mode', () => {
    const stale = { ...request, prompt: 'plain latest' }
    expect(restorePromptRequest(stale, false).promptParts?.base).toBe('plain latest')
    expect(restorePromptRequest(stale, true).prompt).toBe('sky, smile, detail')
  })
  it('legacy partial parts are normalized without crashing', () => {
    expect(
      restorePromptRequest(
        { prompt: 'fallback', promptParts: { additional: 'new' } } as GenerationRequest,
        true
      ).prompt
    ).toBe('fallback, new')
  })
  it('a comment in one part cannot swallow subsequent parts or scene tags', () => {
    const parts = { base: 'sky # base note', additional: 'smile # middle note', detail: 'detail' }
    const merged = mergePromptParts(parts)
    expect(removeComments(merged)).toContain('detail')
    expect(removeComments(merged)).toContain('smile')
    const scene = scenePositivePrompt(
      '',
      { prompt: 'forest # scene note', censorKinds: ['anal'] },
      parts
    )
    const clean = removeComments(scene.prompt)
    expect(clean).toContain('forest')
    expect(clean).toContain('white censored anal')
    expect(clean).toContain('detail')
  })
  it('role hash tags do not become comment boundaries', () => {
    expect(mergePromptParts({ base: 'source#hug', additional: 'sky,', detail: ', detail' })).toBe(
      'source#hug, sky, detail'
    )
  })
})
