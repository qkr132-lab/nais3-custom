import { commentStart, removeComments } from './nai-presets'
import {
  activePieces,
  outfitTags,
  resolveOutfit,
  splitPromptTokens,
  tokenTags,
  type Outfit,
  type OutfitChoice,
  type SceneAreas,
  type TagKind
} from './outfit'

/**
 * 누드면 옷 벗기기 (커스텀).
 *
 * 목욕 씬처럼 장면에 nude·completely nude를 넣어도 카드·복장의 옷 태그가 그대로 붙어
 * 옷을 입은 채 나왔다. 이 캐릭터에게 걸린 장면 태그에 누드가 있으면, 카드의 기본 복장을
 * 빼고 카드 프롬프트에서 옷 태그만 걷어낸다. 씬·큐 항목에서 직접 고른 복장은 그대로 둔다
 * (누드 씬에 일부러 고른 스타킹·초커 같은 것). 설정에서 끌 수 있다.
 *
 * naked towel·naked apron처럼 "naked + 한 가지"는 단보루에서 "그것만 걸친 알몸"이라
 * 같이 본다 — 수건·앞치마는 장면 태그에 있으니 그대로 남는다.
 *
 * 복장 안의 누드 조각(상태·nsfw 조각에 nude를 적어 둔 것)이 켜져도 같다 — 그 복장의 다른 조각에서
 * 몸에 걸친 옷을 빼고, 카드의 옷 태그도 걷어낸다. 벗길 때도 머리·얼굴 장비(모자·두건·헬멧·
 * 가면·베일·안대·고글·머리 장식)는 남긴다 — 캐릭터의 얼굴을 정하는 설정이라.
 */

const NUDE_TAGS = new Set(['nude', 'completely nude'])

const norm = (t: string): string =>
  t
    .trim()
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^(source|target|mutual)#/, '')
    .replace(/\s+/g, ' ')

const isNudeTag = (tag: string): boolean => NUDE_TAGS.has(tag) || tag.startsWith('naked ')

const isNegativeWeight = (token: string): boolean => /^-\d*\.?\d+::/.test(token.trim())

/** 와일드카드·조각 문법이 든 토큰 — 무엇이 뽑힐지 모르니 판단에서 뺀다 (a/b, <조각>, {…}) */
const isWildcard = (token: string): boolean => /[/<>{}|]/.test(token)

/**
 * 장면 태그들에서 처음 찾은 누드 태그 (없으면 null).
 * 실제로 보내는 글과 같게 본다 — 주석(#)은 지우고, 랜덤 선택지 `(a, nude/b, swimsuit)`와
 * 와일드카드 토큰은 뽑힐지 모르니 신호로 치지 않는다. 빼달라는 음수 가중치도 안 본다.
 */
export function nudeTrigger(contexts: string[]): string | null {
  for (const text of contexts) {
    const live = removeComments(text ?? '').replace(/\([^()]+\/[^()]+\)/g, ' ')
    for (const token of splitPromptTokens(live)) {
      if (isNegativeWeight(token) || isWildcard(token)) continue
      const hit = tokenTags(token).map(norm).find(isNudeTag)
      if (hit) return hit
    }
  }
  return null
}

/** 옷 벗기기를 가를 때의 남캐·여캐 */
export type NudeStripSex = 'male' | 'female'

/**
 * 씬의 「옷 벗기기」 값 (커스텀) — 누구를 벗길지.
 * true = 둘 다(옛 값 그대로) · false = 안 벗김 · 'male' = 남캐만 · 'female' = 여캐만.
 * 값이 없으면(undefined) 설정 창의 전체 설정을 따른다 — 장면 태그에 nude 가 있을 때만 벗기는 쪽.
 * 옛 파일·DB 에 든 true/false 가 그대로 읽히도록 「둘 다」를 새 문자열로 바꾸지 않고 true 로 둔다.
 */
export type NudeStripSetting = boolean | NudeStripSex

/**
 * 저장·파일에서 읽은 값을 정리한다 — 알 수 없는 값은 undefined(= 전체 설정 따름).
 * 'both' 는 옛 true 와 같은 뜻으로 받아 준다 (쓰지는 않는다).
 */
