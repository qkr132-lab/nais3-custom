import { describe, expect, it } from 'vitest'
import { completionEdit, completionRange } from '../src/renderer/src/lib/prompt-completion'

describe('completion replacement boundaries', () => {
  it('preserves role prefix and surrounding tags', () => {
    const text = 'sky, target#smi, clouds'
    expect(completionEdit(completionRange(text, 15)!, 'smile').next).toBe(
      'sky, target#smile, clouds'
    )
  })
  it('replaces the entire current tag when the cursor is in the middle', () => {
    expect(completionEdit(completionRange('blue eyes, sky', 4)!, 'blue hair').next).toBe(
      'blue hair, sky'
    )
  })
  it('preserves numeric emphasis and brace syntax', () => {
    expect(completionEdit(completionRange('3::smi::', 6)!, 'smile').next).toBe('3::smile::')
    expect(completionEdit(completionRange('{smi}', 4)!, 'smile').next).toBe('{smile}')
  })
  it('preserves already-present fragment close and commas', () => {
    expect(completionEdit(completionRange('<flow>, sky', 5)!, 'flowers').next).toBe(
      '<flowers>, sky'
    )
  })
  it('uses no suggestions for selected text or comments', () => {
    expect(completionRange('smile', 0, 5)).toBeNull()
    expect(completionRange('# comment sm', 12)).toBeNull()
  })
  it('appends a separator when inserting at an empty position', () => {
    expect(completionEdit(completionRange('sky, ', 5)!, 'smile').next).toBe('sky, smile, ')
  })
})
