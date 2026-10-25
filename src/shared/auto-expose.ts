import { removeComments } from './nai-presets'
import {
  outfitTags,
  splitPromptTokens,
  tokenTags,
  type Outfit,
  type PieceTrigger,
  type SceneAreas
} from './outfit'
import type { ExposeArea } from './types'

/**
 * nsfw 조각 (커스텀) — 장면에 따라 저절로 켜지는 복장 조각.
 *
 * 씬 태그를 보고 "아래가 드러나야 하는 장면(삽입 등)"이나 "가슴이 드러나야 하는 장면(파이즈리 등)"이면
 * 복장의 nsfw 아래·가슴 조각이 켜진다. 무엇을 젖힐지는 조각에 적힌 태그 그대로다.
 *
 * 복장 탭에선 기본 조각(평소 옷)을 보고 젖히는 태그를 후보로 보여준다. 누르면 nsfw 조각이 된다.
 *   비키니 → bikini bottom aside,   치마 + 팬티 → skirt lift, panties aside
 * 젖히는 태그는 단보루에서 그 옷에 실제로 가장 많이 쓰인 것으로 정했다 (2026-09 사용 수 기준).
 *
 * 이 파일의 옷 표(GARMENTS)와 옷 읽기(readGarments)는 「입은 옷 자동 젖힘」(expose-state.ts)도 쓴다 —
 * 조각이 없는 곳(카드에 직접 적은 옷)을 메우려고 카드 글과 켜진 복장 조각에서 입은 옷을 읽어 같은 표로 젖히는 태그를 정한다.
 * 그 계산에서 붙은 태그와 안 붙은 이유는 요청의 exposeNotes 로 늘 화면에 보인다 (몰래 붙이지 않는다).
 * 아래 neededAreas·triggerAreas 는 옛 판정(주인을 따지지 않는 태그 목록 읽기)이며, 입은 옷 자동 젖힘을 끄면 그대로 쓰인다.
 */

export type { ExposeArea }

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
    'internal cumshot',
    'female ejaculation',
    'deep penetration',
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
    'tribadism',
    'anilingus',
    'object insertion',
    'imminent penetration',
    'imminent vaginal',
    'imminent anal',
    'tentacle sex',
    'rape',
    'cum on pussy',
    'presenting',
    'dildo riding',
    'sitting on face',
    'fisting',
    'groping'
  ],
  chest: [
    'paizuri',
    'breast sucking',
    "grabbing another's breast",
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
    'nipple pull',
    'breast punch'
  ]
}

/**
 * 기본 장면 목록의 판 — 저장된 목록이 이 판이 아니면 새 기본 태그를 더한다.
 * 입은 옷 자동 젖힘이 새로 아는 행위(ENGINE_EXTRA_ACTS)는 저장된 목록에 합치지 않으므로 판을 올리지 않는다 —
 * 합치면 자동 젖힘을 꺼도 옛 판정(neededAreas)이 달라져 「끄면 글자 단위로 같음」이 깨진다.
 */
export const EXPOSE_ACTS_VERSION = 4

/**
 * 입은 옷 자동 젖힘이 목록과 상관없이 아는 행위 — 저장된 목록에 없어도 새 판정은 읽는다.
 * (단보루 사용 수: deep penetration 8,578 · internal cumshot 11,322 · female ejaculation 14,077 · groping 121,503 ·
 * grabbing another's breast 87,127). 옛 판정은 이 표를 쓰지 않는다.
 */
export const ENGINE_EXTRA_ACTS: ExposeActs = {
  lower: ['deep penetration', 'internal cumshot', 'female ejaculation', 'groping'],
  chest: ["grabbing another's breast"]
}

const engineActsCache = new WeakMap<ExposeActs, ExposeActs>()

/** 저장된(또는 기본) 행위 목록에 엔진 내장 행위를 더한 것 — 같은 목록 객체에는 같은 결과(읽기 기억이 목록 객체로 열쇠를 삼는다) */
export function engineActs(acts: ExposeActs): ExposeActs {
  const hit = engineActsCache.get(acts)
  if (hit) return hit
  const add = (mine: string[], extra: string[]): string[] => {
    const have = new Set(mine.map(norm))
    return [...mine, ...extra.filter((t) => !have.has(norm(t)))]
  }
  const made = {
    lower: add(acts.lower, ENGINE_EXTRA_ACTS.lower),
    chest: add(acts.chest, ENGINE_EXTRA_ACTS.chest)
  }
  engineActsCache.set(acts, made)
  return made
}

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

