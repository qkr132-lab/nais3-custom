import { splitPromptTokens, tokenTags } from './outfit'

/**
 * 옷 입은 채 자동으로 젖히기 (커스텀).
 *
 * 씬 태그를 보고 "아래가 드러나야 하는 장면(삽입 등)"이나 "가슴이 드러나야 하는 장면(파이즈리 등)"이면,
 * 입은 옷 중 그 부위를 가리는 옷을 찾아 그 옷에 맞게 젖히는 태그를 붙인다.
 *   비키니 + 삽입 → bikini bottom aside,   치마 + 팬티 + 삽입 → skirt lift, panties aside
 * 알몸으로 만들지 않는다 — 옷은 입은 채 필요한 곳만 드러난다.
 *
 * 젖히는 태그는 단보루에서 그 옷에 실제로 가장 많이 쓰인 것으로 정했다 (2026-09 사용 수 기준).
 * 복장(조각)에 적힌 옷만 본다 — 카드에 섞인 옷은 건드리지 않아, 복장을 안 쓰는 씬은 그대로다.
 */

export type ExposeArea = 'lower' | 'chest'

/** 부위를 드러내야 하는 행위 태그 목록 — 복장 탭에서 고칠 수 있다 */
export interface ExposeActs {
  lower: string[]
  chest: string[]
}

export const DEFAULT_EXPOSE_ACTS: ExposeActs = {
  lower: [
    'sex', 'vaginal', 'anal', 'cunnilingus', 'fingering', 'anal fingering', 'masturbation',
    'female masturbation', 'clitoral stimulation', 'pussy', 'spread pussy', 'pussy juice', 'anus',
    'spread anus', 'cum in pussy', 'cum in ass', 'creampie', 'anal creampie', 'doggystyle', 'missionary',
    'cowgirl position', 'reverse cowgirl position', 'mating press', 'full nelson', 'piledriver (sex)',
    'standing sex', 'spooning', 'amazon position', 'prone bone', 'suspended congress', 'sex from behind',
    'sex from above', 'tribadism', 'facesitting', 'anilingus', 'object insertion', 'imminent penetration',
    'imminent vaginal', 'imminent anal', 'tentacle sex', 'rape', 'after sex', 'after vaginal', 'after anal',
    'cum on pussy', 'presenting'
  ],
  chest: [
    'paizuri', 'breast sucking', 'nipple sucking', 'breast grab', "grabbing another's breasts",
    'breast fondling', 'nipple tweak', 'nipple stimulation', 'licking nipple', 'nipples', 'breastfeeding',
    'lactation', 'cum on breasts', 'breasts out'
  ]
}

interface GarmentRule {
  /** 옷 이름 (태그 안에 단어 단위로 들어 있으면 그 옷) — 구체적인 것부터 */
  nouns: string[]
  lower?: string
  chest?: string
}

const GARMENTS: GarmentRule[] = [
  { nouns: ['bikini bottom'], lower: 'bikini bottom aside' },
  { nouns: ['bikini top'], chest: 'bikini top lift' },
  // 비키니 아머·스트링 비키니·마이크로 비키니 등
  { nouns: ['bikini'], lower: 'bikini bottom aside', chest: 'bikini top lift' },
  { nouns: ['one-piece swimsuit', 'school swimsuit', 'swimsuit'], lower: 'swimsuit aside', chest: 'one-piece swimsuit pull' },
  { nouns: ['leotard'], lower: 'leotard aside', chest: 'leotard pull' },
  // 짝지은 태그가 없는 쪽은 일반 태그로 (바디수트 아래·유카타 가슴)
  { nouns: ['bodysuit'], lower: 'clothing aside', chest: 'open bodysuit' },
  { nouns: ['dress'], lower: 'dress lift', chest: 'dress pull' },
  { nouns: ['kimono'], lower: 'kimono lift', chest: 'open kimono' },
  { nouns: ['yukata'], lower: 'yukata lift', chest: 'breasts out' },
  { nouns: ['pelvic curtain'], lower: 'pelvic curtain lift' },
  { nouns: ['loincloth'], lower: 'loincloth lift' },
  { nouns: ['thong'], lower: 'thong aside' },
  { nouns: ['panties'], lower: 'panties aside' },
  { nouns: ['skirt', 'miniskirt'], lower: 'skirt lift' },
  { nouns: ['pants', 'jeans', 'trousers'], lower: 'pants pull' },
  { nouns: ['shorts'], lower: 'shorts pull' },
  { nouns: ['pantyhose'], lower: 'pantyhose pull' },
  { nouns: ['buruma'], lower: 'buruma aside' },
  { nouns: ['apron'], lower: 'apron lift' },
  { nouns: ['bra'], chest: 'bra lift' },
  { nouns: ['shirt', 'blouse'], chest: 'shirt lift' },
  { nouns: ['sweater'], chest: 'sweater lift' },
  { nouns: ['hoodie'], chest: 'open hoodie' },
  { nouns: ['jacket', 'blazer'], chest: 'open jacket' },
  { nouns: ['coat'], chest: 'open coat' }
]

