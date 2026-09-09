import { preparePromptCaptions } from '../../shared/nai-prompts'
import { removeComments } from '../../shared/nai-presets'
import {
  promptTokenLimit,
  type PromptTokenReport,
  type PromptTokenRequest
} from '../../shared/nai-tokens'
import {
  processWildcards,
  snapshotSequentialCounters,
  type FragmentSource
} from '../fragments/processor'

type CountTexts = (model: string, texts: string[]) => Promise<number[]>

export async function previewTokenTexts(
  model: string,
  texts: string[],
  source: FragmentSource,
  countTexts: CountTexts
): Promise<{ counts: number[]; limit: number; estimated: boolean }> {
  let estimated = false
  const sequentialCounters = snapshotSequentialCounters()
  const expanded = texts.map((text) =>
    removeComments(
      processWildcards(removeComments(text), source, () => 0, {
        peek: true,
        sequentialCounters,
        onChoice: () => {
          estimated = true
        }
      })
    )
  )
  estimated ||= expanded.some((text) => text.includes('||'))
  return { counts: await countTexts(model, expanded), limit: promptTokenLimit(model), estimated }
}

/** Preview each scene/round from the current sequential state, without advancing generation.
 * Random choices use their first candidate; the report explicitly marks sampled requests.
 */
export async function previewPromptTokens(
  requests: PromptTokenRequest[],
  source: FragmentSource,
  countTexts: CountTexts
): Promise<PromptTokenReport[]> {
  const prepared = requests.map((request) => {
    let estimated = false
    const counters = snapshotSequentialCounters()
    const expand = (text: string): string =>
      processWildcards(removeComments(text), source, () => 0, {
        peek: true,
        sequentialCounters: counters,
        onChoice: () => {
          estimated = true
        }
      })
    // Keep exactly the same expansion order as the generation handler, including disabled cards.
    const captions = preparePromptCaptions({
      ...request,
      prompt: expand(request.prompt),
      negativePrompt: expand(request.negativePrompt),
      characterPrompts: request.characterPrompts.map((character) => ({
        ...character,
        prompt: expand(character.prompt),
        negativePrompt: expand(character.negativePrompt)
      }))
    })
    estimated ||= [
      captions.positive.base,
      captions.negative.base,
      ...captions.positive.characters,
      ...captions.negative.characters
    ].some((text) => text.includes('||'))
    return { request, captions, estimated }
  })
  const groups = new Map<string, Set<string>>()
  for (const { request, captions } of prepared) {
    const texts = groups.get(request.model) ?? new Set<string>()
    for (const sign of [captions.positive, captions.negative]) {
      texts.add(sign.base)
      for (const text of sign.characters) texts.add(text)
    }
    groups.set(request.model, texts)
  }
  const countsByModel = new Map<string, Map<string, number>>()
  await Promise.all(
    [...groups].map(async ([model, textSet]) => {
      const texts = [...textSet]
      const counts = await countTexts(model, texts)
      if (counts.length !== texts.length) throw new Error('Incomplete token count response')
      countsByModel.set(model, new Map(texts.map((text, i) => [text, counts[i]])))
    })
  )
  return prepared.map(({ request, captions, estimated }) => {
    const counts = countsByModel.get(request.model)!
    const count = (text: string): number => counts.get(text)!
    return {
      model: request.model,
      limit: promptTokenLimit(request.model),
      positive: [captions.positive.base, ...captions.positive.characters].reduce(
        (sum, t) => sum + count(t),
        0
      ),
      negative: [captions.negative.base, ...captions.negative.characters].reduce(
        (sum, t) => sum + count(t),
        0
      ),
      characters: captions.positive.characters.map((text, i) => ({
        positive: count(text),
        negative: count(captions.negative.characters[i])
      })),
      estimated
    }
  })
}
