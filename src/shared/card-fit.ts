import { norm } from './auto-expose'
import { liveFragments } from './expose-evidence'
import { hiddenEyesEvidence } from './eyes'
import { mapTags } from './futa'
import { appendPromptPiece, removeComments, splitTextTail } from './nai-presets'
import type { NudeStripSex } from './nude-strip'
import { splitPromptTokens } from './outfit'
import type { BodyNote, CharRole } from './types'

/**
 * 카드 태그 씬 맞춤 (커스텀) — 씬이 요구하는 것과 부딪히는 캐릭터 카드(·입은 복장) 태그를 생성 직전에 빼거나 가중치를 푼다.
 *
 * NAI V4 는 캐릭터 칸에 적힌 태그를 씬 프롬프트의 음수 가중치로 지우지 못한다 — 카드에 `1.4::yellow eyes::, tsurime` 가 있으면
 * 씬의 closed eyes 가 안 먹는다. 그래서 그 캐릭터에게 걸린 장면 글을 읽고, 규칙표(%APPDATA%\NAIS3 Custom\card-fit-rules.json)에 적힌
 * 「근거 → 뺄 것」대로 이 요청에 실리는 카드 사본만 고친다. 카드 원문은 그대로다.
 *
 * - 규칙은 코드에 박지 않는다 — 파일(규칙표)에서 읽고, 파일이 없으면 DEFAULT_CARD_FIT_RULES 를 써 둔다.
 * - 고친 것은 전부 BodyNote(topic fit)로 돌려줘 화면에 보인다 — 몰래 빼지 않는다.
 * - 꺼져 있으면(설정·세트·씬) 카드 글을 읽지 않고 그대로 돌려준다 (이 기능이 없던 때와 글자 단위로 같다).
 * - 빼달라는 음수 가중치·와일드카드·주석·Text: 블록·따옴표 대사는 건드리지 않는다 (futa.ts 의 mapTags 와 같은 안전 규칙).
 * DB·IPC 없는 순수 계산이다 (렌더러·폰이 같은 코드를 쓴다).
 */

// ── 규칙표 파일 모양 ───────────────────────────────────────

/** 파일에 적는 규칙 하나 (키는 한국어 — 메모장으로 고치는 사람을 위해) */
export interface CardFitRuleRaw {
  이름: string
  /** 기본 true */
  켬?: boolean
  설명?: string
  /** 이 중 하나라도 장면 글에 있으면 규칙이 걸린다 — 태그 · `*` 무늬 · `~낱말`(문장 토막) · `@묶음` · `#내장 판정` */
  근거?: string[]
  /** 근거를 읽을 글 — 씬(기본·씬 프롬프트) · 역할(하는쪽/당하는쪽 칸) · 캐릭터(씬별 캐릭터·자리·상대 태그). 기본 셋 다 */
  '근거 범위'?: string[]
  /** 씬 전체 글의 근거는 그림에 한 명만 그려질 때만 믿는다 (head out of frame 처럼 누구 말인지 모르는 글) */
  '씬 글은 혼자일 때만'?: boolean
  /** 누구의 카드를 고치나 — 받는 캐릭터(기본) · 하는쪽 · 당하는쪽 · 모두 */
  대상?: string
  /** 근거와 같은 글에 이 중 하나라도 있으면 이 규칙을 쓰지 않는다 */
  예외?: string[]
  /** 카드·복장에서 뺄 태그 */
  빼기?: string[]
  /** 1보다 센 가중치 묶음에서 꺼내 가중치 없이 둘 태그 (1.4::yellow eyes:: → yellow eyes) */
  '가중치 풀기'?: string[]
  /** 남은 태그·문장에서 색 낱말을 뺀다 (white shirt → shirt · black hair → 뺌) */
  '색 낱말 빼기'?: boolean
  /** 이 캐릭터 글 끝에 더할 태그 */
  더하기?: string
  /** 이 캐릭터 네거티브 끝에 더할 태그 */
  '네거티브에 더하기'?: string
  /** 씬에 옷 벗기기를 따로 정하지 않았으면 옷 벗기기를 켠다 (알몸 판정은 기존 옷 벗기기가 한다) */
  '옷 벗기기'?: boolean
}

