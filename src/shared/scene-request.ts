import {
  normalizeBackground,
  stripSimpleBackgrounds,
  type SceneBackground
} from './background-tags'
import type { CharacterPromptInput, CharRole, GenerationRequest, PromptParts } from './types'
import { appendPromptPiece, removeComments, splitTextTail } from './nai-presets'
import {
  withCensorTags,
  withoutCensorDuplicates,
  withAnalSuppression,
  type CensorKind,
  type CensorWeights
} from './censor-tags'

/**
 * 검열 태그를 붙일 캐릭터 — 요청에 실제로 들어가는 첫 캐릭터 (꺼졌거나 주석뿐인 칸은 건너뜀).
 * 전송 직전 걸러내는 규칙(preparePromptCaptions)과 같아야 한다. 없으면 -1
 */
export function censorCharacterIndex(characters: { prompt: string; enabled: boolean }[]): number {
  return characters.findIndex((c) => c.enabled && removeComments(c.prompt).trim())
}

export function scenePositivePrompt(
  base: string,
  scene: {
    prompt: string
    kind?: 'scene' | 'background'
    background?: SceneBackground
    censorKinds?: CensorKind[]
    censorTagWeights?: CensorWeights
  },
  parts?: PromptParts,
  /** 검열 태그 전 캐릭터 프롬프트. 주면 첫 캐릭터 끝에 검열 태그를 붙여 돌려준다 */
  characters?: CharacterPromptInput[]
): { prompt: string; promptParts?: PromptParts; characterPrompts?: CharacterPromptInput[] } {
  const background = normalizeBackground(scene.background)
  // A background card's prompt is the background itself, with no scene action tags.
  if (scene.kind === 'background') background.prompt = scene.prompt
  const actionPrompt = scene.kind === 'background' ? '' : scene.prompt
  const clean = (value: string): string =>
    background.prompt.trim() && background.replaceSimple ? stripSimpleBackgrounds(value) : value
  const scenePrompt =
    background.placement === 'before-scene'
      ? appendPrompt(background.prompt, clean(actionPrompt))
      : appendPrompt(clean(actionPrompt), background.prompt)
  // 검열 태그는 첫 캐릭터 맨 끝에 붙이고, 캐릭터가 없을 때만 기본 프롬프트 끝(예전 자리)에 붙인다.
  // 어느 쪽이든 기본 프롬프트에 적힌 같은 태그(예전 표기 포함)는 요청 사본에서 걷어낸다
  const kinds = scene.censorKinds
  const weights = scene.censorTagWeights
  const target = characters ? censorCharacterIndex(characters) : -1
  const tagged = (value: string): string =>
    target < 0 ? withCensorTags(value, kinds, weights) : withoutCensorDuplicates(value, kinds)
  const withCharacters = <T extends { prompt: string; promptParts?: PromptParts }>(
    result: T
  ): T & { characterPrompts?: CharacterPromptInput[] } =>
    characters
      ? {
          ...result,
          characterPrompts: characters.map((c, i) =>
            i === target ? { ...c, prompt: withCensorTags(c.prompt, kinds, weights) } : c
          )
        }
      : result
  if (!parts) return withCharacters({ prompt: tagged(appendPrompt(clean(base), scenePrompt)) })
  const merged = mergeSceneIntoPromptParts(
    { base: clean(parts.base), additional: clean(parts.additional), detail: clean(parts.detail) },
    scenePrompt
  )
  // 검열 태그는 씬과 같은 칸(디테일 끝)에 — 씬 묶음이 통째로 맨 뒤에 가도록
  const result = textToLastPart({
    base: withoutCensorDuplicates(merged.base, kinds),
    additional: withoutCensorDuplicates(merged.additional, kinds),
    detail: tagged(merged.detail)
  })
  return withCharacters({ prompt: mergePromptParts(result), promptParts: result })
}

/** 기본 프롬프트 뒤에 씬 프롬프트를 붙이되 경계의 중복 콤마만 정리한다 (`Text:` 블록은 맨 끝으로). */
export const appendPrompt = appendPromptPiece

