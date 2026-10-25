import { norm } from './auto-expose'
import { liveFragments } from './expose-evidence'
import { mapTags } from './futa'
import type { NudeStripSex } from './nude-strip'
import type { BodyNote } from './types'

/**
 * 눈 감음이면 카드의 눈 외형 태그를 뺀다 (커스텀).
 *
 * 그 캐릭터에게 걸린 장면 태그(옷 벗기기와 같은 범위 — scene-request 의 sceneContextsFor)에
 * closed eyes / eyes closed (영어 문장 her eyes are closed · with eyes closed · closes her eyes 포함)가 있으면,
 * 카드(캐릭터 탭) 글에서 눈을 떠야 보이는 외형 태그를 걷어낸다. 눈 색·동공·흰자·빛나는 눈·눈동자 무늬가 그렇다.
 * 감은 눈에 눈 색이 남으면 NAI 가 눈을 뜬 그림으로 끌려간다.
 *
 * 남기는 것 — 눈 모양(tsurime · tareme · jitome), 속눈썹, 화장(eyeshadow · eyeliner · mascara),
 * 안경·안대·고글·가면, 눈 주변 흉터·문신. 눈이 보이는 표현(one eye closed · wink · half-closed eyes)은 감은 눈으로 치지 않는다.
 * 빼달라는 음수 가중치(-1::blue eyes::)·와일드카드·주석은 그대로 둔다 (nude-strip 의 filterTags 와 같은 규칙 — futa.ts 의 mapTags).
 * 뺀 것은 전부 BodyNote(kind removed, topic eyes)로 돌려줘 화면에 보인다 — 몰래 빼지 않는다. 설정은 따로 없다.
 * DB·IPC 없는 순수 계산이다 (렌더러·폰이 같은 코드를 쓴다).
 */

// ── 감은 눈 읽기 ─────────────────────────────────────────

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
/**
 * 닫힘 바로 뒤에서 감은 눈이 아니라는 말 — eyes closed halfway · eyes wide open · open eyes closed mouth ·
 * (쉼표 없이 이어 쓴 글 mouth closed eyes wide open). 눈이 보이거나 닫힌 것이 눈이 아니다
 */
const AFTER_BLOCK = /^(?:wide|open|opened|halfway|partway|partly|partially|slightly|mouth)$/
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
    const prev = words[i - 1] ?? ''
    if (CLOSED.test(prev) && !QUALIFIER.test(words[i - 2] ?? '')) end = i
    if (end < 0) {
      let j = i + 1
      while (j < words.length && j <= i + MAX_FILLERS && FILLER.test(words[j])) j++
      if (j < words.length && CLOSED.test(words[j])) end = j
    }
    if (end < 0) {
      let k = i - 1
      while (k >= 0 && DETERMINER.test(words[k])) k--
      if (k < i - 1 && k >= 0 && CLOSE_VERB.test(words[k]) && !QUALIFIER.test(words[k - 1] ?? ''))
        end = i
    }
    if (end < 0) continue
    if (AFTER_BLOCK.test(words[end + 1] ?? '')) continue
    const start = Math.max(0, i - 4)
    if (words.slice(start, end + 1).some((w) => NEGATION.test(w))) continue
    if (!ownedBy(eyeOwner(words, i), sex)) continue
    return true
  }
  return false
}

/** 근거로 보일 글 조각의 길이 (expose-evidence 와 같은 80자) */
const clip = (s: string): string => (s.length > 80 ? `${s.slice(0, 79)}…` : s)

/** 감은 눈을 말하는 글이 있을 법한가 — 글 전체를 읽기 전에 거르는 값싼 검사 */
const CLOSED_HINT = /clos|shut/i

/**
 * 이 캐릭터에게 걸린 장면 태그(contexts)에서 눈을 감았다는 근거를 찾는다 (원문 표기, 없으면 null).
 * 실제로 보내는 글과 같게 읽는다 — 주석·랜덤 선택지·와일드카드·빼달라는 음수·0 가중치·Text: 블록·따옴표 대사는 신호가 아니다.
 * sex = 문장의 her/his 를 이 캐릭터 몸과 맞춰 볼 때의 성별 (null = 맞춰 보지 않음 — 후타).
 */
export function closedEyesEvidence(
  contexts: readonly string[],
  sex: NudeStripSex | null
): string | null {
  for (const text of contexts) {
    if (!text || !CLOSED_HINT.test(text)) continue
    for (const frag of liveFragments(text)) {
      if (frag.end || !frag.raw || /[가-힣]/.test(frag.text)) continue
      if (sayEyesClosed(frag.text, sex)) return clip(frag.raw)
    }
  }
  return null
}

