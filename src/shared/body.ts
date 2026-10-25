import { removeComments } from './nai-presets'
import { engineTagsOf, norm } from './auto-expose'
import { splitPromptTokens } from './outfit'
import { characterSex, hasMaleTag, type NudeStripSex } from './nude-strip'
import type { ExposeArea } from './types'

/**
 * 캐릭터의 몸 (커스텀) — 후타 재조립과 입은 옷 자동 젖힘, 알몸일 때의 pink nipples 가 같이 쓴다.
 *
 * 역할 기준인 characterSex(하는쪽=남캐, 당하는쪽=여캐)는 그대로 둔다 — 옷 벗기기 「남캐만/여캐만」이 거기에 기대고 있다.
 * 몸은 따로 읽는다: 음경·음부·가슴. 후타는 카드의 futanari 한 낱말로 정하고(가슴은 여성, 음경 있음),
 * 후타가 아니면 characterSex 에서 만든 옛 몸을 그대로 쓴다 (남=음경+남 가슴, 여=음부+여 가슴).
 * DB·IPC 없는 순수 계산이다.
 */

export interface CharBody {
  /** 음경이 있는가 */
  penis: boolean
  /** 음부가 있는가 — 후타는 당하는쪽(받는 몸)일 때만 있다고 본다. futa without pussy 면 없음 */
  pussy: boolean
  chest: 'female' | 'male'
  /** 카드에서 후타로 읽었는가 */
  futa: boolean
}

/** 눈여겨볼 카드 상태 — 화면에 그대로 보인다 (BodyNote 의 suspect · conflict · unreadable) */
export type BodyFlag = 'suspect' | 'conflict' | 'unreadable'

export interface BodyReading {
  body: CharBody
  /** characterSex (역할 기준) */
  sex: NudeStripSex
  flags: BodyFlag[]
  /** 카드(와 자리 태그)에 large penis 가 있음 — 씬 글의 large penis 가 겹친다 */
  largePenis: boolean
  /** girl 계열 태그(1girl · girl · 2girls)가 있음 */
  hasGirl: boolean
  /**
   * 몸 가슴이 여성인가 — 후타는 여성, 그 밖에는 카드에 남자 태그가 없고 (역할이 하는쪽이 아니거나 카드에 girl 태그가 있을 때).
   * 하는쪽 역할이어도 카드가 girl 이면 여성이다 (역할은 옷 벗기기 메뉴 몫이고, 몸과 사람 수는 카드로 본다)
   */
  chestFemale: boolean
  /** 카드(와 자리 태그)에 고환 유형 태그가 있음 — 있으면 고환을 빼거나 no testicles 를 더하지 않는다 */
  testicleType: boolean
  /** 눈여겨볼 상태의 근거가 된 글 조각 (충돌 = 후타 태그 + 남자 태그, 의심 = 음경 태그, 못 읽음 = 와일드카드) */
  evidence: Partial<Record<BodyFlag, string>>
}

/** 옛 몸 — 역할 기준 남녀에서 만든다 */
export function bodyOfSex(sex: NudeStripSex): CharBody {
  return sex === 'male'
    ? { penis: true, pussy: false, chest: 'male', futa: false }
    : { penis: false, pussy: true, chest: 'female', futa: false }
}

/**
 * 증거의 주인(male = 음경 쪽, female = 음부·여 가슴 쪽)이 이 몸 부위의 주인인가.
 * 아래는 음경/음부, 가슴은 가슴 종류로 가른다.
 */
export function bodyHolds(body: CharBody, owner: NudeStripSex, area: ExposeArea): boolean {
  if (area === 'lower') return owner === 'male' ? body.penis : body.pussy
  return owner === 'male' ? body.chest === 'male' : body.chest === 'female'
}

// ── 카드 읽기 ───────────────────────────────────────────

/**
 * 후타 낱말 — futanari 가 든 태그(full-package futanari · implied futanari · intravaginal futanari …),
 * 별칭 futa · dickgirl · newhalf · shemale, futa with … / futa without … / futasub
 */
const FUTA_ALIAS = /^(?:futa(?:sub|dom)?|dickgirl|newhalf|shemale)(?: |$)/
export function isFutaTag(tag: string): boolean {
  return tag.split(' ').includes('futanari') || FUTA_ALIAS.test(tag)
}

/** 후타 관계 태그 (futa with female · futa on male …) — 카드가 아니라 자리·씬별 태그에 있으면 몸 신호가 아니라 상대와의 관계다 */
const FUTA_RELATION = /^futa (?:with|on) /

