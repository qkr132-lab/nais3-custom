import { norm } from './auto-expose'
import { liveFragments } from './expose-evidence'
import { mapTags } from './futa'
import type { NudeStripSex } from './nude-strip'
import type { BodyNote } from './types'

/**
 * 눈이 안 보이는 장면이면 카드의 눈 외형 태그를 뺀다 (커스텀).
 *
 * 「눈이 안 보임」은 세 갈래다 — 눈 감음(closed eyes · ^_^ · >_< …) · 잠듦(sleeping · she is asleep …) · 눈 가림(blindfold · 눈을 덮은 sleep mask · covered eyes · covering own eyes …).
 * 그 캐릭터에게 걸린 장면 태그(옷 벗기기와 같은 범위 — scene-request 의 sceneContextGroupsFor)나 그 캐릭터가 입은 복장에
 * 근거가 있으면, 카드(캐릭터 탭) 글에서 눈을 떠야만 보이는 것을 걷어낸다 — 눈 색·동공·흰자·빛나는 눈·눈동자 무늬·기호 눈(하트·소용돌이 …)·
 * 눈 상태(반쯤 뜬 눈·공허한 눈 …)·시선(looking at viewer …). 눈이 가려졌는데 눈 색이 남으면 NAI 가 눈을 뜬 그림으로 끌려간다.
 *
 * 남기는 것 — 눈매 윤곽(tsurime · tareme), 속눈썹, 눈썹, 화장(eyeshadow · eyeliner · mascara), 안경·안대·고글·가면,
 * 눈 주변 흉터·문신·점, 눈물·다크서클처럼 감은 눈에도 그려지는 것, 얼굴 방향(facing viewer).
 * 한쪽 눈만 감은 표현(one eye closed · wink)은 근거가 아니다 (눈이 보인다).
 * 더 좁은 글의 말이 이긴다 — 근거가 씬 전체 글처럼 넓은 범위에서 왔는데, 이 캐릭터만의 글(자리·캐릭터·상대 태그)에
 * 눈 뜬 표현(rolling eyes · looking at viewer …)이 분명하면 빼지 않고 「안 바꿈」으로 알린다.
 * 빼달라는 음수 가중치(-1::blue eyes::)·와일드카드·주석은 그대로 둔다 (nude-strip 의 filterTags 와 같은 규칙 — futa.ts 의 mapTags).
 * 뺀 것은 전부 BodyNote(kind removed, topic eyes)로 돌려줘 화면에 보인다 — 몰래 빼지 않는다.
 * 설정 「눈이 안 보이면 눈 태그 빼기」(eyes_closed_strip, 기본 꺼짐)가 꺼져 있으면 카드 글을 읽지 않고 그대로 돌려준다 (이 기능이 없던 때와 같다).
 * DB·IPC 없는 순수 계산이다.
 */

// ── 눈이 안 보이는 까닭 ───────────────────────────────────

/** 눈이 안 보이는 까닭 — 눈 감음 · 잠듦 · 눈 가림 */
export type EyeCause = 'closed' | 'asleep' | 'covered'

export const EYE_CAUSE_LABEL: Record<EyeCause, string> = {
  closed: '눈 감음',
  asleep: '잠듦',
  covered: '눈 가림'
}

/** 근거가 놓인 글의 범위 — 씬 전체 글 < 하는쪽·당하는쪽 칸 < 이 캐릭터만의 글 (뒤로 갈수록 좁다) */
export type EyeScope = 'scene' | 'role' | 'char'

const SCOPE_RANK: Record<EyeScope, number> = { scene: 0, role: 1, char: 2 }

/** 범위마다 이 캐릭터에게 걸린 장면 글 */
export interface EyeContexts {
  /** 씬 전체 글 (기본·씬·메인 프롬프트) — 이 캐릭터가 받는 경우에만 */
  scene?: readonly string[]
  /** 하는쪽/당하는쪽 태그 칸 */
  role?: readonly string[]
  /** 이 캐릭터만의 글 — 씬별 캐릭터 태그·상대 태그 (자리 태그를 seat 로 따로 주지 않으면 자리 태그도 여기) */
  char?: readonly string[]
  /**
   * 자리 태그 — char 와 같은 범위다. 「안 바꿈」 이유에서 인셋 자리라고 말해도 되는지(눈 뜬 표현이 자리 태그에서 왔는지)를
   * 가리는 데만 따로 둔다
   */
  seat?: readonly string[]
}

/** 글 목록만 주면 씬 전체 글로 본다 (범위를 가르지 않는 호출) */
const groupsOf = (contexts: EyeContexts | readonly string[]): EyeContexts =>
  Array.isArray(contexts) ? { scene: contexts as readonly string[] } : (contexts as EyeContexts)

/** 범위 하나의 글 — 이 캐릭터만의 글(char)은 자리 태그(seat)를 함께 읽는다 */
const textsOf = (g: EyeContexts, scope: EyeScope): readonly string[] =>
  scope === 'char' ? [...(g.char ?? []), ...(g.seat ?? [])] : (g[scope] ?? [])

const SCOPES: EyeScope[] = ['scene', 'role', 'char']

/** 근거가 여럿일 때 어느 까닭을 보여 줄지의 차례 */
const CAUSE_ORDER: EyeCause[] = ['closed', 'asleep', 'covered']

// ── 글 읽기 도구 ─────────────────────────────────────────

/** 눈이 감겼다는 낱말 */
const CLOSED = /^(?:closed|shut)$/
/** 눈을 감는 동사 — closes her eyes · shut his eyes */
const CLOSE_VERB = /^(?:close|closes|closed|closing|shut|shuts|shutting)$/
/** 동사와 눈 사이의 한정어 (closes her eyes) */
const DETERMINER = /^(?:her|his|their|its|the|both|own|your|my|our)$/
/** 눈과 닫힘 사이에 올 수 있는 말 — 이 밖의 말이 끼면(half · slightly · wide open …) 감은 눈이 아니다 */
const FILLER =
  /^(?:are|is|were|was|be|being|been|remain|remains|remained|stay|stays|stayed|kept|keep|keeps|keeping|tightly|tight|firmly|gently|softly|lightly|now|still|always|fully|completely|squeezed|squeezing|screwed|scrunched|clenched|forced)$/
/** 닫힘 앞에서 눈이 보인다는 뜻으로 돌리는 말 — half closed eyes · slightly closed eyes */
const QUALIFIER = /^(?:half|partly|partially|slightly|barely|almost|nearly|mostly|semi|somewhat)$/
/** 부정어 — her eyes are not closed · without closing her eyes · never closes her eyes */
const NEGATION =
  /^(?:not|no|never|without|nor|neither|isn't|aren't|wasn't|weren't|doesn't|don't|didn't|won't|can't|cannot|couldn't|wouldn't|shouldn't|unable|refuses|refused|fails|failed)$/
/** 닫힘 바로 뒤에서 감은 눈이 아니라는 말 — eyes closed halfway · eyes wide open */
const AFTER_WIDE = /^(?:wide|halfway|partway|partly|partially|slightly)$/
const AFTER_OPEN = /^(?:open|opened)$/
const AFTER_MOUTH_OPEN = /^(?:open|opened|agape|ajar)$/

