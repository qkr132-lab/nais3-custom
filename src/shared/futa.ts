import { appendPromptPiece, commentStart, textBlockStart } from './nai-presets'
import { engineTagsOf, norm } from './auto-expose'
import { splitPromptTokens } from './outfit'
import {
  NO_TESTICLES,
  PINK_NIPPLES,
  declaresFullNude,
  hasTesticleType,
  wantsPinkNipples,
  type BodyReading
} from './body'
import type { BodyNote, FutaPlan, PromptParts } from './types'

/**
 * 후타 자동 재조립 (커스텀).
 *
 * 카드에 futanari 가 있는 캐릭터가 그려지면, 씬 글이 「남자가 있는 장면」으로 선언한 태그
 * (hetero · 1boy · faceless male · male 구절 · he/his/him)를 후타 구성에 맞게 바꾼다. 후타는 girl 로 센다.
 * 바꾼 것·뺀 것·더한 것·안 바꾼 것은 전부 BodyNote 로 돌려줘 화면에 보인다 — 몰래 바꾸지 않는다.
 * 씬에 적힌 원본 글은 건드리지 않고, 요청에 실리는 사본만 바꾼다. 같은 글에 두 번 적용해도 결과가 같다.
 *
 * 그려지는 구성(FutaPlan.counts)에서 규칙이 갈린다.
 *  - 남자가 없다 (후타+여, 후타+후타, 후타 혼자): 남자 선언을 모두 정리하고 관계 태그를 맞춘다
 *      후타+여 = 2girls + futa with female · 후타+후타 = 2girls + futa with futa · 후타 혼자 = 1girl
 *  - 남자가 있다 (후타+남): 남자 선언은 맞으니 그대로 두고 hetero 만 futa with male 로 바꾼다
 * DB·IPC 없는 순수 계산이다 (렌더러·폰·클라우드가 같은 코드를 쓴다).
 */

// ── 계획 ────────────────────────────────────────────────

export interface FutaPerson {
  kind: 'futa' | 'female' | 'male'
  /** 후타 카드에 large penis 가 있음 */
  largePenis?: boolean
  /** 후타 카드에 고환 유형 태그가 있음 — 씬 글의 고환 태그를 빼지 않는다 */
  testicleType?: boolean
  /** characterPrompts 안의 순서와 카드 — 화면이 어느 카드가 후타로 읽혔는지 알려 주려고 계획에 싣는다 */
  index?: number
  id?: number
  name?: string
  /** 이 사람의 행위 역할 (자리 역할 > 씬별 역할 > 카드 역할) — 하는쪽 후타가 그려지는지 가린다 */
  role?: 'source' | 'target' | null
}

/**
 * 그려지는 사람들에서 재조립 계획을 만든다. 후타가 한 명도 없으면 null (아무것도 바꾸지 않는다).
 * 얼굴 인셋 자리는 같은 인물의 두 번째 자리라 사람 수에 넣지 않는다 — 부르는 쪽이 거른다.
 */
export function planFuta(people: FutaPerson[], viewFix: boolean): FutaPlan | null {
  const counts = { futa: 0, female: 0, male: 0 }
  for (const p of people) counts[p.kind]++
  if (!counts.futa) return null
  const futas = people.filter((p) => p.kind === 'futa')
  const chars = futas.filter((p) => p.index != null && p.id != null)
  return {
    counts,
    viewFix,
    dedupePenis: futas.some((p) => p.largePenis),
    ...(futas.some((p) => p.testicleType) ? { keepTesticles: true } : {}),
    ...(futas.some((p) => p.role === 'source') ? { sourceFuta: true } : {}),
    ...(chars.length
      ? { chars: chars.map((p) => ({ index: p.index!, id: p.id!, name: p.name ?? '' })) }
      : {})
  }
}

/** 관계 태그 (단보루 실존) — 후타+남 / 후타+여 / 후타+후타. 후타 혼자면 없다 */
export function relationTag(c: FutaPlan['counts']): string | null {
  if (c.male > 0) return 'futa with male'
  if (c.female > 0) return 'futa with female'
  if (c.futa >= 2) return 'futa with futa'
  return null
}

/** 후타를 girl 로 센 인원수 태그 — 남자가 없고 2명 이상일 때만 (1명이면 1girl 그대로) */
export function girlsTag(c: FutaPlan['counts']): string | null {
  if (c.male > 0) return null
  const n = c.futa + c.female
  if (n < 2) return null
  return n >= 6 ? '6+girls' : `${n}girls`
}

// ── 태그 바꾸기 ──────────────────────────────────────────

const isNegativeWeight = (t: string): boolean => /^-\d*\.?\d+::/.test(t.trim())
const isZeroWeight = (t: string): boolean => /^\+?0*\.?0+::/.test(t.trim())
const isWildcard = (t: string): boolean => /[/<>{}|]/.test(t)

