import { removeComments } from './nai-presets'
import {
  activePieces,
  splitPromptTokens,
  tokenTags,
  type Outfit,
  type OutfitChoice,
  type SceneAreas
} from './outfit'
import {
  engineActs,
  engineTagsOf,
  garmentOpenerAreas,
  isOffWeight,
  layeredTags,
  liveTagsOf,
  norm,
  openByDesign,
  readGarments,
  type ExposeActs,
  type GarmentRule
} from './auto-expose'
import {
  analyzeText,
  bodyClue,
  overAreasOf,
  type Evidence,
  type Sex,
  type TextAnalysis
} from './expose-evidence'
import { bodyHolds, type CharBody } from './body'
import { isNudePiece } from './nude-strip'
import type { ExposeArea, ExposeNote, ExposeStatus } from './types'

/**
 * 입은 옷 자동 젖힘 — 캐릭터 한 명 x 부위 둘(아래, 가슴)마다 한 장의 상태표 (커스텀).
 *
 * 입력 세 가지를 합쳐 결정한다.
 *   A 입은 옷   카드 글 + 켜진 복장 조각에서 옷 낱말표(GARMENTS)로 읽은 옷
 *   B 행위 증거 씬 글·역할 태그·자리 태그·상대 태그의 태그와 문장 (누구 몸인지 주인을 붙여서)
 *   C 벗음 선언 nude · topless · bottomless · clothing aside · breasts out · open … (같은 캐릭터가 직접 적은 것)
 * 결과는 부위마다 하나: 붙임(added) · 이미 젖힘 · 조각이 맡음 · 알몸 · 옷 위 · 화면 밖 · 부정 · 사후 · 옷 못 읽음 ·
 * 판단 못 함 · 충돌 · 막힘. 붙은 태그와 안 붙은 이유는 모두 ExposeNote 로 요청에 동반돼 화면에 보인다 —
 * 문자열에 몰래 섞지 않는다 (예전에 이 기능이 빠진 이유).
 *
 * 두 단계다.
 *   1) analyzeExposure — 씬 글을 읽어 캐릭터별 「드러내야 하는 부위」를 정한다. nsfw 조각을 켤지도 여기서 정한다.
 *   2) finishExposure  — 옷 벗기기가 끝난 카드·복장 글을 받아, 입은 옷에 맞는 젖힘 태그를 붙이거나 이유를 남긴다.
 * DB·IPC 없는 순수 계산이다.
 */

const AREAS = ['lower', 'chest'] as const
const AREA_NAME: Record<ExposeArea, string> = { lower: '아래', chest: '가슴' }
/** 조사를 붙인 부위 이름 — 아래가·가슴이 / 아래를·가슴을 */
const AREA_SUBJECT: Record<ExposeArea, string> = { lower: '아래가', chest: '가슴이' }
const AREA_OBJECT: Record<ExposeArea, string> = { lower: '아래를', chest: '가슴을' }

/** 씬에서 자동 젖힘을 껐을 때 쓰는 이유 */
const SCENE_OFF_REASON = '이 씬은 자동 젖힘을 껐음'

// ── 1단계: 씬 글 읽기 ──────────────────────────────────────

/** 그림에 나오는 캐릭터 한 명(자리 하나) */
export interface ExposeChar {
  /** characterPrompts 안의 순서 */
  index: number
  id: number | null
  name: string
  /** 남녀 — characterSex(역할 기준, 역할 없으면 카드의 남자 태그) */
  sex: Sex
  /**
   * 몸 (음경·음부·가슴) — 후타처럼 역할 기준 남녀와 몸이 다른 캐릭터에게만 넘기면 된다. 없으면 sex 에서 만든 옛 몸이다.
   * 태그의 아래 증거(음경·음부)와 이 캐릭터 칸의 증거는 몸 보유자에게 가고, 문장의 he/she 는 역할의 성별(sex)을 따른다
   */
  body?: CharBody
  /** 행위 역할 (자리 역할 > 씬별 역할 > 카드 역할) */
  role: 'source' | 'target' | null
  /** 얼굴만 나오는 자리(inset·portrait·close-up) — 몸이 안 나온다 */
  faceSeat: boolean
  /** 씬에서 자동 젖힘을 껐음 (OutfitChoice.auto === false) */
  autoOff: boolean
  /** 씬 전체 글(기본·씬 프롬프트)을 이 캐릭터의 글로 받는지 — 옷 벗기기와 같은 기준 */
  receivesScene: boolean
}

/**
 * 씬 전체 글을 받는 캐릭터인가 — 당하는쪽이거나, 역할 걸린 캐릭터가 없는 씬의 전원.
 * 역할 없는 카드가 역할 있는 카드와 같이 나오면 남녀로 가른다 (여캐는 당하는쪽처럼 받는다).
 */
export function receivesSceneText(
  role: 'source' | 'target' | null | undefined,
  sex: Sex,
  anyRole: boolean
): boolean {
  if (!anyRole) return true
  if (role) return role === 'target'
  return sex === 'female'
}