/**
 * 닫힘 낱말(end) 바로 뒤가 「눈이 보인다」거나 「닫힌 것이 눈이 아니다」를 말하는가.
 * 쉼표 없이 이어 쓴 글을 가른다 — mouth closed eyes wide open(눈 뜸) · open eyes closed mouth(닫힌 것은 입) 는 막고,
 * closed eyes open mouth · eyes closed mouth open(입이 열림)은 감은 눈이다.
 * byEyesFirst = 「eyes … closed」 어순 — 닫힘 뒤의 mouth 는 닫힌 입일 수 있어 입이 열렸다는 말이 이어질 때만 감은 눈으로 본다
 */
function afterBlocksClosed(words: string[], end: number, byEyesFirst: boolean): boolean {
  const next = words[end + 1] ?? ''
  const after = words[end + 2] ?? ''
  if (AFTER_WIDE.test(next)) return true
  if (AFTER_OPEN.test(next)) return after !== 'mouth'
  if (byEyesFirst && next === 'mouth') return !AFTER_MOUTH_OPEN.test(after)
  return false
}
/** 눈과 닫힘 사이에 끼울 수 있는 말의 최대 개수 (eyes are tightly closed = 2개) */
const MAX_FILLERS = 3

/** 낱말 목록 — 소문자, 영숫자·아포스트로피·하이픈만 (expose-evidence 와 같은 나누기) */
const wordsOf = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^a-z0-9'\- ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

/** 눈의 주인 — F/M = 지칭어로 정해짐, other = 상대(another's · your …)의 눈, null = 모름 */
type EyeOwner = 'F' | 'M' | 'other' | null

/** her/his 와 눈 사이에 이 낱말이 끼면 her/his 는 소유격이 아니라 목적어다 — he kisses her with eyes closed */
const OWNER_BREAK =
  /^(?:with|to|at|in|on|by|for|of|from|against|into|onto|toward|towards|and|as|while|then|but)$/

