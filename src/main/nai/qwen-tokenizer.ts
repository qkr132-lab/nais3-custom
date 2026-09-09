/** Byte-level BPE using NovelAI's published qwen35_tokenizer.def data/config.
 * The heap updates adjacent pairs only, avoiding quadratic rescans of long input.
 * V5's web encoder preserves weight syntax, normalizes NFC and adds no EOS/BOS.
 */
export interface QwenDefinition {
  config: { splitRegex: string; normalization: 'NFC'; ignoreMerges: boolean }
  specialTokens: string[]
  vocab: Record<string, number>
  merges: [string, string][]
}

interface Merge {
  rank: number
  token: number
}
interface Pair extends Merge {
  left: number
  right: number
  a: number
  b: number
}

const precedes = (a: Pair, b: Pair): boolean =>
  a.rank < b.rank || (a.rank === b.rank && a.left < b.left)

class PairHeap {
  private values: Pair[] = []
  push(pair: Pair): void {
    const values = this.values
    let i = values.length
    values.push(pair)
    while (i > 0) {
      const parent = (i - 1) >>> 1
      if (!precedes(pair, values[parent])) break
      values[i] = values[parent]
      i = parent
    }
    values[i] = pair
  }
  pop(): Pair | undefined {
    const values = this.values
    const first = values[0]
    const last = values.pop()
    if (!values.length || !last) return first
    let i = 0
    while (i * 2 + 1 < values.length) {
      let child = i * 2 + 1
      if (child + 1 < values.length && precedes(values[child + 1], values[child])) child++
      if (!precedes(values[child], last)) break
      values[i] = values[child]
      i = child
    }
    values[i] = last
    return first
  }
}

/** Bounded caches: typing many unique tags must not grow memory indefinitely. */
export class CountCache {
  private values = new Map<string, number>()
  private chars = 0
  get(text: string): number | undefined {
    const value = this.values.get(text)
    if (value !== undefined) {
      this.values.delete(text)
      this.values.set(text, value)
    }
    return value
  }
  set(text: string, value: number): void {
    if (text.length > 32768) return
    if (!this.values.has(text)) this.chars += text.length
    this.values.set(text, value)
    while (this.values.size > 4096 || this.chars > 262144) {
      const first = this.values.keys().next().value!
      this.values.delete(first)
      this.chars -= first.length
    }
  }
}

export class QwenTokenizer {
  private byteIds: number[] = []
  private merges = new Map<number, Merge>()
  private radix: number
  private split: RegExp
  private special: RegExp
  private cache = new CountCache()
  private normalization: 'NFC'

  constructor(definition: QwenDefinition) {
    const { vocab, config, specialTokens } = definition
    this.normalization = config.normalization
    this.radix = 1
    for (const id of Object.values(vocab)) this.radix = Math.max(this.radix, id + 1)
    const bytes = Array.from({ length: 256 }, (_, i) => i).filter(
      (b) => (b >= 33 && b <= 126) || (b >= 161 && b <= 172) || b >= 174
    )
    let extra = 0
    for (let b = 0; b < 256; b++) {
      const codepoint = bytes.includes(b) ? b : 256 + extra++
      this.byteIds[b] = vocab[String.fromCodePoint(codepoint)]
    }
    definition.merges.forEach(([a, b], rank) => {
      this.merges.set(vocab[a] * this.radix + vocab[b], { rank, token: vocab[a + b] })
    })
    this.split = new RegExp(config.splitRegex, 'gu')
    this.special = new RegExp(
      specialTokens
        .slice()
        .sort((a, b) => b.length - a.length)
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|'),
      'g'
    )
  }

  private countPiece(text: string): number {
    const cached = this.cache.get(text)
    if (cached !== undefined) return cached
    const bytes = new TextEncoder().encode(text)
    const ids = Int32Array.from(bytes, (b) => this.byteIds[b])
    const next = Int32Array.from(ids, (_, i) => (i + 1 < ids.length ? i + 1 : -1))
    const prev = Int32Array.from(ids, (_, i) => i - 1)
    const heap = new PairHeap()
    const add = (left: number): void => {
      if (left < 0) return
      const right = next[left]
      if (right < 0) return
      const merge = this.merges.get(ids[left] * this.radix + ids[right])
      if (merge) heap.push({ ...merge, left, right, a: ids[left], b: ids[right] })
    }
    for (let i = 0; i < ids.length - 1; i++) add(i)
    let count = ids.length
    for (let pair = heap.pop(); pair; pair = heap.pop()) {
      const { left, right, a, b, token } = pair
      if (next[left] !== right || ids[left] !== a || ids[right] !== b) continue
      ids[left] = token
      ids[right] = -1
      next[left] = next[right]
      if (next[right] >= 0) prev[next[right]] = left
      count--
      add(prev[left])
      add(left)
    }
    this.cache.set(text, count)
    return count
  }

  count(text: string): number {
    const normalized = text.normalize(this.normalization)
    let count = 0
    let start = 0
    const ordinary = (part: string): void => {
      for (const match of part.matchAll(this.split)) count += this.countPiece(match[0])
    }
    for (const match of normalized.matchAll(this.special)) {
      ordinary(normalized.slice(start, match.index))
      count++
      start = match.index + match[0].length
    }
    ordinary(normalized.slice(start))
    return count
  }
}