/** 글이 적힌 칸 */
export type ExposeFieldScope = 'scene' | 'source' | 'target' | 'char'

export interface ExposeField {
  text: string
  /** scene = 기본·씬 프롬프트 · source/target = 하는쪽/당하는쪽 태그 칸 · char = 캐릭터 하나의 칸(씬별 캐릭터 태그·자리 태그·상대 태그) */
  scope: ExposeFieldScope
  /** scope 가 char 일 때 그 캐릭터의 index */
  index?: number
}

/** 부위 하나의 판정 (1단계) */
export interface AreaDecision {
  /** 근거가 있어 이 부위를 드러내야 한다 — nsfw 조각을 켜고 입은 옷 젖힘 대상 */
  needed: boolean
  /** needed 가 아닐 때 안 붙은 이유 (근거가 없으면 없음) */
  status?: ExposeStatus
  /** 근거 글 */
  evidence: string[]
  /** 이 캐릭터의 이 부위가 이미 벗었거나 젖혀졌다는 문장 */
  opens: Evidence[]
  /** 벗음·젖힘 단서가 있으나 누구 옷인지 모호한 것 */
  ambiguousOpens: Evidence[]
  reason?: string
}

export interface CharExposure {
  char: ExposeChar
  areas: Record<ExposeArea, AreaDecision>
  /** nsfw 조각을 켤 부위 */
  auto: Required<SceneAreas>
}

export interface SceneExposure {
  chars: CharExposure[]
  /** 기본·씬 프롬프트 (이 글을 받는 캐릭터가 직접 적은 벗음 선언을 볼 때 쓴다) */
  sceneTexts: string[]
}

interface Bag {
  need: Evidence[]
  weak: Evidence[]
  open: Evidence[]
  over: Evidence[]
  off: Evidence[]
  neg: Evidence[]
  amb: Evidence[]
  ambOpen: Evidence[]
}
const emptyBag = (): Bag => ({
  need: [],
  weak: [],
  open: [],
  over: [],
  off: [],
  neg: [],
  amb: [],
  ambOpen: []
})

/** 글 읽기 결과 기억 — 같은 씬을 미리보기·대기 항목 재구성에서 여러 번 만든다 */
const analysisCache = new WeakMap<ExposeActs, Map<string, TextAnalysis>>()
const CACHE_LIMIT = 4000
function analyzeCached(
  text: string,
  actor: Sex | null,
  clue: Sex | null,
  acts: ExposeActs
): TextAnalysis {
  let byActs = analysisCache.get(acts)
  if (!byActs) {
    byActs = new Map()
    analysisCache.set(acts, byActs)
  }
  const key = `${actor ?? '-'}${clue ?? '-'}\u0000${text}`
  const hit = byActs.get(key)
  if (hit) return hit
  const made = analyzeText(text, { actor, clue }, acts)
  if (byActs.size >= CACHE_LIMIT) byActs.clear()
  byActs.set(key, made)
  return made
}

const effectiveRole = (c: ExposeChar): 'source' | 'target' =>
  c.role ?? (c.sex === 'male' ? 'source' : 'target')

/**
 * 이 증거의 주인(male = 음경 쪽, female = 음부·여 가슴 쪽)이 이 캐릭터의 몸인가.
 * 몸을 모르는 캐릭터는 옛 방식(sex 일치)이다. 몸을 아는 캐릭터(후타)는
 *  - 아래 증거 가운데 주인을 몸 낱말의 해부학 기본으로 정한 것(태그, 지칭어 없는 penis·pussy)을 음경/음부 보유 여부로,
 *  - 이 캐릭터 자기 칸의 증거(own)를 몸으로 가린다.
 * 지칭어(he/his/her)로 주인을 정한 문장과 가슴 증거는 역할의 성별을 따른다 — 후타 하는쪽은 글에서 「그」이고 가슴 이야기(her)는 상대의 것이다.
 */
function holds(c: ExposeChar, owner: Sex, ev: Evidence, own: boolean): boolean {
  if (!c.body) return c.sex === owner
  if (own || (ev.area === 'lower' && (ev.via === 'tag' || ev.anatomy)))
    return bodyHolds(c.body, owner, ev.area)
  return c.sex === owner
}

/**
 * 씬 글을 읽어 캐릭터별로 어느 부위를 드러내야 하는지 정한다.
 * 칸마다 증거를 뽑고(주인 포함), 주인 몸을 가진 캐릭터에게 배정한다:
 *  - 하는쪽의 상대 몸 행위는 상대 쪽으로 간다 (핑거링 → 여 아래) · 자기 몸 행위는 자기에게
 *  - 같은 성별이 둘 이상이면 칸으로 가른다. 씬 전체 글의 지칭어(her)로는 못 가르니 모호(판단 못 함)
 *  - 얼굴 인셋 자리는 몸 증거를 받지 않는다
 */