export interface TagEdit {
  before: string
  /** 바꾼 뒤 — 빈 문자열이면 뺀 것 */
  after: string
  reason: string
}

/** 가중치 표기(::)가 깨진 토큰 — :: 가 있는데 N::태그:: 한 묶음으로 읽히지 않는다 */
const isBrokenWeight = (token: string): boolean =>
  token.includes('::') &&
  !(/^(-?\d*\.?\d+)::([\s\S]*?)::$/.test(token.trim()) && token.split('::').length === 3)

/** 짝이 맞지 않는 :: 줄 가운데 바뀌었을 법한 것 — 남성 낱말·시점·고환이 든 것만 알린다 */
const BROKEN_WATCH = /\b(?:male|boys?|man|men|hetero|testicles?|pov|penis focus|he|his|him)\b/i

/** 역할 접두사 (source#faceless male) — norm 이 떼는 것을 바꾼 태그에 다시 붙인다 */
const ROLE_PREFIX = /^(?:source|target|mutual)#/i

export interface TagKept {
  /** 남은 글 조각 */
  before: string
  reason: string
}

/** decide 의 답 — 바꿈/뺌(after) 또는 그대로 두되 알림(keep) 또는 바꾸고 남은 것을 알림(after + keepRest) */
export type TagVerdict =
  { after: string; reason: string; keepRest?: string; keepReason?: string } | { keep: string }

/**
 * 프롬프트의 태그를 하나씩 바꾼다 (nude-strip 의 filterTags 와 같은 안전 규칙).
 * - 줄 단위로 처리해 줄바꿈을 지키고, 주석(#부터 줄 끝)과 `Text:` 꼬리는 손대지 않는다
 * - 가중치 묶음은 안쪽 태그만 바꾸고 남은 게 없으면 묶음째 뺀다 (가중치 숫자는 그대로)
 * - 빼달라는 음수·0 가중치, 와일드카드·랜덤 선택지 토큰, 따옴표 안 대사는 건드리지 않는다
 * - 바뀐 게 없으면 원문 그대로 돌려준다 (같은 문자열)
 * decide(정규화 태그, 원문 태그): null = 그대로.
 */
/** mapTags 가 바꾸지 못한 곳을 알릴 때 무엇을 알릴 만한 글로 볼지 — 정하지 않으면 후타의 기준(남성 낱말)을 쓴다 */
export interface MapTagsWatch {
  /** 가중치 짝이 안 맞아 줄째 둔 줄(body)에 알릴 만한 태그가 있는가 */
  broken?: (body: string) => boolean
  /** 랜덤 선택지·와일드카드 토큰이라 건드리지 않은 토큰에 알릴 만한 태그가 있는가 (정하지 않으면 알리지 않는다) */
  wildcard?: (token: string) => boolean
}