/**
 * 옷 한 벌(규칙) — nouns 중 하나가 낱말 단위로 들어 있으면 그 옷이다.
 * lower/chest = 그 옷을 젖히는 태그 (그 옷 하나에 대한 것, 여럿이면 병기).
 * layer = 겹침 순서(작을수록 겉) — 겉옷 0 · 윗옷·아랫옷 1 · 스타킹 2 · 수영복·바디수트 3 · 속옷 4
 */
export interface GarmentRule {
  /** 옷 이름 (태그 안에 단어 단위로 들어 있으면 그 옷) — 구체적인 것부터 */
  nouns: string[]
  lower?: string[]
  chest?: string[]
  layer: number
}

const GARMENTS: GarmentRule[] = [
  { nouns: ['bikini bottom', 'bikini bottoms'], lower: ['bikini bottom aside'], layer: 3 },
  { nouns: ['bikini top'], chest: ['bikini top lift'], layer: 3 },
  // 비키니 아머·스트링 비키니·마이크로 비키니 등
  { nouns: ['bikini'], lower: ['bikini bottom aside'], chest: ['bikini top lift'], layer: 3 },
  {
    nouns: ['one-piece swimsuit', 'school swimsuit', 'swimsuit'],
    lower: ['swimsuit aside'],
    chest: ['one-piece swimsuit pull'],
    layer: 3
  },
  { nouns: ['leotard'], lower: ['leotard aside'], chest: ['leotard pull'], layer: 3 },
  // 짝지은 태그가 없는 쪽은 일반 태그로 (바디수트 아래)
  { nouns: ['bodysuit'], lower: ['clothing aside'], chest: ['open bodysuit'], layer: 3 },
  {
    nouns: ['dress', 'evening gown', 'gown', 'sundress', 'nightgown'],
    lower: ['dress lift'],
    chest: ['dress pull'],
    layer: 1
  },
  { nouns: ['kimono'], lower: ['kimono lift'], chest: ['open kimono'], layer: 1 },
  // yukata lift(100)·breasts out 보다 단보루에서 옷에 더 맞는 기모노 태그로 (별칭 open yukata)
  { nouns: ['yukata'], lower: ['kimono lift'], chest: ['open kimono'], layer: 1 },
  { nouns: ['pelvic curtain'], lower: ['pelvic curtain lift'], layer: 1 },
  // loincloth lift 는 165건뿐이라 일반 태그로
  { nouns: ['loincloth'], lower: ['clothing aside'], layer: 1 },
  { nouns: ['thong', 'g-string'], lower: ['thong aside'], layer: 4 },
  { nouns: ['fundoshi'], lower: ['fundoshi aside'], layer: 4 },
  { nouns: ['panties'], lower: ['panties aside'], layer: 4 },
  { nouns: ['skirt', 'miniskirt', 'microskirt'], lower: ['skirt lift'], layer: 1 },
  // 바지는 내리는 것과 앞섶을 여는 것을 병기 (남캐 바지는 open fly 가 더 흔하다)
  {
    nouns: ['pants', 'jeans', 'trousers', 'sweatpants'],
    lower: ['pants pull', 'open fly'],
    layer: 1
  },
  { nouns: ['shorts'], lower: ['shorts pull'], layer: 1 },
  { nouns: ['pantyhose'], lower: ['pantyhose pull', 'torn pantyhose'], layer: 2 },
  { nouns: ['buruma'], lower: ['buruma aside'], layer: 1 },
  { nouns: ['apron'], lower: ['apron lift'], layer: 0 },
  { nouns: ['bra'], chest: ['bra lift'], layer: 4 },
  // crop top lift(161)는 약해서 셔츠 태그로 (별칭 top lift)
  {
    nouns: ['shirt', 'blouse', 't-shirt', 'tank top', 'camisole', 'crop top'],
    chest: ['shirt lift'],
    layer: 1
  },
  // tube top lift 는 239건뿐이라 일반 태그로
  { nouns: ['tube top'], chest: ['breasts out'], layer: 1 },
  { nouns: ['sweater'], chest: ['sweater lift'], layer: 1 },
  { nouns: ['hoodie'], chest: ['open hoodie'], layer: 0 },
  { nouns: ['cardigan'], chest: ['open cardigan'], layer: 0 },
  { nouns: ['jacket', 'blazer', 'tailcoat', 'tuxedo'], chest: ['open jacket'], layer: 0 },
  { nouns: ['coat'], chest: ['open coat'], layer: 0 },
  { nouns: ['vest'], chest: ['open vest'], layer: 0 },
  { nouns: ['robe'], lower: ['open robe'], chest: ['open robe'], layer: 0 }
  // 전용 젖힘 태그가 없는 armor·cape·halterneck·corset 은 일부러 뺀다
]