export function analyzeExposure(input: {
  chars: ExposeChar[]
  fields: ExposeField[]
  acts: ExposeActs
}): SceneExposure {
  const { chars, fields } = input
  // 목록에 없어도 엔진이 아는 행위를 더한다 (저장된 목록은 건드리지 않는다)
  const acts = engineActs(input.acts)
  const bags = chars.map(() => ({ lower: emptyBag(), chest: emptyBag() }))
  const after = chars.map(() => false)
  const framed = chars.map(() => new Set<ExposeArea>())
  const bodies = chars.filter((c) => !c.faceSeat)
  // 항문 핥기처럼 태그만으로는 누구 몸인지 모를 때 쓰는 몸 단서 — 씬 전체 글에서 읽는다
  const clue = bodyClue(fields.map((f) => f.text).join('\n'))
  const distinct = (sex: Sex): number =>
    new Set(bodies.filter((c) => c.sex === sex).map((c) => c.id ?? `i${c.index}`)).size

  for (const field of fields) {
    if (!field.text || !field.text.trim()) continue
    const self = field.scope === 'char' && field.index != null ? chars[field.index] : undefined
    if (field.scope === 'char' && !self) continue
    const actor: Sex | null =
      field.scope === 'source'
        ? 'male'
        : field.scope === 'target'
          ? 'female'
          : field.scope === 'char'
            ? (self?.sex ?? null)
            : null
    const analysis = analyzeCached(field.text, actor, clue, acts)
    const everyone = self ? [self.index] : chars.map((c) => c.index)
    if (analysis.after) for (const i of everyone) after[i] = true
    for (const area of analysis.framing) for (const i of everyone) framed[i].add(area)

    // 이 칸의 글이 실제로 들어가는 몸 캐릭터 — 하는쪽 칸은 하는쪽 역할, 당하는쪽 칸은 당하는쪽 역할, 캐릭터 칸은 그 캐릭터만
    // (그 글은 그들의 프롬프트에만 가므로 모호한 증거도 이들 사이에서만 모호하다. 역할 캐릭터가 없으면 몸 캐릭터 전원)
    const candidates = (): ExposeChar[] => {
      if (self) return self.faceSeat ? [] : [self]
      if (field.scope === 'source' || field.scope === 'target') {
        const mine = bodies.filter((c) => effectiveRole(c) === field.scope)
        if (mine.length) return mine
      }
      return bodies
    }

    for (const ev of analysis.evidence) {
      // 받는 캐릭터와 모호 여부
      let targets: ExposeChar[]
      let ambiguous = false
      if (ev.kind === 'off' && ev.owner == null) {
        // 주인 없는 화면 밖 (lower body out of frame) — 구도 이야기라 이 칸을 받는 몸 캐릭터 모두의 그 부위가 안 보인다
        targets = candidates()
      } else if (ev.owner == null && ev.kind === 'open' && field.scope === 'scene') {
        // 씬 전체 글의 주인 없는 벗음 서술(nude · ass nude)은 옷 벗기기와 같게 씬 글을 받는 캐릭터의 것
        targets = chars.filter((c) => c.receivesScene && !c.faceSeat)
      } else if (
        ev.owner == null ||
        (ev.kind === 'open' && ev.guess && (field.scope === 'source' || field.scope === 'target'))
      ) {
        // 주인을 모른다 / 하는쪽·당하는쪽 칸의 옷 상태 서술은 누구 옷인지 모른다
        targets = candidates()
        ambiguous = true
      } else {
        const owner = ev.owner
        // 후타의 음경·고환 낱말은 지칭어가 여성형(her cock)이어도 음경 보유자의 것이다 — 몸을 아는 후타가 있으면 그 후타에게만 간다
        const futaPenis =
          ev.penisWord && ev.via === 'sentence' && owner === 'female'
            ? chars.filter((c) => c.body?.futa && c.body.penis)
            : []
        const sameSex = futaPenis.length
          ? futaPenis
          : chars.filter((c) => holds(c, owner, ev, false))
        if (field.scope === 'char' && self) {
          targets = holds(self, owner, ev, true) ? [self] : sameSex
        } else if (field.scope === 'source' || field.scope === 'target') {
          const mine = sameSex.filter((c) => effectiveRole(c) === field.scope)
          targets = actor === owner && mine.length ? mine : sameSex
        } else {
          // 씬 전체 글 — 문장의 지칭어(her/his)로는 같은 성별 둘을 못 가른다 (태그 표는 그 성별 전원)
          targets = sameSex
          if (ev.via === 'sentence' && (futaPenis.length || distinct(owner)) > 1) ambiguous = true
        }
        if (field.scope !== 'char' || !self || !holds(self, owner, ev, true)) {
          // 얼굴 자리는 다른 칸의 증거를 받지 않는다 (자기 칸 것만)
          targets = targets.filter((c) => !c.faceSeat || c === self)
        }
      }
      for (const c of targets) {
        const bag = bags[c.index][ev.area]
        if (ambiguous) {
          if (ev.kind === 'open') bag.ambOpen.push(ev)
          else if (ev.kind === 'need' || ev.kind === 'weak' || ev.kind === 'amb') bag.amb.push(ev)
          continue
        }
        bag[ev.kind].push(ev)
      }
    }
  }

  const out: CharExposure[] = chars.map((char) => {
    const areas = {} as Record<ExposeArea, AreaDecision>
    for (const area of AREAS)
      areas[area] = decide(
        char,
        bags[char.index][area],
        area,
        after[char.index],
        framed[char.index]
      )
    return {
      char,
      areas,
      auto: { lower: areas.lower.needed, chest: areas.chest.needed }
    }
  })
  return { chars: out, sceneTexts: fields.filter((f) => f.scope === 'scene').map((f) => f.text) }
}

