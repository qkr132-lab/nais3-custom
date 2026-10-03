import { removeComments } from './nai-presets'
import {
  outfitTags,
  splitPromptTokens,
  tokenTags,
  type Outfit,
  type PieceTrigger,
  type SceneAreas
} from './outfit'

/**
 * nsfw 조각 (커스텀) — 장면에 따라 저절로 켜지는 복장 조각.
 *
 * 씬 태그를 보고 "아래가 드러나야 하는 장면(삽입 등)"이나 "가슴이 드러나야 하는 장면(파이즈리 등)"이면
 * 복장의 nsfw 아래·가슴 조각이 켜진다. 무엇을 젖힐지는 조각에 적힌 태그 그대로다 —
 * 앱이 젖히는 태그를 따로 붙이지 않는다.
 *
 * 복장 탭에선 기본 조각(평소 옷)을 보고 젖히는 태그를 후보로 보여준다. 누르면 nsfw 조각이 된다.
 *   비키니 → bikini bottom aside,   치마 + 팬티 → skirt lift, panties aside
 * 젖히는 태그는 단보루에서 그 옷에 실제로 가장 많이 쓰인 것으로 정했다 (2026-09 사용 수 기준).
 */

export type ExposeArea = 'lower' | 'chest'

/** 부위를 드러내야 하는 행위 태그 목록 — nsfw 조각이 켜지는 장면. 복장 탭에서 고칠 수 있다 */
export interface ExposeActs {
  lower: string[]
  chest: string[]
}

export const DEFAULT_EXPOSE_ACTS: ExposeActs = {
  lower: [
    'sex',
    'vaginal',
    'anal',
    'cunnilingus',
    'fingering',
    'anal fingering',
    'masturbation',
    'female masturbation',
    'clitoral stimulation',
    'pussy',
    'spread pussy',
    'pussy juice',
    'anus',
    'spread anus',
    'cum in pussy',
    'cum in ass',
    'creampie',
    'anal creampie',
    'doggystyle',
    'missionary',
    'cowgirl position',
    'reverse cowgirl position',
    'mating press',
    'full nelson',
    'piledriver (sex)',
    'standing sex',
    'spooning',
    'amazon position',
    'prone bone',
    'suspended congress',
    'sex from behind',
    'sex from above',
    'tribadism',
    'facesitting',
    'anilingus',
    'object insertion',
    'imminent penetration',
    'imminent vaginal',
    'imminent anal',
    'tentacle sex',
    'rape',
    'after sex',
    'after vaginal',
    'after anal',
    'cum on pussy',
    'presenting',
    'dildo riding',
    'sitting on face'
  ],
  chest: [
    'paizuri',
    'breast sucking',
    'nipple sucking',
    'breast grab',
    "grabbing another's breasts",
    'breast fondling',
    'nipple tweak',
    'nipple stimulation',
    'licking nipple',
    'nipples',
    'breastfeeding',
    'lactation',
    'cum on breasts',
    'breasts out',
    'naizuri',
    'nursing handjob',
    'nipple pull'
  ]
}

/** 기본 장면 목록의 판 — 기본 목록에 태그를 더하면 올린다. 저장된 목록이 이 판이 아니면 새 기본 태그를 더한다 */
export const EXPOSE_ACTS_VERSION = 2