/** 이미 드러나 있으면 더 젖힐 필요가 없다 */
const ALREADY_BARE: Record<ExposeArea, string[]> = {
  lower: ['nude', 'completely nude', 'bottomless'],
  chest: ['nude', 'completely nude', 'topless', 'breasts out']
}

const norm = (t: string): string =>
  t.trim().toLowerCase().replace(/_/g, ' ').replace(/^(source|target|mutual)#/, '').replace(/\s+/g, ' ')

/** 태그 목록으로 — 가중치 묶음은 풀고, 빼달라는 음수 가중치는 버린다 */
function tagsOf(text: string): string[] {
  return splitPromptTokens(text)
    .filter((t) => !/^-\d*\.?\d+::/.test(t.trim()))
    .flatMap(tokenTags)
    .map(norm)
    .filter(Boolean)
}

const hasWords = (tag: string, noun: string): boolean =>
  new RegExp(`(^|\\s)${noun.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(tag)

/** 옷 태그에서 입은 옷을 찾는다. 문장(단어 5개 넘는 것)은 옷 이름을 흘릴 수 있어 보지 않는다 */
export function detectGarments(outfitText: string): GarmentRule[] {
  const found: GarmentRule[] = []
  for (const tag of tagsOf(outfitText)) {
    if (tag.split(' ').length > 4) continue
    const rule = GARMENTS.find((g) => g.nouns.some((n) => hasWords(tag, n)))
    if (rule && !found.includes(rule)) found.push(rule)
  }
  return found
}

/** 어느 부위를 드러내야 하는지 — 처음 걸린 행위 태그를 이유로 함께 */
export function neededAreas(contexts: string[], acts: ExposeActs): Partial<Record<ExposeArea, string>> {
  const lower = new Set(acts.lower.map(norm))
  const chest = new Set(acts.chest.map(norm))
  const out: Partial<Record<ExposeArea, string>> = {}
  for (const text of contexts) {
    for (const tag of tagsOf(text)) {
      if (!out.lower && lower.has(tag)) out.lower = tag
      if (!out.chest && chest.has(tag)) out.chest = tag
    }
  }
  return out
}

export interface ExposeTag {
  tag: string
  area: ExposeArea
  /** 이 태그를 붙이게 만든 행위 태그 */
  because: string
}

/**
 * 붙일 젖히기 태그. outfitText = 입은 복장의 켜진 조각 태그, contexts = 이 캐릭터에게 걸린 장면 태그들.
 * 이미 들어 있는 태그는 다시 붙이지 않고, 이미 드러난 부위(nude·topless 등)는 건너뛴다.
 */
export function autoExposeTags(outfitText: string, contexts: string[], acts: ExposeActs): ExposeTag[] {
  const need = neededAreas(contexts, acts)
  if (!need.lower && !need.chest) return []
  const garments = detectGarments(outfitText)
  if (!garments.length) return []
  const present = new Set([outfitText, ...contexts].flatMap(tagsOf))
  const out: ExposeTag[] = []
  for (const area of ['lower', 'chest'] as const) {
    const because = need[area]
    if (!because) continue
    if (ALREADY_BARE[area].some((t) => present.has(t))) continue
    // 그 부위를 가리는 옷 = 그 부위 짝이 있는 옷. 셔츠만 입었으면 아래는 모르는 것 — 안 건드린다
    const tags = garments.flatMap((g) => (g[area] ? [g[area] as string] : []))
    for (const tag of new Set(tags)) {
      if (present.has(tag) || out.some((o) => o.tag === tag)) continue
      out.push({ tag, area, because })
    }
  }
  return out
}

/** 복장 탭에 보여줄 안내 — 이 옷이면 어떤 태그가 붙는지 (장면과 무관하게) */
export function exposePreview(outfitText: string): Record<ExposeArea, string[]> {
  const g = detectGarments(outfitText)
  const pick = (area: ExposeArea): string[] => [
    ...new Set(g.flatMap((r) => (r[area] ? [r[area] as string] : [])))
  ]
  return { lower: pick('lower'), chest: pick('chest') }
}