const srcs = (list: Evidence[]): string[] => [...new Set(list.map((e) => e.src))].slice(0, 3)

/** 한 캐릭터의 한 부위에 모인 증거로 드러내야 하는지 정한다 */
function decide(
  char: ExposeChar,
  bag: Bag,
  area: ExposeArea,
  afterPhrase: boolean,
  framing: ReadonlySet<ExposeArea>
): AreaDecision {
  const none: AreaDecision = {
    needed: false,
    evidence: [],
    opens: bag.open,
    ambiguousOpens: bag.ambOpen
  }
  const signal = [...bag.need, ...bag.weak]
  const block = (status: ExposeStatus, reason: string, list: Evidence[]): AreaDecision => ({
    ...none,
    status,
    reason,
    evidence: srcs(list)
  })
  if (!signal.length) {
    if (bag.neg.length)
      return block('negated', `${AREA_NAME[area]}: 부정문이라 드러내지 않음`, bag.neg)
    if (bag.amb.length)
      return block('unknown', `${AREA_NAME[area]}: 누구 몸인지 모호해 판단 못 함`, bag.amb)
    return none
  }
  if (char.autoOff) return block('vetoed', SCENE_OFF_REASON, signal)
  if (char.faceSeat) return block('off-frame', '얼굴만 나오는 자리라 몸이 안 나와 안 붙임', signal)
  if (framing.has(area) || bag.off.length)
    return block(
      'off-frame',
      `${AREA_NAME[area]}: ${AREA_SUBJECT[area]} 화면 밖이라 안 붙임`,
      bag.off.length ? bag.off : signal
    )
  if (bag.need.length) return { ...none, needed: true, evidence: srcs(bag.need) }
  // 약한 신호뿐 — 옷 위 표지나 사후 어구가 있으면 무시
  if (bag.over.length)
    return block('over-clothes', `${AREA_NAME[area]}: 옷 위에서 하는 접촉이라 안 붙임`, [
      ...bag.over,
      ...bag.weak
    ])
  // 가리거나 부정하는 글이 같은 부위에 있으면 약한 신호(pussy · nipples)만으로는 드러내지 않는다
  if (bag.neg.length)
    return block('negated', `${AREA_NAME[area]}: 가리거나 부정하는 글이 있어 약한 신호를 무시함`, [
      ...bag.neg,
      ...bag.weak
    ])
  if (afterPhrase)
    return block('after', `${AREA_NAME[area]}: 사후 어구라 약한 신호를 무시함`, bag.weak)
  return { ...none, needed: true, evidence: srcs(bag.weak) }
}

// ── 벗음 선언 읽기 ──────────────────────────────────────

/** 알몸 선언 — 그 부위에 입은 옷이 없다 */
function nudeAreasOf(tag: string): ExposeArea[] {
  if (tag === 'nude' || tag === 'completely nude') return ['lower', 'chest']
  // naked apron 처럼 naked + 옷 한 벌은 그 옷만 입은 것이라 알몸이 아니다
  if (tag.startsWith('naked ')) return readGarments(tag).length ? [] : ['lower', 'chest']
  if (/^topless\b/.test(tag) || tag === 'shirtless') return ['chest']
  if (tag === 'bottomless') return ['lower']
  return []
}

const OPENERS: [RegExp, ExposeArea[]][] = [
  [
    /^(?:one )?breasts? out$|^(?:breast|nipple) slip$|^nipples? out$|^(?:exposed|bare) (?:breasts?|nipples?)$|^(?:breasts?|nipples?) exposed$/,
    ['chest']
  ],
  // clothing aside 는 사타구니 한 곳 (옷 표의 젖힘 태그로 아래) — clothes pull/lift/open 은 어느 쪽인지 모르니 둘 다
  [
    /^(?:open|opened) (?:clothes|clothing)$|^(?:clothes|clothing) (?:pull|lift)/,
    ['lower', 'chest']
  ],
  [
    /^(?:open|opened|unbuttoned|unzipped) (?:shirt|top|jacket|coat|hoodie|vest|kimono|bodysuit|bra|dress|robe|cardigan|blouse|sweater)$/,
    ['chest']
  ],
  [
    /^(?:panties|thong|underwear|pants|shorts|skirt|pantyhose|bottoms|bikini bottom|swimsuit|leotard|buruma|bloomers|loincloth|jeans) (?:aside|pulled?|down|lift|lifted)/,
    ['lower']
  ],
  [
    /^(?:shirt|bra|top|sweater|bikini top|tank top|blouse|camisole|crop top|t-shirt) (?:lift|lifted|pulled?|up|aside|down)/,
    ['chest']
  ],
  [/^panties around (?:one |her |his )?(?:leg|legs|ankles?)/, ['lower']],
  [/^open fly$|^unzipped (?:pants|fly)$|^pants down$/, ['lower']]
]

