import { beforeEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { previewPromptTokens } from '../src/main/nai/token-preview'
import { NaiTokenizer } from '../src/main/nai/tokenizer'
import { buildGenerateImagePayload } from '../src/main/nai/payload'
import { processWildcards, resetSequentialCounters } from '../src/main/fragments/processor'
import { removeComments } from '../src/shared/nai-presets'
import type { GenerationRequest } from '../src/shared/types'

const tokenizer = new NaiTokenizer(resolve('resources'))
const count = async (model: string, texts: string[]): Promise<number[]> =>
  texts.map((t) => tokenizer.countPrompt(t, model))
const request: GenerationRequest = {
  model: 'nai-diffusion-5-full',
  prompt: '1girl, silver hair # draft',
  negativePrompt: 'blurry',
  qualityToggle: true,
  ucPreset: 0,
  characterPrompts: [
    { prompt: 'blue eyes', negativePrompt: 'hat', enabled: true },
    { prompt: '# hidden', negativePrompt: 'excluded', enabled: true },
    { prompt: 'excluded', negativePrompt: 'excluded', enabled: false }
  ],
  width: 1024,
  height: 1024,
  steps: 28,
  cfgScale: 6,
  cfgRescale: 0,
  sampler: 'k_euler_ancestral',
  noiseSchedule: 'karras',
  seed: 1,
  variety: false,
  useCoords: false
}
const fragments = {
  getLines: (name: string): string[] | null =>
    name === 'pose' ? ['cat', 'a very long description of a rabbit running through a forest'] : null
}

describe('final token counts match actual payload captions', () => {
  beforeEach(resetSequentialCounters)
  it.each(['nai-diffusion-5-full', 'nai-diffusion-5-curated', 'nai-diffusion-4-5-full'])(
    '%s includes quality, UC and both character signs',
    async (model) => {
      const req = { ...request, model }
      const [report] = await previewPromptTokens([req], fragments, count)
      // Mirror only generation expansion; count the actual payload, not the preview helper.
      const expand = (text: string): string =>
        processWildcards(removeComments(text), fragments, () => 0)
      const payload = buildGenerateImagePayload({
        ...req,
        prompt: expand(req.prompt),
        negativePrompt: expand(req.negativePrompt),
        characterPrompts: req.characterPrompts.map((c) => ({
          ...c,
          prompt: expand(c.prompt),
          negativePrompt: expand(c.negativePrompt)
        }))
      })
      const actual = (key: string): number => {
        const { caption } = payload.parameters[key] as {
          caption: { base_caption: string; char_captions: { char_caption: string }[] }
        }
        return [caption.base_caption, ...caption.char_captions.map((c) => c.char_caption)].reduce(
          (sum, text) => sum + tokenizer.countPrompt(text, model),
          0
        )
      }
      expect(report.positive).toBe(actual('v4_prompt'))
      expect(report.negative).toBe(actual('v4_negative_prompt'))
      expect(report.characters).toHaveLength(1)
      expect(report.estimated).toBe(false)
    }
  )
  it('quality and UC toggles change the counted text without needing an editor change', async () => {
    const [off, on] = await previewPromptTokens(
      [{ ...request, qualityToggle: false, ucPreset: 4 }, request],
      fragments,
      count
    )
    expect(on.positive).toBeGreaterThan(off.positive)
    expect(on.negative).toBeGreaterThan(off.negative)
  })
  it('empty negative captions keep T5 EOS but add no invented Qwen EOS', async () => {
    const req = {
      ...request,
      prompt: '',
      negativePrompt: '',
      qualityToggle: false,
      ucPreset: 4 as const,
      characterPrompts: [{ enabled: true, prompt: 'cat', negativePrompt: '' }]
    }
    const [v5, v45] = await previewPromptTokens(
      [req, { ...req, model: 'nai-diffusion-4-5-full' }],
      fragments,
      count
    )
    expect(v5.negative).toBe(0)
    expect(v45.negative).toBe(2)
  })
  it('sequential choices advance inside one preview across base and characters only', async () => {
    const req = {
      ...request,
      prompt: '<*pose>',
      negativePrompt: '',
      qualityToggle: false,
      ucPreset: 4 as const,
      characterPrompts: [{ enabled: true, prompt: '<*pose>', negativePrompt: '' }]
    }
    const [report] = await previewPromptTokens([req], fragments, count)
    expect(report.positive).toBe(
      fragments.getLines('pose')!.reduce((sum, t) => sum + tokenizer.count(t, req.model), 0)
    )
    expect(report.estimated).toBe(true)
    expect(processWildcards('<*pose>', fragments)).toBe('cat')
  })
  it('random lengths are labelled sampled and identical captions are counted once per model', async () => {
    const calls: string[][] = []
    const req = { ...request, prompt: '<cat|very long rabbit description>', qualityToggle: false }
    const reports = await previewPromptTokens([req, req], fragments, async (model, texts) => {
      calls.push(texts)
      return count(model, texts)
    })
    expect(reports.every((r) => r.estimated)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(new Set(calls[0]).size).toBe(calls[0].length)
  })
})
