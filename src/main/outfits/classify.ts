import { existsSync, readFileSync } from 'node:fs'
import type { TagKind } from '../../shared/outfit'
import { extraKoPath } from '../tags'

/**
 * 옷 태그 알아보기 (커스텀) — 카드에서 옷을 떼어낼 때, 복장에 상태 후보를 깔아줄 때 쓴다.
 *
 * 사용자 PC의 한글 태그 자료(tag-ko-extra.json)에 분류가 있으면 그걸 쓰고,
 * 없으면(다른 PC) 흔한 옷 이름 몇 개로만 알아본다 — 모르면 카드에 남기니 틀려도 안전하다.
 */

interface Info {
  ko: string
  /** "대분류/소분류" (영어) */
  category: string
  count: number
}

let data: Map<string, Info> | null = null

const norm = (s: string): string => s.trim().toLowerCase().replace(/_/g, ' ')

function load(): Map<string, Info> {
  if (data) return data
  data = new Map()
  try {
    const path = extraKoPath()
    if (path && existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { tags?: Record<string, unknown> }
      for (const [tag, v] of Object.entries(parsed.tags ?? {})) {
        if (!Array.isArray(v)) continue
        data.set(norm(tag), {
          ko: typeof v[0] === 'string' ? v[0] : '',
          category: typeof v[3] === 'string' ? v[3] : '',
          count: typeof v[4] === 'number' ? v[4] : 0
        })
      }
    }
  } catch {
    data = new Map()
  }
  return data
}

/** 분류 자료가 있는지 — 없으면 화면에서 "흔한 옷만 알아본다"고 알린다 */
export function hasClothingData(): boolean {
  for (const v of load().values()) if (v.category) return true
  return false
}

/** 사전에 그대로 없으면 앞 단어를 떼어가며 찾는다 — 'purple latex gloves' → 'latex gloves' */
function resolve(tag: string): string | null {
  const words = norm(tag).split(/\s+/)
  const d = load()
  for (let i = 0; i < words.length; i++) {
    const cand = words.slice(i).join(' ')
    if (d.has(cand)) return cand
  }
  return null
}

// 자료가 없을 때만 쓰는 흔한 옷 이름 (마지막 단어 기준)
const CLOTH_NOUNS = new Set([
  'shirt', 'blouse', 'skirt', 'miniskirt', 'pants', 'shorts', 'jeans', 'dress', 'jacket', 'coat',
  'hoodie', 'sweater', 'cardigan', 'vest', 'uniform', 'bikini', 'swimsuit', 'leotard', 'bodysuit',
  'gloves', 'thighhighs', 'pantyhose', 'socks', 'kneehighs', 'stockings', 'leggings', 'boots',
  'shoes', 'heels', 'sandals', 'sneakers', 'loafers', 'apron', 'kimono', 'yukata', 'armor', 'cape',
  'cloak', 'robe', 'bra', 'panties', 'underwear', 'lingerie', 'garter', 'belt', 'sleeves', 'overalls',
  'top', 'camisole', 'corset', 'serafuku', 'blazer', 'necktie', 'scarf', 'tabard', 'tunic'
])
const BARE = new Set(['nude', 'completely nude', 'naked', 'topless', 'bottomless', 'bare'])
// 장신구·안경은 캐릭터 얼굴의 일부에 가까워 기본은 카드에 남긴다 (떼어낼지는 미리보기에서 고른다).
// 사이트 분류의 "액세서리"엔 장갑·넥타이·벨트처럼 옷인 것도 섞여 있어 소분류 통째로 남기지 않는다
const KEEP_ON_CARD_NOUNS = new Set([
  'earrings', 'earring', 'necklace', 'jewelry', 'glasses', 'eyewear', 'sunglasses', 'monocle',
  'bracelet', 'bracelets', 'ring', 'piercing', 'choker', 'pendant', 'tattoo'
])

/** 태그 하나가 옷 / 알몸·노출 / 몸 / 모름 중 무엇인지 */
export function classifyTag(tag: string): TagKind {
  const t = norm(tag)
  if (BARE.has(t)) return 'bare'
  const base = resolve(t)
  if (base) {
    const [major, minor] = load().get(base)!.category.split('/')
    if (major === 'Adult Content' && minor === 'Exposure') return 'bare'
    if (major === 'Clothing and Accessories') {
      const last = base.split(/\s+/).pop() ?? ''
      // 머리 장식(머리핀·머리 리본)은 카드에, 모자·헬멧은 옷으로
      if (minor === 'Headwear and Headgear') return /\bhair/.test(base) ? 'body' : 'cloth'
      return KEEP_ON_CARD_NOUNS.has(last) ? 'body' : 'cloth'
    }
    if (major === 'Adult Content' && minor === 'Clothing & Accessories') return 'cloth'
    if (major) return 'body'
  }
  const last = t.split(/\s+/).pop() ?? ''
  if (CLOTH_NOUNS.has(last) || CLOTH_NOUNS.has(last.replace(/s$/, ''))) return 'cloth'
  return base ? 'body' : 'unknown'
}

/** 태그의 한글 이름 (없으면 빈 문자열) — 조각 이름을 지을 때 */
export function tagKo(tag: string): string {
  const base = resolve(tag)
  return base ? load().get(base)!.ko : ''
}

// 옷 이름과 짝지을 상태 단어 — "그 옷이 어떤 상태인가"를 말하는 태그만 후보로
const STATE_WORDS = new Set([
  'lift', 'lifted', 'pull', 'aside', 'down', 'open', 'unzipped', 'unbuttoned', 'removed', 'off',
  'undone', 'untied', 'torn', 'wet', 'partially', 'around', 'tug', 'peek', 'slip'
])

/**
 * 이 옷들에 맞는 착의 상태 후보. 상태 태그에 그 옷 이름이 들어 있을 때만 짝짓는다 —
 * 비키니엔 bikini pull, 스타킹엔 torn thighhighs. 치마 없는 옷에 skirt lift는 안 나온다.
 */
export function stateCandidates(
  clothTags: string[],
  limit = 24
): { tag: string; ko: string; count: number }[] {
  const nouns = new Set<string>()
  for (const t of clothTags) {
    const base = resolve(t) ?? norm(t)
    const last = base.split(/\s+/).pop()
    if (last) {
      nouns.add(last)
      nouns.add(last.replace(/(es|s)$/, ''))
    }
  }
  if (!nouns.size) return []
  const out: { tag: string; ko: string; count: number }[] = []
  for (const [tag, info] of load()) {
    const [major, minor] = info.category.split('/')
    // 옷 이름 자체(down jacket 같은)는 상태가 아니다. 상태 태그는 복장/상태·성인용/노출뿐 아니라
    // 포즈/어필 자세(skirt lift, pants pull)에도 흩어져 있어 분류로 거르지 않는다
    if (major === 'Clothing and Accessories' && minor !== 'State') continue
    const words = tag.split(/\s+/)
    if (!words.some((w) => STATE_WORDS.has(w))) continue
    if (!words.some((w) => nouns.has(w) || nouns.has(w.replace(/(es|s)$/, '')))) continue
    out.push({ tag, ko: info.ko, count: info.count })
  }
  return out.sort((a, b) => b.count - a.count).slice(0, limit)
}