export function normalizeNudeStrip(value: unknown): NudeStripSetting | undefined {
  if (typeof value === 'boolean') return value
  if (value === 'male' || value === 'female') return value
  if (value === 'both') return true
  return undefined
}

/** 고를 수 있는 값 — 메뉴 순서. value 가 undefined 면 「전체 설정 따름」 */
export const NUDE_STRIP_CHOICES: readonly { value: NudeStripSetting | undefined; label: string }[] =
  [
    { value: undefined, label: '전체 설정 따름' },
    { value: false, label: '안 벗김' },
    { value: true, label: '둘 다' },
    { value: 'male', label: '남캐만' },
    { value: 'female', label: '여캐만' }
  ]

/** 값의 이름 — 버튼·안내 문구에 쓴다 */
export function nudeStripLabel(value: NudeStripSetting | undefined): string {
  return NUDE_STRIP_CHOICES.find((c) => c.value === value)?.label ?? '전체 설정 따름'
}

/** 버튼에 마우스를 올렸을 때 보이는 설명 — 지금 값이 무슨 뜻인지 */
export function nudeStripTitle(value: NudeStripSetting | undefined, globalOn: boolean): string {
  const head = '옷 벗기기'
  if (value === undefined) {
    return `${head}: 전체 설정 따름 (${globalOn ? '켬 — 누드 태그가 있는 캐릭터를 벗김 · 씬 전체 태그는 당하는쪽, 역할이 없는 씬이면 전원' : '끔'}) · 눌러서 이 씬만 고름`
  }
  if (value === false) return `${head}: 이 씬은 안 벗김 (눌러서 바꿈)`
  if (value === true) {
    return `${head}: 남캐·여캐 모두 — 누드 태그가 없어도 옷 태그를 빼고 nude, completely nude를 붙임 (눌러서 바꿈)`
  }
  const who =
    value === 'male'
      ? '남캐만 알몸 — 하는쪽(역할이 없으면 카드에 boy·male 태그가 있는 캐릭터), 여캐는 이 씬에서 벗기지 않음'
      : '여캐만 알몸 — 당하는쪽(역할이 없으면 그 밖의 캐릭터), 남캐는 이 씬에서 벗기지 않음'
  return `${head}: ${who} (눌러서 바꿈)`
}

/** 이 씬에서 옷 벗기기가 한 명이라도 켜질 수 있는지 — 옷 분류를 미리 받아둘지·버튼 색 판단용 */
export function nudeStripOn(
  setting: NudeStripSetting | undefined,
  globalEnabled: boolean
): boolean {
  return setting === undefined ? globalEnabled : setting !== false
}

/**
 * 이 캐릭터에게 걸리는 옷 벗기기 — enabled = 장면 태그의 nude 로 벗기는 판정을 켤지,
 * force = 태그가 없어도 알몸으로 만들지.
 * 씬에서 한쪽만 골랐으면 반대쪽은 이 씬에서 벗기지 않는다 (태그 판정도 끈다).
 */
export function nudeStripFor(
  setting: NudeStripSetting | undefined,
  globalEnabled: boolean,
  sex: NudeStripSex
): { enabled: boolean; force: boolean } {
  if (setting === undefined) return { enabled: globalEnabled, force: false }
  if (typeof setting === 'boolean') return { enabled: setting, force: setting }
  const mine = setting === sex
  return { enabled: mine, force: mine }
}

/** 남캐로 볼 낱말 — 태그의 마지막(또는 첫) 낱말이 이것이면 남자다 (mature male · old man · multiple boys · male focus) */
const MALE_WORD = /^(?:\d+\+?)?(?:boys?|males?|man|men)$/

/** 남자 태그로 볼 최대 낱말 수 — 'she is with a man' 같은 문장은 끝 낱말이 man 이어도 남자 태그가 아니다 */
const MAX_MALE_TAG_WORDS = 4

/** 가중치가 0 인 묶음 (0::1boy::) — 효과를 없애는 표기라 빼달라는 음수 가중치와 같이 본다 */
const isZeroWeight = (token: string): boolean => /^\+?0*\.?0+::/.test(token.trim())

