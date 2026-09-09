import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import reference from './fixtures/nai-tokenizer-reference.json'
import { NaiTokenizer } from '../src/main/nai/tokenizer'
import { promptTokenLimit, promptTokenizer, promptTokenParts } from '../src/shared/nai-tokens'

const tokenizer = new NaiTokenizer(resolve('resources'))

describe('unmodified official NovelAI worker reference vectors', () => {
  for (const vector of reference.vectors) {
    it(vector.name, () => {
      expect(tokenizer.count(vector.input, 'nai-diffusion-5-full')).toBe(vector.qwen.count)
      expect(tokenizer.count(vector.input, 'nai-diffusion-4-5-full')).toBe(vector.t5.count)
    })
  }
  for (const vector of reference.promptVectors) {
    it(`official UI mixing/alternation: ${vector.name}`, () => {
      expect(promptTokenParts(vector.input)).toEqual(vector.segments)
      expect(tokenizer.countPrompt(vector.input, 'nai-diffusion-5-full')).toBe(vector.qwen.count)
      expect(tokenizer.countPrompt(vector.input, 'nai-diffusion-4-5-full')).toBe(vector.t5.count)
    })
  }
  it('ships the exact Qwen definition used for the captured reference vectors', () => {
    expect(
      createHash('sha256').update(readFileSync('resources/qwen35_tokenizer.def')).digest('hex')
    ).toBe(reference.sources.qwen.sha256)
  })
  it('selects the official budget/tokenizer for both model families and inpainting', () => {
    for (const suffix of ['', '-inpainting']) {
      expect(promptTokenLimit(`nai-diffusion-5-full${suffix}`)).toBe(1471)
      expect(promptTokenLimit(`nai-diffusion-5-curated${suffix}`)).toBe(703)
      expect(promptTokenLimit(`nai-diffusion-4-5-full${suffix}`)).toBe(512)
      expect(promptTokenizer(`nai-diffusion-5-full${suffix}`)).toBe('qwen')
      expect(promptTokenizer(`nai-diffusion-4-5-curated${suffix}`)).toBe('t5')
    }
  })
})