/** Always rebuild managed negatives from the raw fields so switching off restores them. */
export function sceneNegativePrompt(
  base: string,
  scene: { negativePrompt: string; suppressAnal?: boolean }
): string {
  return withAnalSuppression(appendPrompt(base, scene.negativePrompt), scene.suppressAnal)
}

/** NAI 상호작용(mutual) 태그 — 행위 태그 필드에 접두사 없이 쓰면 source#/target#을 자동으로 붙인다.
 *  포즈·표정 같은 일반 태그는 접두사가 붙으면 안 되므로 이 목록에 있는 것만 변환한다 */
const MUTUAL_TAGS = new Set([
  'sex',
  'anal',
  'fellatio',
  'irrumatio',
  'deepthroat',
  'oral',
  'cunnilingus',
  'paizuri',
  'handjob',
  'footjob',
  'kiss',
  'french kiss',
  'hug',
  'missionary',
  'doggystyle',
  'cowgirl position',
  'reverse cowgirl position',
  'mating press',
  'full nelson',
  'spooning',
  'standing sex',
  'sixty-nine',
  '69',
  'breast sucking',
  'nursing handjob',
  'breastfeeding',
  'kissing penis',
  'licking penis',
  'grinding',
  'tribadism',
  'headpat',
  'arm grab',
  'hair grab',
  'spanking',
  'groping',
  'breast grab',
  'after sex',
  'piledriver'
])

/** 행위 태그의 bare 상호작용 태그에 역할 접두사를 붙인다 (커스텀).
 *  "sex, fellatio, on top" + target → "target#sex, target#fellatio, on top".
 *  이미 #이 있거나 가중치(n::…::) 안에 있는 태그는 건드리지 않는다 */
export function autoRolePrefix(tags: string, role: CharRole): string {
  if (!tags.trim()) return tags
  // 최상위 콤마로만 분리 — "::" 사이(가중치 블록)의 콤마는 분리하지 않는다
  const tokens: string[] = []
  let buf = ''
  let inWeight = false
  for (let i = 0; i < tags.length; i++) {
    if (tags.startsWith('::', i)) {
      inWeight = !inWeight
      buf += '::'
      i++
      continue
    }
    const ch = tags[i]
    if (ch === ',' && !inWeight) {
      tokens.push(buf)
      buf = ''
    } else buf += ch
  }
  tokens.push(buf)
  return tokens
    .map((raw) => {
      const t = raw.trim()
      if (!t) return null
      if (t.includes('#') || t.includes('::')) return t
      return MUTUAL_TAGS.has(t.toLowerCase()) ? `${role}#${t}` : t
    })
    .filter((t): t is string => t != null)
    .join(', ')
}

/** 역할에 해당하는 씬 행위 태그 (자동 접두사 적용). 역할이 없으면 빈 문자열 */
export function roleTagsFor(
  role: CharRole | undefined,
  scene: { sourceTags?: string; targetTags?: string }
): string {
  if (role === 'source') return autoRolePrefix(scene.sourceTags ?? '', 'source')
  if (role === 'target') return autoRolePrefix(scene.targetTags ?? '', 'target')
  return ''
}

/**
 * 이 캐릭터에게 걸린 장면 태그 (커스텀) — 누드면 옷 벗기기·nsfw 조각이 이걸 보고 정한다.
 * 씬 전체 태그(기본·씬 프롬프트)는 당하는쪽(역할 걸린 캐릭터가 없는 씬이면 전원)에게만.
 * 생성과 씬 배치 창이 같은 규칙을 쓰도록 한 곳에 둔다.
 */
export function sceneContextsFor(input: {
  role: CharRole | undefined
  /** 이 그림에 역할이 걸린 캐릭터가 있는지 */
  anyRole: boolean
  /** 기본 프롬프트·씬 프롬프트 */
  prompts: string[]
  scene: { sourceTags?: string; targetTags?: string }
  /** 이 씬 태그·자리 태그·상대 태그 */
  tags: string[]
}): string[] {
  const { role, anyRole, prompts, scene, tags } = input
  return [...(role === 'target' || !anyRole ? prompts : []), roleTagsFor(role, scene), ...tags]
}