/**
 * 앞이 열린 겉옷 — 속에 입은 옷이 있으면 피부가 드러나지 않는다 (open jacket 인데 셔츠·브라를 입었다).
 * 이런 태그는 속옷이 없을 때만 「이미 젖힘」으로 친다
 */
const OUTER_OPEN = /^open (?:jacket|coat|hoodie|vest|robe|cardigan|blazer|bodysuit)$/

/** 이미 젖혀진 태그가 드러내는 부위 — 옷 표의 젖힘 태그와 일반 표현 */
export function openedAreasOf(tag: string): ExposeArea[] {
  const out = new Set<ExposeArea>(garmentOpenerAreas(tag))
  for (const [re, areas] of OPENERS) if (re.test(tag)) for (const a of areas) out.add(a)
  return [...out]
}

/** 입은 모습을 가리키는 단서의 부위 — 옷 벗기기와 충돌하면 알린다 (젖힘 태그·옷 위 표지·착의 섹스) */
function clothedClueAreas(tag: string): ExposeArea[] {
  if (tag === 'clothed sex' || tag === 'fully clothed') return ['lower', 'chest']
  const open = openedAreasOf(tag)
  return open.length ? open : overAreasOf(tag)
}

/** 글(들)의 음수·0 가중치 안 태그 — 막으라는 뜻 (-1::skirt lift::, 0::skirt lift::) */
function vetoedTags(texts: string[]): Set<string> {
  const out = new Set<string>()
  for (const text of texts) {
    for (const token of splitPromptTokens(removeComments(text ?? ''))) {
      if (!isOffWeight(token)) continue
      for (const t of tokenTags(token)) out.add(norm(t))
    }
  }
  return out
}

// ── 복장의 nsfw 조각 ───────────────────────────────────────

export type PieceState = 'none' | 'on' | 'off'

/**
 * 이 복장·선택에서 부위별 nsfw 조각이 있는지, 켜져 있는지 — 있으면 그 부위는 조각이 맡는다.
 * auto = 1단계가 정한 「드러내야 하는 부위」 (조각이 저절로 켜지는 조건)
 */
export function pieceInfo(
  outfit: Outfit | undefined,
  choice: Pick<OutfitChoice, 'on' | 'off'> | undefined,
  auto: SceneAreas
): { state: Record<ExposeArea, PieceState>; tags: Record<ExposeArea, string[]> } {
  const state: Record<ExposeArea, PieceState> = { lower: 'none', chest: 'none' }
  const tags: Record<ExposeArea, string[]> = { lower: [], chest: [] }
  if (!outfit) return { state, tags }
  const active = new Set(activePieces(outfit, choice, auto).map((p) => p.id))
  for (const area of AREAS) {
    const when = area === 'lower' ? 'nsfw-lower' : 'nsfw-chest'
    const pieces = outfit.pieces.filter((p) => !p.on && p.when === when)
    if (!pieces.length) continue
    const on = pieces.filter((p) => active.has(p.id))
    state[area] = on.length ? 'on' : 'off'
    tags[area] = on.flatMap((p) => liveTagsOf(p.tags))
  }
  return { state, tags }
}

/**
 * 이 캐릭터가 부위마다 알몸을 선언했는가 (nude · completely nude · naked … · topless · bottomless · 문장의 ass nude).
 * texts = 카드와 이 캐릭터에게만 붙는 글 (복장 조각은 뺀다). 씬 전체 글은 받는 캐릭터만 본다.
 */
export function declaredNudeAreas(
  ex: CharExposure,
  scene: SceneExposure,
  texts: string[]
): Record<ExposeArea, boolean> {
  const char = ex.char
  const all = [...texts, ...(char.receivesScene ? scene.sceneTexts : [])]
  const out: Record<ExposeArea, boolean> = { lower: false, chest: false }
  for (const tag of all.flatMap(engineTagsOf)) {
    if (!char.body?.futa && !tagFitsSex(tag, char.sex)) continue
    for (const a of nudeAreasOf(tag)) out[a] = true
  }
  for (const area of AREAS)
    if (ex.areas[area].opens.some((e) => /^(naked|topless|bottomless)$/.test(e.rule)))
      out[area] = true
  return out
}

/**
 * nsfw 조각을 켤 부위 — 1단계가 정한 auto 에서, 같은 부위에 알몸 선언이 있는 곳을 뺀다 (카드에 직접 적은 옷은 알몸이면 젖히지 않는데
 * 복장 조각만 켜지던 어긋남). 그 부위의 nsfw 조각이 누드 조각이면 예외라 그대로 켠다.
 */