/** 질이 없는 후타 */
const NO_PUSSY = /^(?:futa without pussy|newhalf|shemale)(?: |$)/
/** 고환 유형이 정해져 있는 태그 — 고환 낱말과 질 없는 후타·풀패키지 */
const TESTICLE_TYPE =
  /\b(?:testicles?|balls|scrotum)\b|^(?:full-package futanari|futa without pussy|futa without balls|newhalf|shemale)$/
/** 글들에 고환 유형 태그가 있는가 — 있으면 no testicles 를 더하지 않는다 */
export function hasTesticleType(texts: string[]): boolean {
  return texts.some((t) => engineTagsOf(t).some((tag) => TESTICLE_TYPE.test(tag)))
}
/** 남성 몸 태그 — 후타 판정에서 뺀다 (같은 카드에 futanari 와 있으면 충돌) */
const MALE_BODY = /^(?:trap|otoko no ko|reverse trap|cuntboy)$/
/** 음경만 적은 약신호 */
const PENIS_ONLY = /^(?:(?:small|medium|large|huge|gigantic|horse) )?penis$|^erection$|^testicles$/
const GIRL_TAG = /^(?:\d+\+?)?girls?$/

const OFF_WEIGHT = /^(?:-\d*\.?\d+|\+?0*\.?0+)::/

/** 선택지(a/b · <a|b>)의 한 칸에 후타 낱말이 있는가 */
const optionIsFuta = (option: string): boolean => engineTagsOf(option).some(isFutaTag)

/**
 * 뽑힌 값에 후타가 들어올 수 있는 와일드카드가 카드에 있으면 그 조각을 돌려준다 (없으면 null).
 * 앱이 실제로 뽑는 문법만 본다 — 조각 <이름> · <*이름>(안에 무엇이 든지 알 수 없음), 선택지가 보이는 <a|b> · (a/b) · a/b/c 는 선택지에 후타가 있을 때만.
 * >_< · <3 · w/ hat · fate/grand order 처럼 우연히 기호가 든 평범한 태그는 와일드카드가 아니다.
 */
export function riskyWildcard(text: string): string | null {
  const live = splitPromptTokens(removeComments(text ?? ''))
    .filter((t) => !OFF_WEIGHT.test(t.trim()))
    .join(', ')
  for (const m of live.matchAll(/<([^<>]+)>/g)) {
    // >_<, blush, >_< 처럼 얼굴 기호 사이를 잘못 묶은 것은 조각 이름이 아니다
    if (/^[\s,]|[\s,]$/.test(m[1])) continue
    if (!m[1].includes('|') || m[1].split('|').some(optionIsFuta)) return m[0]
  }
  for (const m of live.matchAll(/\(([^()]+\/[^()]+)\)/g))
    if (m[1].split('/').some(optionIsFuta)) return m[0]
  for (const part of live.split(/[,\n]/)) {
    const tag = part.trim()
    // 쉼표 사이의 공백 없는 a/b/c (URL 아님) — 앱의 단순 와일드카드
    if (!tag.includes('/') || tag.startsWith('http') || tag.includes('://') || tag.includes(' '))
      continue
    const options = tag.split('/').filter((o) => o.trim())
    if (options.length > 1 && options.some(optionIsFuta)) return tag
  }
  return null
}

/**
 * 카드(와 그 자리 태그)에서 몸을 읽는다.
 * futaOn 이 꺼져 있으면 후타를 읽지 않고 옛 몸을 돌려준다 (끄면 이 기능이 없던 때와 같다).
 * 읽는 글은 실제로 보내는 긍정 글과 같다 — 주석, 음수·0 가중치, 와일드카드·랜덤 선택지는 신호가 아니다.
 * texts 는 카드 프롬프트와, 있으면 이 캐릭터에게 붙는 자리 태그·씬별 캐릭터 태그.
 */