export interface CardFitRuleFile {
  설명?: string | string[]
  /** 묶음 이름 → 태그 목록 (규칙에서 @이름 으로 부른다 · 다른 묶음을 @로 불러도 된다) */
  묶음?: Record<string, string[]>
  규칙?: CardFitRuleRaw[]
}

// ── 읽은 규칙 ────────────────────────────────────────────

type Scope = 'scene' | 'role' | 'char'
type Who = 'receiver' | 'source' | 'target' | 'all'
/** 앱이 직접 판정하는 근거 */
type Builtin = 'eyes-hidden' | 'scene-suppressed'

const BUILTIN: Record<string, Builtin> = {
  '눈 안 보임': 'eyes-hidden',
  '씬이 누른 태그': 'scene-suppressed'
}
const SCOPE: Record<string, Scope> = { 씬: 'scene', 역할: 'role', 캐릭터: 'char' }
const WHO: Record<string, Who> = {
  '받는 캐릭터': 'receiver',
  하는쪽: 'source',
  당하는쪽: 'target',
  모두: 'all'
}

/** 태그 목록 하나를 읽은 것 */
interface Matcher {
  exact: Set<string>
  globs: RegExp[]
  /** ~낱말 — 문장 토막 안의 낱말 */
  words: Set<string>
  /** !로 뺀 것 (태그·무늬) */
  notExact: Set<string>
  notGlobs: RegExp[]
}

export interface CardFitRule {
  name: string
  on: boolean
  when: Matcher
  builtins: Builtin[]
  scopes: Scope[]
  soloScene: boolean
  who: Who
  unless: Matcher
  remove: Matcher
  unweight: Matcher
  dropColor: boolean
  add: string
  addNegative: string
  strip: boolean
}

export interface CardFitRules {
  rules: CardFitRule[]
  /** 읽다가 걸린 문제 (한국어 한 줄씩) — 문제가 있어도 읽을 수 있는 규칙은 쓴다 */
  warnings: string[]
}

const emptyMatcher = (): Matcher => ({
  exact: new Set(),
  globs: [],
  words: new Set(),
  notExact: new Set(),
  notGlobs: []
})

const globToRegExp = (glob: string): RegExp =>
  new RegExp(
    '^' +
      glob
        .split('*')
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$'
  )

/** 태그 목록을 읽는다 — @묶음은 펼치고(돌고 도는 참조는 한 번만), #내장 판정은 따로 모은다 */
function compileList(
  list: readonly string[] | undefined,
  groups: Record<string, string[]>,
  warn: (s: string) => void,
  where: string
): { matcher: Matcher; builtins: Builtin[] } {
  const m = emptyMatcher()
  const builtins: Builtin[] = []
  const seen = new Set<string>()
  const add = (entry: unknown): void => {
    if (typeof entry !== 'string') {
      warn(`${where}: 글자가 아닌 값은 건너뜀 (${JSON.stringify(entry)})`)
      return
    }
    const e = entry.trim()
    if (!e) return
    // @·#·~ 바로 뒤가 빈칸이면 기호 태그다 (@ @ 같은 단보루 태그)
    if (/^@\S/.test(e)) {
      const name = e.slice(1).trim()
      if (seen.has(name)) return
      seen.add(name)
      const g = groups[name]
      if (!Array.isArray(g)) {
        warn(`${where}: 묶음 「${name}」이 없음`)
        return
      }
      g.forEach(add)
      return
    }
    if (/^#\S/.test(e)) {
      const b = BUILTIN[e.slice(1).trim()]
      if (b) builtins.push(b)
      else
        warn(
          `${where}: 모르는 내장 판정 「${e}」 (쓸 수 있는 것: ${Object.keys(BUILTIN).join(' · ')})`
        )
      return
    }
    if (/^~\S/.test(e)) {
      const w = e.slice(1).trim().toLowerCase()
      if (w) m.words.add(w)
      return
    }
    const not = /^!\S/.test(e)
    const t = norm(not ? e.slice(1) : e)
    if (!t) return
    if (t.includes('*')) (not ? m.notGlobs : m.globs).push(globToRegExp(t))
    else (not ? m.notExact : m.exact).add(t)
  }
  for (const entry of list ?? []) add(entry)
  return { matcher: m, builtins }
}