export function gateAuto(
  ex: CharExposure,
  declared: Record<ExposeArea, boolean>,
  outfit: Outfit | undefined
): Required<SceneAreas> {
  const auto = { ...ex.auto }
  for (const area of AREAS) {
    if (!auto[area] || !declared[area]) continue
    const when = area === 'lower' ? 'nsfw-lower' : 'nsfw-chest'
    const pieces = (outfit?.pieces ?? []).filter((p) => !p.on && p.when === when)
    if (!pieces.some((p) => isNudePiece(p.tags))) auto[area] = false
  }
  return auto
}

// ── 2단계: 입은 옷에 맞춰 붙이기 ─────────────────────────────

export interface WornState {
  /** 옷 벗기기를 거친 뒤의 카드 글 */
  card: string
  /** 입는 복장의 켜진 조각 태그 (옷 벗기기를 거친 뒤) */
  outfit: string
  /** 이 캐릭터에게만 붙는 글 — 씬별 캐릭터 태그·자리 태그·상대 태그·역할 태그 */
  own: string[]
  /** 옷 벗기기가 알몸으로 만들었다 */
  stripped: boolean
  /** 알몸이 된 까닭을 보이는 말로 (「옷 벗기기 둘 다」 · 「completely nude 태그」) — 안내 문구용 */
  strippedBy?: string
  piece: ReturnType<typeof pieceInfo>
}

export interface ExposeResult {
  /** 입은 옷에 맞춰 붙일 젖힘 태그 (겉에서 속으로, 두 부위의 같은 태그는 한 번) */
  tags: string[]
  notes: ExposeNote[]
}

/** 제안만 하는 일반형 태그 — 옷을 못 읽었을 때 */
const SUGGEST: Record<ExposeArea, string> = { lower: 'clothing aside', chest: 'breasts out' }

const uniq = <T>(list: T[]): T[] => [...new Set(list)]

/**
 * 이 캐릭터에게 해당하는 태그인가 — 반대 성별 이야기(topless male · nude female)와 남성 하의 서술(open fly)은
 * 씬 전체 글을 받는 다른 성별 캐릭터의 벗음·젖힘으로 읽지 않는다
 */
const MALE_WORDS = /\b(?:male|boy|man|guy|1boy)\b/
const FEMALE_WORDS = /\b(?:female|girl|woman|lady|1girl)\b/
const MALE_ONLY_OPEN = /^(?:open fly|unzipped (?:pants|fly)|pants down|fly open)$/
function tagFitsSex(tag: string, sex: Sex): boolean {
  const male = MALE_WORDS.test(tag)
  const female = FEMALE_WORDS.test(tag)
  if (sex === 'female') return !(male && !female) && !MALE_ONLY_OPEN.test(tag)
  return !(female && !male)
}

/** 글의 「no panties」 · 「without a bra」 가 가리키는 옷 — 그 옷은 안 입은 것이다 */
function droppedRules(texts: string[]): Set<GarmentRule> {
  const out = new Set<GarmentRule>()
  for (const tag of texts.flatMap(engineTagsOf)) {
    const m = /^(?:no|without|not wearing(?: any)?)\s+(.+)$/.exec(tag)
    if (m) for (const g of readGarments(m[1])) out.add(g.rule)
  }
  return out
}

/** 옷 이야기가 있는 글인데 옷 표가 못 읽는 낱말 — 이게 있으면 「옷 못 읽음」(경고), 없으면 옷 글 자체가 없는 것(조용히) */
const WEARISH =
  /\b(?:armou?r|cape|cloak|corset|halter\w*|suit|uniform|outfit|clothes|clothing|costume|gown|robe|lingerie|babydoll|qipao|hakama|kimono|bunny|maid|nurse|swimwear|underwear|sleeve\w*|collar|wear\w*|dressed)\b/

/**
 * 1단계 결과와 옷 벗기기가 끝난 글로 이 캐릭터의 젖힘 태그와 메모를 만든다.
 * 우선순위(위가 이김): 씬에서 끔·조각을 끔·음수 가중치 > 옷 벗기기(알몸) > 같은 캐릭터가 직접 적은 벗음·젖힘 >
 * 복장 nsfw 조각 > 입은 옷에 맞춘 젖힘 태그.
 */