function eyeOwner(words: string[], i: number): EyeOwner {
  // 눈 바로 앞의 소유 표현 — her eyes · his closed eyes · the man's eyes
  const before = words[i - 1] ?? ''
  if (/^(?:another|other|someone|partner|viewer)'s$/.test(before) || before === 'your')
    return 'other'
  for (let k = i - 1; k >= Math.max(0, i - 3); k--) {
    const w = words[k]
    if (w === 'her' || /^(?:woman|girl|female|lady)'s$/.test(w)) return 'F'
    if (w === 'his' || /^(?:man|male|boy|guy)'s$/.test(w)) return 'M'
    if (w === 'their') return null
    if (OWNER_BREAK.test(w)) break
  }
  // 소유 표현이 없으면 토막 앞쪽의 주어 — she keeps eyes closed
  for (let k = 0; k < Math.min(words.length, 4); k++) {
    if (/^(?:she|herself|woman|girl|female|lady)$/.test(words[k])) return 'F'
    if (/^(?:he|himself|man|boy|male|guy)$/.test(words[k])) return 'M'
  }
  return null
}

/** 이 눈 주인이 이 캐릭터 몸인가 — sex 가 null(후타·모름)이면 남녀 지칭어로 거르지 않는다 */
function ownedBy(owner: EyeOwner, sex: NudeStripSex | null): boolean {
  if (owner === 'other') return false
  if (owner === null || sex === null) return true
  return (owner === 'F') === (sex === 'female')
}

/** 말하는 이를 가리키는 낱말 — 잠듦·가림 문장의 주어 */
const BE_WORD =
  /^(?:is|are|was|were|be|been|being|remain|remains|remained|stay|stays|stayed|keep|keeps|kept|lie|lies|lay|lying|'s)$/
const SUBJECT_ADVERB =
  /^(?:fast|sound|deeply|deep|soundly|peacefully|quietly|already|still|now|also|just|completely|fully|totally|really|truly|both|always)$/
const F_SUBJECT = /^(?:she|she's|herself|woman|girl|female|lady|heroine)$/
const M_SUBJECT = /^(?:he|he's|himself|man|boy|male|guy)$/
const OTHER_SUBJECT =
  /^(?:they|they're|it|it's|you|you're|another|someone|partner|partner's|viewer|others?|friend|child|baby|cat|dog|pet|animal|husband|boyfriend|lover)$/

/** 문장 속 동작·상태(잠듦·눈 가림)의 주어가 누구인가 — 뚜렷한 주어가 없으면 null */
function subjectOwner(words: string[], i: number): EyeOwner {
  for (let k = i - 1; k >= Math.max(0, i - 5); k--) {
    const w = words[k]
    if (BE_WORD.test(w) || SUBJECT_ADVERB.test(w)) continue
    if (F_SUBJECT.test(w) || w === 'her') return 'F'
    if (M_SUBJECT.test(w) || w === 'his') return 'M'
    if (OTHER_SUBJECT.test(w)) return 'other'
    return null
  }
  return null
}

/** 근거로 보일 글 조각의 길이 (expose-evidence 와 같은 80자) */
const clip = (s: string): string => (s.length > 80 ? `${s.slice(0, 79)}…` : s)

// ── 눈 감음 ──────────────────────────────────────────────

/**
 * 토막 하나가 「눈을 감았다」고 말하는가 (소문자·norm 한 글).
 * closed eyes · eyes closed · her eyes are closed · with eyes tightly closed · eyes squeezed shut · closes her eyes.
 * 단수 eye(one eye closed · left eye closed)·half-closed eyes·부정문은 아니다.
 */
function sayEyesClosed(text: string, sex: NudeStripSex | null): boolean {
  const words = wordsOf(text)
  for (let i = 0; i < words.length; i++) {
    if (words[i] !== 'eyes') continue
    // 닫힘 낱말이 있는 자리 — (a) closed eyes (b) eyes (are tightly) closed (c) closes her eyes
    let end = -1
    let eyesFirst = false
    const prev = words[i - 1] ?? ''
    if (CLOSED.test(prev) && !QUALIFIER.test(words[i - 2] ?? '')) end = i
    if (end < 0) {
      let j = i + 1
      while (j < words.length && j <= i + MAX_FILLERS && FILLER.test(words[j])) j++
      if (j < words.length && CLOSED.test(words[j])) {
        end = j
        eyesFirst = true
      }
    }
    if (end < 0) {
      let k = i - 1
      while (k >= 0 && DETERMINER.test(words[k])) k--
      if (k < i - 1 && k >= 0 && CLOSE_VERB.test(words[k]) && !QUALIFIER.test(words[k - 1] ?? ''))
        end = i
    }
    if (end < 0) continue
    if (afterBlocksClosed(words, end, eyesFirst)) continue
    const start = Math.max(0, i - 4)
    if (words.slice(start, end + 1).some((w) => NEGATION.test(w))) continue
    if (!ownedBy(eyeOwner(words, i), sex)) continue
    return true
  }
  return false
}

/**
 * 눈을 완전히 감은 얼굴 기호 (단보루 실존 · norm 한 글) — ^_^ (감은 눈) · >_< (꽉 감은 눈) · u_u (감은 눈) · ^q^ (^_^ 눈) ·
 * x3 (>_< 눈 + :3) · xd (>_< 눈 + :D) · dx (> < 눈 + :D).
 * 반쯤 뜬 기호(=_= 실눈)·윙크(>_o · ;) · ;d …)·울음(T_T)은 완전히 감은 것이 아니라 넣지 않는다.
 * >_< 는 < > 가 들어 있어 와일드카드 토큰으로 읽히므로 읽기 전에 SQUEEZED+번호 낱말로 바꿨다가 근거를 보일 때 원문 표기로 되돌린다
 */
const SQUEEZED = 'tight-shut-eyes-face'
const SQUEEZED_BACK = /tight-shut-eyes-face(\d+)/g
const GT_LT = /(?<![^\s,(:#\n])>[_ ]<(?![^\s,):\n])/g
const CLOSED_FACES = new Set(['^ ^', 'u u', '^q^', 'x3', 'xd', 'dx'])
const isSqueezedFace = (t: string): boolean => /^tight-shut-eyes-face\d+$/.test(t)

// ── 잠듦 ────────────────────────────────────────────────

/**
 * 잠든 상태를 말하는 태그 (단보루 실존) — sleeping · sleeping upright · sleeping on person · sleeping on desk.
 * 못 넣는 것 — half-asleep · sleepy · waking up · feigning sleep · unconscious · fainting · sleeping bag · sleepwear · sleeping animal
 */
const SLEEP_TAG =
  /^(?:(?:fast|sound|deeply|deep) )?asleep$|^sleeping(?: (?:upright|on person|on desk|soundly|peacefully|deeply|quietly))?$/
/**
 * 자는 사람을 당하는 쪽이 가리키는 태그 — sleep molestation (잠든 사람에게 하는 행위: 잠든 쪽은 받는 쪽이다).
 * 하는쪽 캐릭터에게는 근거가 아니다 — 깨어서 행위하는 쪽의 눈을 가리면 거꾸로 된 그림이 된다
 */
const SLEEP_RECEIVER_TAG = /^sleep molestation$/
/** 잠듦이 아니게 만드는 말 — 반쯤 · 깨는 중 · 자는 척 · 잠들려는 참 · 침낭 · 잠옷 */
const SLEEP_BLOCK =
  /^(?:half|barely|almost|nearly|about|trying|try|tries|pretend|pretends|pretending|feign|feigns|feigning|fake|fakes|faking|wake|wakes|waking|woke|awake|awaken|bag|bags|pill|pills|mat|position|gown|wear|quarters|sleepy|drowsy|falling|falls|fall|fell|nodding)$/
/** 「sleeping 다음」에 오면 자는 사람이 따로 있다는 말 — her sleeping partner · his sleeping mother */
const SLEEPER_NOUN: [RegExp, EyeOwner][] = [
  [
    /^(?:partners?|husband|wife|boyfriend|girlfriend|lover|friends?|child|children|baby|kid|kids|cat|dog|pet|animal|bird|fox|sister|brother|mother|mom|mum|father|dad|daughter|son|master|guest|customer|stranger|victim|companion|roommate|neighbou?r|teacher|student|boss|maid|servant|prisoner|twin|siblings?|parents?)$/,
    'other'
  ],
  [/^(?:man|boy|guy|male)$/, 'M'],
  [/^(?:girl|woman|lady|female)$/, 'F']
]
/** 소유격 + sleeping 다음에 와도 자는 사람이 소유자 자신인 몸 낱말 — her sleeping face */
const SLEEPER_BODY =
  /^(?:face|body|head|eyes|self|expression|form|figure|features|profile|posture|pose|appearance|look|looks)$/
/** sleeping 다음에 와서 「자는 사람」이 아니라 상태를 이어 말하는 낱말 — 이때의 her sleeping 은 소유자가 자는 것이다 */
const SLEEP_CONTINUES =
  /^(?:with|on|in|at|by|beside|next|under|and|but|while|as|because|when|so|to|after|before|from|during|like|together|around|against|upon|over|still|soundly|peacefully|deeply|quietly|fast|too|also|again|now|then|here|there|upright)$/
/** 같이 자는 사람을 가리켜 「성관계」 뜻으로 쓰는 낱말 — sleeping with him · sleeps with her boyfriend */
const SLEEP_WITH_PERSON =
  /^(?:him|them|me|you|us|himself|someone|somebody|everyone|anyone|another|strangers?|men|women|man|woman|guy|guys|boy|boys|girl|girls|partners?|husband|wife|boyfriend|girlfriend|lovers?|friends?|sister|brother|mother|mom|mum|father|dad|boss|teacher|master|customers?|clients?|king|prince|knight|neighbou?r)$/

/** asleep/sleeping/sleeps 가 「누구와 잔다」(성관계 완곡어)로 쓰였는가 — she is sleeping with him · they sleep together */
function sleepsWithSomeone(words: string[], i: number): boolean {
  const next = words[i + 1] ?? ''
  if (next === 'together') return true
  if (next !== 'with') return false
  const a = words[i + 2] ?? ''
  if (/^(?:the|a|an|my|your|our|his|their|her)$/.test(a)) {
    const b = words[i + 3]
    // 「with her」로 끝나면 목적어다 — with her eyes closed 와 가른다
    if (b === undefined) return a === 'her' || a === 'his'
    return SLEEP_WITH_PERSON.test(b)
  }
  return SLEEP_WITH_PERSON.test(a)
}

/**
 * 토막 하나가 이 캐릭터가 잠들었다고 말하는가 (소문자·norm 한 글) — 태그는 누구에게나, 문장은 주어로 가른다.
 * giver = 이 캐릭터가 하는쪽이다 — sleep molestation 은 자는 쪽(받는 쪽)의 태그라 하는쪽에게는 근거가 아니다
 */
function saySleeping(text: string, sex: NudeStripSex | null, giver = false): boolean {
  if (SLEEP_TAG.test(text)) return true
  if (!giver && SLEEP_RECEIVER_TAG.test(text)) return true
  const words = wordsOf(text)
  if (words.some((w) => SLEEP_BLOCK.test(w))) return false
  for (let i = 0; i < words.length; i++) {
    if (!/^(?:asleep|sleeping|sleeps)$/.test(words[i])) continue
    if (words.slice(Math.max(0, i - 4), i).some((w) => NEGATION.test(w))) continue
    if (words.slice(i + 1, i + 3).some((w) => NEGATION.test(w))) continue
    if (sleepsWithSomeone(words, i)) continue
    let owner = subjectOwner(words, i)
    // her sleeping partner — 자는 사람은 다음 낱말이 가리킨다
    const noun = words[i + 1] ?? ''
    if (words[i] === 'sleeping') {
      for (const [re, who] of SLEEPER_NOUN) if (re.test(noun)) owner = who
      // her sleeping X — X 가 사람·물건이면 자는 것은 소유자가 아니라 X 다 (몸 낱말·이어 말하는 낱말만 소유자 몫)
      if (
        /^(?:her|his|their|my|your)$/.test(words[i - 1] ?? '') &&
        noun &&
        !SLEEPER_BODY.test(noun) &&
        !SLEEP_CONTINUES.test(noun) &&
        !BE_WORD.test(noun)
      )
        owner = SLEEPER_NOUN.some(([re]) => re.test(noun)) ? owner : null
    }
    if (owner === null) continue
    if (!ownedBy(owner, sex)) continue
    return true
  }
  return false
}

// ── 눈 가림 ──────────────────────────────────────────────

/** 눈가리개 낱말 — blindfold · blindfolds · blindfolded · blindfolding (명사·동사·분사) */
const BLINDFOLD_WORD = /^blindfold(?:s|ed|ing)?$/
const SLEEP_WORDS = /^(?:sleep|sleeping)$/

/** 눈가리개·수면 안대를 푸는·올리는·벗은 낱말 — blindfold lift · blindfold removed · unworn blindfold · see-through blindfold */
const LIFT_WORD =
  /^(?:lift|lifted|lifting|lifts|raise|raised|raising|raises|remove|removed|removing|removes|off|unworn|loose|loosened|loosen|loosening|taking|takes|took|taken|dropped|fallen|see-through|transparent|sheer|mesh|translucent)$/
/** 푸는 동작 — untie · untied · untying · undo · undoing · undone · unwrap · unfasten · unbuckle … */
const UN_WORD =
  /^un(?:tie|ties|tied|tying|do|does|doing|done|wrap|wraps|wrapped|wrapping|fasten|fastens|fastened|fastening|buckle|buckles|buckled|buckling|knot|knots|knotted|knotting|lace|laces|laced|lacing|clasp|clasps|clasped|clasping|hook|hooks|hooked|hooking)$/
/** 옮기는 동작 — 눈 위로 끌어내린 것(pulled over her eyes)은 덮은 것이라, 가까이에 eyes 가 있으면 푼 것으로 보지 않는다 */
const MOVE_WORD = /^(?:pulled|pulling|pushed|pushing|slipped|slipping|slid|sliding|shoved)$/
/** 손에 든 것·걸린 것 — 쓰고 있지 않다 (물건 바로 앞뒤 2낱말만) */
const HELD_WORD = /^(?:holding|holds|hold|held|hanging|dangling|carrying|carries|carried)$/
/** 한쪽 눈만 — blindfold over one eye */
const SINGLE_WORD = /^(?:one|single|eye)$/
/** 머리 위·목에 걸쳤다는 말 — blindfold on head · blindfold around neck · mask on her forehead (around head 는 눈가리개를 쓴 묘사라 뺀다) */
const WORN_ELSEWHERE =
  /\b(?:(?:on|onto|atop|above) (?:the |her |his |their )?(?:head|forehead)|around (?:the |her |his |their )?neck)\b/
/** 손가락 사이로 엿보는 표현 — peeking through fingers · 머리카락이 가린 것(hair over eyes)은 이번 범위 밖 */
const PEEK =
  /^(?:peek|peeks|peeking|peeked|through|between|fingers|gap|gaps|spread|hair|bangs|fringe)$/
const COVER_VERB = /^(?:cover|covers|covered|covering)$/
/** 눈을 덮는 물건·손 — hands over her eyes · bandages over eyes · penis over eyes (dick/cock/arm over eyes 는 단보루에 없는 표기라 읽지 않는다) */
const COVER_THING = /^(?:hand|hands|bandage|bandages|gauze|penis)$/
/** eyes covered 뒤에서 가린 것이 아니라 묻은 것을 뜻하는 말 — covered in tears · covered with cum */
const COVERED_STAIN = /^(?:in|with)$/

/** 눈 가림 물건의 종류 — 눈가리개(blindfold) · 수면 안대(sleep mask). 「들어 올림」 표현이 이 물건들에만 영향을 준다 */
type MaskKind = 'blindfold' | 'sleep'

/** 눈 가림 근거 한 토막 — mask = 눈가리개·수면 안대일 때 그 종류 */
interface CoverHit {
  mask: MaskKind | null
}

/** words[i] 가 눈가리개·수면 안대 낱말인가 — 어느 물건인지 */
function maskKindAt(words: string[], i: number): MaskKind | null {
  const w = words[i]
  if (BLINDFOLD_WORD.test(w)) return 'blindfold'
  if (w === 'mask' && SLEEP_WORDS.test(words[i - 1] ?? '')) return 'sleep'
  return null
}

/**
 * words[i] 의 눈가리개·수면 안대가 눈을 덮고 있지 않다는 말이 가까이 있는가 — 앞뒤 3낱말만 본다 (조각 전체를 읽지 않는다).
 * single = 한쪽 눈만(one eye)도 덮고 있지 않은 것으로 센다. 부정어(no · not · without · never)도 센다
 */
function maskNotCovering(words: string[], i: number, single: boolean): boolean {
  const person = words[i] === 'blindfolded'
  const eyesNear = words.slice(Math.max(0, i - 3), i + 6).includes('eyes')
  for (let k = Math.max(0, i - 3); k <= Math.min(words.length - 1, i + 3); k++) {
    if (k === i) continue
    const w = words[k]
    if (LIFT_WORD.test(w) || UN_WORD.test(w) || NEGATION.test(w)) return true
    if (MOVE_WORD.test(w) && !eyesNear) return true
    if (!person && HELD_WORD.test(w) && Math.abs(k - i) <= 2) return true
    if (single && SINGLE_WORD.test(w)) return true
  }
  // blindfold up · blindfold down — 바로 뒤에 붙은 up/down 만 (blindfolded and tied up 의 up 은 아니다)
  return !person && /^(?:up|down)$/.test(words[i + 1] ?? '')
}

const DET_NEUTRAL = /^(?:the|a|an|that|this)$/
const PERSON_F = /^(?:woman|girl|female|lady|heroine)$/
const PERSON_M = /^(?:man|boy|male|guy)$/

/** words[j] 부터 읽는 사람(목적어)이 누구인가 — her partner · the man · him · 모르면 null */
function personAt(words: string[], j: number): EyeOwner {
  let k = j
  while (k < words.length && DET_NEUTRAL.test(words[k])) k++
  const w = words[k]
  if (!w) return null
  const next = words[k + 1] ?? ''
  if (/^(?:me|you|us)$/.test(w) || OTHER_SUBJECT.test(w)) return 'other'
  if (w === 'her' || w === 'herself') return OTHER_SUBJECT.test(next) ? 'other' : 'F'
  if (w === 'his') return OTHER_SUBJECT.test(next) ? 'other' : 'M'
  if (w === 'him' || w === 'himself') return 'M'
  if (PERSON_F.test(w)) return 'F'
  if (PERSON_M.test(w)) return 'M'
  return null
}

/** 눈가리개를 씌우는 동작의 동사 — he puts a blindfold on her (이 동사의 주어는 쓰는 사람이 아니다) */
const MASK_DO_VERB =
  /^(?:put|puts|putting|tie|ties|tying|tied|place|places|placing|placed|wrap|wraps|wrapping|wrapped|fasten|fastens|fastening|fastened|apply|applies|applying|applied|secure|secures|securing|secured|strap|straps|strapping|strapped|bring|brings|hand|hands|give|gives|offer|offers)$/
/** 쓰는 사람이 주어인 동사 — she wears a blindfold */
const MASK_WEAR_VERB = /^(?:wear|wears|wearing|worn|wore|don|dons|donning|donned)$/
const PUT_VERB = /^(?:put|puts|putting)$/
/** 눈가리개 뒤에서 쓴 사람을 가리키는 전치사 — blindfold on him · blindfold over her eyes */
const MASK_PREP = /^(?:on|onto|over|across|around|covering|against)$/
const GET_VERB = /^(?:get|gets|getting|got)$/

/**
 * 눈가리개·수면 안대(words[i])를 쓴 사람이 누구인가 — 모르면 null (이때는 이 캐릭터에게도 걸린다).
 * he blindfolded her · he puts a blindfold on her · his eyes are covered by a blindfold · she is blindfolded · her blindfold · blindfolded man
 */
function maskWearer(words: string[], i: number): EyeOwner {
  const w = words[i]
  // 동사·분사 — 목적어가 쓰는 사람이다 (blindfolds/blindfolded/blindfolding + 사람)
  if (/^blindfold(?:s|ed|ing)$/.test(w)) {
    const prev = words[i - 1] ?? ''
    const passive =
      w === 'blindfolded' &&
      (BE_WORD.test(prev) || GET_VERB.test(prev) || SUBJECT_ADVERB.test(prev))
    if (passive) return subjectOwner(words, i)
    const obj = personAt(words, i + 1)
    if (obj !== null) return obj
    if (w === 'blindfolded') return subjectOwner(words, i)
  }
  // 명사 — 뒤따르는 전치사의 사람 (blindfold on her · over his eyes)
  for (let j = i + 1; j <= Math.min(words.length - 1, i + 4); j++) {
    if (!MASK_PREP.test(words[j])) continue
    const p = personAt(words, j + 1)
    if (p !== null) return p
  }
  // 앞에서 눈의 주인을 말했다 — his eyes are covered by a blindfold
  for (let e = i - 1; e >= Math.max(0, i - 6); e--) {
    if (words[e] !== 'eyes') continue
    const o = eyeOwner(words, e)
    if (o !== null) return o
    break
  }
  // 소유격 — her blindfold · his black blindfold (쓰고 있는지는 알 수 없으나 쓴 사람은 주인)
  for (let k = i - 1; k >= Math.max(0, i - 2); k--) {
    const p = words[k]
    if (p === 'her' || /^(?:woman|girl|female|lady)'s$/.test(p)) return 'F'
    if (p === 'his' || /^(?:man|male|boy|guy)'s$/.test(p)) return 'M'
    if (/^(?:another|other|someone|partner|viewer)'s$/.test(p)) return 'other'
  }
  // 쓰는 동사 — she wears a blindfold · she puts on a blindfold
  for (let k = i - 1; k >= Math.max(0, i - 5); k--) {
    const v = words[k]
    if (MASK_WEAR_VERB.test(v) || (PUT_VERB.test(v) && words[k + 1] === 'on'))
      return subjectOwner(words, k)
    // 씌우는 동사의 주어는 쓰는 사람이 아니다 — 쓰는 사람을 모르니 거르지 않는다
    if (MASK_DO_VERB.test(v)) return null
  }
  return null
}

/** 눈가리개·수면 안대가 눈을 덮었다고 말하는가 — 덮었으면 어느 물건인지 */
function sayMaskCovers(words: string[], sex: NudeStripSex | null): MaskKind | null {
  const elsewhere = WORN_ELSEWHERE.test(words.join(' '))
  for (let i = 0; i < words.length; i++) {
    const kind = maskKindAt(words, i)
    if (!kind) continue
    if (elsewhere || maskNotCovering(words, i, true)) continue
    if (!ownedBy(maskWearer(words, i), sex)) continue
    return kind
  }
  return null
}

/** 눈이 덮였다고 말하는 문장·태그 — covered eyes · eyes covered · covering own eyes · she covers her eyes · hands over her eyes */
function sayEyesCovered(words: string[], sex: NudeStripSex | null): boolean {
  if (words.some((w) => PEEK.test(w))) return false
  for (let i = 0; i < words.length; i++) {
    if (words[i] !== 'eyes') continue
    let hit = false
    // (a) covered eyes (태그) · covers her eyes · covering own eyes
    let k = i - 1
    while (k >= 0 && DETERMINER.test(words[k])) k--
    if (k >= 0 && COVER_VERB.test(words[k])) hit = true
    // (b) eyes covered · her eyes are completely covered — 묻은 것(covered in tears)은 아니다
    if (!hit) {
      let j = i + 1
      while (j < words.length && j <= i + MAX_FILLERS && FILLER.test(words[j])) j++
      if (j < words.length && words[j] === 'covered' && !COVERED_STAIN.test(words[j + 1] ?? ''))
        hit = true
    }
    // (c) hands over her eyes · bandages over eyes
    if (!hit) {
      let m = i - 1
      while (m >= 0 && DETERMINER.test(words[m])) m--
      if (m >= 1 && words[m] === 'over' && COVER_THING.test(words[m - 1])) hit = true
    }
    if (!hit) continue
    if (words.slice(Math.max(0, i - 4), i).some((w) => NEGATION.test(w))) continue
    if (words.slice(i + 1, i + 3).some((w) => /^(?:partially|partly|slightly|halfway)$/.test(w)))
      continue
    if (!ownedBy(eyeOwner(words, i), sex)) continue
    return true
  }
  return false
}

/** 토막 하나가 이 캐릭터의 눈이 가려졌다고 말하는가 (소문자·norm 한 글) */
function sayCovered(text: string, sex: NudeStripSex | null): CoverHit | null {
  const words = wordsOf(text)
  const mask = sayMaskCovers(words, sex)
  if (mask) return { mask }
  if (sayEyesCovered(words, sex)) return { mask: null }
  return null
}

/**
 * 눈가리개·수면 안대를 들어 올렸거나 벗었다는 토막 — 한 글에라도 있으면 그 물건은 근거로 치지 않는다.
 * 그 물건 낱말 앞뒤 3낱말만 읽는다 (조각의 다른 낱말은 보지 않는다 — blindfolded and tied up 은 푼 것이 아니다).
 * all = 눈가리개·수면 안대 둘 다 (blindfold lift · blindfold removed · sleep mask on head …)
 * sleep = 수면 안대만 (그냥 mask on head — 무슨 마스크인지 모르니 눈가리개까지 지우지 않는다)
 */
function liftsMask(text: string): 'all' | 'sleep' | null {
  const words = wordsOf(text)
  const elsewhere = WORN_ELSEWHERE.test(words.join(' '))
  let hasMask = false
  let lifted = false
  let plainMask = false
  for (let i = 0; i < words.length; i++) {
    if (maskKindAt(words, i)) {
      hasMask = true
      if (maskNotCovering(words, i, false)) lifted = true
    } else if (words[i] === 'mask') plainMask = true
  }
  if (hasMask) return elsewhere || lifted ? 'all' : null
  // 그냥 mask — 머리 위로 올린 마스크(mask on head)만 수면 안대를 올린 것으로 본다
  return plainMask && elsewhere ? 'sleep' : null
}

// ── 눈이 안 보임 — 근거 찾기 ─────────────────────────────

/** 감음·잠듦·가림을 말하는 글이 있을 법한가 — 글 전체를 읽기 전에 거르는 값싼 검사 */
const HIDDEN_HINT =
  /clos|shut|sleep|asleep|blind|cover|bandage|gauze|over|\^|>|u[ _]u|x3|xd|dx|mask/i

interface Hit {
  cause: EyeCause
  text: string
  /** 눈가리개·수면 안대로 읽은 근거면 그 종류 */
  mask: MaskKind | null
}

/** 글 하나에서 첫 근거 — 실제로 보내는 글과 같게 읽는다 (주석·랜덤 선택지·와일드카드·빼달라는 음수·0 가중치·Text: 블록·따옴표 대사는 신호가 아니다) */
function* hitsIn(text: string, sex: NudeStripSex | null, giver: boolean): Generator<Hit> {
  if (!text || !HIDDEN_HINT.test(text)) return
  const faces: string[] = []
  const live = text.replace(GT_LT, (m) => `${SQUEEZED}${faces.push(m) - 1}`)
  for (const frag of liveFragments(live)) {
    if (frag.end || !frag.raw || /[가-힣]/.test(frag.text)) continue
    const raw = clip(frag.raw.replace(SQUEEZED_BACK, (_, i: string) => faces[Number(i)]))
    if (CLOSED_FACES.has(frag.text) || isSqueezedFace(frag.text) || sayEyesClosed(frag.text, sex))
      yield { cause: 'closed', text: raw, mask: null }
    else if (saySleeping(frag.text, sex, giver)) yield { cause: 'asleep', text: raw, mask: null }
    else {
      const covered = sayCovered(frag.text, sex)
      if (covered) yield { cause: 'covered', text: raw, mask: covered.mask }
    }
  }
}

/** 눈이 안 보인다는 근거 */
export interface EyeEvidence {
  cause: EyeCause
  /** 근거가 된 글 조각 (원문 표기) */
  text: string
  /** 보여 주는 근거가 놓인 범위 */
  scope: EyeScope
  /** 근거 가운데 가장 좁은 범위 — 눈 뜬 표현과 맞서 볼 때 쓴다 */
  narrowest: EyeScope
  /** 이 캐릭터가 입은 복장에서 읽은 근거 */
  outfit?: boolean
}

/**
 * 이 캐릭터에게 걸린 장면 태그(contexts)와 입은 복장(outfit)에서 눈이 안 보인다는 근거를 찾는다 (없으면 null).
 * 보여 주는 근거는 넓은 범위의 글부터 처음 만난 것, narrowest 는 근거가 있는 가장 좁은 범위.
 * 복장은 눈 가림 물건(blindfold · 눈을 덮은 sleep mask)만 근거로 본다.
 * sex = 문장의 her/his 를 이 캐릭터 몸과 맞춰 볼 때의 성별 (null = 맞춰 보지 않음 — 후타).
 * giver = 이 캐릭터가 하는쪽 (sleep molestation 처럼 받는 쪽의 태그는 하는쪽에게 근거가 아니다).
 */
export function hiddenEyesEvidence(
  contexts: EyeContexts | readonly string[],
  sex: NudeStripSex | null,
  outfit?: string,
  giver = false
): EyeEvidence | null {
  const groups = groupsOf(contexts)
  // 눈가리개를 들어 올렸다/벗었다는 글이 어디에라도 있으면 눈가리개·수면 안대는 근거로 치지 않는다
  // (그냥 mask on head 는 수면 안대만 지운다)
  let lifted: { all: boolean; sleep: boolean } | undefined
  const maskLifted = (kind: MaskKind): boolean => {
    if (lifted === undefined) {
      lifted = { all: false, sleep: false }
      const texts = [...SCOPES.flatMap((s) => [...textsOf(groups, s)]), outfit ?? '']
      for (const t of texts) {
        if (!t || !HIDDEN_HINT.test(t)) continue
        for (const f of liveFragments(t)) {
          if (f.end || !f.raw) continue
          const l = liftsMask(f.text)
          if (l === 'all') lifted.all = true
          else if (l === 'sleep') lifted.sleep = true
        }
      }
    }
    return lifted.all || (kind === 'sleep' && lifted.sleep)
  }
  const found: { scope: EyeScope; hit: Hit; outfit?: boolean }[] = []
  for (const scope of SCOPES) {
    // 범위마다 까닭별로 처음 만난 근거 하나씩 — 눈 감음이 잠듦 뒤에 적혀 있어도 눈 감음을 놓치지 않는다
    const seen = new Set<EyeCause>()
    for (const text of textsOf(groups, scope)) {
      for (const hit of hitsIn(text, sex, giver)) {
        if (seen.has(hit.cause) || (hit.mask && maskLifted(hit.mask))) continue
        seen.add(hit.cause)
        found.push({ scope, hit })
      }
      if (seen.size === CAUSE_ORDER.length) break
    }
  }
  // 복장 — 눈 가림 물건만. 이 캐릭터만의 글과 같은 범위
  if (outfit) {
    for (const hit of hitsIn(outfit, sex, giver)) {
      if (hit.cause !== 'covered' || (hit.mask && maskLifted(hit.mask))) continue
      found.push({ scope: 'char', hit, outfit: true })
      break
    }
  }
  if (!found.length) return null
  // 보여 주는 근거는 눈 감음 > 잠듦 > 눈 가림 순 (눈 감음이 늘 쓰던 이름이다), 같은 까닭이면 넓은 범위부터
  const first = [...found].sort(
    (a, b) => CAUSE_ORDER.indexOf(a.hit.cause) - CAUSE_ORDER.indexOf(b.hit.cause)
  )[0]
  const narrowest = found.reduce(
    (best, f) => (SCOPE_RANK[f.scope] > SCOPE_RANK[best] ? f.scope : best),
    first.scope
  )
  return {
    cause: first.hit.cause,
    text: first.hit.text,
    scope: first.scope,
    narrowest,
    ...(first.outfit ? { outfit: true } : {})
  }
}

// ── 눈 뜬 표현 ───────────────────────────────────────────

/** 눈이 열렸다는 낱말 */
const OPENED = /^(?:open|opened|opening)$/

/** 토막 하나가 눈을 떴다고 말하는가 — open eyes · eyes wide open · her eyes are open · opens her eyes (소문자·norm 한 글) */
function sayEyesOpen(text: string, sex: NudeStripSex | null): boolean {
  const words = wordsOf(text)
  for (let i = 0; i < words.length; i++) {
    if (words[i] !== 'eyes') continue
    let hit = false
    const prev = words[i - 1] ?? ''
    if ((OPENED.test(prev) || prev === 'wide') && !QUALIFIER.test(words[i - 2] ?? '')) hit = true
    if (!hit) {
      let j = i + 1
      while (
        j < words.length &&
        j <= i + MAX_FILLERS &&
        (FILLER.test(words[j]) || words[j] === 'wide')
      )
        j++
      if (j < words.length && /^(?:open|opened)$/.test(words[j])) hit = true
    }
    if (!hit) {
      let k = i - 1
      while (k >= 0 && DETERMINER.test(words[k])) k--
      if (k < i - 1 && k >= 0 && /^(?:open|opens|opened|opening)$/.test(words[k])) hit = true
    }
    if (!hit) continue
    if (words.slice(Math.max(0, i - 4), i).some((w) => NEGATION.test(w))) continue
    if (!ownedBy(eyeOwner(words, i), sex)) continue
    return true
  }
  return false
}

/** 눈 뜸이 분명한 외형 갈래 — 동공·기호 눈·눈 상태·시선 (눈 색·흰자·눈빛 효과는 눈 뜸이 분명하지 않다) */
const OPEN_KINDS: ReadonlySet<EyeLookKind> = new Set(['pupil', 'symbol', 'state', 'gaze'])

/** 글 목록에서 눈 뜬 표현 하나를 찾는다 (원문 표기, 없으면 null) — 실제로 보내는 글만 읽는다 */
function openEyesIn(texts: readonly string[], sex: NudeStripSex | null): string | null {
  for (const text of texts) {
    if (!text || !LOOK_HINT.test(text)) continue
    for (const frag of liveFragments(text)) {
      if (frag.end || !frag.raw || /[가-힣]/.test(frag.text)) continue
      const kind = eyeLookKind(frag.text)
      if ((kind && OPEN_KINDS.has(kind)) || sayEyesOpen(frag.text, sex)) return clip(frag.raw)
    }
  }
  return null
}

/** 이 캐릭터의 글에서 가장 좁은 범위의 눈 뜬 표현 — seat = 그 표현이 자리 태그에서 왔다 */
export function openEyesExpression(
  contexts: EyeContexts | readonly string[],
  sex: NudeStripSex | null
): { text: string; scope: EyeScope; seat?: boolean } | null {
  const groups = groupsOf(contexts)
  let best: { text: string; scope: EyeScope; seat?: boolean } | null = null
  for (const scope of SCOPES) {
    if (scope === 'char') {
      const own = openEyesIn(groups.char ?? [], sex)
      const seated = openEyesIn(groups.seat ?? [], sex)
      if (seated) best = { text: seated, scope, seat: true }
      else if (own) best = { text: own, scope }
      continue
    }
    const text = openEyesIn(textsOf(groups, scope), sex)
    if (text) best = { text, scope }
  }
  return best
}

// ── 눈 외형 태그 ─────────────────────────────────────────

/** 빼는 눈 외형의 갈래 — 메모의 이유에 쓴다 */
export type EyeLookKind =
  'color' | 'pupil' | 'sclera' | 'glow' | 'iris' | 'symbol' | 'state' | 'gaze'

export const EYE_LOOK_LABEL: Record<EyeLookKind, string> = {
  color: '눈 색',
  pupil: '동공',
  sclera: '흰자',
  glow: '눈빛 효과',
  iris: '눈동자 무늬',
  symbol: '기호 눈',
  state: '눈 상태',
  gaze: '시선'
}

const COLORS =
  'aqua|black|blue|brown|green|grey|gray|orange|pink|purple|red|white|yellow|silver|gold|golden|amber|teal|cyan|violet|lavender|turquoise|hazel|magenta|crimson|scarlet|indigo|lime|beige|maroon|navy|ruby|emerald|sapphire|amethyst|topaz|jade|bronze|copper|lilac|peach|coral|azure|cerulean|burgundy'
const SHADES =
  'light|dark|pale|deep|bright|pastel|neon|vivid|vibrant|soft|dull|faded|rich|icy|sky|baby|hot|blood|dusty|muted|metallic'
const ONE_COLOR = `(?:(?:${SHADES}) )?(?:${COLORS})`
/** <색> eyes — blue eyes · light blue eyes · blue-green eyes · red and blue eyes */
const COLOR_EYES = new RegExp(`^${ONE_COLOR}(?:(?:-| and )${ONE_COLOR})* eyes$`)
/** 색이 여러 개이거나 눈 색 자체를 말하는 태그 */
const COLOR_OTHER =
  /^(?:(?:multicolou?red|gradient|two-tone|two tone|rainbow) eyes|(?:(?:no|complete|sectoral|central|partial) )?heterochromia|(?:official )?alternate eye colou?r|eye colou?r)$/
/** 동공 — slit pupils · heart-shaped pupils · symbol-shaped pupils · no pupils · bright pupils */
const PUPILS = /(?:^|[ -])pupils?$/
/** 흰자 — black sclera · colored sclera · no sclera */
const SCLERA = /(?:^| )scleras?$/
/** 눈빛 효과 — glowing eyes · glowing red eyes · glowing eye · sparkling eyes · shiny eyes · bloodshot eyes · flaming eyes */
const GLOW = /^(?:glowing|sparkling|shiny|bloodshot|flaming)(?: [a-z-]+)? eyes?$/
/** 눈동자 무늬 — 홍채에 그려 넣는 무늬와 눈 능력 */
const IRIS = new Set([
  'ringed eyes',
  'symbol in eye',
  'symbol in eyes',
  'star in eye',
  'star in eyes',
  'heart in eye',
  'heart in eyes',
  'flower in eye',
  'flower in eyes',
  'text in eyes',
  'clock eyes',
  'sharingan',
  'mangekyou sharingan',
  'byakugan',
  'rinnegan'
])
/**
 * 기호 눈 — 눈 자리에 만화 기호가 그려진 눈 (하이픈은 공백으로 본다 · norm 은 _ 를 공백으로 바꾼다: @_@ → @ @).
 * <|>_<|> (고양이 눈)·|_| 는 < > | 가 와일드카드 문자라 읽을 수 없어 넣지 않는다
 */
const SYMBOL = new Set([
  'heart shaped eyes',
  'spiral only eyes',
  'solid circle eyes',
  'solid oval eyes',
  'solid eyes',
  'wide oval eyes',
  'pac man eyes',
  'wavy eyes',
  'dashed eyes',
  'spiral eyes',
  'star shaped eyes',
  // 단보루에 없는 표기지만 하트·소용돌이 눈을 이렇게 적는 사람이 있다 (swirl eyes 는 실제로 쓰인다)
  'swirl eyes',
  'swirling eyes',
  'heart eyes',
  'star eyes',
  '@ @',
  '+ +',
  'x x',
  'o o',
  '0 0',
  '. .'
])
/** 눈 상태 — 눈을 떠야 성립하는 눈의 모양·표정 (눈매 윤곽 tsurime · tareme 은 감은 눈에도 그려져 여기에 없다) */
const STATE = new Set([
  'half closed eyes',
  'half closed eye',
  'narrowed eyes',
  'jitome',
  'sanpaku',
  'empty eyes',
  'hollow eyes',
  'blank eyes',
  'crazy eyes',
  'creepy eyes',
  'evil eyes',
  'pleading eyes',
  'wide eyed',
  'rolling eyes',
  'cross eyed',
  'wall eyed',
  'lazy eye',
  'cross eye',
  'unusually open eyes',
  'uneven eyes',
  'bulging eyes',
  'eye pop',
  'squinting',
  'lowered eyelids',
  'crying with eyes open',
  'open eyes',
  'opening eyes',
  'eyes open',
  'wide open eyes',
  'eyes wide open',
  '= =',
  '3 3'
])
/** 눈이 위로 돌아간 모양 — eyes rolled back · eyes rolling back · eyes half rolled back · rolled back eyes (rolling eyes 와 같은 뜻) */
const ROLLED =
  /^(?:eyes (?:half )?(?:rolled|rolling) (?:back|up)(?: [a-z ]+)?|(?:half )?(?:rolled|rolling) (?:back|up) eyes)$/
/** 시선 — 눈을 떠야 성립한다. 얼굴 방향(facing viewer)과 고개를 돌린 자세(looking back)는 눈과 상관없어 남긴다 */
const GAZE = new Set([
  'eye contact',
  'sideways glance',
  'glance',
  'staring',
  'glaring',
  'averting eyes',
  'blank stare',
  'downturned eyes',
  'upturned eyes'
])
/** looking … 태그가 아니라 문장이 되는 연결어 */
const LOOKING_SENTENCE = /\b(?:with|while|and|but|because|as|that|who|which|so|then|if|when)\b/

function isGaze(tag: string, flat: string): boolean {
  if (GAZE.has(flat)) return true
  if (!/^looking(?: |$)/.test(tag) || tag === 'looking back') return false
  return tag.split(' ').length <= 5 && !LOOKING_SENTENCE.test(tag)
}

/** 태그 하나(norm 한 글)가 눈을 떠야만 보이는 눈 외형인가 — 아니면 null */
export function eyeLookKind(tag: string): EyeLookKind | null {
  const words = tag.split(' ').length
  if (words > 6) return null
  if (COLOR_EYES.test(tag) || COLOR_OTHER.test(tag)) return 'color'
  if (PUPILS.test(tag)) return 'pupil'
  if (SCLERA.test(tag)) return 'sclera'
  if (GLOW.test(tag)) return 'glow'
  const flat = tag.replace(/-/g, ' ')
  if (IRIS.has(tag) || IRIS.has(flat)) return 'iris'
  if (SYMBOL.has(flat)) return 'symbol'
  if (STATE.has(flat) || ROLLED.test(flat)) return 'state'
  if (isGaze(tag, flat)) return 'gaze'
  return null
}

/** 글 조각(줄·랜덤 선택지 토큰) 안에 눈 외형 태그가 하나라도 있는가 — 가중치 표기·괄호·구분자를 걷고 태그마다 본다 */
function hasEyeLook(text: string): boolean {
  return text
    .split(/[,/<>{}|()[\]]+/)
    .some((part) => eyeLookKind(norm(part.replace(/^\s*-?\d*\.?\d+::|::\s*$/g, ''))) !== null)
}

/** 카드 글에 눈 외형 태그가 있을 법한가 — 값싼 검사 */
const LOOK_HINT =
  /eye|pupil|sclera|heterochromia|sharingan|byakugan|rinnegan|jitome|sanpaku|squint|eyelid|looking|stare|staring|glanc|glaring|[@+0ox.=3][ _][@+0ox.=3]/i

/** 눈이 안 보임 메모의 이유 — 「눈 감음 — 눈 색 뺌」 · 「잠듦 — 기호 눈 뺌」 · 「눈 가림 — 시선 뺌」 */
export const eyeReason = (kind: EyeLookKind, cause: EyeCause = 'closed'): string =>
  `${EYE_CAUSE_LABEL[cause]} — ${EYE_LOOK_LABEL[kind]} 뺌`

/** 더 좁은 글의 눈 뜬 표현을 말할 때 부르는 범위 이름 */
const SCOPE_NAME: Record<EyeScope, string> = {
  scene: '씬 글',
  role: '하는쪽·당하는쪽 칸',
  char: '이 캐릭터의 글'
}

export interface EyeStrip {
  /** 눈 외형 태그를 뺀 카드 글 (뺀 게 없으면 원문 그대로) */
  text: string
  /** 뺀 태그마다 한 줄 — 비어 있으면 아무것도 안 뺐다 */
  notes: BodyNote[]
}

/**
 * 눈이 안 보이면 카드 글에서 눈 외형 태그를 뺀다.
 * enabled = 설정 「눈이 안 보이면 눈 태그 빼기」 — false 면 아무것도 읽지 않고 카드 글을 그대로, 메모 없이 돌려준다.
 * contexts = 이 캐릭터에게 걸린 장면 태그 (범위별 — sceneContextGroupsFor. 글 목록만 주면 씬 전체 글로 본다. 얼굴 인셋 자리도 몸 자리와 같다).
 * outfit = 이 캐릭터가 지금 입은 복장 글 (옷 벗기기가 끝난 뒤 실제로 보내는 글) — 눈 가림 물건만 근거가 된다.
 * faceSeat = 얼굴만 나오는 자리(인셋) — 「안 바꿈」 이유에서 눈 뜬 표현이 자리 태그에서 왔을 때 「인셋 자리」라고 말하는 데만 쓴다.
 * who = 메모에 실을 캐릭터 (characterPrompts 안의 순서·이름·카드 id).
 */
export function stripEyesWhenClosed(input: {
  enabled: boolean
  card: string
  contexts: EyeContexts | readonly string[]
  outfit?: string
  sex: NudeStripSex | null
  /** 이 캐릭터가 하는쪽인가 — sleep molestation 처럼 받는 쪽의 태그를 하는쪽에게 읽지 않는 데 쓴다 */
  giver?: boolean
  faceSeat?: boolean
  who: { index: number; name: string; id?: number }
}): EyeStrip {
  const { card, who } = input
  const none: EyeStrip = { text: card, notes: [] }
  if (!input.enabled || !card || !LOOK_HINT.test(card)) return none
  const groups = groupsOf(input.contexts)
  const evidence = hiddenEyesEvidence(groups, input.sex, input.outfit, !!input.giver)
  if (!evidence) return none
  const { cause } = evidence
  const head = EYE_CAUSE_LABEL[cause]
  // 더 좁은 글의 말이 이긴다 — 근거보다 좁은 범위에 눈 뜬 표현이 있으면 빼지 않는다. 같은 범위면 근거를 따르되 둘 다 보인다
  const open = openEyesExpression(groups, input.sex)
  const openRank = open ? SCOPE_RANK[open.scope] : -1
  const evidenceRank = SCOPE_RANK[evidence.narrowest]
  const yields = !!open && openRank > evidenceRank
  const together = !!open && openRank === evidenceRank
  const keepReason = open
    ? `${head} — ${open.seat ? (input.faceSeat ? '인셋 자리' : '자리 태그') : SCOPE_NAME[open.scope]}에 눈 뜬 표현(${open.text})이 있어 그대로 둠`
    : ''
  const alongside =
    together && open ? ` · 같은 범위에 눈 뜬 표현(${open.text})도 있으나 근거를 따름` : ''
  const r = mapTags(
    card,
    (tag) => {
      const kind = eyeLookKind(tag)
      if (!kind) return null
      return yields
        ? { keep: keepReason }
        : { after: '', reason: `${eyeReason(kind, cause)}${alongside}` }
    },
    // 짝이 안 맞는 :: 줄·랜덤 선택지 안의 눈 외형은 뺄 수 없다 — 말없이 두지 않고 안 바꿈으로 알린다
    // (눈 뜬 표현 때문에 아무것도 안 빼는 경우엔 따로 알릴 것이 없다)
    yields
      ? { broken: () => false, wildcard: () => false }
      : { broken: hasEyeLook, wildcard: hasEyeLook }
  )
  if (!r.edits.length && !r.kept.length) return none
  const base = {
    where: 'char' as const,
    topic: 'eyes' as const,
    ...(cause !== 'closed' ? { cause } : {}),
    charIndex: who.index,
    name: who.name,
    ...(who.id != null ? { charId: who.id } : {}),
    evidence: evidence.outfit ? `복장 ${evidence.text}` : evidence.text
  }
  return {
    text: r.edits.length ? r.text : card,
    notes: [
      ...r.edits.map((e) => ({
        ...base,
        kind: 'removed' as const,
        before: e.before,
        reason: e.reason
      })),
      ...r.kept.map((k) => ({
        ...base,
        kind: 'kept' as const,
        before: k.before,
        reason: yields ? k.reason : `${head} — 눈 외형이 있으나 ${k.reason}`
      }))
    ]
  }
}