const isEmpty = (m: Matcher): boolean => !m.exact.size && !m.globs.length && !m.words.size

/** 규칙표 파일 내용(JSON 을 읽은 값)을 규칙으로 — 깨진 규칙은 건너뛰고 경고를 남긴다 */
export function compileCardFitRules(file: unknown): CardFitRules {
  const warnings: string[] = []
  const warn = (s: string): number => warnings.push(s)
  if (!file || typeof file !== 'object' || Array.isArray(file)) {
    return { rules: [], warnings: ['규칙표가 { } 모양이 아님'] }
  }
  const f = file as CardFitRuleFile
  const groups: Record<string, string[]> = {}
  if (f.묶음 && typeof f.묶음 === 'object') {
    for (const [k, v] of Object.entries(f.묶음)) {
      if (Array.isArray(v)) groups[k] = v
      else warn(`묶음 「${k}」이 [ ] 목록이 아님`)
    }
  }
  const rules: CardFitRule[] = []
  const list = Array.isArray(f.규칙) ? f.규칙 : []
  if (!Array.isArray(f.규칙)) warn('「규칙」 목록이 없음')
  list.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') {
      warn(`규칙 ${i + 1}: { } 모양이 아님`)
      return
    }
    const name = typeof raw.이름 === 'string' && raw.이름.trim() ? raw.이름.trim() : `규칙 ${i + 1}`
    const where = `규칙 「${name}」`
    const when = compileList(raw.근거, groups, warn, `${where} 근거`)
    const unless = compileList(raw.예외, groups, warn, `${where} 예외`)
    const remove = compileList(raw.빼기, groups, warn, `${where} 빼기`)
    const unweight = compileList(raw['가중치 풀기'], groups, warn, `${where} 가중치 풀기`)
    const scopes = (raw['근거 범위'] ?? ['씬', '역할', '캐릭터'])
      .map((s) => {
        const v = SCOPE[String(s).trim()]
        if (!v) warn(`${where}: 모르는 근거 범위 「${s}」 (씬 · 역할 · 캐릭터)`)
        return v
      })
      .filter((v): v is Scope => !!v)
    const whoRaw = raw.대상 == null ? '받는 캐릭터' : String(raw.대상).trim()
    const who = WHO[whoRaw]
    if (!who)
      warn(
        `${where}: 모르는 대상 「${whoRaw}」 (받는 캐릭터 · 하는쪽 · 당하는쪽 · 모두) — 받는 캐릭터로 읽음`
      )
    const strip = raw['옷 벗기기'] === true
    const dropColor = raw['색 낱말 빼기'] === true
    const add = typeof raw.더하기 === 'string' ? raw.더하기.trim() : ''
    const addNegative =
      typeof raw['네거티브에 더하기'] === 'string' ? raw['네거티브에 더하기'].trim() : ''
    const doesSomething =
      strip ||
      dropColor ||
      !!add ||
      !!addNegative ||
      !isEmpty(remove.matcher) ||
      !isEmpty(unweight.matcher) ||
      remove.builtins.includes('scene-suppressed') ||
      when.builtins.includes('scene-suppressed')
    if (!doesSomething) warn(`${where}: 빼기·가중치 풀기·더하기가 비어 있어 하는 일이 없음`)
    if (!strip && isEmpty(when.matcher) && !when.builtins.length)
      warn(`${where}: 근거가 비어 있어 걸리지 않음`)
    rules.push({
      name,
      on: raw.켬 !== false,
      when: when.matcher,
      builtins: [...when.builtins, ...remove.builtins.filter((b) => b === 'scene-suppressed')],
      scopes: scopes.length ? scopes : ['scene', 'role', 'char'],
      soloScene: raw['씬 글은 혼자일 때만'] === true,
      who: who ?? 'receiver',
      unless: unless.matcher,
      remove: remove.matcher,
      unweight: unweight.matcher,
      dropColor,
      add,
      addNegative,
      strip
    })
  })
  return { rules, warnings }
}