export function finishExposure(
  ex: CharExposure,
  scene: SceneExposure,
  worn: WornState
): ExposeResult {
  const { char } = ex
  const notes: ExposeNote[] = []
  const note = (
    area: ExposeArea,
    status: ExposeStatus,
    reason: string,
    extra: Partial<Pick<ExposeNote, 'tags' | 'garments' | 'evidence' | 'gated'>> = {}
  ): void => {
    notes.push({
      charIndex: char.index,
      charId: char.id,
      name: char.name,
      area,
      status,
      tags: extra.tags ?? [],
      garments: extra.garments ?? [],
      evidence: extra.evidence ?? [],
      reason,
      ...(extra.gated ? { gated: true } : {})
    })
  }

  // 이 캐릭터의 글 — 카드·복장(옷 벗기기 뒤)과 직접 붙은 글, 씬 전체 글은 받는 캐릭터만
  const ownTexts = [...worn.own, ...(char.receivesScene ? scene.sceneTexts : [])]
  const allTexts = [worn.card, worn.outfit, ...ownTexts]
  // 후타는 남녀 낱말(topless male · nude female)로 거르지 않는다 — 어느 쪽 이야기든 이 캐릭터의 몸일 수 있다
  const mineTags = (texts: string[]): string[] =>
    texts.flatMap(engineTagsOf).filter((t) => char.body?.futa || tagFitsSex(t, char.sex))
  const present = new Set(mineTags(allTexts))
  const veto = vetoedTags(allTexts)

  // 직접 적은 벗음·젖힘 선언
  const nude: Record<ExposeArea, string | null> = { lower: null, chest: null }
  const opened: Record<ExposeArea, string[]> = { lower: [], chest: [] }
  const outerOpen: Record<ExposeArea, string[]> = { lower: [], chest: [] }
  for (const tag of present) {
    const n = nudeAreasOf(tag)
    for (const a of n) nude[a] ??= tag
    if (n.length) continue
    for (const a of openedAreasOf(tag)) (OUTER_OPEN.test(tag) ? outerOpen : opened)[a].push(tag)
  }
  const design = openByDesign([worn.card, worn.outfit, ...worn.own].join(', '))

  // 입은 옷 — 카드 + 복장 + 이 캐릭터에게만 붙는 글. 씬 글의 「no panties」는 그 옷을 뺀다
  let garments = readGarments([worn.card, worn.outfit, ...worn.own].join('\n'))
  // naked apron — 그 한 겹만 입고 속은 맨몸
  if (garments.some((g) => g.alone)) garments = garments.filter((g) => g.alone)
  const dropped = droppedRules(ownTexts)
  const rules = uniq(garments.map((g) => g.rule)).filter((r) => !dropped.has(r))
  const wornNames = uniq(rules.map((r) => r.nouns[0]))

  // 충돌(R9) — 알몸으로 벗겼는데 같은 캐릭터에 입은 모습을 가리키는 단서가 있다. 자동으로 풀지 않고 표시만
  const conflictAreas = new Set<ExposeArea>()
  if (worn.stripped) {
    const clues: Record<ExposeArea, string[]> = { lower: [], chest: [] }
    for (const tag of uniq(mineTags(ownTexts)))
      for (const a of clothedClueAreas(tag)) clues[a].push(tag)
    const fixable = (worn.strippedBy ?? '').startsWith('옷 벗기기')
    for (const area of AREAS) {
      if (!clues[area].length) continue
      conflictAreas.add(area)
      note(
        area,
        'conflict',
        `${AREA_NAME[area]}: 알몸(${worn.strippedBy ?? '알몸 우선'})인데 ${clues[area].slice(0, 2).join(', ')} 가 있음 — 자동으로 풀지 않음${fixable ? ' · 입은 채로 두려면 씬의 옷 벗기기를 「안 벗김」으로' : ''}`,
        { tags: clues[area].slice(0, 3) }
      )
    }
  }

  const tags: string[] = []
  for (const area of AREAS) {
    const dec = ex.areas[area]
    const name = AREA_NAME[area]
    if (!dec.needed) {
      if (dec.status && dec.reason) note(area, dec.status, dec.reason, { evidence: dec.evidence })
      else note(area, 'not-needed', `${name}: 드러내라는 행위·문장을 못 찾음`)
      continue
    }
    const evidence = dec.evidence
    // 0) 같은 부위에 알몸 선언이 있으면 복장의 nsfw 조각도 켜지지 않는다 (조각이 누드 조각이면 예외 — gateAuto) — 카드 옷과 같은 결과.
    //    옷 벗기기로 벗긴 캐릭터는 아래 2)가 그 까닭을 말한다
    const declared =
      nude[area] ?? dec.opens.find((e) => /^(naked|topless|bottomless)$/.test(e.rule))?.src ?? null
    if (declared && !worn.stripped && worn.piece.state[area] !== 'on') {
      // 복장에 이 부위의 nsfw 조각이 있는데(켜지지 않은 상태) 알몸 선언 때문에 막혔다 — 화면에 그 사실을 같이 보인다
      const gated = worn.piece.state[area] === 'off'
      note(
        area,
        'nude',
        `${nude[area] ? `${name}: ${nude[area]} 라 젖힐 옷이 없음` : `${name}: 이미 벗은 모습을 적었음`}${gated ? ' · 복장의 nsfw 조각도 켜지지 않음' : ''}`,
        {
          tags: nude[area] ? [nude[area] as string] : [],
          evidence: nude[area] ? evidence : [declared],
          gated
        }
      )
      continue
    }
    // 1) 이 복장의 nsfw 조각을 이 씬에서 껐다 (직접 끈 것)
    if (worn.piece.state[area] === 'off') {
      note(area, 'vetoed', `${name}: 복장의 nsfw 조각을 이 씬에서 껐음`, { evidence })
      continue
    }
    // 2) 알몸 — 충돌 행이 이미 같은 말을 하니 한 줄로 둔다
    if (worn.stripped) {
      if (!conflictAreas.has(area))
        note(area, 'nude', `${name}: 알몸이라 젖힐 옷이 없음 (${worn.strippedBy ?? '알몸'})`, {
          evidence
        })
      continue
    }
    // 3) 복장 nsfw 조각이 맡음 — 조각 태그는 이미 프롬프트에 들어갔으니(알몸 선언이 있어도) 그대로 보인다
    if (worn.piece.state[area] === 'on') {
      note(area, 'piece', `${name}: 복장의 nsfw 조각이 이 부위를 맡음`, {
        tags: worn.piece.tags[area],
        evidence
      })
      continue
    }
    if (nude[area]) {
      note(area, 'nude', `${name}: ${nude[area]} 라 젖힐 옷이 없음`, {
        tags: [nude[area] as string],
        evidence
      })
      continue
    }
    const sentenceNude = dec.opens.find((e) => /^(naked|topless|bottomless)$/.test(e.rule))
    if (sentenceNude) {
      note(area, 'nude', `${name}: 이미 벗은 모습을 적었음`, { evidence: [sentenceNude.src] })
      continue
    }
    // 4) 같은 부위에 직접 적은 젖힘이 이미 있다 (앞이 열린 겉옷은 속에 입은 옷이 없을 때만)
    const inner = rules.some((r) => r.layer >= 1 && r[area]?.length)
    const mine = uniq([...opened[area], ...(inner ? [] : outerOpen[area])])
    const cands = layeredTags(rules, area)
    // 설계로 열린 옷(cupless bra · crotchless panties)은 그 겹만 열려 있다 — 바깥에 다른 옷이 가리면 그 옷은 젖힌다
    const openByDesignOnly = !!design[area] && !cands.length
    if (mine.length || openByDesignOnly) {
      note(area, 'already', `${name}: 이미 젖혀진 글이 있어 안 붙임`, {
        tags: mine.length ? mine.slice(0, 3) : [design[area] as string],
        evidence
      })
      continue
    }
    if (dec.ambiguousOpens.length) {
      note(area, 'unknown', `${name}: 벗음·젖힘 단서의 주인이 모호해 판단 못 함`, {
        evidence: srcs(dec.ambiguousOpens)
      })
      continue
    }
    if (dec.opens.length) {
      note(area, 'already', `${name}: 이미 젖혀진 글이 있어 안 붙임`, {
        evidence: srcs(dec.opens)
      })
      continue
    }
    // 5) 입은 옷에 맞는 젖힘 태그
    if (!cands.length) {
      const text = [worn.card, worn.outfit, ...worn.own].join(', ').toLowerCase()
      const wearish = WEARISH.test(text)
      note(
        area,
        'no-garment',
        wornNames.length
          ? `${name}: ${AREA_OBJECT[area]} 가린 옷을 못 읽음 (읽은 옷: ${wornNames.join(', ')}) — 붙이지 않음 · 가린 옷 이름을 카드에 적거나 제안 태그를 직접 적으세요`
          : wearish
            ? `${name}: 옷 이야기는 있는데 낱말표가 못 읽음 — 붙이지 않음 · 옷 이름을 풀어 적거나 제안 태그를 직접 적으세요`
            : `${name}: 카드·복장에 입은 옷이 적혀 있지 않음`,
        {
          // 옷 글이 아예 없으면 제안도 하지 않는다 (경고 피로) — 화면은 tags·garments 가 모두 비면 조용한 상태로 보인다
          tags: wornNames.length || wearish ? [SUGGEST[area]] : [],
          garments: wornNames,
          evidence
        }
      )
      continue
    }
    const blocked = cands.filter((t) => veto.has(t))
    const fresh = cands.filter((t) => !veto.has(t) && !present.has(t))
    const used = rules.filter((r) => r[area]?.some((t) => fresh.includes(t))).map((r) => r.nouns[0])
    if (!fresh.length) {
      if (blocked.length)
        note(area, 'vetoed', `${name}: ${blocked.join(', ')} 는 음수 가중치로 막혀 안 붙임`, {
          tags: blocked,
          garments: wornNames,
          evidence
        })
      else
        note(area, 'already', `${name}: 붙일 젖힘 태그가 이미 글에 있음`, {
          tags: cands,
          garments: wornNames,
          evidence
        })
      continue
    }
    for (const t of fresh) if (!tags.includes(t)) tags.push(t)
    note(
      area,
      'added',
      `${name}: ${fresh.join(', ')} 붙임${blocked.length ? ` (막힌 태그: ${blocked.join(', ')})` : ''}`,
      { tags: fresh, garments: used, evidence }
    )
  }
  return { tags, notes }
}