/**
 * 씬 프롬프트는 3분할의 맨 뒤(디테일 뒤)에 붙는다 (2026-10-11 유저 「씬은 이제 제일 뒤에 오게 하자」).
 * 예전엔 가변 칸에 넣었는데, 그러면 디테일(화풍·품질)이 씬 내용 뒤에 와서 장면 묘사가 묻혔다.
 */
export function mergeSceneIntoPromptParts(parts: PromptParts, scenePrompt: string): PromptParts {
  return {
    ...parts,
    detail: appendPrompt(parts.detail, scenePrompt)
  }
}

/** 3분할을 전송 프롬프트 한 줄로 (고정, 가변, 디테일 순 — 빈 칸은 건너뜀) */
export function mergePromptParts(parts: PromptParts): string {
  return [parts.base, parts.additional, parts.detail].reduce(appendPrompt, '')
}

/**
 * 세 칸의 `Text:` 꼬리를 모아 디테일 칸 끝으로 (커스텀).
 * 씬 프롬프트는 가변 칸에 합쳐지므로 그 안의 Text:가 가변 끝에 남는데, 전송 프롬프트는
 * 이미 맨 끝으로 보내지만 메타데이터의 3분할 표시에선 가변 끝에 보여 헷갈린다 — 둘을 맞춘다.
 */
export function textToLastPart(parts: PromptParts): PromptParts {
  const b = splitTextTail(parts.base)
  const a = splitTextTail(parts.additional)
  const d = splitTextTail(parts.detail)
  const texts = [b.text, a.text, d.text].filter(Boolean)
  if (texts.length === 0) return parts
  return {
    base: b.body,
    additional: a.body,
    detail: appendPrompt(d.body, 'Text: ' + texts.join('\n\n'))
  }
}

/**
 * 상대 태그 (커스텀) — 이 역할의 캐릭터가 받을 태그를, 반대 역할 캐릭터들이 적어둔 것에서 모은다.
 *
 * 하는쪽 카드에 "상대에게 붙일 태그"를 적어두면 그 캐릭터가 나오는 그림에서 당하는쪽이 받는다
 * (반대도 같다). 상대마다 다른 반응을 카드에 걸어두는 용도라, 받는 쪽 카드는 건드리지 않는다.
 * 역할이 없으면 상대도 없다 — 주지도 받지도 않는다.
 */
export function partnerTagsFor(
  receiverRole: CharRole | null | undefined,
  givers: { id: number; role?: CharRole | null; partnerTags?: string }[],
  receiverId?: number
): string {
  if (!receiverRole) return ''
  const opposite: CharRole = receiverRole === 'source' ? 'target' : 'source'
  return givers
    .filter((g) => g.id !== receiverId && g.role === opposite && g.partnerTags?.trim())
    .map((g) => g.partnerTags!.trim().replace(/,\s*$/, ''))
    .join(', ')
}

/** 프롬프트 뒤에 상대 태그를 붙인다 — 행위 태그(sex 등)는 받는 쪽 역할로 접두사가 붙는다 */
export function withPartnerTags(
  prompt: string,
  role: CharRole | null | undefined,
  givers: { id: number; role?: CharRole | null; partnerTags?: string }[],
  selfId?: number
): string {
  const tags = partnerTagsFor(role, givers, selfId)
  return tags && role ? appendPrompt(prompt, autoRolePrefix(tags, role)) : prompt
}

/** 씬에서 고른 순서를 우선하고, 나머지 기본 캐릭터를 뒤에 중복 없이 붙인다. */
export function prioritizeSceneCharacterIds(sceneIds: number[], baseIds: number[]): number[] {
  return [...new Set([...sceneIds, ...baseIds])]
}

/** 자리 배치 정보 (커스텀) — 씬별 추가·큐 항목이 같은 모양으로 갖는다 */
export interface SlotLayout {
  slots?: { x: number; y: number }[]
  /** 자리 번호 → 그 자리에 앉은 캐릭터 id. 같은 캐릭터가 여러 자리에 앉아도 된다 */
  slotChars?: Record<number, number>
  /** (구형) 캐릭터 id → 자리 번호. slotChars가 없을 때만 읽는다 */
  slotOf?: Record<number, number>
  /** 자리 번호 → 행위 역할. 남은 자리를 같은 역할 캐릭터로 채우는 데 쓴다 */
  slotRoles?: Record<number, CharRole | null>
}

