import type { CharRole, GenerationRequest, PromptParts } from './types'

/** 기본 프롬프트 뒤에 씬 프롬프트를 붙이되 경계의 중복 콤마만 정리한다. */
export function appendPrompt(base: string, add: string): string {
  const b = base.trim().replace(/,\s*$/, '')
  const a = add.trim().replace(/^,\s*/, '')
  if (!b) return a
  if (!a) return b
  return `${b}, ${a}`
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

/** 씬 프롬프트는 3분할의 가변(additional) 영역에만 합친다. */
export function mergeSceneIntoPromptParts(parts: PromptParts, scenePrompt: string): PromptParts {
  return {
    ...parts,
    additional: appendPrompt(parts.additional, scenePrompt)
  }
}

/** 3분할을 전송 프롬프트 한 줄로 (고정, 가변, 디테일 순 — 빈 칸은 건너뜀) */
export function mergePromptParts(parts: PromptParts): string {
  return [parts.base, parts.additional, parts.detail].filter((p) => p.trim()).join(', ')
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
  latestScene: { prompt: string; negativePrompt: string }
): GenerationRequest {
  if (request.sceneId == null || request.sceneBasePrompt == null) return request

  const negativePrompt = appendPrompt(
    request.sceneBaseNegativePrompt ?? '',
    latestScene.negativePrompt
  )

  // 분할 사용 시: 씬 프롬프트를 가변 뒤·디테일 앞에 끼워 전송 프롬프트를 파츠에서 재조립.
  // (전체 병합문 끝에 붙이면 디테일 뒤 꼬리가 되어 긴 디테일에 묻힌다 — 적용 약해지던 버그)
  if (request.promptParts && request.sceneBaseAdditionalPrompt != null) {
    const parts = mergeSceneIntoPromptParts(
      { ...request.promptParts, additional: request.sceneBaseAdditionalPrompt },
      latestScene.prompt
    )
    return { ...request, prompt: mergePromptParts(parts), negativePrompt, promptParts: parts }
  }

  return {
    ...request,
    prompt: appendPrompt(request.sceneBasePrompt, latestScene.prompt),
    negativePrompt,
    promptParts: request.promptParts
  }
}