/** 태그 하나가 남자를 가리키는지 — 낱말 단위라 female·tomboy·man bun 은 걸리지 않는다 */
function isMaleTag(tag: string): boolean {
  const list = norm(tag)
    .replace(/^[\s{}[\]()]+|[\s{}[\]()]+$/g, '')
    .split(' ')
    .filter(Boolean)
  if (!list.length || list.length > MAX_MALE_TAG_WORDS) return false
  return MALE_WORD.test(list[list.length - 1]) || (list.length > 1 && list[0] === 'male')
}

/**
 * 카드 프롬프트에 남자 태그(1boy·2boys·male·mature male·male focus·man·men …)가 있는지.
 * 실제로 보내는 글과 같게 본다 — 주석은 지우고, 랜덤 선택지·와일드카드·빼달라는 음수·0 가중치는 신호로 치지 않는다.
 */
export function hasMaleTag(prompt: string): boolean {
  const live = removeComments(prompt ?? '').replace(/\([^()]+\/[^()]+\)/g, ' ')
  for (const token of splitPromptTokens(live)) {
    if (isNegativeWeight(token) || isZeroWeight(token) || /[/<>|]/.test(token)) continue
    if (tokenTags(token).some(isMaleTag)) return true
  }
  return false
}

/**
 * 옷 벗기기를 남녀로 나눌 때 이 캐릭터가 어느 쪽인지 — 역할 기준.
 * 하는쪽(source) = 남캐, 당하는쪽(target) = 여캐. 역할이 없는 캐릭터만 카드 프롬프트의 남자 태그로 가린다.
 */
export function characterSex(
  role: 'source' | 'target' | null | undefined,
  cardPrompt: string
): NudeStripSex {
  if (role === 'source') return 'male'
  if (role === 'target') return 'female'
  return hasMaleTag(cardPrompt) ? 'male' : 'female'
}

/**
 * 옷으로 분류돼도 벗기지 않는 것 — 머리끈·머리 장식(머리 모양의 일부)과
 * 머리·얼굴 장비(가면·복면·베일·안대·고글·모자·두건·헬멧 — 얼굴을 정하는 캐릭터 설정)
 */
const KEEP_WHEN_NUDE =
  /\bhair|scrunchie|kanzashi|headband|headdress|headwear|headgear|(mask|blindfold|eyepatch|veil|goggles|glasses|monocle|visor|balaclava|bandana|hood|hat|cap|beret|helmet|crown|tiara|circlet)$/

/**
 * 태그를 걸러낸다 — remove(태그)가 참인 것만 뺀다. 줄 단위로 처리해 줄바꿈을 지키고,
 * 주석(#부터 줄 끝)은 손대지 않는다 (주석 안의 태그가 되살아나거나, 줄이 합쳐지며 주석이
 * 뒤 태그까지 삼키지 않게). 가중치 묶음은 안쪽만 걸러 남은 게 없으면 묶음째 뺀다.
 * 빼달라는 음수 가중치·와일드카드는 그대로 둔다. 뺀 게 없으면 원문을 그대로 돌려준다.
 */
function filterTags(prompt: string, remove: (tag: string) => boolean): string {
  let changed = false
  const out: string[] = []
  for (const line of prompt.split('\n')) {
    const at = commentStart(line)
    const body = at === -1 ? line : line.slice(0, at)
    const comment = at === -1 ? '' : line.slice(at)
    const kept: string[] = []
    let lineChanged = false
    for (const token of splitPromptTokens(body)) {
      if (isNegativeWeight(token) || isWildcard(token)) {
        kept.push(token)
        continue
      }
      const group = /^(-?\d*\.?\d+)::([\s\S]*?)::$/.exec(token.trim())
      if (group) {
        const inner = group[2]
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
        const rest = inner.filter((t) => !remove(norm(t)))
        if (rest.length === inner.length) kept.push(token)
        else {
          lineChanged = true
          if (rest.length) kept.push(`${group[1]}::${rest.join(', ')}::`)
        }
        continue
      }
      if (remove(norm(token))) lineChanged = true
      else kept.push(token)
    }
    if (!lineChanged) {
      out.push(line)
      continue
    }
    changed = true
    // 원래 줄 끝의 쉼표(다음 줄과 이어 쓰던 것)는 지킨다
    const tail = kept.length && /,\s*$/.test(body) ? ',' : ''
    const rebuilt = kept.join(', ') + tail
    const next = comment ? (rebuilt ? `${rebuilt} ${comment}` : comment) : rebuilt
    if (next.trim()) out.push(next)
  }
  return changed ? out.join('\n') : prompt
}