/** 좌석표 — 어느 자리에 누가 앉았고, 한 캐릭터가 어느 자리들을 차지했는지 */
export interface SlotSeating {
  /** 자리 번호 → 캐릭터 id */
  bySlot: Map<number, number>
  /** 캐릭터 id → 그 캐릭터가 앉은 자리 번호들 (번호 순) */
  bySlots: Map<number, number[]>
}

/**
 * 미리 잡아둔 자리에 캐릭터를 앉힌다 (커스텀).
 *
 * 규칙은 씬 배치 창이 화면에 그리는 것과 같아야 한다 — 안 그러면 창에서 본 배치와
 * 실제 생성이 어긋난다:
 * 1. 자리에 직접 앉힌 캐릭터(slotChars)가 먼저다. **같은 캐릭터를 여러 자리에 앉혀도 된다** —
 *    한 카드로 같은 인물을 여러 명 그리는 구도(자리마다 다른 태그·역할)를 위해서다.
 * 2. 구형 데이터(slotOf, 캐릭터당 한 자리)는 아직 빈 자리에만 반영한다.
 * 3. 그래도 빈 자리는 카드에 적힌 자리 번호(slotNo)가 채운다. 이미 어딘가 앉은 캐릭터는
 *    번호로 또 앉지 않는다 — 직접 앉힌 배치가 번호보다 우선이라는 뜻.
 * 4. 그래도 빈 자리에 역할(하는쪽/당하는쪽)이 걸려 있으면 **같은 역할 캐릭터**가 앉는다.
 *    카드에 '당하는쪽'만 걸어두면 당하는쪽 자리들이 알아서 채워진다. 한 명이 여러 자리를
 *    채워도 되고(같은 인물 여러 컷), 같은 역할 캐릭터가 여럿이면 적게 앉은 쪽부터 돌아간다.
 *
 * 한 자리에 둘이 겹치면 NAI가 두 인물을 한 점에 그려 뭉개므로, 겹침은 여기서 막는다.
 */
export function seatSlots(
  chars: { id: number; slotNo?: number | null; role?: CharRole | null }[],
  layout: SlotLayout
): SlotSeating {
  const count = layout.slots?.length ?? 0
  const known = new Set(chars.map((c) => c.id))
  const bySlot = new Map<number, number>()
  const valid = (index: number): boolean => index >= 0 && index < count && !bySlot.has(index)

  for (const [at, charId] of Object.entries(layout.slotChars ?? {})) {
    const index = Number(at)
    if (valid(index) && known.has(charId)) bySlot.set(index, charId)
  }
  for (const [charId, at] of Object.entries(layout.slotOf ?? {})) {
    const id = Number(charId)
    // 이미 어딘가 앉았으면 구형 배정은 무시 (새 배치가 이겨야 한다)
    if (valid(at) && known.has(id) && ![...bySlot.values()].includes(id)) bySlot.set(at, id)
  }
  for (const c of chars) {
    if (c.slotNo == null || [...bySlot.values()].includes(c.id)) continue
    const index = c.slotNo - 1
    if (valid(index)) bySlot.set(index, c.id)
  }

  // 4) 역할이 걸린 빈 자리는 같은 역할 캐릭터로 채운다
  const seatCount = new Map<number, number>()
  for (const id of bySlot.values()) seatCount.set(id, (seatCount.get(id) ?? 0) + 1)
  for (let i = 0; i < count; i++) {
    const role = layout.slotRoles?.[i]
    if (!role || bySlot.has(i)) continue
    // 적게 앉은 캐릭터부터 — 같은 역할이 여럿이면 한 명씩 고르게 나눠 앉는다
    let pick: { id: number } | undefined
    for (const c of chars) {
      if (c.role !== role) continue
      if (!pick || (seatCount.get(c.id) ?? 0) < (seatCount.get(pick.id) ?? 0)) pick = c
    }
    if (!pick) continue
    bySlot.set(i, pick.id)
    seatCount.set(pick.id, (seatCount.get(pick.id) ?? 0) + 1)
  }

  // 5) 배정 기록이 하나도 없는 자리 묶음(JSON으로 가져온 씬)이면, 빈 자리에 아직 안 앉은 캐릭터를
  //    순서대로 앉힌다 (2026-10-17) — 자리는 쓰라고 만든 것. 누군가를 직접 앉힌 묶음은 일부러 비운
  //    자리일 수 있으니 그대로 둔다. 역할이 걸린 자리엔 역할이 다른 캐릭터는 앉히지 않는다.
  const assigned =
    Object.keys(layout.slotChars ?? {}).length > 0 ||
    Object.keys(layout.slotOf ?? {}).length > 0 ||
    chars.some((c) => c.slotNo != null)
  if (!assigned) {
    for (let i = 0; i < count; i++) {
      if (bySlot.has(i)) continue
      const seatedIds = new Set(bySlot.values())
      const role = layout.slotRoles?.[i]
      const c = chars.find((x) => !seatedIds.has(x.id) && (!role || !x.role || x.role === role))
      if (!c) continue
      bySlot.set(i, c.id)
    }
  }

  const bySlots = new Map<number, number[]>()
  for (const index of [...bySlot.keys()].sort((a, b) => a - b)) {
    const charId = bySlot.get(index) as number
    bySlots.set(charId, [...(bySlots.get(charId) ?? []), index])
  }
  return { bySlot, bySlots }
}