/** 규칙표 글(JSON)을 읽는다 — JSON 이 깨졌으면 error 로 알리고 규칙은 비운다 (반쯤 읽은 규칙으로 고치지 않는다) */
export function parseCardFitRules(text: string): CardFitRules & { error?: string } {
  let data: unknown
  try {
    // 메모장이 붙이는 BOM(EF BB BF)은 떼고 읽는다
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch (e) {
    return { rules: [], warnings: [], error: `JSON 문법 오류 — ${(e as Error).message}` }
  }
  return compileCardFitRules(data)
}

/** 규칙 가운데 켜진 「옷 벗기기」가 있는가 — 옷 벗기기는 카드를 고치기 전에 정해야 해서 따로 묻는다 */
export function cardFitStripRule(rules: CardFitRules | null): CardFitRule | null {
  return rules?.rules.find((r) => r.on && r.strip) ?? null
}

// ── 맞추기 ────────────────────────────────────────────────

const wordsOf = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^a-z0-9'\- ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

/** 태그가 목록에 드는가 — ~낱말은 문장 토막(sentence)일 때만 */
function hit(m: Matcher, tag: string, sentence: boolean): boolean {
  if (m.notExact.has(tag) || m.notGlobs.some((g) => g.test(tag))) return false
  if (m.exact.has(tag) || m.globs.some((g) => g.test(tag))) return true
  if (sentence && m.words.size) return wordsOf(tag).some((w) => m.words.has(w))
  return false
}

/** 근거로 읽을 때 — 문장 토막이든 태그든 ~낱말을 본다 (근거 낱말은 뜻이 좁게 적는다) */
const evidenceHit = (m: Matcher, tag: string): boolean => hit(m, tag, true)

/**
 * 글에서 문장에 든 토막(쉼표로 나뉜 조각)을 모은다 — 대문자로 시작하는 두 낱말 이상 토막부터 마침표로 끝나는 토막까지.
 * 「A proud, fierce, …, sharp upturned golden eyes and a domineering, untamed presence.」 의 토막들이 여기 든다.
 * 가중치 묶음 안은 문장으로 보지 않는다.
 */
function sentencePieces(text: string): Set<string> {
  const set = new Set<string>()
  for (const line of removeComments(splitTextTail(text).body).split('\n')) {
    let inSentence = false
    for (const token of splitPromptTokens(line)) {
      const t = token.trim()
      if (!t || t.includes('::')) {
        inSentence = false
        continue
      }
      const starts = /^[A-Z][a-z']*\s+\S/.test(t)
      if (starts) inSentence = true
      if (inSentence || t.split(/\s+/).length >= 4) set.add(t)
      if (/\.\s*$/.test(t)) inSentence = false
      else if (/\.\s+[A-Z]/.test(t)) inSentence = true
    }
  }
  return set
}

const COLOR_WORDS =
  /^(?:red|blue|green|brown|purple|yellow|pink|black|grey|gray|aqua|orange|white|silver|golden|gold|amber|violet|magenta|crimson|cyan|teal|lavender|beige|blonde|platinum|bronze|navy|maroon|scarlet|ivory|ebony|auburn|chestnut|emerald|sapphire|ruby|azure|turquoise|copper|brunette|tanned|sun-tanned|tan|ginger)$/
const SHADE_WORDS = /^(?:light|dark|pale|deep|bright|dull|vivid|pastel|neon|hot)$/
/** 색을 빼고 나면 무엇인지 모르는 낱말 — 남기지 않는다 */
const GENERIC_LEFT = new Set([
  'hair',
  'eyes',
  'eye',
  'skin',
  'fur',
  'body',
  'lips',
  'nails',
  'sclera',
  'pupils',
  'skinned female',
  'skinned male'
])

/** 태그·문장 토막에서 색 낱말을 뺀다 — 바뀐 게 없으면 원문, 남은 게 무의미하면 '' */
function withoutColors(raw: string): string {
  const parts = raw.split(/(\s+|-)/)
  const out: string[] = []
  let changed = false
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    const w = p.toLowerCase()
    if (COLOR_WORDS.test(w)) {
      changed = true
      // 바로 앞의 명암 낱말(light blue)도 함께
      while (out.length && /^\s+$|^-$/.test(out[out.length - 1])) out.pop()
      if (out.length && SHADE_WORDS.test(out[out.length - 1].toLowerCase())) out.pop()
      // 뒤에 붙는 하이픈(blue-green)·공백은 다음 낱말 차례에 정리된다
      continue
    }
    if (/^-$/.test(p) && changed && (!out.length || /^\s+$/.test(out[out.length - 1]))) continue
    out.push(p)
  }
  if (!changed) return raw
  const left = out
    .join('')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s-]+|[\s-]+$/g, '')
    .replace(/\b(a|an|and|with|of)\s+(?=(?:and|with|of)\b)/gi, '')
  const flat = norm(left)
  if (!flat || GENERIC_LEFT.has(flat) || /^(?:and|with|of|a|an)$/.test(flat)) return ''
  return left
}

