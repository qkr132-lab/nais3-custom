import { removeComments, splitTextTail } from './nai-presets'
import { splitPromptTokens } from './outfit'
import { isOffWeight, neededAreas, norm, WEAK_ACTS, type ExposeActs } from './auto-expose'
import type { NudeStripSex } from './nude-strip'
import type { ExposeArea } from './types'

/**
 * 입은 옷 자동 젖힘 — 글에서 증거 뽑기 (커스텀).
 *
 * 씬 글(태그·영어 문장)을 쉼표 토막으로 나눠, 토막마다 「누구 몸의 어느 부위가 어떻게 되는가」를 뽑는다.
 *   증거 = { 주인(남/여/모름), 부위(아래/가슴), 종류, 근거 글 }
 * 외부 호출 없이 낱말 사전과 정규식만 쓰는 결정적 계산이다. 두 갈래로 읽는다.
 *   1) 문장 해석: 소유 표현(her/his/another's)·행위 낱말·부정·옷 위·화면 밖·벗은 상태
 *   2) 태그 표: 문장에서 아무것도 못 뽑은 짧은 태그는 복장 탭의 장면 행위 목록(acts)으로 — 주인은 행위의 몸 기준
 * 이 증거를 캐릭터·부위별로 합치는 일은 expose-state.ts 가 한다.
 */

export type Sex = NudeStripSex

/**
 * 증거의 종류
 * - need: 강한 신호 — 삽입·핥기·벌림·음경 언급. 옷 위 표지가 있어도 드러내야 한다
 * - weak: 약한 신호 — 만지기·닿기·몸 이름만(pussy·nipples). 옷 위 표지·사후 어구가 있으면 무시
 * - open: 이미 벗었거나 젖혀졌다는 서술 (naked · panties aside · skirt lifted)
 * - over: 옷 위 접촉 (stain · through clothes · covered nipples · outer side of …)
 * - off: 그 부위가 화면 밖 (out of frame · cut off)
 * - neg: 부정 (not shown · no sex · hidden)
 * - amb: 누구 몸인지·무슨 뜻인지 모호 (몰래 만지기 · 주인 모름)
 */
export type EvidenceKind = 'need' | 'weak' | 'open' | 'over' | 'off' | 'neg' | 'amb'

export interface Evidence {
  /** 누구 몸인가 — null = 모름 */
  owner: Sex | null
  area: ExposeArea
  kind: EvidenceKind
  /** 근거가 된 글 조각 (80자까지, 원문 표기) */
  src: string
  /** 어느 규칙이 뽑았는지 — 시험·점검용 */
  rule: string
  /** 문장 해석에서 나왔는지, 태그 표(장면 행위 목록)에서 나왔는지 */
  via: 'sentence' | 'tag'
  /** open 만 — 주인을 지칭어로 정한 게 아니라 칸의 행위자로 짐작했다 (하는쪽 칸의 「open clothes」는 누구 옷인지 모른다) */
  guess?: boolean
}

/** 한 칸(글 하나)을 읽은 결과 */
export interface TextAnalysis {
  evidence: Evidence[]
  /** 사후 어구(after sex …)가 있음 — 약한 신호를 무효로 한다 */
  after: boolean
  /** 구도 태그(upper body · portrait)로 화면 밖이 되는 부위 */
  framing: ExposeArea[]
}

/** 글이 적힌 칸의 성격 */
export interface TextScope {
  /** 이 글이 말하는 이(행위자)의 성별 — 하는쪽 칸=male, 당하는쪽 칸=female, 씬 전체=null */
  actor: Sex | null
  /** 씬 전체 글에서 읽은 몸 단서(bodyClue) — 항문 핥기 같은 태그가 누구 몸인지 가르는 데 쓴다. 없으면 이 글만 본다 */
  clue?: Sex | null
}

type Code = 'F' | 'M'
const toCode = (s: Sex | null | undefined): Code | null =>
  s === 'male' ? 'M' : s === 'female' ? 'F' : null
const toSex = (c: Code | null | undefined): Sex | null =>
  c === 'M' ? 'male' : c === 'F' ? 'female' : null

// ── 토막 나누기 ──────────────────────────────────────────

interface Frag {
  /** 원문 표기 (앞뒤 공백만 뺌) */
  raw: string
  /** 소문자·역할 접두 제거 */
  text: string
  /** 문장 끝 표시 — 다음 토막은 주어를 이어받지 않는다 */
  end?: boolean
}

/**
 * 실제로 보내는 글만 토막으로 — 주석(#)은 지우고, 랜덤 선택지 `(a/b)`·와일드카드 토큰·빼달라는 음수 가중치·Text: 블록·따옴표 대사는 신호로 치지 않는다
 * (장면 판정과 같은 기준). 문장은 마침표에서 끝난다.
 */
export function liveFragments(text: string): Frag[] {
  // 그릴 글자(Text: 블록)와 따옴표 안 대사는 장면 묘사가 아니라 읽지 않는다
  const live = splitTextTail(removeComments(text ?? ''))
    .body.replace(/"[^"]*"|“[^”]*”/g, ' ')
    .replace(/\([^()]+\/[^()]+\)/g, ' ')
  const out: Frag[] = []
  for (const token of splitPromptTokens(live)) {
    const t = token.trim()
    if (isOffWeight(t) || /[/<>{}|]/.test(t)) continue
    const group = /^(-?\d*\.?\d+)::([\s\S]*?)::$/.exec(t)
    const inner = group ? group[2] : t
    const sentences = inner.split(/(?<=[a-z)])\.\s+/i)
    sentences.forEach((sentence, k) => {
      for (const piece of sentence.split(',')) {
        const raw = piece.trim()
        if (raw) out.push({ raw, text: norm(raw) })
      }
      if (k < sentences.length - 1 || /\.\s*$/.test(sentence))
        out.push({ raw: '', text: '', end: true })
    })
  }
  return out
}

/** 낱말 목록 — 소문자, 영숫자·아포스트로피·하이픈만 */
const wordsOf = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^a-z0-9'\- ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

const clip = (s: string): string => (s.length > 80 ? `${s.slice(0, 79)}…` : s)

// ── 낱말 사전 ───────────────────────────────────────────