/** 저장된 목록에 기본 목록에서 빠진 태그를 더한다 — 앱을 올려 기본이 늘어도 예전에 저장한 목록이 뒤처지지 않게 */
export function withDefaultActs(acts: ExposeActs): ExposeActs {
  const add = (mine: string[], def: string[]): string[] => {
    const have = new Set(mine.map(norm))
    return [...mine, ...def.filter((t) => !have.has(norm(t)))]
  }
  return {
    lower: add(acts.lower, DEFAULT_EXPOSE_ACTS.lower),
    chest: add(acts.chest, DEFAULT_EXPOSE_ACTS.chest)
  }
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
  {
    nouns: ['one-piece swimsuit', 'school swimsuit', 'swimsuit'],
    lower: 'swimsuit aside',
    chest: 'one-piece swimsuit pull'
  },
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

const norm = (t: string): string =>
  t
    .trim()
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^(source|target|mutual)#/, '')
    .replace(/\s+/g, ' ')

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

/**
 * 실제로 보내는 장면 태그만 — 주석(#)은 지우고, 랜덤 선택지 `(a/b)`·와일드카드 토큰은
 * 무엇이 뽑힐지 모르니 신호로 치지 않는다 (누드 판정과 같은 기준)
 */
function liveTagsOf(text: string): string[] {
  const live = removeComments(text ?? '').replace(/\([^()]+\/[^()]+\)/g, ' ')
  return splitPromptTokens(live)
    .filter((t) => !/^-\d*\.?\d+::/.test(t.trim()) && !/[/<>{}|]/.test(t))
    .flatMap(tokenTags)
    .map(norm)
    .filter(Boolean)
}

/**
 * 장면 태그가 행위 태그 그 자체이거나, 행위 태그를 단어 단위로 품고 있으면 그 행위로 본다
 * (standing doggystyle ⊃ doggystyle, spooning sex ⊃ spooning, penis on pussy ⊃ pussy, reverse paizuri ⊃ paizuri).
 * 문장(단어 5개 넘음)은 "her pussy is not shown"처럼 뜻이 반대일 수 있어 그대로 일치할 때만.
 */
function matchesAct(tag: string, acts: readonly string[], exact: ReadonlySet<string>): boolean {
  if (exact.has(tag)) return true
  if (tag.split(' ').length > 5) return false
  return acts.some((a) => a.length < tag.length && hasWords(tag, a))
}

/** 어느 부위를 드러내야 하는지 — 처음 걸린 장면 태그를 이유로 함께 */
export function neededAreas(
  contexts: string[],
  acts: ExposeActs
): Partial<Record<ExposeArea, string>> {
  const lower = acts.lower.map(norm)
  const chest = acts.chest.map(norm)
  const lowerSet = new Set(lower)
  const chestSet = new Set(chest)
  const out: Partial<Record<ExposeArea, string>> = {}
  for (const text of contexts) {
    for (const tag of liveTagsOf(text)) {
      if (!out.lower && matchesAct(tag, lower, lowerSet)) out.lower = tag
      if (!out.chest && matchesAct(tag, chest, chestSet)) out.chest = tag
    }
  }
  return out
}

/**
 * nsfw 조각이 켜지는 조건 — 이 캐릭터에게 걸린 장면 태그(contexts)로 본다.
 * 씬에서 자동 켜기를 껐으면(choice.auto === false) 어느 부위도 켜지지 않는다.
 */
export function triggerAreas(
  contexts: string[],
  acts: ExposeActs,
  choice?: { auto?: boolean }
): SceneAreas {
  if (choice?.auto === false) return {}
  const need = neededAreas(contexts, acts)
  return { lower: !!need.lower, chest: !!need.chest }
}

/**
 * 이 옷을 젖히는 태그 (장면과 무관하게). 그 부위를 가리는 옷 = 그 부위 짝이 있는 옷 —
 * 셔츠만 입었으면 아래는 모르는 것이라 비워 둔다.
 */
export function exposePreview(outfitText: string): Record<ExposeArea, string[]> {
  const g = detectGarments(outfitText)
  const pick = (area: ExposeArea): string[] => [
    ...new Set(g.flatMap((r) => (r[area] ? [r[area] as string] : [])))
  ]
  return { lower: pick('lower'), chest: pick('chest') }
}

/** 복장 탭의 nsfw 조각 후보 — 누르면 이 이름·태그·조건으로 조각이 생긴다 */
export interface ExposeCandidate {
  area: ExposeArea
  name: string
  tags: string
  when: PieceTrigger
}

const CANDIDATE: Record<ExposeArea, { name: string; when: PieceTrigger }> = {
  lower: { name: '젖히기(아래)', when: 'nsfw-lower' },
  chest: { name: '젖히기(가슴)', when: 'nsfw-chest' }
}

/**
 * 기본 조각(평소 옷)을 보고 부위마다 젖히는 태그를 한 조각으로 묶는다.
 * 이미 어느 조각에 적힌 태그는 빼고, 남는 게 없으면 그 부위 후보도 없다.
 */
export function exposeCandidates(outfit: Outfit): ExposeCandidate[] {
  const preview = exposePreview(outfitTags(outfit))
  const present = new Set(outfit.pieces.flatMap((p) => tagsOf(p.tags)))
  return (['lower', 'chest'] as const).flatMap((area) => {
    const tags = preview[area].filter((t) => !present.has(t))
    return tags.length ? [{ area, ...CANDIDATE[area], tags: tags.join(', ') }] : []
  })
}