/** 이 캐릭터에게 걸린 장면 글 — 범위별 */
export interface CardFitTexts {
  /** 기본·씬 프롬프트 (후타 재조립을 거친 실제로 보내는 글) */
  scene: readonly string[]
  /** 하는쪽 칸 · 당하는쪽 칸 (역할 접두사가 붙은 그대로여도 된다) */
  source: string
  target: string
  /** 이 캐릭터만의 글 — 씬별 캐릭터 태그 · 자리 태그 · 상대 태그 */
  own: readonly string[]
}

export interface CardFitInput {
  /** 설정·세트·씬을 다 따진 켜짐 — false 면 아무것도 읽지 않는다 */
  enabled: boolean
  rules: CardFitRules | null
  card: string
  /** 입은 복장 글 (옷 벗기기가 끝난 뒤 실제로 보내는 글) — 같은 규칙으로 고친다 */
  outfit?: string
  texts: CardFitTexts
  role: CharRole | null | undefined
  /** 이 그림에 역할이 걸린 캐릭터가 있는지 */
  anyRole: boolean
  /** 그려지는 사람 수 (얼굴 인셋 자리는 같은 인물이라 세지 않는다) */
  drawn: number
  /** 얼굴만 나오는 자리(인셋) — 이 캐릭터만의 글만 근거로 읽는다 */
  faceSeat?: boolean
  /** 문장의 her/his 를 이 캐릭터 몸과 맞춰 볼 때의 성별 (눈 안 보임 판정 · null = 맞춰 보지 않음) */
  sex: NudeStripSex | null
  who: { index: number; name: string; id?: number }
}

export interface CardFitResult {
  card: string
  outfit: string
  /** 이 캐릭터 글 끝에 더할 것 (없으면 '') */
  add: string
  /** 이 캐릭터 네거티브 끝에 더할 것 (없으면 '') */
  addNegative: string
  notes: BodyNote[]
}

/** 근거 한 토막 — 화면에 보일 원문 */
interface Evidence {
  text: string
}

const clip = (s: string): string => (s.length > 80 ? `${s.slice(0, 79)}…` : s)

/** 음수 가중치로 누른 태그들 (-1.5::looking at viewer, smile::) — 씬이 「이건 빼라」고 말한 것 */
function suppressedTags(texts: readonly string[]): { tags: Set<string>; raw: string[] } {
  const tags = new Set<string>()
  const raw: string[] = []
  for (const text of texts) {
    for (const token of splitPromptTokens(removeComments(splitTextTail(text ?? '').body))) {
      const g = /^(-\d*\.?\d+)::([\s\S]*?)::$/.exec(token.trim())
      if (!g) continue
      for (const t of g[2].split(',')) {
        const n = norm(t)
        if (n) {
          tags.add(n)
          raw.push(`${g[1]}::${t.trim()}::`)
        }
      }
    }
  }
  return { tags, raw }
}

/**
 * 카드(와 입은 복장) 태그를 씬에 맞춘다. 규칙은 적힌 차례대로 — 앞 규칙이 뺀 태그는 뒤 규칙이 보지 않는다.
 */