const words = (tag: string): number => tag.split(/\s+/).length
/** 옷으로 볼 태그의 최대 단어 수 — 'white and black maid dress'처럼 색·재질이 붙은 옷 이름(5~7단어)까지. 그보다 길면 문장이라 보고 손대지 않는다 */
const MAX_CLOTH_WORDS = 7

/**
 * 카드 프롬프트에서 옷 태그를 걷어낸다. 문장(단어 5개 넘음)은 건드리지 않는다 —
 * 문장을 통째로 지우면 옷 말고 다른 뜻까지 날아간다.
 */
export function stripClothing(prompt: string, kindOf: (tag: string) => TagKind): string {
  return filterTags(prompt, (tag) =>
    words(tag) <= MAX_CLOTH_WORDS
      ? !KEEP_WHEN_NUDE.test(tag) && kindOf(tag) === 'cloth'
      : sentenceAboutClothes(tag, kindOf)
  )
}

/**
 * 긴 자연어 문장이 옷 이야기인지 — 문장 안 낱말 하나라도 옷(모자·가면 같은 얼굴 장비 제외)이면 그 문장째로 뺀다.
 * 낱말만 빼면 "She is not wearing a dress"처럼 뜻이 뒤집히거나 문장이 깨져서, 통째로 빼는 쪽이 안전하다.
 */
function sentenceAboutClothes(sentence: string, kindOf: (tag: string) => TagKind): boolean {
  for (const w of sentenceWords(sentence)) {
    if (KEEP_WHEN_NUDE.test(w)) continue
    if (kindOf(w) === 'cloth') return true
  }
  return false
}

/** 문장의 낱말들 — 영문자만, 소문자, 3글자 이상 (a·an·the·is 같은 짧은 말은 옷이 아니다) */
function sentenceWords(sentence: string): string[] {
  const out = new Set<string>()
  for (const raw of sentence.toLowerCase().split(/[^a-z-]+/)) {
    if (raw.length >= 3) out.add(raw)
  }
  return [...out]
}

/** 복장을 벗길 때 남길 것만 — 머리 장식·가면·안대 (나머지 옷·문장은 전부 뺀다) */
function keepAccessories(outfit: string): string {
  return filterTags(outfit, (tag) => !KEEP_WHEN_NUDE.test(tag))
}

export interface Undressed {
  /** 옷 태그를 걷어낸 카드 프롬프트 */
  card: string
  /** 입힐 복장 태그 — 벗기면 머리 장식·가면만 남는다 (누드 복장·직접 고른 복장이면 그대로) */
  outfit: string
  outfitNegative: string
  /** 벗긴 이유가 된 누드 태그 (안 벗겼으면 null) */
  nude: string | null
}

/**
 * 이 캐릭터에게 걸린 장면 태그(contexts)에 누드가 있으면 옷을 벗긴다.
 * - 카드의 기본 복장은 머리 장식·가면만 남기고 뺀다 (네거티브도 — 그 옷 모양을 잡던 것이라)
 * - 씬·큐 항목에서 직접 고른 복장(explicitOutfit)과 누드가 적힌 누드 복장은 그대로 둔다
 * - 카드 프롬프트에선 옷 태그만 걷어낸다
 */
export function undressForNude(input: {
  card: string
  outfit: string
  outfitNegative: string
  /** 씬·큐 항목에서 직접 고른 복장인지 (카드 기본 복장이 아니라) */
  explicitOutfit?: boolean
  contexts: string[]
  enabled: boolean
  kindOf: (tag: string) => TagKind
}): Undressed {
  const { card, outfit, outfitNegative } = input
  const nude = input.enabled ? nudeTrigger(input.contexts) : null
  if (!nude) return { card, outfit, outfitNegative, nude: null }
  const keepOutfit = !outfit || input.explicitOutfit === true || nudeTrigger([outfit]) !== null
  return {
    card: withNudeTags(stripClothing(card, input.kindOf), nude, keepOutfit ? outfit : ''),
    outfit: keepOutfit ? outfit : keepAccessories(outfit),
    outfitNegative: keepOutfit ? outfitNegative : '',
    nude
  }
}