export function readBody(
  role: 'source' | 'target' | null | undefined,
  texts: string[],
  futaOn: boolean
): BodyReading {
  const card = texts[0] ?? ''
  const sex = characterSex(role, card)
  const cardTags = engineTagsOf(card)
  const extraTags = texts.slice(1).flatMap(engineTagsOf)
  const tags = [...cardTags, ...extraTags]
  const hasGirl = tags.some((t) => GIRL_TAG.test(t))
  // 몸과 사람 수는 카드로 본다 — 역할이 하는쪽이어도 카드가 girl 이고 남자 태그가 없으면 여성이다
  const chestPlain = !hasMaleTag(card) && (sex === 'female' || hasGirl)
  const testicleType = hasTesticleType(texts)
  const plain = (extra: Partial<BodyReading> = {}): BodyReading => ({
    body: bodyOfSex(sex),
    sex,
    flags: [],
    largePenis: tags.includes('large penis'),
    hasGirl,
    chestFemale: chestPlain,
    testicleType,
    evidence: {},
    ...extra
  })
  if (!futaOn) return plain()

  // 후타 관계 태그(futa with …)는 카드에 있을 때만 몸 신호다 — 자리·씬별 태그에 적은 것은 상대와의 관계
  const futaTags = [
    ...cardTags.filter(isFutaTag),
    ...extraTags.filter((t) => isFutaTag(t) && !FUTA_RELATION.test(t))
  ]
  const futa = futaTags.length > 0
  const others = tags.filter((t) => !isFutaTag(t))
  // futa with male 처럼 후타 태그 안의 male 은 몸 신호가 아니다 — 그 밖의 태그만 본다
  const maleTag = others.find((t) => hasMaleTag(t) || MALE_BODY.test(t))
  const flags: BodyFlag[] = []
  if (futa && maleTag)
    return plain({
      flags: ['conflict'],
      evidence: { conflict: `${futaTags[0]} + ${maleTag}` }
    })
  if (!futa) {
    const evidence: BodyReading['evidence'] = {}
    const penisTag = others.find((t) => PENIS_ONLY.test(t))
    if (sex === 'female' && !maleTag && penisTag) {
      flags.push('suspect')
      evidence.suspect = penisTag
    }
    // 와일드카드가 있으면 뽑힌 값에 futanari 가 있을지 몰라 읽지 못했다고 알린다
    const wildcard = texts.map(riskyWildcard).find((w) => w != null)
    if (wildcard) {
      flags.push('unreadable')
      evidence.unreadable = wildcard
    }
    return plain({ flags, evidence })
  }
  return {
    body: {
      penis: true,
      pussy: role !== 'source' && !tags.some((t) => NO_PUSSY.test(t)),
      chest: 'female',
      futa: true
    },
    sex,
    flags,
    largePenis: tags.includes('large penis'),
    hasGirl,
    chestFemale: true,
    testicleType,
    evidence: {}
  }
}

/** 몸 하나 — 후타 판정만 필요할 때 */
export function characterBody(
  role: 'source' | 'target' | null | undefined,
  texts: string[],
  futaOn = true
): CharBody {
  return readBody(role, texts, futaOn).body
}

// ── 알몸일 때의 pink nipples ──────────────────────────────

/** 알몸 선언 — 온몸 알몸만 (naked towel 같은 「그것만 걸친」 것과 topless 는 아니다) */
const FULL_NUDE = new Set(['nude', 'completely nude', 'naked'])

/**
 * 글들에 온몸 알몸 선언(nude · completely nude · naked)이 있는가.
 * 실제로 보내는 글과 같게 본다 — 주석·랜덤 선택지·와일드카드·음수·0 가중치는 신호가 아니다.
 */
export function declaresFullNude(texts: string[]): boolean {
  return texts.some((t) => engineTagsOf(t).some((tag) => FULL_NUDE.has(tag)))
}

/**
 * 유두 색을 정한 태그 — 있으면 사용자가 정한 색이라 pink nipples 를 더하지 않는다.
 * 음수 가중치(-1::pink nipples::)로 막은 것도 정한 것으로 본다.
 */
const NIPPLE_COLOR =
  /(?:^|\s)(?:pink|red|purple|brown|dark|light|pale|blue|green|black|white|orange|yellow|gray|grey|tan|peach|rosy|coral|beige|golden|lavender|silver|multicolou?red|colou?red) (?:nipples?|areolae?)(?:$|\s)/

/** 글들에서 가중치·음수 여부와 상관없이 모든 태그를 읽는다 (주석만 뺀다) */
function everyTag(text: string): string[] {
  return splitPromptTokens(removeComments(text ?? ''))
    .flatMap((token) => {
      const m = /^-?\d*\.?\d+::([\s\S]*?)::$/.exec(token.trim())
      return (m ? m[1] : token).split(',')
    })
    .map(norm)
    .filter(Boolean)
}

/** 알몸이고 가슴이 여성 몸인 캐릭터에게 pink nipples 를 더할지 — 유두 색 태그가 있거나 이미 있으면 더하지 않는다 */
export function wantsPinkNipples(input: {
  chestFemale: boolean
  /** 이 캐릭터가 알몸인가 (옷 벗기기로 벗겼거나 글이 알몸을 선언함) */
  nude: boolean
  texts: string[]
}): boolean {
  if (!input.chestFemale || !input.nude) return false
  return !input.texts.some((t) => everyTag(t).some((tag) => NIPPLE_COLOR.test(tag)))
}

export const PINK_NIPPLES = 'pink nipples'
export const NO_TESTICLES = 'no testicles'