export function mapTags(
  prompt: string,
  decide: (tag: string, raw: string) => TagVerdict | null,
  watch?: MapTagsWatch
): { text: string; edits: TagEdit[]; kept: TagKept[] } {
  const edits: TagEdit[] = []
  const kept: TagKept[] = []
  const at = textBlockStart(prompt)
  const head = at < 0 ? prompt : prompt.slice(0, at)
  const tail = at < 0 ? '' : prompt.slice(at)
  const apply = (raw: string): { after: string } | null => {
    const v = decide(norm(raw), raw.trim())
    if (!v) return null
    if ('keep' in v) {
      kept.push({ before: raw.trim(), reason: v.keep })
      return null
    }
    // 접두사가 붙은 태그를 바꾸면 접두사를 이어 붙인다 (상호작용 태그의 source#·target# 가 사라지지 않게)
    const prefix = ROLE_PREFIX.exec(raw.trim())?.[0] ?? ''
    const after = v.after && prefix ? `${prefix}${v.after}` : v.after
    edits.push({ before: raw.trim(), after, reason: v.reason })
    if (v.keepRest) kept.push({ before: v.keepRest, reason: v.keepReason ?? v.reason })
    return { after }
  }

  const out: string[] = []
  let changed = false
  for (const line of head.split('\n')) {
    const cut = commentStart(line)
    const body = cut === -1 ? line : line.slice(0, cut)
    const comment = cut === -1 ? '' : line.slice(cut)
    const keptTokens: string[] = []
    let lineChanged = false
    let inQuote = false
    const tokens = splitPromptTokens(body)
    // 가중치 표기(::)의 짝이 맞지 않는 줄 — 어디까지가 한 묶음인지 알 수 없다. 줄째 건드리지 않는다
    // (-2:: 같은 억제가 사라지거나, 줄을 다시 이으며 쉼표가 끼어 뜻이 달라지면 안 된다)
    if (tokens.some(isBrokenWeight)) {
      if (watch?.broken ? watch.broken(body) : BROKEN_WATCH.test(body))
        kept.push({
          before: body.trim(),
          reason: '가중치 표기(::)의 짝이 맞지 않는 줄이라 안전하게 바꿀 수 없어 줄째 그대로 둠'
        })
      out.push(line)
      continue
    }
    for (const token of tokens) {
      const quotes = (token.match(/["“”]/g) ?? []).length
      const group = /^(-?\d*\.?\d+)::([\s\S]*?)::$/.exec(token.trim())
      const quoted = inQuote || quotes > 0
      const off = isNegativeWeight(token) || isZeroWeight(token)
      const skip = quoted || off || isWildcard(token)
      if (quotes % 2 === 1) inQuote = !inQuote
      if (skip) {
        // 랜덤 선택지·와일드카드는 뽑힐 값을 알 수 없다 — 알릴 만한 태그가 들어 있으면 그대로 뒀다고 알린다
        if (!quoted && !off && watch?.wildcard?.(token))
          kept.push({
            before: token.trim(),
            reason: '랜덤 선택지·와일드카드라 뽑힐 값을 미리 알 수 없어 그대로 둠'
          })
        keptTokens.push(token)
        continue
      }
      if (group) {
        const inner = group[2]
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
        const next: string[] = []
        let groupChanged = false
        for (const t of inner) {
          const r = apply(t)
          if (!r) next.push(t)
          else {
            groupChanged = true
            if (r.after) next.push(r.after)
          }
        }
        if (!groupChanged) keptTokens.push(token)
        else {
          lineChanged = true
          if (next.length) keptTokens.push(`${group[1]}::${next.join(', ')}::`)
        }
        continue
      }
      const r = apply(token)
      if (!r) keptTokens.push(token)
      else {
        lineChanged = true
        if (r.after) keptTokens.push(r.after)
      }
    }
    if (!lineChanged) {
      out.push(line)
      continue
    }
    changed = true
    // 원래 줄 끝의 쉼표(다음 줄과 이어 쓰던 것)는 지킨다
    const trail = keptTokens.length && /,\s*$/.test(body) ? ',' : ''
    const rebuilt = keptTokens.join(', ') + trail
    const next = comment ? (rebuilt ? `${rebuilt} ${comment}` : comment) : rebuilt
    if (next.trim()) out.push(next)
  }
  if (!changed) return { text: prompt, edits, kept }
  const text = out.join('\n')
  return {
    text: tail ? `${text.replace(/[\s,]+$/, '')}${text.trim() ? '\n' : ''}${tail}` : text,
    edits,
    kept
  }
}

// ── 규칙 ────────────────────────────────────────────────

/** 남자가 있는 장면이라는 선언 — 이게 있을 때만 인원수(1girl → 2girls)와 관계 태그를 고친다 */
const MALE_MARKER = /^(?:hetero|\d+\+?boys?|multiple boys|faceless male|male focus)$/
/** 1명 이상 남자를 세는 인원수 태그 */
const BOYS_COUNT = /^(?:\d+\+?boys?|multiple boys)$/

/** 통째로 뺄 남자 묘사 (단보루에 없거나 후타에 맞지 않는 것) */
const REMOVE_MALE = new Set([
  'peach skin male',
  'nude male',
  'muscular male',
  'fat man',
  'male pubic hair',
  'male pubic hair on face',
  'male pubic hair on mouth',
  'male pubic hair on breasts',
  'male licking pussy',
  'male on bottom',
  'male focus',
  'male'
])

/** 알려진 male 구절 → 후타에 맞는 태그 (결과는 단보루 실존 태그) */
const MALE_PHRASE: Record<string, string> = {
  'faceless male': 'faceless female',
  'male head between female thighs': 'head between thighs',
  'male sucking her breast': 'breast sucking',
  'looking at male': 'looking at another',
  'other male arm around waist': 'arm around waist',
  "male's lower body": 'lower body'
}

/** 한 태그로 볼 최대 단어 수 — 이보다 길면 문장이라 male 구절 규칙을 쓰지 않는다 */
const MAX_PHRASE_WORDS = 7
const wordCount = (t: string): number => t.split(' ').length

/** 시점 태그 — 후타가 화면에 나오게 from side 로 */
const POV_TAGS = new Set(['pov', 'pov hands', 'pov crotch', 'disembodied hand'])
/** 하는쪽 칸에서 얼굴·몸이 보이게 뺄 구도 태그 */
const SOURCE_FRAMING = new Set(['head out of frame', 'lower body'])

/** 음경이 나오는 행위 태그 — 남자 선언이 없어도 남자 시점 씬이다 (시점·구도 정리를 할 만한 씬) */
const PENIS_ACT =
  /\b(?:penis|cock|dick|erection|testicles?|balls|fellatio|blowjob|handjob|footjob|paizuri|titjob|deepthroat|irrumatio|buttjob|assjob|sumata|thigh sex|frottage|vaginal|anal|sex|pov crotch)\b/
/** pov 말고 이미 앵글을 정한 태그 — 있으면 pov 를 from side 로 바꾸면 앵글끼리 부딪히니 뺄 뿐이다 */
const ANGLE_TAG = /^(?:from behind|from below|from above|front view|side view|back view)$/

/** 영문 서술 속 남성 지칭 */
const MALE_PRONOUN = /\b(?:the man|his|him|he)\b/i
const MALE_WORD_LEFT = /\b(?:man|men|male|males|boy|boys|guy|guys|himself)\b/i
/**
 * 화면 밖·잘림·보임을 말하는 문장 — 「그」의 몸을 잘라 내거나 가리라는 뜻이라, the futanari 로 바꾸면 후타를 잘라 내라는 뜻이 된다.
 * 시점·구도 정리(R8)가 후타 쪽 얼굴·몸을 살리려고 하는 일과 반대라 바꾸지 않는다
 */
const FRAMING_WORDS =
  /\b(?:cut off|crop(?:ped)?|frame|off-?screen|out of (?:the )?(?:shot|view|picture|sight)|visible|invisible|unseen|hidden|not shown|not seen|gone|obscured)\b/i

/** he/his/him/the man → the futanari (소유격은 the futanari's) — 문장 첫머리의 대문자는 지킨다 */
export function swapMalePronouns(piece: string): string {
  return piece.replace(/\b(?:the man|his|him|he)\b/gi, (m) => {
    const lower = m.toLowerCase()
    const word = lower === 'his' ? "the futanari's" : 'the futanari'
    return /^[A-Z]/.test(m) ? word[0].toUpperCase() + word.slice(1) : word
  })
}

type TextWhere = BodyNote['where']

export interface TextState {
  /** 관계 태그가 이미 글에 있거나 이번에 넣었다 */
  relation: boolean
  /** from side 가 이미 있거나 이번에 넣었다 */
  fromSide: boolean
  /** 씬 글(메인·씬)에 남자 선언이나 음경 행위 태그가 있음 — 시점·구도 정리(R7·R8)는 이런 씬에서만 한다 */
  viewScene?: boolean
  /** 씬 글에 pov 말고 앵글을 정한 태그(from behind · from below …)가 있음 — 있으면 pov 는 from side 로 바꾸지 않고 뺀다 */
  angle?: boolean
}

/** 씬 글들에서 시점·구도 정리에 쓰는 사실 — 바꾸기 전 원문 기준 */
function sceneFacts(texts: string[]): Required<Pick<TextState, 'viewScene' | 'angle'>> {
  const tags = texts.flatMap(engineTagsOf)
  return {
    viewScene: tags.some((t) => MALE_MARKER.test(t) || PENIS_ACT.test(t)),
    angle: tags.some((t) => ANGLE_TAG.test(t))
  }
}

interface TextCtx {
  plan: FutaPlan
  where: TextWhere
  /** 이 글을 받는 캐릭터의 역할 (구도 태그는 하는쪽에서만 뺀다) */
  role?: 'source' | 'target' | null
  /** 이 글을 받는 캐릭터의 카드에 girl 계열 태그가 있음 — 없으면 1boy 를 1girl 로 바꾼다 */
  hasGirl?: boolean
  /** 이 글을 받는 캐릭터가 후타 — 남자가 따로 있는 씬에서도 이 캐릭터가 받은 글의 남자 낱말은 정리한다 */
  futaChar?: boolean
  state: TextState
}

const isScene = (w: TextWhere): boolean => w === 'main' || w === 'scene'

/**
 * 글 하나를 후타 구성에 맞게 바꾼다. 인원수·관계 태그를 더하거나 합치는 일은 하지 않는다 (글 여러 개를 함께 봐야 한다 — rewriteSceneTexts).
 * 돌려주는 메모에는 charIndex·name 이 없다 — 부르는 쪽이 채운다.
 */
function rewriteOne(
  text: string,
  ctx: TextCtx
): { text: string; notes: Omit<BodyNote, 'charIndex' | 'name'>[] } {
  if (!text || !text.trim()) return { text, notes: [] }
  const { plan, where, state } = ctx
  const c = plan.counts
  const scene = isScene(where)
  const relation = relationTag(c)
  const girls = girlsTag(c)
  const live = new Set(engineTagsOf(text))
  const hasMarker = [...live].some((t) => MALE_MARKER.test(t))
  const notes: Omit<BodyNote, 'charIndex' | 'name'>[] = []

  // 남자가 있는 구성 — 남자 선언은 맞으니 씬 글은 hetero 만 후타 관계로 바꾼다.
  // 캐릭터 칸 글은 남자 몫일 수 있어 건드리지 않되, 후타가 받은 글만은 남자 낱말(1boy · male · faceless male …)을 정리한다
  const bodyOnly = c.male > 0
  if (bodyOnly) {
    if (scene) {
      if (!relation) return { text, notes }
      const r = mapTags(text, (tag) => {
        if (tag !== 'hetero') return null
        if (state.relation) return { after: '', reason: `${relation} 가 이미 있어 hetero 를 뺌` }
        state.relation = true
        return { after: relation, reason: `후타가 그려져 hetero 를 ${relation} 로 바꿈` }
      })
      for (const e of r.edits) notes.push(noteOf(where, e))
      return { text: r.text, notes }
    }
    if (!ctx.futaChar) return { text, notes }
  }

  let fromSide = state.fromSide || live.has('from side')
  // 시점·구도 정리는 남자 시점 씬(남자 선언이나 음경 행위가 있음)에서만 한다 — 입맞춤·무릎베개 같은 씬의 pov 는 그대로 둔다
  const viewOk =
    !bodyOnly &&
    plan.viewFix &&
    (state.viewScene || hasMarker || [...live].some((t) => PENIS_ACT.test(t)))
  const angled = state.angle || [...live].some((t) => ANGLE_TAG.test(t))
  const r = mapTags(text, (tag, rawTag) => {
    // 관계 — hetero 는 후타 관계 태그로 (이미 있으면 뺌). 후타 혼자면 관계가 없으니 뺀다
    if (tag === 'hetero' && !bodyOnly) {
      if (scene && relation && !state.relation) {
        state.relation = true
        return { after: relation, reason: `후타가 그려져 hetero 를 ${relation} 로 바꿈` }
      }
      return {
        after: '',
        reason:
          scene && relation
            ? `${relation} 가 이미 있어 hetero 를 뺌`
            : scene
              ? '후타 혼자라 관계 태그가 필요 없어 hetero 를 뺌'
              : '후타가 그려져 남녀 관계 태그 hetero 를 뺌'
      }
    }
    // 인원수 — 남자는 세지 않는다. 하는쪽 칸의 1boy 는 카드에 girl 이 없으면 1girl 로
    if (tag === '1boy' && !scene && ctx.hasGirl === false) {
      return {
        after: '1girl',
        reason: '남자가 그려지지 않고 카드에 girl 이 없어 1boy 를 1girl 로 바꿈'
      }
    }
    if (BOYS_COUNT.test(tag)) return { after: '', reason: `남자가 그려지지 않아 ${tag} 를 뺌` }
    if (tag === '1girl' && scene && hasMarker && girls)
      return { after: girls, reason: `후타를 girl 로 세어 1girl 을 ${girls} 로 합침` }
    // 남자 묘사 — 알려진 구절은 바꾸고, 나머지 male 구절은 구절째 뺀다
    const mapped = MALE_PHRASE[tag]
    if (mapped) return { after: mapped, reason: `후타가 그려져 ${tag} 를 ${mapped} 로 바꿈` }
    if (REMOVE_MALE.has(tag)) return { after: '', reason: `남자가 그려지지 않아 ${tag} 를 뺌` }
    const another = /^another's male (.+)$/.exec(tag)
    if (another) {
      const after = `another's ${another[1]}`
      return { after, reason: `후타가 그려져 ${tag} 에서 male 을 뺌` }
    }
    const words = wordCount(tag)
    if (
      words <= MAX_PHRASE_WORDS &&
      !tag.startsWith('futa ') &&
      (/\bmale\b/.test(tag) ||
        (words <= 4 && /^(?:man|men|guy|guys|boy|boys)$/.test(tag.split(' ').pop() ?? '')))
    )
      return {
        after: '',
        reason: `남자가 그려지지 않아 남성 구절 ${tag} 를 구절째 뺌 (male 만 뺀 태그를 확인할 수 없음)`
      }
    // 남자가 따로 있는 씬에서 후타가 받은 글은 여기까지만 정리한다 (고환·시점·서술은 남자 몫일 수 있다)
    if (bodyOnly) return null
    // 고환 — 후타는 고환이 없다 (no testicles 는 카드 칸에 더한다). 카드가 고환 유형을 정했으면 존중한다
    if (!plan.keepTesticles && /\btesticles?\b/.test(tag) && !/^(?:no|without) /.test(tag))
      return { after: '', reason: `후타는 고환이 없어 ${tag} 를 뺌` }
    // 시점·구도 (설정으로 따로 끈다 · 남자 시점 씬에서만)
    if (viewOk) {
      if (POV_TAGS.has(tag)) {
        if (!fromSide && !angled) {
          fromSide = true
          state.fromSide = true
          return { after: 'from side', reason: `후타가 화면에 나오게 ${tag} 를 from side 로 바꿈` }
        }
        return {
          after: '',
          reason: angled
            ? `후타가 화면에 나오게 ${tag} 를 뺌 (다른 앵글 태그가 있어 from side 는 더하지 않음)`
            : `후타가 화면에 나오게 ${tag} 를 뺌 (from side 가 이미 있음)`
        }
      }
      if (
        SOURCE_FRAMING.has(tag) &&
        (where === 'source' || ((where === 'slot' || where === 'char') && ctx.role === 'source'))
      )
        return { after: '', reason: `하는쪽의 얼굴·몸이 보이게 ${tag} 를 뺌` }
      // 하는쪽 후타가 그려지면 씬 전체 글(메인·씬 프롬프트)의 head out of frame 도 뺀다 — 하는쪽 칸의 것과 같은 까닭이다.
      // 하는쪽 후타가 아닌 씬(후타가 당하는쪽이거나 남자가 같이 그려짐)의 씬 글은 누구의 얼굴인지 몰라 그대로 둔다
      if (tag === 'head out of frame' && scene && plan.sourceFuta)
        return {
          after: '',
          reason: '하는쪽 후타의 얼굴이 보이게 씬 전체 글의 head out of frame 을 뺌'
        }
      if (tag === 'penis focus' && scene)
        return { after: '', reason: '후타 얼굴·몸이 보이게 penis focus 를 뺌' }
    }
    // 중복 — 후타 카드에 이미 large penis 가 있다
    if (plan.dedupePenis && tag === 'large penis' && (scene || where === 'source'))
      return { after: '', reason: '후타 카드에 large penis 가 이미 있어 겹치는 것을 뺌' }
    // 영문 서술 — he/his/him/the man → the futanari. 화면 밖·잘림을 말하는 문장과, 바꾼 뒤에도 남성 낱말이 남는 문장은 바꾸지 않는다
    if (MALE_PRONOUN.test(tag)) {
      if (FRAMING_WORDS.test(tag))
        return {
          keep: '화면 밖·잘림·보임을 말하는 문장이라 바꾸면 후타를 가리거나 잘라 내라는 뜻이 되어 안 바꿈 — 필요하면 씬 글을 직접 고치세요'
        }
      const after = swapMalePronouns(rawTag)
      if (MALE_WORD_LEFT.test(after))
        return {
          keep: '남성 낱말이 함께 있어 안전하게 못 바꿈 — 필요하면 씬 글을 직접 고치세요'
        }
      return {
        after,
        reason: '후타가 그려져 서술 속 남성 지칭(he·his·him·the man)을 the futanari 로 바꿈'
      }
    }
    // 접두 표정 — 둘 다 girl 이라 누구 것인지 모호할 수 있다 (짧은 태그만 · 경고만)
    if (scene && girls && words <= 3 && /^(?:girl|she) (?!on top|on bottom)\w/.test(tag))
      return { keep: `둘 다 여성형이라 ${tag} 가 누구 것인지 모호할 수 있음 — 안 바꿈` }
    if (!tag.startsWith('futa ') && MALE_WORD_LEFT.test(tag))
      return { keep: '서술 속 남성 낱말이라 안전하게 바꿀 수 없어 그대로 둠' }
    return null
  })
  for (const e of r.edits) notes.push(noteOf(where, e))
  for (const k of r.kept) notes.push({ kind: 'kept', where, before: k.before, reason: k.reason })
  return { text: r.text, notes }
}

function noteOf(where: TextWhere, e: TagEdit): Omit<BodyNote, 'charIndex' | 'name'> {
  const kind: BodyNote['kind'] = !e.after ? 'removed' : 'replaced'
  return {
    kind,
    where,
    before: e.before,
    ...(e.after ? { after: e.after } : {}),
    reason: e.reason
  }
}

// ── 씬·메인 글 ───────────────────────────────────────────

export interface SceneTexts {
  /** 기본(메인) 프롬프트 — 분할을 쓰면 parts 가 우선이다 */
  base: string
  parts?: PromptParts
  /** 씬 프롬프트 (메인 탭이면 빈 글) */
  prompt: string
}

/**
 * 메인 프롬프트(기본 3분할 또는 한 줄)와 씬 프롬프트를 함께 읽어 후타 구성에 맞게 바꾼다.
 * 인원수·관계는 글 여러 개를 함께 봐야 해서 여기서 한다 — 남자 선언(hetero·1boy …)이 어느 글에 있든
 * 1girl 은 합치고 관계 태그는 하나만 둔다. 후타가 안 그려지면 부르지 않는다.
 * 같은 plan 으로 다시 부르면(refreshScenePrompts) 같은 결과가 나온다.
 */
export function rewriteSceneTexts(
  plan: FutaPlan,
  input: SceneTexts
): SceneTexts & { notes: BodyNote[]; state: TextState } {
  const relation = relationTag(plan.counts)
  const texts = input.parts
    ? [input.parts.base, input.parts.additional, input.parts.detail, input.prompt]
    : [input.base, input.prompt]
  const places: TextWhere[] = input.parts ? ['main', 'main', 'main', 'scene'] : ['main', 'scene']
  const state: TextState = {
    relation: !!relation && texts.some((t) => engineTagsOf(t).includes(relation)),
    fromSide: texts.some((t) => engineTagsOf(t).includes('from side')),
    ...sceneFacts(texts)
  }
  // 남자가 없는 구성에서 남자 선언이 어느 글에 있는지 — 1girl 합침과 관계 태그 더하기의 조건
  const markerAt = texts.findIndex((t) => engineTagsOf(t).some((tag) => MALE_MARKER.test(tag)))

  const notes: BodyNote[] = []
  const next = texts.map((t, i) => {
    // 남자 선언이 다른 글에 있어도 합침이 되도록, 마커가 있으면 이 글에도 마커가 있는 것으로 읽는다
    const r = rewriteOne(t, { plan, where: places[i], state })
    notes.push(...r.notes)
    return r.text
  })
  const girls = girlsTag(plan.counts)
  // 남자가 없고 남자 선언이 있었다 — 1girl 이 다른 글에 있으면 합친다, 관계 태그가 아직 없으면 더한다
  if (plan.counts.male === 0 && markerAt >= 0) {
    if (girls) {
      texts.forEach((t, i) => {
        // markerAt 글은 rewriteOne 이 이미 했다 (그 글에 마커가 있어서) — 다른 글의 1girl 만 합친다
        if (i === markerAt || !engineTagsOf(t).includes('1girl')) return
        const m = mapTags(next[i], (tag) =>
          tag === '1girl'
            ? { after: girls, reason: `후타를 girl 로 세어 1girl 을 ${girls} 로 합침` }
            : null
        )
        next[i] = m.text
        notes.push(...m.edits.map((e) => ({ ...noteOf(places[i], e) })))
      })
    }
    if (relation && !state.relation) {
      state.relation = true
      // 가중치 표기(::)가 홀수인 깨진 글 끝에 이으면 관계 태그가 닫히지 않은 묶음 안으로 들어간다 — 그런 글은 앞에 둔다
      const open = (next[markerAt].match(/::/g) ?? []).length % 2 === 1
      next[markerAt] = open
        ? appendPromptPiece(relation, next[markerAt])
        : appendPromptPiece(next[markerAt], relation)
      notes.push({
        kind: 'added',
        where: places[markerAt],
        after: relation,
        evidence: [
          ...new Set(engineTagsOf(texts[markerAt]).filter((t) => MALE_MARKER.test(t)))
        ].join(', '),
        reason: `남자 선언은 있는데 관계 태그가 없어 ${relation} 를 더함`
      })
    }
  }
  const base = input.parts ? input.base : next[0]
  const parts = input.parts ? { base: next[0], additional: next[1], detail: next[2] } : undefined
  return { base, parts, prompt: next[next.length - 1], notes, state }
}

/**
 * 메인 탭 요청의 프롬프트(한 줄 또는 3분할)를 후타 구성에 맞게 바꾼 사본을 돌려준다.
 * 바뀐 게 없으면 요청 객체를 그대로 돌려준다 (예전과 글자 단위로 같다). state 는 캐릭터 칸 글에 이어 쓴다.
 */
export function rewriteRequestPrompt<T extends { prompt: string; promptParts?: PromptParts }>(
  plan: FutaPlan,
  request: T
): { request: T; notes: BodyNote[]; state: TextState } {
  const r = rewriteSceneTexts(plan, {
    base: request.prompt,
    parts: request.promptParts,
    prompt: ''
  })
  if (!r.notes.length) return { request, notes: [], state: r.state }
  if (r.parts)
    return {
      request: {
        ...request,
        promptParts: r.parts,
        prompt: [r.parts.base, r.parts.additional, r.parts.detail].reduce(appendPromptPiece, '')
      },
      notes: r.notes,
      state: r.state
    }
  return { request: { ...request, prompt: r.base }, notes: r.notes, state: r.state }
}

// ── 캐릭터 칸 글 ──────────────────────────────────────────

export interface CharTexts {
  /** 하는쪽 태그 칸을 이 캐릭터가 받은 것 (역할이 하는쪽일 때) */
  source?: string
  /** 당하는쪽 태그 칸을 이 캐릭터가 받은 것 */
  target?: string
  slot?: string
  /** 씬별 캐릭터 태그 */
  char?: string
  /** 상대 태그 */
  partner?: string
}

/** 캐릭터가 걸린 메모 — 순서·이름·카드 id */
function charNote(
  n: Omit<BodyNote, 'charIndex' | 'name'>,
  who: { index: number; name: string; id?: number }
): BodyNote {
  return {
    ...n,
    charIndex: who.index,
    name: who.name,
    ...(who.id != null ? { charId: who.id } : {})
  }
}

/**
 * 이 캐릭터에게 붙는 글(하는쪽/당하는쪽 칸·자리·캐릭터·상대 태그)을 후타 구성에 맞게 바꾼다.
 * 남자가 없는 구성에서는 모든 캐릭터의 글을, 남자가 있는 구성에서는 후타가 받은 글의 남자 낱말만 정리한다 (나머지는 남자 몫일 수 있다).
 * state 는 rewriteSceneTexts 가 돌려준 것을 이어 쓴다 — from side 가 캐릭터마다 겹쳐 붙지 않게.
 */
export function rewriteCharTexts(
  plan: FutaPlan,
  texts: CharTexts,
  who: {
    index: number
    name: string
    /** 카드 id — 화면이 어느 카드의 메모인지 이름이 겹쳐도 가리게 */
    id?: number
    role: 'source' | 'target' | null
    hasGirl: boolean
    /** 이 캐릭터가 후타로 읽혔음 */
    futa?: boolean
  },
  state: TextState
): { texts: CharTexts; notes: BodyNote[] } {
  const out: CharTexts = {}
  const notes: BodyNote[] = []
  const slots: [keyof CharTexts, TextWhere][] = [
    ['source', 'source'],
    ['target', 'target'],
    ['slot', 'slot'],
    ['char', 'char'],
    ['partner', 'char']
  ]
  for (const [key, where] of slots) {
    const text = texts[key]
    if (text == null) continue
    const r = rewriteOne(text, {
      plan,
      where,
      role: who.role,
      hasGirl: who.hasGirl,
      futaChar: who.futa,
      state
    })
    out[key] = r.text
    for (const n of r.notes) notes.push(charNote(n, who))
  }
  return { texts: out, notes }
}

// ── 몸에 맞춰 더하는 태그 ───────────────────────────────────

/**
 * 이 캐릭터 칸에 몸에 맞춰 더할 태그와 메모.
 *  - 후타(재조립이 켜져 있을 때)이고 고환 유형 태그가 없으면 no testicles
 *  - 알몸이고 가슴이 여성 몸이면 pink nipples (후타 하는쪽 포함 · 유두 색 태그가 있거나 이미 있으면 안 더함 · 설정 없음)
 * texts 는 이 캐릭터의 모든 글(카드·복장·씬 태그 — 바꾼 뒤의 것). nude 는 알몸 여부.
 */
export function bodyTagsFor(input: {
  reading: BodyReading
  /** 후타 재조립 설정 */
  futaOn: boolean
  /** 이 캐릭터가 알몸인가 — 옷 벗기기로 벗겼거나 글이 온몸 알몸을 선언함 */
  nude: boolean
  texts: string[]
  index: number
  name: string
  id?: number
}): { tags: string[]; notes: BodyNote[] } {
  const { reading, texts } = input
  const tags: string[] = []
  const notes: BodyNote[] = []
  const add = (tag: string, reason: string): void => {
    tags.push(tag)
    notes.push(charNote({ kind: 'added', where: 'char', after: tag, reason }, input))
  }
  if (input.futaOn && reading.body.futa && !reading.testicleType && !hasTesticleType(texts))
    add(NO_TESTICLES, '후타 카드에 고환 유형 태그가 없어 더함 (후타는 고환 없음이 기본)')
  if (wantsPinkNipples({ chestFemale: reading.chestFemale, nude: input.nude, texts }))
    add(
      PINK_NIPPLES,
      '알몸이고 가슴이 여성 몸이라 더함 (단보루 태그는 아니지만 실측으로 유두가 잘 나옴)'
    )
  return { tags, notes }
}

/** 이 캐릭터가 알몸인가 — 옷 벗기기로 벗겼거나, 글이 온몸 알몸(nude · completely nude · naked)을 선언했다 */
export function isNudeChar(stripped: boolean, texts: string[]): boolean {
  return stripped || declaresFullNude(texts)
}

/** 카드 상태(의심·충돌·못 읽음)를 메모로 — 바꾸지 않고 표시만 한다. 근거가 된 태그를 같이 보인다 */
export function flagNotes(
  reading: BodyReading,
  index: number,
  name: string,
  id?: number
): BodyNote[] {
  const reasons: Record<BodyReading['flags'][number], [BodyNote['kind'], string]> = {
    suspect: [
      'suspect',
      '여성 카드에 음경 태그만 있어 후타로 보지 않았음 — 후타라면 카드에 futanari 를 적으세요'
    ],
    conflict: [
      'conflict',
      '카드에 1boy 같은 남자 태그와 futanari 가 함께 있어 후타로 바꾸지 않았음'
    ],
    unreadable: [
      'unreadable',
      '카드의 조각(<이름>)·랜덤 선택지에 후타가 들어올 수 있는데 뽑힌 값을 미리 알 수 없어 후타인지 읽지 못함'
    ]
  }
  return reading.flags.map((f) =>
    charNote(
      {
        kind: reasons[f][0],
        where: 'char',
        ...(reading.evidence[f] ? { evidence: reading.evidence[f] } : {}),
        reason: reasons[f][1]
      },
      { index, name, id }
    )
  )
}