/**
 * 벗긴 캐릭터 태그 끝에 누드 태그를 붙인다 — 장면에만 있으면 여러 명 그림에서 누가 벗었는지
 * 모를 수 있어 캐릭터 태그에도 적는다. nude·completely nude면 둘 다, naked towel 같은 것은 그대로.
 * 카드·입히는 복장에 이미 있으면 다시 붙이지 않는다.
 */
function withNudeTags(card: string, nude: string, outfit: string): string {
  // 입히는 복장(누드 조각)이 이미 누드를 말하면 그걸로 충분하다
  if (nudeTrigger([outfit]) !== null) return card
  const want = NUDE_TAGS.has(nude) ? ['nude', 'completely nude'] : [nude]
  const have = new Set(promptTags([card, outfit]))
  const add = want.filter((t) => !have.has(t))
  if (!add.length) return card
  const base = card.replace(/[\s,]+$/, '')
  return base ? `${base}, ${add.join(', ')}` : add.join(', ')
}

const pieceTags = (tags: string): string =>
  tags
    .trim()
    .replace(/^,+|,+$/g, '')
    .trim()

/** 누드 조각인지 — 조각 태그에 nude·completely nude·naked … 가 있음 (화면에 nsfw로 표시) */
export function isNudePiece(tags: string): boolean {
  return nudeTrigger([tags]) !== null
}

/**
 * 이 복장·선택으로 실제로 입히는 태그 — 켠 조각에 누드 조각이 있으면 누드 조각은 그대로 두고
 * 나머지 조각에선 몸에 걸친 옷만 뺀다 (머리·얼굴 장비·문장은 남김).
 * 누드 조각이 없거나 끈 설정이면 평소대로 켠 조각을 모두 입힌다.
 * auto = 이 씬에서 드러나야 하는 부위 — 맞는 nsfw 조각도 켜진 조각에 든다 (activePieces).
 */
export function undressOutfit(
  outfit: Outfit,
  choice: Pick<OutfitChoice, 'on' | 'off'> | undefined,
  enabled: boolean,
  kindOf: (tag: string) => TagKind,
  auto?: SceneAreas
): string {
  const pieces = activePieces(outfit, choice, auto)
  if (!enabled || !pieces.some((p) => isNudePiece(p.tags))) return outfitTags(outfit, choice, auto)
  return pieces
    .map((p) => pieceTags(isNudePiece(p.tags) ? p.tags : stripClothing(p.tags, kindOf)))
    .filter(Boolean)
    .join(', ')
}

/** 이 캐릭터가 입는 복장의 태그 — 씬 선택 > 카드 기본 복장 (undressOutfit 규칙으로) */
export function wornOutfitTags(
  cardOutfitId: number | null | undefined,
  sceneChoice: OutfitChoice | undefined,
  outfits: ReadonlyMap<number, Outfit>,
  enabled: boolean,
  kindOf: (tag: string) => TagKind,
  auto?: SceneAreas
): string {
  const r = resolveOutfit(cardOutfitId, sceneChoice, outfits)
  return r ? undressOutfit(r.outfit, r.choice, enabled, kindOf, auto) : ''
}

/** 옷 분류를 물어볼 태그들 — 프롬프트 여러 개에서 중복 없이 */
export function promptTags(prompts: string[]): string[] {
  const out = new Set<string>()
  for (const p of prompts) {
    for (const token of splitPromptTokens(removeComments(p ?? ''))) {
      for (const tag of tokenTags(token)) {
        const t = norm(tag)
        if (!t) continue
        if (words(t) <= MAX_CLOTH_WORDS) out.add(t)
        // 긴 문장은 낱말을 따로 분류해 둔다 — 옷 문장인지 보려고
        else for (const w of sentenceWords(t)) out.add(w)
      }
    }
  }
  return [...out]
}