/**
 * 예약 당시의 기본 설정은 유지하고, 실행 직전 씬 프롬프트만 최신값으로 다시 합친다.
 * 이미 서버로 넘어간 generating 항목에는 호출되지 않고 pending 항목에만 자연스럽게 적용된다.
 */
export function refreshScenePrompts(
  request: GenerationRequest,
  latestScene: {
    prompt: string
    kind?: 'scene' | 'background'
    background?: SceneBackground
    negativePrompt: string
    censorKinds?: CensorKind[]
    censorTagWeights?: CensorWeights
    suppressAnal?: boolean
  }
): GenerationRequest {
  if (request.sceneId == null || request.sceneBasePrompt == null) return request

  const negativePrompt = sceneNegativePrompt(request.sceneBaseNegativePrompt ?? '', latestScene)
  // 검열 태그 전 캐릭터 프롬프트로 되돌린 뒤 최신 검열 설정으로 다시 붙인다.
  // 원문이 없는 항목(이 필드가 생기기 전 예약)은 캐릭터에 검열 태그가 붙은 적이 없어 그대로 쓴다
  const chars = Array.isArray(request.characterPrompts) ? request.characterPrompts : undefined
  const texts = request.sceneBaseCharacterPrompts
  const characters =
    chars && texts?.length === chars.length
      ? chars.map((c, i) => ({ ...c, prompt: texts[i] }))
      : chars
  // 다시 최신화해도 같은 원문에서 시작하도록 원문을 함께 넘긴다
  const baseCharacters = characters
    ? { sceneBaseCharacterPrompts: characters.map((c) => c.prompt) }
    : {}

  // 분할 사용 시: 예약 당시 원문 파츠에서 다시 조립 (씬은 디테일 뒤 — mergeSceneIntoPromptParts)
  if (request.promptParts && request.sceneBaseAdditionalPrompt != null) {
    const positive = scenePositivePrompt(
      request.sceneBasePrompt,
      latestScene,
      {
        ...(request.sceneBasePromptParts ?? request.promptParts),
        additional: request.sceneBaseAdditionalPrompt
      },
      characters
    )
    return { ...request, ...positive, ...baseCharacters, negativePrompt }
  }

  const positive = scenePositivePrompt(request.sceneBasePrompt, latestScene, undefined, characters)
  return {
    ...request,
    ...positive,
    ...baseCharacters,
    negativePrompt,
    promptParts: request.promptParts
  }
}
