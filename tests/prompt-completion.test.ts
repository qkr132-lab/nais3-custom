import { describe, expect, it } from 'vitest'
import {
  completionEdit,
  completionRange,
  completionAnchor,
  anchoredCompletionRange
} from '../src/renderer/src/lib/prompt-completion'

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

describe('new tag insertion preserves existing neighbors', () => {
  function insertAt(original: string, start: number, query: string, tag = 'abs') {
    const text = original.slice(0, start) + query + original.slice(start)
    const cursor = start + query.length
    const anchor = completionAnchor(null, { text: original, start, end: start }, text, cursor)
    expect(anchor).not.toBeNull()
    const range = anchoredCompletionRange(anchor!, text, cursor)
    expect(range).not.toBeNull()
    expect(range!.query).toBe(query.replace(/^target#|^</, ''))
    return { text, cursor, anchor: anchor!, range: range!, edit: completionEdit(range!, tag) }
  }

  it('inserts before and after a middle tag without requiring a manually typed comma', () => {
    const original = 'tags1,tags2,tags3'
    expect(insertAt(original, original.indexOf('tags2'), '복근').edit.next).toBe(
      'tags1,abs, tags2,tags3'
    )
    expect(insertAt(original, original.indexOf(',tags3'), '복근').edit.next).toBe(
      'tags1,tags2, abs,tags3'
    )
  })

  it('preserves a long English tag and every surrounding tag', () => {
    const original = 'sky, warrior (dq3) (cosplay), clouds'
    expect(insertAt(original, original.indexOf('warrior'), '복근').edit.next).toBe(
      'sky, abs, warrior (dq3) (cosplay), clouds'
    )
    expect(completionEdit(completionRange('복근warrior (dq3) (cosplay)', 2)!, 'abs').next).toBe(
      'abs, warrior (dq3) (cosplay)'
    )
  })

  it('adds missing separators at the beginning and end, preserving existing spaces', () => {
    expect(insertAt('sky, clouds', 0, '복근').edit.next).toBe('abs, sky, clouds')
    expect(insertAt('sky, clouds', 11, '복근').edit.next).toBe('sky, clouds, abs, ')
    expect(insertAt('sky, clouds', 4, '복근').edit.next).toBe('sky,abs, clouds')
  })

  it('uses the supplied original caret even when the query repeats existing letters', () => {
    expect(insertAt('blue eyes, sky', 0, 'blue', 'blue hair').edit.next).toBe(
      'blue hair, blue eyes, sky'
    )
    expect(insertAt('sky, clouds', 3, 'sky', 'night sky').edit.next).toBe('sky, night sky, clouds')
  })

  it('retains Korean IME replacements, multiword queries and backspace inside the new span', () => {
    const initial = insertAt('sky, clouds', 5, 'ㅂ')
    let previous = initial.text
    for (const query of ['복', '복근', '복근 있', '복근 있는', '복근 있']) {
      const text = initial.anchor.prefix + query + initial.anchor.suffix
      const anchor = completionAnchor(
        initial.anchor,
        {
          text: previous,
          start: initial.anchor.prefix.length,
          end: previous.length - initial.anchor.suffix.length
        },
        text,
        initial.anchor.prefix.length + query.length
      )
      expect(anchor).toEqual(initial.anchor)
      const range = anchoredCompletionRange(
        anchor!,
        text,
        initial.anchor.prefix.length + query.length
      )!
      expect(range.query).toBe(query)
      expect(completionEdit(range, 'abs').next).toBe('sky, abs, clouds')
      previous = text
    }
  })

  it('invalidates anchors after protected text changes or the cursor leaves the new span', () => {
    const initial = insertAt('sky, clouds', 5, '복근')
    expect(
      anchoredCompletionRange(initial.anchor, initial.text.replace('sky', 'moon'), initial.cursor)
    ).toBeNull()
    expect(anchoredCompletionRange(initial.anchor, initial.text, 1)).toBeNull()
    expect(
      anchoredCompletionRange(initial.anchor, initial.text, initial.cursor, initial.cursor + 1)
    ).toBeNull()
    expect(
      completionAnchor(
        initial.anchor,
        {
          text: initial.text,
          start: 0,
          end: 3
        },
        initial.text.replace('sky', 'moon'),
        4
      )
    ).toBeNull()
  })

  it('keeps replacement semantics when editing inside or replacing an existing tag', () => {
    expect(
      completionAnchor(null, { text: 'blue eyes, sky', start: 2, end: 2 }, 'bl복근ue eyes, sky', 4)
    ).toBeNull()
    expect(
      completionAnchor(null, { text: 'blue eyes, sky', start: 0, end: 9 }, '복근, sky', 2)
    ).toBeNull()
    expect(
      completionAnchor(
        null,
        { text: 'target#blue eyes, sky', start: 7, end: 7 },
        'target#복근blue eyes, sky',
        9
      )
    ).toBeNull()
    expect(completionEdit(completionRange('target#복근blue eyes, sky', 9)!, 'abs').next).toBe(
      'target#abs, sky'
    )
  })

  it('preserves role ownership whether a new tag is before a role or has its own prefix', () => {
    expect(insertAt('target#blue eyes, sky', 0, '복근').edit.next).toBe(
      'abs, target#blue eyes, sky'
    )
    expect(insertAt('sky, clouds', 3, 'target#복근').edit.next).toBe('sky, target#abs, clouds')
    expect(insertAt('source#', 7, '복근').edit.next).toBe('source#abs, ')
  })

  it('keeps numeric emphasis, braces, and fragments intact', () => {
    expect(insertAt('3::sky::', 3, '복근').edit.next).toBe('3::abs, sky::')
    expect(insertAt('3::sky::', 6, '복근').edit.next).toBe('3::sky, abs::')
    expect(insertAt('3::sky::', 8, '복근').edit.next).toBe('3::sky::, abs, ')
    expect(insertAt('{sky}', 1, '복근').edit.next).toBe('{abs, sky}')
    expect(insertAt('sky', 3, '<fl', 'flowers').edit.next).toBe('sky, <flowers>, ')
    expect(
      completionAnchor(null, { text: '<flowers>, sky', start: 1, end: 1 }, '<nflowers>, sky', 2)
    ).toBeNull()
  })

  it('does not offer anchored completion inside a comment', () => {
    const text = '# note 복근'
    expect(anchoredCompletionRange({ prefix: '# note ', suffix: '' }, text, text.length)).toBeNull()
  })
})