// ── 눈 외형 태그 ─────────────────────────────────────────

/** 빼는 눈 외형의 갈래 — 메모의 이유에 쓴다 */
export type EyeLookKind = 'color' | 'pupil' | 'sclera' | 'glow' | 'iris'

export const EYE_LOOK_LABEL: Record<EyeLookKind, string> = {
  color: '눈 색',
  pupil: '동공',
  sclera: '흰자',
  glow: '눈빛 효과',
  iris: '눈동자 무늬'
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
/** 눈빛 효과 — glowing eyes · glowing red eyes · glowing eye · sparkling eyes · shiny eyes · bloodshot eyes */
const GLOW = /^(?:glowing|sparkling|shiny|bloodshot)(?: [a-z-]+)? eyes?$/
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
  'sharingan',
  'mangekyou sharingan',
  'byakugan',
  'rinnegan'
])

/** 태그 하나(norm 한 글)가 눈을 떠야 보이는 눈 외형인가 — 아니면 null */
export function eyeLookKind(tag: string): EyeLookKind | null {
  const words = tag.split(' ').length
  if (words > 6) return null
  if (COLOR_EYES.test(tag) || COLOR_OTHER.test(tag)) return 'color'
  if (PUPILS.test(tag)) return 'pupil'
  if (SCLERA.test(tag)) return 'sclera'
  if (GLOW.test(tag)) return 'glow'
  if (IRIS.has(tag)) return 'iris'
  return null
}

/** 글 조각(줄·랜덤 선택지 토큰) 안에 눈 외형 태그가 하나라도 있는가 — 가중치 표기·괄호·구분자를 걷고 태그마다 본다 */
function hasEyeLook(text: string): boolean {
  return text
    .split(/[,/<>{}|()[\]]+/)
    .some((part) => eyeLookKind(norm(part.replace(/^\s*-?\d*\.?\d+::|::\s*$/g, ''))) !== null)
}

/** 카드 글에 눈 외형 태그가 있을 법한가 — 값싼 검사 */
const LOOK_HINT = /eye|pupil|sclera|heterochromia|sharingan|byakugan|rinnegan/i

/** 눈 감음 메모의 이유 — 「눈 감음 — 눈 색 뺌」 */
export const eyeReason = (kind: EyeLookKind): string => `눈 감음 — ${EYE_LOOK_LABEL[kind]} 뺌`

export interface EyeStrip {
  /** 눈 외형 태그를 뺀 카드 글 (뺀 게 없으면 원문 그대로) */
  text: string
  /** 뺀 태그마다 한 줄 — 비어 있으면 아무것도 안 뺐다 */
  notes: BodyNote[]
}

/**
 * 눈 감음이면 카드 글에서 눈 외형 태그를 뺀다.
 * contexts = 이 캐릭터에게 걸린 장면 태그 (sceneContextsFor · 얼굴 인셋 자리는 그 자리 태그만).
 * who = 메모에 실을 캐릭터 (characterPrompts 안의 순서·이름·카드 id).
 */
export function stripEyesWhenClosed(input: {
  card: string
  contexts: readonly string[]
  sex: NudeStripSex | null
  who: { index: number; name: string; id?: number }
}): EyeStrip {
  const { card, who } = input
  const none: EyeStrip = { text: card, notes: [] }
  if (!card || !LOOK_HINT.test(card)) return none
  const evidence = closedEyesEvidence(input.contexts, input.sex)
  if (!evidence) return none
  const r = mapTags(
    card,
    (tag) => {
      const kind = eyeLookKind(tag)
      return kind ? { after: '', reason: eyeReason(kind) } : null
    },
    // 짝이 안 맞는 :: 줄·랜덤 선택지 안의 눈 외형은 뺄 수 없다 — 말없이 두지 않고 안 바꿈으로 알린다
    { broken: hasEyeLook, wildcard: hasEyeLook }
  )
  if (!r.edits.length && !r.kept.length) return none
  const base = {
    where: 'char' as const,
    topic: 'eyes' as const,
    charIndex: who.index,
    name: who.name,
    ...(who.id != null ? { charId: who.id } : {}),
    evidence
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
        reason: `눈 감음 — 눈 외형이 있으나 ${k.reason}`
      }))
    ]
  }
}