/** [낱말, 부위, 기본 주인(해부학), 세기] */
const PARTS: [RegExp, ExposeArea, Code, 'strong' | 'weak' | 'clothed'][] = [
  [
    /^(pussy|vagina|vulva|labia|clit|clitoris|cunt|crotch|groin|genitals?|pubic|womanhood)$/,
    'lower',
    'F',
    'strong'
  ],
  [
    /^(penis|cock|dick|shaft|glans|erection|testicles|balls|scrotum|foreskin|boner)$/,
    'lower',
    'M',
    'strong'
  ],
  [/^(anus|asshole|butthole|anal|rectum)$/, 'lower', 'F', 'strong'],
  [/^(ass|butt|buttocks|buttock)$/, 'lower', 'F', 'weak'],
  [/^(breasts?|nipples?|areolae?|areolas?|boobs?|tits?|bust)$/, 'chest', 'F', 'strong'],
  [/^chest$/, 'chest', 'F', 'weak'],
  [/^cleavage$/, 'chest', 'F', 'clothed']
]
const partOf = (w: string): (typeof PARTS)[number] | undefined => PARTS.find((p) => p[0].test(w))

/** 몸 낱말처럼 생겼지만 몸이 아닌 쓰임 — treasure chest · balls of light · shaft of light */
function notBodyContext(words: string[], i: number): boolean {
  const w = words[i]
  const prev = words[i - 1] ?? ''
  const next = words[i + 1] ?? ''
  if (w === 'chest')
    return (
      /^(treasure|wooden|storage|toy|weapon|ammo|tool|metal|iron)$/.test(prev) ||
      /^(of|plate|armor|armour|drawers?)$/.test(next)
    )
  if (w === 'balls')
    return (
      next === 'of' ||
      /^(light|lights|fire|energy|magic|magical|glowing|snow|cotton|eye|eyes|fur|paint|yarn|crystal|water|ice|pearl)$/.test(
        prev
      )
    )
  if (w === 'shaft')
    return (
      next === 'of' ||
      /^(light|elevator|mine|arrow|spear|wooden|sunlight|moonlight|golden)$/.test(prev)
    )
  return false
}

/** 해부학으로 주인이 거의 정해진 부위 — another's breast 는 칸의 행위자가 여성이어도 남성 가슴이 아니다 */
const FIXED_ANATOMY =
  /^(?:pussy|vagina|vulva|labia|clit|clitoris|cunt|womanhood|penis|cock|dick|shaft|glans|testicles|balls|scrotum|foreskin|boner|erection|breasts?|nipples?|areolae?|areolas?|boobs?|tits?|bust)$/

const GARMENT_LOWER =
  /^(panties|panty|underwear|thong|skirt|miniskirt|pants|jeans|trousers|shorts|pantyhose|tights|bottoms|buruma|loincloth|briefs|boxers|leggings|g-string|bloomers|crotchless)$/
const GARMENT_CHEST =
  /^(bra|shirt|blouse|sweater|hoodie|jacket|blazer|coat|camisole|vest|tank|corset|bikini-top)$/
const GARMENT_BOTH =
  /^(dress|kimono|yukata|bodysuit|leotard|swimsuit|bikini|uniform|clothes|clothing|outfit|lingerie|robe|gown|armor|costume|fabric|cloth|towel|apron)$/

type GarmentArea = ExposeArea | 'both'
const garmentArea = (w: string, prev?: string): GarmentArea | null => {
  if (w === 'top')
    return /^(crop|tank|her|his|bikini|white|black|red|blue|pink|tube|halter)$/.test(prev ?? '')
      ? 'chest'
      : null
  return GARMENT_LOWER.test(w)
    ? 'lower'
    : GARMENT_CHEST.test(w)
      ? 'chest'
      : GARMENT_BOTH.test(w)
        ? 'both'
        : null
}