export const norm = (t: string): string =>
  t
    .trim()
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^(source|target|mutual)#/, '')
    .replace(/\s+/g, ' ')

/** 빼달라는 묶음 — 음수 가중치(-1::x::)와 0 가중치(0::x::, 효과를 없애는 표기) */
export const isOffWeight = (token: string): boolean =>
  /^-\d*\.?\d+::/.test(token.trim()) || /^\+?0*\.?0+::/.test(token.trim())

/** 태그 목록으로 — 가중치 묶음은 풀고, 빼달라는 음수·0 가중치는 버린다 */
export function tagsOf(text: string): string[] {
  return splitPromptTokens(text)
    .filter((t) => !isOffWeight(t))
    .flatMap(tokenTags)
    .map(norm)
    .filter(Boolean)
}

export const hasWords = (tag: string, noun: string): boolean =>
  new RegExp(`(^|\\s)${noun.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(tag)

/** 옷 낱말 앞에 오면 그 옷은 입은 게 아니다 — no panties · without a bra · not wearing a dress · unworn bikini top · took off her jacket */
const NOT_WORN_BEFORE = new Set([
  'no',
  'not',
  'without',
  'never',
  'unworn',
  'removed',
  'remove',
  'off',
  'discarded',
  'missing',
  'minus',
  'nothing',
  'undressed',
  // 손에 든 것·냄새 맡는 것은 입은 옷이 아니다
  'holding',
  'holds',
  'carrying',
  'sniffing'
])

/** 옷 낱말 뒤에 이런 자리가 오면 몸에 입은 게 아니다 — panties on head · jacket on shoulders · panties around one leg */
const NOT_WORN_AFTER =
  /^(?:(?:on|around|over|in|at|between|beside|near|under) (?:(?:her|his|the|one|a|an|both|own) )*(?:head|shoulders?|neck|legs?|ankles?|thighs?|knees?|floor|ground|bed|chair|table|hands?|face|mouth|arms?|wrists?|hair|bag|breasts?|cleavage|teeth|fingers?|lips)|removed|taken off|pulled off|discarded)\b/
/** 허리에 묶은 윗옷(jacket around waist)은 몸을 안 가린다 — 치마·바지가 허리에 걸린 것은 입은 것이라 윗옷에만 */
const TIED_AT_WAIST = /^(?:on|around) (?:(?:her|his|the|one|a|an|both|own) )*waist\b/

/** 낱말 앞에 붙어 옷 모양을 바꾸는 말 — dress shirt 는 셔츠, dress shoes 는 신발 */
const DRESS_MODIFIED =
  /\bdress (shirt|shoes|pants|socks|boots|bow|flower|code|hat|gloves|ribbon|coat|jacket|vest|belt|tie|up)\b/g

/** 입는 옷이 아닌 어구 — bikini tan 은 태닝 자국 */
const NOT_GARMENT_PHRASE = /\b(?:bikini|swimsuit|one-piece) tan(?:line|lines)?\b|\btan lines?\b/g

/** 이미 열려 있는 설계인 옷 — 컵이 없는 브라·가랑이가 트인 팬티 */
const OPEN_BY_DESIGN_CHEST =
  /\b(?:cupless|open-cup|open cup)\b|\bnipple cutouts?\b|\bbreast curtains\b|\bo-ring top\b/
const OPEN_BY_DESIGN_LOWER = /\b(?:crotchless|open-crotch|open crotch)\b/

/** 읽은 옷 하나 */
export interface WornGarment {
  rule: GarmentRule
  /** 이 옷을 읽은 글 조각 (소문자) */
  fragment: string
  /** naked apron — 이것 한 겹만 입고 속은 맨몸 */
  alone: boolean
}

/** 쉼표 토막 안 낱말 번호 i 에서 시작해 noun(여러 낱말)과 같은지 */
function matchAt(words: string[], i: number, noun: string[]): boolean {
  return noun.every((w, k) => words[i + k] === w)
}

/**
 * 글에서 입은 옷을 읽는다 — 토막 안 낱말 단위로 보고(문장도 읽는다), 입지 않은 것은 뺀다:
 * 음수 가중치 안 · no/without/not · unworn · 머리/어깨/허리에 걸친 것 · dress shirt/shoes · bikini tan · cupless/crotchless.
 * 한 토막에 여러 벌이 있으면 모두 (bikini top 이 잡히면 같은 자리의 bikini 는 다시 안 잡는다).
 */
export function readGarments(outfitText: string): WornGarment[] {
  const found: WornGarment[] = []
  const live = removeComments(outfitText ?? '')
  for (const token of splitPromptTokens(live)) {
    if (isOffWeight(token)) continue
    for (const raw of tokenTags(token)) {
      const fragment = norm(raw)
        .replace(DRESS_MODIFIED, (_m, w: string) => w)
        .replace(NOT_GARMENT_PHRASE, ' ')
      const words = fragment.split(/[^a-z0-9'-]+/).filter(Boolean)
      if (!words.length) continue
      const alone = words.includes('naked')
      const used = new Array<boolean>(words.length).fill(false)
      for (const rule of GARMENTS) {
        for (const noun of rule.nouns) {
          const parts = noun.split(' ')
          for (let i = 0; i + parts.length <= words.length; i++) {
            if (!matchAt(words, i, parts) || used.slice(i, i + parts.length).some(Boolean)) continue
            for (let k = 0; k < parts.length; k++) used[i + k] = true
            // 입은 게 아닌 자리인지
            const before = words.slice(Math.max(0, i - 3), i)
            // off shoulder dress 의 off 는 벗었다는 뜻이 아니고, nothing but panties 는 그 옷만 입었다는 뜻이다
            if (
              before.some(
                (w, k) =>
                  NOT_WORN_BEFORE.has(w) &&
                  !(w === 'off' && before[k + 1] === 'shoulder') &&
                  !(w === 'nothing' && before[k + 1] === 'but')
              )
            )
              continue
            if (
              before.length &&
              /^(cupless|crotchless|open-cup|open-crotch)$/.test(before[before.length - 1])
            )
              continue
            const after = words.slice(i + parts.length, i + parts.length + 5).join(' ')
            if (NOT_WORN_AFTER.test(after)) continue
            if (TIED_AT_WAIST.test(after) && rule.chest && !rule.lower) continue
            if (!found.some((f) => f.rule === rule && f.fragment === fragment))
              found.push({ rule, fragment, alone })
          }
        }
      }
    }
  }
  return found
}

/** 글 속 옷이 이미 열려 있는 설계인 부위 — cupless bra(가슴)·crotchless panties(아래) */
export function openByDesign(text: string): Partial<Record<ExposeArea, string>> {
  const out: Partial<Record<ExposeArea, string>> = {}
  for (const tag of tagsOf(removeComments(text ?? ''))) {
    if (!out.chest && OPEN_BY_DESIGN_CHEST.test(tag)) out.chest = tag
    if (!out.lower && OPEN_BY_DESIGN_LOWER.test(tag)) out.lower = tag
  }
  return out
}

/** 옷 태그에서 입은 옷을 찾는다 (나온 순서, 겹침 순서 아님) */
export function detectGarments(outfitText: string): GarmentRule[] {
  const rules: GarmentRule[] = []
  for (const g of readGarments(outfitText)) if (!rules.includes(g.rule)) rules.push(g.rule)
  return rules
}

/** 부위당 붙이는 젖힘 태그 최대 수 */
export const MAX_LAYER_TAGS = 3

/**
 * 그 부위를 젖히는 태그를 겉에서 속으로 — 겹(규칙)마다 대표 태그 하나, 부위당 최대 MAX_LAYER_TAGS 개.
 * 겹이 상한을 넘으면 같은 겹 순서(겉옷끼리 등)는 하나만 남겨 서로 다른 겹을 살리고, 그래도 넘으면 가장 안쪽 겹을 지키고
 * 나머지를 겉에서부터 채운다 (몸을 실제로 가리는 속옷이 빠지면 젖힘이 소용없다).
 * 병기 태그(open fly · torn pantyhose)는 자리가 남을 때만 그 겹 바로 뒤에 붙는다.
 */
export function layeredTags(rules: readonly GarmentRule[], area: ExposeArea): string[] {
  const picked = rules
    .map((rule, order) => ({ rule, order }))
    .filter((r) => r.rule[area]?.length)
    .sort((a, b) => a.rule.layer - b.rule.layer || a.order - b.order)
  let reps: { rule: GarmentRule; tag: string }[] = []
  for (const { rule } of picked) {
    const tag = (rule[area] as string[])[0]
    if (!reps.some((r) => r.tag === tag)) reps.push({ rule, tag })
  }
  if (reps.length > MAX_LAYER_TAGS) {
    // 같은 겹 순서는 하나만 (jacket+hoodie → jacket)
    const layers = new Set<number>()
    reps = reps.filter((r) => {
      if (layers.has(r.rule.layer)) return false
      layers.add(r.rule.layer)
      return true
    })
  }
  if (reps.length > MAX_LAYER_TAGS)
    reps = [...reps.slice(0, MAX_LAYER_TAGS - 1), reps[reps.length - 1]]
  const out = reps.map((r) => r.tag)
  // 자리가 남으면 병기 태그를 그 겹 바로 뒤에
  let room = MAX_LAYER_TAGS - out.length
  for (let k = reps.length - 1; k >= 0 && room > 0; k--) {
    const extra = (reps[k].rule[area] as string[]).slice(1).filter((t) => !out.includes(t))
    const take = extra.slice(0, room)
    if (!take.length) continue
    out.splice(out.indexOf(reps[k].tag) + 1, 0, ...take)
    room -= take.length
  }
  return out
}

/** 옷 표의 젖힘 태그 → 그 태그가 드러내는 부위 (skirt lift=아래, shirt lift=가슴, open robe=둘 다) */
const OPENER_AREAS: ReadonlyMap<string, readonly ExposeArea[]> = (() => {
  const map = new Map<string, Set<ExposeArea>>()
  for (const rule of GARMENTS) {
    for (const area of ['lower', 'chest'] as const) {
      for (const tag of rule[area] ?? []) {
        const set = map.get(tag) ?? new Set<ExposeArea>()
        set.add(area)
        map.set(tag, set)
      }
    }
  }
  return new Map([...map].map(([tag, areas]) => [tag, [...areas]]))
})()

/** 이 태그가 옷 표의 젖힘 태그면 그 부위 (아니면 []) */
export const garmentOpenerAreas = (tag: string): readonly ExposeArea[] =>
  OPENER_AREAS.get(tag) ?? []

/**
 * 실제로 보내는 장면 태그만 — 주석(#)은 지우고, 랜덤 선택지 `(a/b)`·와일드카드 토큰은
 * 무엇이 뽑힐지 모르니 신호로 치지 않는다 (누드 판정과 같은 기준)
 */
export function liveTagsOf(text: string): string[] {
  const live = removeComments(text ?? '').replace(/\([^()]+\/[^()]+\)/g, ' ')
  return splitPromptTokens(live)
    .filter((t) => !/^-\d*\.?\d+::/.test(t.trim()) && !/[/<>{}|]/.test(t))
    .flatMap(tokenTags)
    .map(norm)
    .filter(Boolean)
}

/** liveTagsOf 와 같되 0 가중치 묶음(0::x::)도 뺀다 — 입은 옷 자동 젖힘이 읽는 글 (옛 판정은 liveTagsOf 그대로 쓴다) */
export function engineTagsOf(text: string): string[] {
  const live = removeComments(text ?? '').replace(/\([^()]+\/[^()]+\)/g, ' ')
  return splitPromptTokens(live)
    .filter((t) => !isOffWeight(t) && !/[/<>{}|]/.test(t))
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

/**
 * 옷 위를 뜻하는 태그 — 젖은 자국(pussy juice stain)·가린 것(covered nipples)·옷 너머로 비침·패스티.
 * 이 태그 자체는 신호가 아니고, 있으면 그 부위는 옷을 입은 채라고 본다.
 */
const CLOTHED_MARK =
  /(^|\s)(stain|stains)$|^covered\s|\bthrough (clothes|clothing|panties)\b|\bpasties\b/
const CHEST_WORDS = /\b(breast|breasts|nipple|nipples|chest|areola|areolae)\b/

/** 옷 위 태그가 가리키는 부위 */
const clothedArea = (tag: string): ExposeArea | null =>
  CLOTHED_MARK.test(tag) ? (CHEST_WORDS.test(tag) ? 'chest' : 'lower') : null

/**
 * 몸 부위·체액 이름만 걸린 약한 신호 — pussy juice, hand on pussy, pussy focus처럼 옷 위로도 되는 것.
 * 그 부위에 옷 위 태그가 있으면 이것만으로는 켜지 않는다. 행위 태그(vaginal·doggystyle 등)는 그대로 켠다.
 */
export const WEAK_ACTS = new Set([
  'pussy',
  'pussy juice',
  'anus',
  'nipples',
  'groping',
  "grabbing another's breast"
])
/** 옛 판정이 약하다고 보는 목록 — 입은 옷 자동 젖힘을 꺼도 출력이 같아야 하니 이 기능 전의 4개 그대로 둔다 */
const LEGACY_WEAK_ACTS = new Set(['pussy', 'pussy juice', 'anus', 'nipples'])
const isWeakHit = (tag: string, acts: readonly string[]): boolean =>
  !acts.some(
    (a) =>
      !LEGACY_WEAK_ACTS.has(a) &&
      (a === tag || (tag.split(' ').length <= 5 && a.length < tag.length && hasWords(tag, a)))
  )

/**
 * 얼굴만 나오는 자리 — 자리 태그에 inset·portrait·close-up이 있으면 몸이 화면에 없다.
 * 이런 자리는 씬 전체 태그로 조각을 켜지 않고, 자리 태그에 직접 적은 노출 태그로만 켠다.
 */
export function isFaceSeat(seatTags: string): boolean {
  return liveTagsOf(seatTags).some(
    (t) => hasWords(t, 'inset') || t === 'portrait' || t === 'close-up'
  )
}

/** 어느 부위를 드러내야 하는지 — 처음 걸린 장면 태그를 이유로 함께 */
export function neededAreas(
  contexts: string[],
  acts: ExposeActs
): Partial<Record<ExposeArea, string>> {
  const list: Record<ExposeArea, string[]> = {
    lower: acts.lower.map(norm),
    chest: acts.chest.map(norm)
  }
  const sets: Record<ExposeArea, Set<string>> = {
    lower: new Set(list.lower),
    chest: new Set(list.chest)
  }
  const tags = contexts.flatMap(liveTagsOf)
  // 옷 위 태그가 있는 부위
  const clothed = new Set(tags.map(clothedArea).filter((a): a is ExposeArea => !!a))
  const out: Partial<Record<ExposeArea, string>> = {}
  for (const tag of tags) {
    if (clothedArea(tag)) continue
    for (const area of ['lower', 'chest'] as const) {
      if (out[area] || !matchesAct(tag, list[area], sets[area])) continue
      if (clothed.has(area) && isWeakHit(tag, list[area])) continue
      out[area] = tag
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
  choice?: { auto?: boolean },
  /** 당하는쪽이면 하는쪽 태그 — 하는쪽이 상대 몸에 하는 행위(breast punch·vaginal 등)도 신호로 본다 */
  partner: string[] = []
): SceneAreas {
  if (choice?.auto === false) return {}
  const need = neededAreas(contexts, acts)
  const by = partner.length ? partnerAreas(partner, acts) : {}
  return { lower: !!need.lower || !!by.lower, chest: !!need.chest || !!by.chest }
}

/**
 * 하는쪽 자기 몸 이야기 — 상대를 드러낼 신호가 아니다
 * (하는쪽이 자위하거나·제 몸을 내보이거나·상대 얼굴에 앉는 것).
 */
const SELF_ACTS = new Set([
  'masturbation',
  'female masturbation',
  'clitoral stimulation',
  'pussy',
  'spread pussy',
  'pussy juice',
  'anus',
  'spread anus',
  'presenting',
  'dildo riding',
  'sitting on face',
  'facesitting',
  'nipples',
  'breasts out',
  'lactation',
  'breastfeeding',
  'nursing handjob'
])

/** 하는쪽 태그 가운데 상대 몸에 하는 행위로 드러날 부위 */
export function partnerAreas(partner: string[], acts: ExposeActs): SceneAreas {
  const others = (list: string[]): string[] => list.filter((a) => !SELF_ACTS.has(norm(a)))
  const need = neededAreas(partner, { lower: others(acts.lower), chest: others(acts.chest) })
  return { lower: !!need.lower, chest: !!need.chest }
}

/**
 * 이 옷을 젖히는 태그 (장면과 무관하게). 그 부위를 가리는 옷 = 그 부위 짝이 있는 옷 —
 * 셔츠만 입었으면 아래는 모르는 것이라 비워 둔다.
 */
export function exposePreview(outfitText: string): Record<ExposeArea, string[]> {
  const g = detectGarments(outfitText)
  return { lower: layeredTags(g, 'lower'), chest: layeredTags(g, 'chest') }
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
