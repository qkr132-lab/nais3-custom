import { promptTokenLimit } from '../../src/shared/nai-tokens'
import type { IpcInvokeMap } from '../../src/shared/types'

/** Deterministic UI responses only; tokenizer accuracy has separate reference tests. */
export function tokenFixtureInvoke(
  channel: 'tokens:count' | 'tokens:preview',
  request: IpcInvokeMap['tokens:count']['req'] | IpcInvokeMap['tokens:preview']['req']
): IpcInvokeMap['tokens:count']['res'] | IpcInvokeMap['tokens:preview']['res'] {
  if (channel === 'tokens:count') {
    const { model, texts } = request as IpcInvokeMap['tokens:count']['req']
    return { counts: texts.map((text) => text.length), limit: promptTokenLimit(model) }
  }
  const { requests } = request as IpcInvokeMap['tokens:preview']['req']
  return {
    reports: requests.map((req) => {
      const characters = req.characterPrompts
        .filter((character) => character.enabled)
        .map((character) => ({
          positive: character.prompt.length,
          negative: character.negativePrompt.length
        }))
      return {
        model: req.model,
        limit: promptTokenLimit(req.model),
        positive: req.prompt.length + characters.reduce((sum, c) => sum + c.positive, 0),
        negative: req.negativePrompt.length + characters.reduce((sum, c) => sum + c.negative, 0),
        characters,
        estimated: /[<>|]/.test(req.prompt)
      }
    })
  }
}
