import { removeComments } from './nai-presets'

export interface SceneBackground {
  prompt: string
  placement: 'before-scene' | 'after-scene'
  replaceSimple: boolean
}

export function normalizeBackground(raw: unknown): SceneBackground {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      raw = null
    }
  }
  const v = raw as Partial<SceneBackground> | null
  return {
    prompt: typeof v?.prompt === 'string' ? v.prompt : '',
    placement: v?.placement === 'before-scene' ? 'before-scene' : 'after-scene',
    replaceSimple: v?.replaceSimple === true
  }
}

const SIMPLE =
  /^(?:simple|white|pink|black|grey|gray|red|blue|green|yellow|orange|purple|brown|beige|solid|plain|transparent) background$/i

/** Conservative: never split a weighted group or alter negative emphasis / free prose. */
export function stripSimpleBackgrounds(prompt: string): string {
  prompt = removeComments(prompt)
  // Track all emphasis delimiters so commas inside a group remain untouched.
  const parts: string[] = []
  let start = 0
  let weighted = false
  let depth = 0
  for (let i = 0; i < prompt.length; i++) {
    if (prompt.startsWith('::', i)) {
      weighted = !weighted
      i++
      continue
    }
    if ('{['.includes(prompt[i])) depth++
    if ('}]'.includes(prompt[i])) depth--
    if (prompt[i] === ',' && !weighted && depth === 0) {
      parts.push(prompt.slice(start, i))
      start = i + 1
    }
  }
  parts.push(prompt.slice(start))
  const keep = parts.filter((part) => {
    const t = part.trim().replace(/_/g, ' ')
    if (SIMPLE.test(t)) return false
    const weight = t.match(/^(\d+(?:\.\d+)?)::\s*([^,:]+)\s*::$/)
    return !(weight && Number(weight[1]) > 0 && SIMPLE.test(weight[2].trim()))
  })
  // Return original text byte-for-byte when no recognized standalone tag was removed.
  return keep.length === parts.length
    ? prompt
    : keep
        .map((p) => p.trim())
        .filter(Boolean)
        .join(', ')
}
