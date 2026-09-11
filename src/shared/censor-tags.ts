export const CENSOR_OPTIONS = [
  {
    id: 'penis',
    label: '음경',
    weight: 2,
    tag: 'completely white penis censor',
    suppress: ['veiny penis', 'pink penis', 'red penis', 'white skin', 'pale skin', 'white nipples']
  },
  {
    id: 'vulva',
    label: '외음부',
    weight: 2,
    tag: 'completely white pussy censor',
    suppress: ['white nipples']
  },
  { id: 'anal', label: '항문', weight: 2, tag: 'completely white censored anal', suppress: [] },
  {
    id: 'testicles',
    label: '고환',
    weight: 2,
    tag: 'completely white censored testicles',
    suppress: ['white skin']
  }
] as const

export type CensorKind = (typeof CENSOR_OPTIONS)[number]['id']
export type CensorWeights = Record<CensorKind | 'suppress', number>
export type CensorChanges = Partial<Record<CensorKind, boolean>> & {
  weights?: Partial<CensorWeights>
  suppressAnal?: boolean
}
export const DEFAULT_CENSOR_WEIGHTS: CensorWeights = {
  penis: 2,
  vulva: 2,
  anal: 2,
  testicles: 2,
  suppress: 2
}

export function normalizeCensorWeights(value: unknown): CensorWeights {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      value = null
    }
  }
  const result = { ...DEFAULT_CENSOR_WEIGHTS }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  for (const key of Object.keys(result) as (keyof CensorWeights)[]) {
    const v = (value as Record<string, unknown>)[key]
    if (typeof v === 'number' && Number.isFinite(v))
      result[key] =
        Math.round(
          Math.min(key === 'suppress' ? 3 : 5, Math.max(key === 'suppress' ? 0 : 0.1, v)) * 10
        ) / 10
  }
  return result
}

export function changeCensorWeights(value: unknown, changes: CensorChanges): CensorWeights {
  return normalizeCensorWeights({ ...normalizeCensorWeights(value), ...changes.weights })
}

/** The independent negative-prompt control is opt-in, including for older imports. */
export function normalizeAnalSuppression(value: unknown): boolean {
  return value === true || value === 1
}

export function changeAnalSuppression(value: unknown, changes: CensorChanges): boolean {
  return normalizeAnalSuppression(changes.suppressAnal ?? value)
}

/** Preserve every user-authored tag; add only a missing, unqualified negative tag. */
export function withAnalSuppression(prompt: string, enabled: unknown): string {
  if (!normalizeAnalSuppression(enabled)) return prompt
  const tags = removeComments(prompt)
    .replace(/-?\d+(?:\.\d+)?::|::|[{}[\]]/g, '')
    .split(/[,\n]/)
  if (tags.some((tag) => tag.trim().toLowerCase() === 'anal')) return prompt
  const base = prompt.trim().replace(/,\s*$/, '')
  if (!base) return 'anal'
  return `${base}${commentStart(base.slice(base.lastIndexOf('\n') + 1)) !== -1 ? '\n' : ', '}anal`
}

/** Accept legacy missing data and reject unknown options. Stable order, no duplicates. */
export function normalizeCensors(value: unknown): CensorKind[] {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return []
    }
  }
  if (!Array.isArray(value)) return []
  const items = value
  return CENSOR_OPTIONS.filter((o) => items.includes(o.id)).map((o) => o.id)
}

export function changeCensors(value: unknown, changes: CensorChanges): CensorKind[] {
  const current = normalizeCensors(value)
  return CENSOR_OPTIONS.filter((o) => changes[o.id] ?? current.includes(o.id)).map((o) => o.id)
}

export function censorLabel(value: unknown): string {
  const active = normalizeCensors(value)
  return CENSOR_OPTIONS.filter((o) => active.includes(o.id))
    .map((o) => o.label)
    .join(' · ')
}

function censorWeights(value: unknown, weights?: unknown): Map<string, number> {
  const active = normalizeCensors(value)
  const strength = normalizeCensorWeights(weights)
  const tags = new Map<string, number>()
  for (const o of CENSOR_OPTIONS) {
    if (!active.includes(o.id)) continue
    tags.set(o.tag, strength[o.id])
    if (strength.suppress > 0) for (const tag of o.suppress) tags.set(tag, -strength.suppress)
  }
  return tags
}

export function censorPrompt(value: unknown, weights?: unknown): string {
  const groups = new Map<number, string[]>()
  for (const [tag, weight] of censorWeights(value, weights)) {
    groups.set(weight, [...(groups.get(weight) ?? []), tag])
  }
  return [...groups].map(([weight, tags]) => `${weight}::${tags.join(', ')}::`).join(', ')
}

/** Remove only selected control tags from plain/flat numeric tag groups.
 * Other content (including role-qualified tags) stays in its original scope.
 * This runs on request copies; user-authored prompt fields are never rewritten.
 */
export function withoutCensorDuplicates(prompt: string, value: unknown, weights?: unknown): string {
  const tags = censorWeights(value, weights)
  if (!tags.size) return prompt
  // Selected controls replace their older spelling in request copies as well.
  for (const [tag, weight] of tags) {
    if (tag.startsWith('completely ')) tags.set(tag.slice('completely '.length), weight)
  }
  const strip = (text: string): string =>
    text
      .split(',')
      .filter((t) => !tags.has(t.trim().toLowerCase()))
      .join(',')
  const chunks: string[] = []
  const weighted = /(-?\d+(?:\.\d+)?)::([\s\S]*?)::/g
  let at = 0
  for (const match of prompt.matchAll(weighted)) {
    chunks.push(strip(prompt.slice(at, match.index)))
    const body = strip(match[2])
    chunks.push(body.trim().replaceAll(',', '').trim() ? `${match[1]}::${body}::` : '')
    at = match.index! + match[0].length
  }
  chunks.push(strip(prompt.slice(at)))
  return chunks
    .join('')
    .replace(/,\s*(?=,|$)/g, '')
    .replace(/^\s*,\s*/, '')
    .trim()
}

export function withCensorTags(prompt: string, value: unknown, weights?: unknown): string {
  const extra = censorPrompt(value, weights)
  if (!extra) return prompt
  const clean = withoutCensorDuplicates(prompt, value, weights)
  return clean
    ? `${clean}${commentStart(clean.slice(clean.lastIndexOf('\n') + 1)) !== -1 ? '\n' : ', '}${extra}`
    : extra
}
import { commentStart, removeComments } from './nai-presets'