type Owner = Code | 'self' | 'other' | 'V' | null
const possOwner = (w: string): Owner => {
  if (w === 'her' || /^(woman|girl|female|lady)'s$/.test(w)) return 'F'
  if (w === 'his' || /^(man|male|boy|guy)'s$/.test(w)) return 'M'
  if (/^(another|other|someone|partner)'s$/.test(w)) return 'other'
  if (w === "viewer's" || w === 'your') return 'V'
  return null
}

const V_PEN =
  /^(thrust\w*|penetrat\w*|insert\w*|slid\w*|slip\w*|slides?|buried|bury\w*|shov\w*|jam\w*|ram\w*|sink\w*|plung\w*|fuck\w*|bang\w*|pound\w*|impal\w*|enter\w*|inside|fingers?|fingered)$/
const V_ORAL = /^(lick\w*|suck\w*|kiss\w*|eat\w*|tongue|blow\w*|deepthroat\w*)$/
const V_TOUCH =
  /^(rub\w*|strok\w*|grab\w*|grip\w*|squeez\w*|grop\w*|fondl\w*|caress\w*|massag\w*|pinch\w*|tweak\w*|cup\w*|clamp\w*|play\w*|tease\w*|tug\w*|pull\w*|flick\w*|slap\w*|spank\w*|smack\w*|hold\w*|holding|pump\w*|jerk\w*|crush\w*|sandwich\w*|rest\w*|slap|grind\w*|rubbing)$/
const V_SHOW =
  /^(spread\w*|show\w*|expos\w*|reveal\w*|present\w*|flash\w*|display\w*|offer\w*|part\w*|open\w*)$/
// 사정 낱말 — splash·spray 처럼 액체 일반을 가리키는 말은 뺀다 (juice splash 는 사정이 아니다)
const V_EJAC = /^(cum\w*|ejaculat\w*|squirt\w*|spurt\w*|semen|precum)$/
const V_NEAR =
  /^(around|near|toward|towards|against|poised|aimed|pointing|lined|touching|touches|between|beside|onto|on|at)$/
/** 닿는 쪽의 낱말 — 이게 없으면 on·at·between 은 접촉이 아니라 위치 설명이다 (necklace between her breasts) */
const TOUCHER =
  /^(hands?|fingers?|palms?|mouth|lips|tongue|penis|cock|dick|tip|head|shaft|glans|thumbs?|knees?|foot|feet|toes?|dildo|vibrator|toys?|hitachi)$/
/** 몸이 아닌 물건 — 이게 가슴 곁에 있고 손·입 같은 닿는 쪽이 없으면 물건 이야기다 (holds a pillow against her breasts) */
const OBJECT_NEAR =
  /^(pillow|towel|blanket|bag|book|books|phone|cup|mug|tray|plate|doll|plushie|bouquet|flowers?|basket|clipboard|shield|bottle|folder|necklace|pendant|pearls?|jewelry|brooch|badge|apple|fruit|cake)$/
/** 낱말 자체가 접촉을 뜻하는 것 */
const INHERENT_CONTACT = /^(poised|aimed|pointing|lined|touching|touches)$/

const NEG =
  /^(not|no|never|without|nothing|neither|isn't|aren't|doesn't|don't|n't|cannot|hardly|barely)$/
/**
 * 부정어가 들어 있지만 노출을 부정하지 않는 관용구 — never stops · doesn't hide · without hesitation/a condom
 * (이런 말 때문에 「she never stops rubbing her pussy」가 부정문으로 읽히면 안 된다)
 */
const NEUTRAL_NEG =
  /\bnever (?:stops?|stopped|ends?|lets? go)\b|\b(?:do|does|did|will|would|can|could)(?: not|n't) (?:stop|hesitate|hide|cover|let go|pause)\b|\bwithout (?:hesitation|hesitating|stopping|pause|pausing|a condom|condoms?|protection|warning|mercy|restraint|a word|any hesitation)\b|\bnot (?:even )?(?:once|hesitat\w*)\b/g

/** 낱말 목록에서 NEUTRAL_NEG 에 걸리는 자리 — 부정어로 세지 않는다 */
function neutralMask(words: string[]): boolean[] {
  const mask = words.map(() => false)
  const joined = words.join(' ')
  for (const m of joined.matchAll(NEUTRAL_NEG)) {
    const start = (joined.slice(0, m.index).match(/ /g) ?? []).length
    const len = m[0].split(' ').length
    for (let k = start; k < start + len && k < mask.length; k++) mask[k] = true
  }
  return mask
}

const HIDDEN =
  /^(hidden|hides|hiding|concealed|obscured|blocked|censored|covered|covering|covers|masked)$/

/** 절을 가르는 말 — 화면 밖 표현이 이 너머 부위에는 걸리지 않는다 */
const CLAUSE_BREAK = /^(?:as|while|and|when|then|but|because|so)$/
const THROUGH = /^(through|over|beneath|under|underneath|inside|within|against)$/
const OFFFRAME =
  /(out of (the )?frame|cut off|not visible|off[- ]screen|cropped|outside (the )?frame|out of view)/

/** 옷 상태가 바뀌는 동사 — up/down 은 옷 낱말 바로 옆일 때만 센다 (dressed up 같은 말을 거른다) */
const CHANGE_VERB =
  /^(aside|lift\w*|hik\w*|yank\w*|rip\w*|tear\w*|torn|unbutton\w*|unzip\w*|open\w*|remov\w*|strip\w*|undress\w*|rais\w*|lower\w*|push\w*|mov\w*|flip\w*|pull\w*|off|tak\w*|peel\w*|undo\w*|drop\w*)$/
const UP_DOWN = /^(up|down)$/
const UPV = /^(lift\w*|hik\w*|rais\w*|flip\w*|up|aside|push\w*|mov\w*)$/
const DOWNV =
  /^(down|open\w*|unzip\w*|unbutton\w*|undo\w*|unti\w*|lower\w*|drop\w*|slip\w*|slid\w*|rip\w*|tear\w*|torn|yank\w*)$/
const OFFV = /^(off|remov\w*|strip\w*|undress\w*|tak\w*|peel\w*)$/

/** 어느 옷인지 모르는 통칭 — open clothes 는 아래도 가슴도 될 수 있다 */
const GENERIC_CLOTHES = /^(clothes|clothing|outfit|uniform|costume|cloth|fabric)$/

/** 몰래·들킬까 같은 단서 — 그 칸의 만지기를 모호로 돌린다 */
const SECRET_CUE =
  /secretly|discreetly|afraid someone|might discover|in public|unnoticed|keeps? it quiet/i
/** 사후 어구 — 평상 복귀 장면 (after sex · after vaginal · after fellatio · aftersex · afterglow …) */
const AFTER_RE =
  /\bafter[ -]?(?:having )?(?:sex|vaginal|anal|oral|intercourse|fellatio|cunnilingus|paizuri|handjob|footjob|masturbation|ejaculation|orgasm|climax)\b|\bafterglow\b|\bpost-?coital\b/
/** 구도 태그 — 그 부위가 화면에 안 나온다 */
const FRAMING: Record<string, ExposeArea[]> = {
  'upper body': ['lower'],
  portrait: ['lower', 'chest']
}

// ── 옷 위 표지 ──────────────────────────────────────────

const CHEST_WORDS =
  /\b(?:breasts?|nipples?|chest|areolae?|areolas?|pectorals?|bust|cleavage|bra|bikini top)\b/
const LOWER_WORDS =
  /\b(?:pussy|crotch|groin|panties|panty|penis|cock|anus|ass|butt|thighs?|vagina|genitals?|cameltoe|bulge|pubic|skirt|shorts|pants|underwear|thong|erection)\b/
const OVER_MARK = new RegExp(
  [
    '(?:^|\\s)(?:stain|stains|stained)$',
    '^covered\\s',
    '\\b(?:through|under|beneath|underneath|against) (?:her |his |the |a |own )?(?:tight |thin |wet |sheer |thick )?(?:clothes|clothing|panties|underwear|dress|skirt|shirt|bra|swimsuit|bikini|leotard|pants|shorts|fabric|cloth)\\b',
    '\\bover (?:her |his |the )?(?:panties|clothes|clothing|underwear|dress|skirt|shirt|bra|swimsuit|bikini|leotard|pants|shorts)\\b',
    '\\bpasties\\b',
    '\\bmaebari\\b',
    '\\btaut (?:clothes|clothing|shirt|dress|bra|swimsuit)\\b',
    '\\bwet (?:clothes|clothing|panties|shirt|dress|skirt|swimsuit)\\b',
    '\\bsee-through\\b',
    '\\bcameltoe\\b',
    '\\b(?:erection|tent) under\\b',
    '\\bouter side of\\b',
    '\\berect nipples\\b',
    '\\bhand under (?:clothes|clothing|skirt|shirt|dress)\\b'
  ].join('|')
)
const BULGE = /\b(?:bulge|bulging)\b/
const CLOTHES_WORD =
  /\b(?:panties|panty|underwear|pants|shorts|skirt|trousers|jeans|swimsuit|bikini|leotard|briefs|boxers|clothes|clothing|fabric|cloth|thong|dress|towel)\b/
/** covered eyes · covered navel 처럼 가슴·사타구니와 상관없는 가림은 옷 위 표지가 아니다 */
const COVERED_UNRELATED =
  /^covered (?:navel|eyes|mouth|face|collarbone|abs|ears?|nose|forehead|hair|body|arms?|hands?|legs?|feet|shoulders?|stomach|belly|neck)\b/

/** 옷 위 표지가 가리키는 부위 — 표지가 아니면 [] */
export function overAreasOf(tag: string): ExposeArea[] {
  if (COVERED_UNRELATED.test(tag)) return []
  // bulge 는 옷 낱말이 같은 토막에 있을 때만 (bulge in her neck 은 아니다)
  if (!OVER_MARK.test(tag) && !(BULGE.test(tag) && CLOTHES_WORD.test(tag))) return []
  const areas: ExposeArea[] = []
  if (CHEST_WORDS.test(tag)) areas.push('chest')
  if (LOWER_WORDS.test(tag)) areas.push('lower')
  if (areas.length) return areas
  // 부위 낱말이 없는 표지 — stain 은 아래, see-through/wet/through clothes 는 둘 다
  return /(?:^|\s)(?:stain|stains|stained)$|^covered\s/.test(tag) ? ['lower'] : ['lower', 'chest']
}

const ownerOfOver = (tag: string, scope: TextScope): Sex => {
  if (/\b(?:penis|cock|erection|bulge|testicles)\b/.test(tag)) return 'male'
  if (CHEST_WORDS.test(tag) || /\b(?:pussy|vagina|cameltoe|clit\w*)\b/.test(tag)) return 'female'
  return scope.actor ?? 'female'
}

// ── 태그 표 (문장에서 못 뽑은 짧은 태그) ──────────────────────

/** 행위 뜻이 아닌 합성 — 음식 내밀기·몸짓·장난감 가게 */
const NOT_ACT =
  /\b((?:blowjob|handjob|fellatio|sex|kiss|licking) gestures?|mimic\w*|pretend\w*|presenting (?:(?:a|an|the|some|his|her|their|my|your) )?(?:\w+ )?(?:food|gifts?|flowers?|present|item|bouquet|sword|card|plate|dish|tray|cake)|sex toy|sex shop|sex education|sex doll|sex slaves?|sex appeal|sex symbol|sex change|sexy)\b/

/** 하는쪽 자기 몸 이야기 — 행위자 자신의 몸 */
const SELF_ACT =
  /\b(?:masturbation|presenting|dildo riding|sitting on face|facesitting|clitoral stimulation|anus|spread anus)\b/
/** 여성 몸만 열리는 행위 */
const F_ONLY =
  /\b(?:cunnilingus|fingering|fisting|object insertion|cum in pussy|cum in ass|cum on pussy|internal cumshot|female ejaculation|tribadism|tentacle|pussy|spread)\b/
/** 삽입 — 여성과 남성 둘 다 열린다 */
const BOTH =
  /\b(?:sex|vaginal|anal|doggystyle|missionary|cowgirl|mating press|full nelson|piledriver|spooning|amazon position|prone bone|suspended congress|penetration|rape|imminent)\b/
/** 남성 아래가 열려야 하는 행위 (복장 탭 행위 목록에는 없는 앱 내장 신호) */
const MALE_STRONG =
  /\b(?:fellatio|blowjob|handjob|footjob|paizuri|naizuri|deepthroat|irrumatio|thigh sex|penis on ass|large penis|buttjob|intercrural|licking penis|kissing penis|sixty-nine|penis in mouth|hand on penis|nursing handjob)\b/
/** 음경 낱말만 — 너무 흔해 약한 신호 */
const MALE_WEAK = /\b(?:penis|cock|dick|testicles)\b/
/** 가슴도 같이 열리는 행위 */
const CHEST_ALSO = /\b(?:paizuri|naizuri|nursing handjob)\b/

const MALE_CLUE =
  /male'?s? (?:lower body|ass|crotch)|nude male|male focus|\bpenis\b|\bcock\b|\bhis (?:ass|anus|butt)\b/
const FEMALE_CLUE = /\bher (?:ass|anus|butt)\b|female'?s? (?:ass|butt)/

/** 글에서 몸 단서가 남성인지 여성인지 (둘 다 없으면 null) — 항문 핥기처럼 태그만으로는 주인을 모를 때 */
export function bodyClue(text: string): Sex | null {
  const t = (text ?? '').toLowerCase().replace(/_/g, ' ')
  return MALE_CLUE.test(t) ? 'male' : FEMALE_CLUE.test(t) ? 'female' : null
}

/**
 * 태그 하나(짧은 토막)를 복장 탭의 장면 행위 목록으로 읽는다. 누구 몸인지는 행위의 몸으로 정한다:
 * 삽입=남·여 아래 · 핥기·핑거링=여 아래 · 펠라·핸드잡=남 아래 · 파이즈리=여 가슴+남 아래 · 자위·presenting=행위자 자신.
 */
function tagEvidence(
  text: string,
  raw: string,
  scope: TextScope,
  acts: ExposeActs,
  clue: Sex | null
): Evidence[] {
  const t = text
  if (NOT_ACT.test(t)) return []
  const src = clip(raw)
  const out: Evidence[] = []
  const push = (owner: Sex | null, area: ExposeArea, kind: EvidenceKind, rule: string): void => {
    out.push({ owner, area, kind, src, rule, via: 'tag' })
  }

  // 1) 옷 위 표지 자체 — 이 토막은 신호가 아니라 그 부위가 옷 위라는 표시
  const over = overAreasOf(t)
  if (over.length) {
    for (const a of over) push(ownerOfOver(t, scope), a, 'over', 'tag-over')
    return out
  }

  const hasNeg = /\b(?:no|not|without|never)\b/.test(t.replace(NEUTRAL_NEG, ' '))
  const matched = neededAreas([t], acts)
  const male = MALE_STRONG.test(t) || MALE_WEAK.test(t)
  if (!matched.lower && !matched.chest && !male) return out

  const weakLower = !matched.lower || isWeakTag(t, 'lower', acts)
  const weakChest = !matched.chest || isWeakTag(t, 'chest', acts)

  const emit = (owner: Sex | null, area: ExposeArea, weak: boolean, rule: string): void => {
    push(owner, area, hasNeg ? 'neg' : weak ? 'weak' : 'need', hasNeg ? `neg:${rule}` : rule)
  }

  if (matched.lower || male) {
    if (/\banilingus\b/.test(t)) {
      // 항문 핥기 — 받는 쪽 몸. 같은 칸에 남성/여성 단서가 있으면 그쪽, 없으면 모름
      if (clue)
        emit(clue, 'lower', false, `tag:anilingus(${clue === 'male' ? '남성' : '여성'} 단서)`)
      else push(null, 'lower', 'amb', 'tag:anilingus(주인 모름)')
    } else if (matched.lower) {
      if (MALE_STRONG.test(t) && !F_ONLY.test(t)) {
        // thigh sex · fellatio 처럼 남성 쪽 행위 낱말이 든 태그는 sex 가 들어 있어도 남 아래만
        emit('male', 'lower', false, 'tag:male-lower')
      } else if (SELF_ACT.test(t)) {
        // 자위·presenting·얼굴에 앉기 — 행위자 자신 (칸의 행위자, 모르면 여성)
        const owner = /\bfemale\b|clitoral/.test(t) ? 'female' : (scope.actor ?? 'female')
        emit(owner, 'lower', weakLower, 'tag:self')
      } else if (F_ONLY.test(t)) {
        emit('female', 'lower', weakLower, 'tag:female-lower')
        if (MALE_STRONG.test(t)) emit('male', 'lower', false, 'tag:male-lower')
      } else if (BOTH.test(t)) {
        emit('female', 'lower', weakLower, 'tag:penetration')
        emit('male', 'lower', weakLower, 'tag:penetration')
      } else {
        // 목록에 직접 더한 태그 — 장면 태그는 당하는쪽 몸 이야기로 읽는다
        emit('female', 'lower', weakLower, 'tag:listed')
      }
    } else if (MALE_STRONG.test(t)) {
      emit('male', 'lower', false, 'tag:male-lower')
    } else {
      emit('male', 'lower', true, 'tag:penis')
    }
  }
  if (matched.chest) {
    if (/\b(?:male|his) (?:nipples?|chest|breasts?)\b/.test(t))
      emit('male', 'chest', weakChest, 'tag:male-chest')
    else emit('female', 'chest', weakChest, 'tag:chest')
  }
  // 파이즈리 같은 행위는 남성 아래도 같이 열린다 (목록에 없어도)
  if (CHEST_ALSO.test(t) && !out.some((e) => e.owner === 'male' && e.area === 'lower'))
    emit('male', 'lower', false, 'tag:male-lower')
  return out
}

/** 이 태그가 약한 신호뿐인지 — 약한 행위(pussy · nipples · groping …)를 뺀 목록으로는 안 걸리면 약하다 */
function isWeakTag(tag: string, area: ExposeArea, acts: ExposeActs): boolean {
  const strict = {
    lower: acts.lower.filter((a) => !WEAK_ACTS.has(norm(a))),
    chest: acts.chest.filter((a) => !WEAK_ACTS.has(norm(a)))
  }
  return !neededAreas([tag], strict)[area]
}

// ── 문장 해석 ───────────────────────────────────────────

interface Carry {
  subj?: Code | 'both'
  cue: boolean
}

interface Analyzed {
  ev: Evidence[]
  subj: Code | 'both' | null
  /** 몸 부위 이름만 걸린 약한 언급 — 신호로 치지 않지만 표 읽기로 넘길지 가르는 데 쓴다 */
  onlyMention: boolean
}

function ownerNear(words: string[], idx: number): Code | null {
  for (let k = idx; k >= Math.max(0, idx - 4); k--) {
    const w = words[k]
    if (/^(she|her|woman|girl|female|lady|herself)$/.test(w)) return 'F'
    if (/^(he|his|him|man|male|boy|guy|himself)$/.test(w)) return 'M'
  }
  // 뒤에 오는 성별 낱말 — nude male · topless female
  for (let k = idx + 1; k <= Math.min(words.length - 1, idx + 3); k++) {
    const w = words[k]
    if (/^(her|she|female|woman|girl|lady)$/.test(w)) return 'F'
    if (/^(his|him|he|male|man|boy|guy)$/.test(w)) return 'M'
  }
  return null
}

/** 옷 낱말만으로 거의 정해지는 성별 — 치마·팬티·브라는 여성 쪽, 앞섶·훈도시는 남성 쪽 (바지·셔츠는 모른다) */
const garmentSexClue = (w: string): Code | null =>
  /^(skirt|miniskirt|panties|panty|bra|dress|thong|g-string|pantyhose|stockings?|bikini|camisole|leotard|lingerie|gown|bloomers|bikini-top)$/.test(
    w
  )
    ? 'F'
    : /^(fly|boxers|briefs|fundoshi)$/.test(w)
      ? 'M'
      : null

/** 토막 안에서 가장 먼저 나오는 소유·지칭 */
function firstRef(words: string[]): Code | null {
  for (const w of words) {
    const po = possOwner(w)
    if (po === 'F' || po === 'M') return po
    if (po === 'other') return null
    if (/^(she|woman|girl|female|lady)$/.test(w)) return 'F'
    if (/^(he|man|male|boy|guy)$/.test(w)) return 'M'
  }
  return null
}

/**
 * 토막 하나를 문장으로 읽는다.
 * scope.actor = 이 칸이 말하는 이, carry.subj = 앞 토막에서 이어받은 주어(문장 끝에서 끊김).
 */
function analyzeFragment(frag: Frag, scope: TextScope, carry: Carry): Analyzed {
  const ev: Evidence[] = []
  const src = clip(frag.raw)
  const words = wordsOf(frag.text)
  if (!words.length) return { ev, subj: carry.subj ?? null, onlyMention: false }
  const lower = words.join(' ')
  const n = words.length
  const scopeActor = toCode(scope.actor)
  const push = (
    owner: Code | null,
    area: ExposeArea,
    kind: EvidenceKind | 'mention',
    rule: string,
    guess = false
  ): void => {
    // mention 은 신호가 아니라 표 읽기로 넘길지 가르는 표시 — 아래에서 걸러낸다
    ev.push({
      owner: toSex(owner),
      area,
      kind: kind as EvidenceKind,
      src,
      rule,
      via: 'sentence',
      ...(guess ? { guess: true } : {})
    })
  }

  // 주어: 토막 맨 앞 지칭 — 없으면 앞 토막에서 이어받는다
  let subj: Code | 'both' | null = null
  for (let i = 0; i < Math.min(n, 4); i++) {
    const w = words[i]
    if (/^(she|woman|girl|female|lady)$/.test(w)) {
      subj = 'F'
      break
    }
    if (/^(he|man|male|boy|guy)$/.test(w)) {
      subj = 'M'
      break
    }
    if (/^(they|both)$/.test(w)) {
      subj = 'both'
      break
    }
  }
  const actorAny = subj ?? scopeActor ?? carry.subj ?? null
  const actor: Code | null = actorAny === 'both' ? null : actorAny

  // 화면 밖: 「… out of frame」 구절의 위치(oi~oe)와 같은 절 — 그 절 밖의 부위는 영향을 받지 않는다
  // (his face is out of frame as he thrusts into her pussy 에서 pussy 는 화면 안이다)
  const offM = OFFFRAME.exec(lower)
  let oi = -1
  let oe = -1
  let clauseStart = 0
  if (offM) {
    oi = (lower.slice(0, offM.index).match(/ /g) ?? []).length
    oe = oi + offM[0].split(' ').length - 1
    for (let k = oi - 1; k >= 0; k--)
      if (CLAUSE_BREAK.test(words[k])) {
        clauseStart = k + 1
        break
      }
    // 부위 낱말은 구절 앞(lower body out of frame) 또는 바로 뒤(cut off at the waist)에 온다
    let segEnd = Math.min(n, oe + 5)
    for (let k = oe + 1; k < segEnd; k++)
      if (CLAUSE_BREAK.test(words[k])) {
        segEnd = k
        break
      }
    const segWords = words.slice(clauseStart, segEnd)
    const m = /\b(?:(?:lower|upper) body|legs?|torso|waist|chest|breasts?|crotch|hips?)\b/.exec(
      segWords.join(' ')
    )
    if (m) {
      const area: ExposeArea = /lower body|legs?|crotch|hips?|waist/.test(m[0]) ? 'lower' : 'chest'
      push(firstRef(segWords) ?? actor, area, 'off', 'offframe')
    }
  }
  /** 이 부위(낱말 번호)가 화면 밖 구절과 같은 절에 있는가 */
  const offPart = (pi: number): boolean => {
    if (!offM) return false
    if (pi < oi) return !words.slice(pi + 1, oi).some((w) => CLAUSE_BREAK.test(w))
    if (pi > oe) return pi - oe <= 3 && !words.slice(oe + 1, pi).some((w) => CLAUSE_BREAK.test(w))
    return false
  }

  // 몸 부위
  interface PartHit {
    i: number
    area: ExposeArea
    def: Code
    power: 'strong' | 'weak' | 'clothed'
    owner: Owner
    fixed: boolean
  }
  const parts: PartHit[] = []
  for (let i = 0; i < n; i++) {
    const p = partOf(words[i])
    if (!p || notBodyContext(words, i)) continue
    // 주인: 앞 4낱말 안의 소유 표현 — 전치사·접속사를 만나면 거기서 멈춘다
    let owner: Owner = null
    for (let k = i - 1; k >= Math.max(0, i - 4); k--) {
      const w = words[k]
      if (
        /^(on|in|into|onto|between|from|with|to|at|against|around|over|under|through|by|and|while|as|toward|towards|across|inside|near|beside|behind|next|after|before)$/.test(
          w
        )
      )
        break
      const po = possOwner(w)
      if (po) {
        owner = po
        break
      }
      if (w === 'own') {
        owner = 'self'
        break
      }
      if (/^(male|female)$/.test(w) && k === i - 1) {
        owner = w === 'male' ? 'M' : 'F'
        break
      }
    }
    parts.push({
      i,
      area: p[1],
      def: p[2],
      power: p[3],
      owner,
      fixed: FIXED_ANATOMY.test(words[i])
    })
  }

  // 옷 낱말
  const garments: { i: number; w: string; area: GarmentArea; owner: Owner }[] = []
  for (let i = 0; i < n; i++) {
    const area = garmentArea(words[i], words[i - 1])
    if (!area) continue
    let owner: Owner = null
    for (let k = i - 1; k >= Math.max(0, i - 3); k--) {
      const po = possOwner(words[k])
      if (po) {
        owner = po
        break
      }
    }
    garments.push({ i, w: words[i], area, owner })
  }

  // 부정·가림·옷 위 — never stops · without hesitation 같은 관용구의 부정어는 세지 않는다
  const neutral = neutralMask(words)
  const negIdx = words.findIndex((w, i) => NEG.test(w) && !neutral[i])
  const hasNeg = negIdx >= 0
  const hiddenIdx = words.findIndex((w) => HIDDEN.test(w))
  const through = words.findIndex(
    (w, i) => THROUGH.test(w) && garments.some((g) => g.i > i && g.i <= i + 3)
  )
  const stain =
    /\b(stain|stains|stained|soaked through|wet spot)\b/.test(lower) ||
    (/\b(bulge|tent|damp)\b/.test(lower) && garments.length > 0)

  // 행위 낱말 종류
  const has = (re: RegExp): boolean => words.some((w) => re.test(w))
  const toy = has(/^(dildo|vibrator|beads|plug|toy|toys|hitachi)$/)
  // penis in pussy — 음경 낱말과 in/into 가 같이 있으면 삽입
  const penIn = parts.some((p) => p.def === 'M') && words.some((w) => w === 'in' || w === 'into')
  const pen = has(V_PEN) || toy || penIn
  const oral = has(V_ORAL)
  const touch = has(V_TOUCH)
  const show = has(V_SHOW)
  const ejac = has(V_EJAC)

  const addState = (
    owner: Code | null,
    guess: boolean,
    area: GarmentArea,
    kind: 'open',
    rule: string
  ): void => {
    if (area === 'both') {
      push(owner, 'lower', kind, rule, guess)
      push(owner, 'chest', kind, rule, guess)
    } else push(owner, area, kind, rule, guess)
  }

  // 1) 벗은 상태 서술 — naked · topless · bottomless
  const nakedAt = words.findIndex((w) =>
    /^(naked|nude|undressed|stripped|unclothed|disrobed)$/.test(w)
  )
  if (nakedAt >= 0 && !parts.some((p) => p.i === nakedAt + 1)) {
    const named = ownerNear(words, nakedAt)
    // ass nude — 부위 낱말이 앞에 붙으면 그 부위만 벗은 것
    const partBefore = nakedAt > 0 ? partOf(words[nakedAt - 1]) : undefined
    if (!(hasNeg && negIdx < nakedAt))
      addState(named ?? actor, named == null, partBefore ? partBefore[1] : 'both', 'open', 'naked')
  }
  const toplessAt = words.findIndex((w) => /^(topless|shirtless)$/.test(w))
  if (toplessAt >= 0) {
    const named = ownerNear(words, toplessAt)
    addState(named ?? actor, named == null, 'chest', 'open', 'topless')
  }
  if (words.includes('bottomless')) {
    const named = ownerNear(words, words.indexOf('bottomless'))
    addState(named ?? actor, named == null, 'lower', 'open', 'bottomless')
  }

  // 옷 상태 바꿈: 옷 낱말 + (aside/lifted/pulled/open/removed …). 통짜 옷은 동작으로 부위를 가른다
  for (const g of garments) {
    const near = words.slice(Math.max(0, g.i - 4), g.i + 5)
    const adjacent = [words[g.i - 1], words[g.i + 1]]
    const changed =
      near.some((w) => CHANGE_VERB.test(w)) || adjacent.some((w) => w != null && UP_DOWN.test(w))
    const negGar = hasNeg && negIdx < g.i && negIdx >= g.i - 3
    if (!changed || negGar) continue
    let area: GarmentArea = g.area
    if (area === 'both') {
      if (GENERIC_CLOTHES.test(g.w)) {
        // clothes/clothing 은 어느 옷인지 모르니 aside(사타구니)만 아래, 나머지 상태 변화는 둘 다
        area = near.some((w) => w === 'aside') ? 'lower' : 'both'
      } else if (near.some((w) => OFFV.test(w))) area = 'both'
      else if (near.some((w) => UPV.test(w))) area = 'lower'
      else if (near.some((w) => DOWNV.test(w))) area = 'chest'
    }
    const named: Code | null =
      g.owner === 'F' || g.owner === 'M' ? g.owner : (ownerNear(words, g.i) ?? garmentSexClue(g.w))
    addState(named ?? actor, named == null, area, 'open', `garment-changed:${g.w}`)
  }

  // 2) 부위 + 행위 → 필요
  const resolveOwner = (p: PartHit): Code | null => {
    if (p.owner === 'other')
      return p.fixed ? p.def : actor === 'F' ? 'M' : actor === 'M' ? 'F' : p.def
    if (p.owner === 'self') return actor ?? p.def
    if (p.owner === 'V') return null
    return p.owner ?? p.def
  }
  /**
   * 이 부위에 무언가가 닿아 있는가 — 가까이 접촉어(on·at·against·between …)가 있고 닿는 쪽 낱말(손·입·음경 …)이 같이 있을 때만.
   * 닿는 쪽 낱말이 없으면 위치 설명이다 (a necklace between her breasts · a pillow against her breasts)
   */
  const contactNear = (p: { i: number; def: Code }): boolean => {
    const win = words.slice(Math.max(0, p.i - 6), p.i + 7)
    if (win.some((w) => INHERENT_CONTACT.test(w))) return true
    if (!win.some((w) => V_NEAR.test(w))) return false
    return p.def === 'M' || win.some((w, k) => TOUCHER.test(w) && Math.max(0, p.i - 6) + k !== p.i)
  }
  let onlyMention = parts.length > 0
  for (const p of parts) {
    if (p.owner === 'V') continue
    const owner = resolveOwner(p)
    if (p.power === 'clothed') continue // cleavage — 옷 입은 가슴골
    if (offPart(p.i)) {
      push(owner, p.area, 'off', 'part-offframe')
      continue
    }
    // 옷 위·가림·부정
    const thr = through >= 0 && Math.abs(through - p.i) <= 7
    if (thr || stain) {
      push(owner, p.area, 'over', thr ? 'through-clothes' : 'stain')
      onlyMention = false
      continue
    }
    const negNear = hasNeg && Math.abs(negIdx - p.i) <= 6
    const hidNear = hiddenIdx >= 0 && Math.abs(hiddenIdx - p.i) <= 5 && !ejac
    if (negNear || hidNear) {
      // 가린 이유가 옷이면 옷 위, 아니면 부정
      const byGarment = garments.some((g) => Math.abs(g.i - p.i) <= 5)
      push(owner, p.area, byGarment ? 'over' : 'neg', negNear ? 'neg' : 'hidden')
      onlyMention = false
      continue
    }
    if (p.power === 'weak') {
      // 엉덩이·가슴팍은 센 행위일 때만 (삽입·핥기·벌림)
      if (pen || oral || show || /\b(?:bare|exposed|spread|out)\b/.test(lower)) {
        push(owner, p.area, 'need', 'weak-part+strong-verb')
        onlyMention = false
      } else if (/on (his|the|another's) (face|mouth)/.test(lower)) {
        push(owner, p.area, 'need', 'facesit')
        onlyMention = false
      }
      continue
    }
    // 사정은 몸 위에 뿌리는 것 — 가슴/음부에 닿을 때만
    if (ejac && !(pen || oral || touch || show)) {
      push(owner, p.area, 'need', 'cum-on-part')
      onlyMention = false
      continue
    }
    // 물건이 곁에 있고 닿는 쪽(손·입 …)이 없다 — necklace between her breasts · holds a pillow against her breasts
    const near = words.slice(Math.max(0, p.i - 6), p.i + 7)
    if (
      !pen &&
      !oral &&
      !show &&
      near.some((w) => OBJECT_NEAR.test(w)) &&
      !near.some((w) => TOUCHER.test(w))
    ) {
      push(owner, p.area, 'mention', 'object-near')
    } else if (carry.cue && touch && !pen && !oral && !show) {
      push(owner, p.area, 'amb', 'secret-cue+touch')
      onlyMention = false
    } else if (pen || oral || show) {
      push(owner, p.area, 'need', 'verb+part')
      onlyMention = false
    } else if (touch) {
      push(owner, p.area, p.def === 'M' ? 'need' : 'weak', 'touch')
      onlyMention = false
    } else if (contactNear(p)) {
      push(owner, p.area, p.def === 'M' ? 'need' : 'weak', 'contact')
      onlyMention = false
    } else if (p.def === 'M' && p.area === 'lower') {
      push(owner, p.area, 'need', 'penis-mention')
      onlyMention = false
    } else {
      push(owner, p.area, 'mention', 'mention')
    }
  }

  // 3) 부위 이름 없이 행위만 있는 문장 (he fucks her · strokes him · masturbating)
  if (!parts.length && through < 0 && !stain) {
    if (
      /\b(strokes?|stroking|jerks?|jerking|pumps?|pumping|sucks?|sucking|blows?|rides?|riding|licks?|licking) him\b/.test(
        lower
      )
    )
      push('M', 'lower', 'need', 'verb-him')
    const mast = words.findIndex((w) => /masturbat/.test(w))
    if (mast >= 0) {
      const o =
        (subj === 'F' || subj === 'M' ? subj : null) ?? actor ?? ownerNear(words, mast) ?? 'F'
      push(o, 'lower', 'need', 'masturbat')
    }
    if (
      /\b(fucks?|fucking|fucked|penetrat\w*)\b/.test(lower) &&
      /\b(her|him|she|he)\b/.test(lower)
    ) {
      push('F', 'lower', 'need', 'sex-verb')
      push('M', 'lower', 'need', 'sex-verb')
    }
    // 신체 낱말 없이 삽입을 말하는 문장 — he thrusts into her · he pounds into her from behind · he cums inside her
    if (
      /\b(?:thrusts?|thrusting|pounds?|pounding|rams?|ramming|slams?|slamming)\b.*\b(?:into|inside) (?:her|him)\b/.test(
        lower
      )
    ) {
      push('F', 'lower', 'need', 'thrust-into')
      push('M', 'lower', 'need', 'thrust-into')
    }
    if (/\b(?:cums?|cumming|ejaculates?|ejaculating|spurts?)\b.*\b(?:inside|in) her\b/.test(lower))
      push('F', 'lower', 'need', 'cum-inside')
    if (/\bsits? on (his|her|the) face\b|\bsitting on (his|her) face\b/.test(lower))
      push('F', 'lower', 'need', 'facesit')
    if (/\bfingers? (?:inserted|inside|buried|pushed in)\b|\binserted fingers?\b/.test(lower))
      push('F', 'lower', 'need', 'fingers-inserted')
    // 지시어만 있는 접촉 문장 (the tip presses against her · he pushes her toward it) — 사람 지칭어와 접촉 동사가 같이 있는데
    // 무엇의 어느 부위인지 모르니 판단 못 함. 접촉 동사가 없는 묘사(staring at the tip)는 신호가 아니다
    // (the head of the cat · the base of the tree 처럼 of 가 붙는 것은 몸이 아니다. toward it 의 it 도 지시어가 아니라 목적지)
    const anatomical = /\b(?:the|its) (?:tip|head|shaft|base)\b(?! of)/.test(lower)
    const pressing = pen || has(/^(?:press\w*|push\w*|rub\w*|slid\w*|touch\w*|grind\w*)$/)
    const bareIt =
      /\b(?:it|its)\b/.test(lower) &&
      !/\b(?:toward|towards|to|for|from|about|of|at) it\b/.test(lower)
    if (
      n >= 4 &&
      /\b(?:her|him|his|she|he)\b/.test(lower) &&
      (anatomical ? pressing || touch : bareIt && pressing)
    )
      // tip·head·shaft 는 음경 쪽 낱말이라 남성 쪽 판단 못 함, it 만 있으면 누구 것인지도 모른다
      push(anatomical ? 'M' : null, 'lower', 'amb', 'referent')
  }
  const real = ev.filter((e) => (e.kind as string) !== 'mention')
  return {
    ev: real,
    subj: actorAny === 'both' ? 'both' : actor,
    onlyMention: onlyMention && !real.length
  }
}

/**
 * 글 하나를 읽는다 — 토막마다 문장 해석을 먼저 하고, 아무 증거도(또는 약한 언급뿐) 못 뽑은 짧은 태그는 장면 행위 목록(표)으로 읽는다.
 * 한글 토막은 읽지 않는다 (영어 문장·태그만).
 */
export function analyzeText(text: string, scope: TextScope, acts: ExposeActs): TextAnalysis {
  const evidence: Evidence[] = []
  const framing = new Set<ExposeArea>()
  let after = false
  const cue = SECRET_CUE.test(text ?? '')
  const clue = scope.clue !== undefined ? scope.clue : bodyClue(text ?? '')
  let carry: Carry = { cue }
  for (const f of liveFragments(text)) {
    if (f.end) {
      carry = { cue }
      continue
    }
    if (/[가-힣]/.test(f.text)) continue
    // 사후 어구(after sex)는 행위가 아니라 평상 복귀 표시 — 약한 신호를 무효로 한다
    if (AFTER_RE.test(f.text)) {
      after = true
      continue
    }
    const frame = FRAMING[f.text]
    if (frame) for (const a of frame) framing.add(a)
    const r = analyzeFragment(f, scope, carry)
    if (r.subj) carry = { subj: r.subj, cue }
    let list = r.ev
    if (!list.length || list.every((e) => e.kind === 'weak')) {
      const fb = tagEvidence(f.text, f.raw, scope, acts, clue)
      if (fb.length) list = fb
    }
    // 이 토막 자체가 옷 위 표지(outer side of her breast · stain · through clothes)면 부위마다 옷 위 증거를 더한다
    for (const area of overAreasOf(f.text)) {
      if (list.some((e) => e.kind === 'over' && e.area === area)) continue
      const same = list.find((e) => e.area === area)
      list = [
        ...list,
        {
          owner: same?.owner ?? ownerOfOver(f.text, scope),
          area,
          kind: 'over',
          src: clip(f.raw),
          rule: 'fragment-over',
          via: 'sentence'
        }
      ]
    }
    evidence.push(...list)
  }
  return { evidence, after, framing: [...framing] }
}