export function fitCardToScene(input: CardFitInput): CardFitResult {
  const { card, who } = input
  const outfit = input.outfit ?? ''
  const none: CardFitResult = { card, outfit, add: '', addNegative: '', notes: [] }
  if (!input.enabled || !input.rules?.rules.length) return none
  const role = input.role ?? null
  let curCard = card
  let curOutfit = outfit
  const adds: string[] = []
  const negs: string[] = []
  const notes: BodyNote[] = []
  const base = {
    where: 'char' as const,
    topic: 'fit' as const,
    charIndex: who.index,
    name: who.name,
    ...(who.id != null ? { charId: who.id } : {})
  }

  for (const rule of input.rules.rules) {
    if (!rule.on) continue
    // 옷 벗기기 규칙은 조립 앞쪽(옷 벗기기)에서 따로 쓴다
    if (
      rule.strip &&
      isEmpty(rule.remove) &&
      isEmpty(rule.unweight) &&
      !rule.dropColor &&
      !rule.add &&
      !rule.addNegative
    )
      continue
    if (rule.who === 'source' && role !== 'source') continue
    if (rule.who === 'target' && role !== 'target') continue

    // 이 규칙이 읽는 글 (범위별)
    const scopes = input.faceSeat ? (['char'] as Scope[]) : rule.scopes
    const sceneOk =
      scopes.includes('scene') &&
      (rule.who !== 'receiver' || role === 'target' || !input.anyRole) &&
      !(rule.soloScene && input.drawn > 1)
    const sceneTexts = sceneOk ? input.texts.scene : []
    const roleTexts = scopes.includes('role')
      ? rule.who === 'source'
        ? [input.texts.source]
        : rule.who === 'target'
          ? [input.texts.target]
          : role === 'source'
            ? [input.texts.source]
            : role === 'target'
              ? [input.texts.target]
              : []
      : []
    const charTexts = scopes.includes('char') ? input.texts.own : []
    const texts = [...sceneTexts, ...roleTexts, ...charTexts].filter((t) => t && t.trim())

    // 근거 찾기
    let evidence: Evidence | null = null
    for (const t of texts) {
      if (evidence) break
      for (const f of liveFragments(t)) {
        if (f.end || !f.text) continue
        if (evidenceHit(rule.when, f.text)) {
          evidence = { text: f.raw }
          break
        }
      }
    }
    if (!evidence && rule.builtins.includes('eyes-hidden')) {
      const e = hiddenEyesEvidence(
        { scene: sceneTexts, role: roleTexts, char: charTexts },
        input.sex,
        curOutfit,
        role === 'source'
      )
      if (e) evidence = { text: e.outfit ? `복장 ${e.text}` : e.text }
    }
    let suppressed: Set<string> | null = null
    if (rule.builtins.includes('scene-suppressed')) {
      const s = suppressedTags(texts)
      if (s.tags.size) {
        suppressed = s.tags
        if (!evidence) evidence = { text: s.raw.slice(0, 3).join(', ') }
      }
    }
    if (!evidence) continue

    // 예외 — 같은 글에 있으면 이 규칙을 쓰지 않는다
    let exception: string | null = null
    if (!isEmpty(rule.unless)) {
      outer: for (const t of texts) {
        for (const f of liveFragments(t)) {
          if (f.end || !f.text) continue
          if (evidenceHit(rule.unless, f.text)) {
            exception = f.raw
            break outer
          }
        }
      }
    }

    const reason = `${rule.name} — 근거 ${clip(evidence.text)}`
    const fix = (
      text: string
    ): { text: string; edits: { before: string; after: string; lifted?: string }[] } => {
      if (!text.trim()) return { text, edits: [] }
      const pieces = sentencePieces(text)
      const r = mapTags(text, (tag, raw) => {
        const sentence = pieces.has(raw.trim())
        // 가중치 풀기가 먼저 — 풀 태그면 빼지 않는다 (묶음 밖이면 그대로 둔다)
        if (hit(rule.unweight, tag, false)) return { after: raw, reason, lift: true }
        if (hit(rule.remove, tag, false) || suppressed?.has(tag)) return { after: '', reason }
        if (sentence && hit(rule.remove, tag, true)) {
          // 문장 토막 — 마침표 뒤에 다른 문장이 이어지면 그 문장은 남긴다
          const parts = raw.split(/(?<=\.)\s+/)
          const kept = parts.filter((p) => !hit(rule.remove, norm(p), true))
          return { after: kept.length < parts.length ? kept.join(' ') : '', reason }
        }
        if (rule.dropColor) {
          const c = withoutColors(raw)
          if (c !== raw) return { after: c, reason }
        }
        return null
      })
      return {
        text: r.edits.length ? r.text : text,
        edits: r.edits.map((e) => ({
          before: e.before,
          after: e.after,
          ...(e.liftedFrom ? { lifted: e.liftedFrom } : {})
        }))
      }
    }

    const fc = fix(curCard)
    const fo = fix(curOutfit)
    const edits = [
      ...fc.edits.map((e) => ({ ...e, outfit: false })),
      ...fo.edits.map((e) => ({ ...e, outfit: true }))
    ]
    if (exception) {
      // 예외로 건너뛴 규칙 — 뺄 게 있었으면 「안 바꿈」으로 알린다
      if (edits.length)
        notes.push({
          ...base,
          kind: 'kept',
          evidence: clip(evidence.text),
          before: edits.map((e) => e.before).join(', '),
          reason: `${rule.name} — 예외(${clip(exception)})가 있어 그대로 둠`
        })
      continue
    }
    curCard = fc.text
    curOutfit = fo.text
    for (const e of edits) {
      const where = e.outfit ? '복장 · ' : ''
      notes.push({
        ...base,
        kind: e.after ? 'replaced' : 'removed',
        evidence: clip(evidence.text),
        before: e.lifted ? `${e.lifted}::${e.before}::` : e.before,
        ...(e.after ? { after: e.after } : {}),
        reason: `${where}${rule.name}${e.lifted ? ' (가중치 풀기)' : ''}`
      })
    }
    if (rule.add && !adds.includes(rule.add)) {
      adds.push(rule.add)
      notes.push({
        ...base,
        kind: 'added',
        evidence: clip(evidence.text),
        after: rule.add,
        reason: `${rule.name} — 더함`
      })
    }
    if (rule.addNegative && !negs.includes(rule.addNegative)) {
      negs.push(rule.addNegative)
      notes.push({
        ...base,
        kind: 'added',
        evidence: clip(evidence.text),
        after: rule.addNegative,
        reason: `${rule.name} — 네거티브에 더함`
      })
    }
  }

  if (!notes.length) return none
  return {
    card: curCard,
    outfit: curOutfit,
    add: adds.reduce(appendPromptPiece, ''),
    addNegative: negs.reduce(appendPromptPiece, ''),
    notes
  }
}

