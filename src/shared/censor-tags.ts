/**
 * 씬 검열 태그 (커스텀) — 가중치 없이 첫 캐릭터 프롬프트 맨 끝에 붙인다.
 * legacy = 예전 버전이 넣던 표기. 프롬프트에 직접 적어 둔 것이 있으면 요청 사본에서 걷어낸다.
 */
export const CENSOR_OPTIONS = [
  {
    id: 'penis',
    label: '음경',
    tag: 'completely white censored penis',
    legacy: ['completely white penis censor']
  },
  {
    id: 'vulva',
    label: '외음부',
    tag: 'completely white censored pussy',
    legacy: ['completely white pussy censor']
  },
  { id: 'anal', label: '항문', tag: 'completely white censored anal', legacy: [] },
  { id: 'testicles', label: '고환', tag: 'completely white censored testicles', legacy: [] }
] as const

export type CensorKind = (typeof CENSOR_OPTIONS)[number]['id']
export type CensorChanges = Partial<Record<CensorKind, boolean>> & {
  suppressAnal?: boolean
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

/** 고른 부위의 태그 — CENSOR_OPTIONS 순서, 가중치 없이 콤마로 잇는다 */
export function censorPrompt(value: unknown): string {
  const active = normalizeCensors(value)
  return CENSOR_OPTIONS.filter((o) => active.includes(o.id))
    .map((o) => o.tag)
    .join(', ')
}

/** 고른 부위의 지금 표기와 예전 표기 (completely를 뺀 표기 포함) — 소문자 */
function censorSpellings(value: unknown): Set<string> {
  const active = normalizeCensors(value)
  const spellings = new Set<string>()
  for (const o of CENSOR_OPTIONS) {
    if (!active.includes(o.id)) continue
    for (const tag of [o.tag, ...o.legacy]) {
      spellings.add(tag)
      if (tag.startsWith('completely ')) spellings.add(tag.slice('completely '.length))
    }
  }
  return spellings
}

/** Remove only selected control tags from plain/flat numeric tag groups.
 * Other content (including role-qualified tags) stays in its original scope.
 * This runs on request copies; user-authored prompt fields are never rewritten.
 */
export function withoutCensorDuplicates(prompt: string, value: unknown): string {
  const tags = censorSpellings(value)
  if (!tags.size) return prompt
  // 줄 단위로도 나눈다 — 주석 뒤에 줄을 바꿔 붙인 태그도 한 태그로 본다
  const strip = (text: string): string =>
    text
      .split('\n')
      .map((line) =>
        line
          .split(',')
          .filter((t) => !tags.has(t.trim().toLowerCase()))
          .join(',')
      )
      .join('\n')
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

/** 프롬프트 맨 끝에 검열 태그를 붙인다. 마지막 줄이 주석이면 줄을 바꿔 붙인다 */
export function withCensorTags(prompt: string, value: unknown): string {
  const extra = censorPrompt(value)
  if (!extra) return prompt
  const clean = withoutCensorDuplicates(prompt, value)
  return clean
    ? `${clean}${commentStart(clean.slice(clean.lastIndexOf('\n') + 1)) !== -1 ? '\n' : ', '}${extra}`
    : extra
}
import { commentStart, removeComments } from './nai-presets'
