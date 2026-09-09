import { readFileSync } from 'fs'
import { join } from 'path'
import { inflateRawSync } from 'node:zlib'
import { promptTokenizer, promptTokenParts } from '../../shared/nai-tokens'
import { CountCache, QwenTokenizer, type QwenDefinition } from './qwen-tokenizer'

/**
 * T5 unigram — V4/4.5. V5는 아래 NaiTokenizer에서 Qwen BPE를 선택한다.
 *
 * NAI 웹 번들의 자체 JS 구현을 미러링한다 (resources/t5_tokenizer.json =
 * novelai.net/tokenizer/compressed/t5_tokenizer.def 해제본):
 * - normalizer: 웹은 Precompiled charsmap을 "무시"하고 identity — 동일하게 함
 * - pre-tokenize: 공백 분할 → 각 조각 앞에 ▁ (Metaspace, add_prefix_space)
 * - encode 전에 웹과 동일하게 가중치 문자 []{} 제거
 * - 결과에 EOS 1토큰 포함 (웹 카운트 방식)
 */

interface TokenizerDef {
  model: { vocab: [string, number][]; unk_id: number }
}

interface Vocab {
  pieces: Map<string, { id: number; score: number }>
  maxPieceLength: number
  unkScore: number
}

function load(resourcesDir: string): Vocab {
  const def = JSON.parse(
    readFileSync(join(resourcesDir, 't5_tokenizer.json'), 'utf-8')
  ) as TokenizerDef

  const pieces = new Map<string, { id: number; score: number }>()
  let maxPieceLength = 0
  let minScore = Infinity
  def.model.vocab.forEach(([piece, score], id) => {
    pieces.set(piece, { id, score })
    maxPieceLength = Math.max(maxPieceLength, piece.length)
    if (score < minScore) minScore = score
  })
  const unkScore = minScore - 10
  pieces.set(def.model.vocab[def.model.unk_id][0], { id: def.model.unk_id, score: unkScore })
  return { pieces, maxPieceLength, unkScore }
}

/** sentencepiece unigram Viterbi — 한 조각(▁포함)을 최적 분할했을 때의 토큰 수 */
function viterbiCount(piece: string, v: Vocab): number {
  const n = piece.length
  // best[i] = [0,i) 구간 최적 (score, tokenCount)
  const bestScore = new Float64Array(n + 1).fill(-Infinity)
  const bestCount = new Int32Array(n + 1)
  bestScore[0] = 0
  for (let i = 0; i < n; i++) {
    if (bestScore[i] === -Infinity) continue
    const maxLen = Math.min(v.maxPieceLength, n - i)
    let matchedSingle = false
    for (let len = 1; len <= maxLen; len++) {
      const sub = piece.slice(i, i + len)
      const entry = v.pieces.get(sub)
      if (!entry) continue
      if (len === 1) matchedSingle = true
      const score = bestScore[i] + entry.score
      if (score > bestScore[i + len]) {
        bestScore[i + len] = score
        bestCount[i + len] = bestCount[i] + 1
      }
    }
    if (!matchedSingle) {
      // 공식 JS는 긴 prefix가 일치해도 단일 UTF-16 단위가 없으면 unk 경로를 둔다.
      const score = bestScore[i] + v.unkScore
      if (score > bestScore[i + 1]) {
        bestScore[i + 1] = score
        bestCount[i + 1] = bestCount[i] + 1
      }
    }
  }
  return bestCount[n]
}

/**
 * 웹과 동일한 카운트: []{} 및 수치 가중치(N:: / ::) 제거 → 공백 분할 → ▁조각 unigram → +EOS(1)
 * (전처리 정규식은 NAI 웹 encode()에서 그대로 — 원본 코드와 카운트 일치 검증 완료)
 */
function countT5(text: string, v: Vocab): number {
  if (!text) return 1
  const cleaned = text.replace(/[[\]{}]/g, '').replace(/-?\d*\.?\d*::/g, '')
  // NAI WhitespaceSplit keeps empty leading/trailing fields; do not trim/filter.
  const parts = cleaned.split(/\s+/)
  let total = 1 // EOS
  for (const part of parts) {
    total += viterbiCount(part.startsWith('▁') ? part : '▁' + part, v)
  }
  return total
}

/** Loaded lazily inside the token worker, never on the UI/main event loop. */
export class NaiTokenizer {
  private t5: Vocab | null = null
  private qwen: QwenTokenizer | null = null
  private cache = { t5: new CountCache(), qwen: new CountCache() }
  constructor(private resourcesDir: string) {}

  countPrompt(text: string, model: string): number {
    return promptTokenParts(text).reduce((sum, part) => sum + this.count(part, model), 0)
  }

  count(text: string, model: string): number {
    const kind = promptTokenizer(model)
    const cached = this.cache[kind].get(text)
    if (cached !== undefined) return cached
    let count: number
    if (kind === 'qwen') {
      if (!this.qwen) {
        const data = inflateRawSync(readFileSync(join(this.resourcesDir, 'qwen35_tokenizer.def')))
        this.qwen = new QwenTokenizer(JSON.parse(data.toString('utf8')) as QwenDefinition)
      }
      count = this.qwen.count(text)
    } else {
      this.t5 ??= load(this.resourcesDir)
      count = countT5(text, this.t5)
    }
    this.cache[kind].set(text, count)
    return count
  }
}