/** 토큰 목록 (주석·Text: 꼬리 뺌) — 옷 벗기기 앞뒤를 견주는 데 쓴다 */
const tokensOf = (text: string): string[] =>
  splitPromptTokens(removeComments(splitTextTail(text ?? '').body))
    .map((t) => t.trim())
    .filter(Boolean)

/**
 * 「알몸이면 옷 벗기기 따라 켜기」로 옷 벗기기가 돌았을 때의 메모 — 카드·복장에서 빠진 것과 붙은 것(nude 등)을 보인다.
 * 옷 벗기기 계산은 기존 것(nude-strip)이 하고, 여기서는 앞뒤 글을 견주기만 한다.
 */
export function cardFitStripNotes(input: {
  rule: CardFitRule
  /** 알몸 근거 태그 (undressForNude 가 찾은 것) */
  nude: string
  before: { card: string; outfit: string }
  after: { card: string; outfit: string }
  who: { index: number; name: string; id?: number }
}): BodyNote[] {
  const { rule, nude, before, after, who } = input
  const base = {
    where: 'char' as const,
    topic: 'fit' as const,
    charIndex: who.index,
    name: who.name,
    ...(who.id != null ? { charId: who.id } : {}),
    evidence: nude
  }
  const notes: BodyNote[] = []
  for (const [what, b, a] of [
    ['', before.card, after.card],
    ['복장 · ', before.outfit, after.outfit]
  ] as const) {
    if (b === a) continue
    const bt = tokensOf(b)
    const at = tokensOf(a)
    const gone = bt.filter((t) => !at.includes(t))
    const came = at.filter((t) => !bt.includes(t))
    if (gone.length)
      notes.push({
        ...base,
        kind: 'removed',
        before: clip(gone.join(', ')),
        reason: `${what}${rule.name} — 옷 벗기기`
      })
    if (came.length)
      notes.push({
        ...base,
        kind: 'added',
        after: clip(came.join(', ')),
        reason: `${what}${rule.name} — 옷 벗기기`
      })
  }
  return notes
}

/** 메모가 카드 맞춤 것인가 */
export const isFitNote = (n: BodyNote): boolean => n.topic === 'fit'
