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

/** 씬에서 고른 순서를 우선하고, 나머지 기본 캐릭터를 뒤에 중복 없이 붙인다. */
export function prioritizeSceneCharacterIds(sceneIds: number[], baseIds: number[]): number[] {
  return [...new Set([...sceneIds, ...baseIds])]
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

  return {
    ...request,
    prompt: appendPrompt(request.sceneBasePrompt, latestScene.prompt),
    negativePrompt: appendPrompt(request.sceneBaseNegativePrompt ?? '', latestScene.negativePrompt),
    promptParts:
      request.promptParts && request.sceneBaseAdditionalPrompt != null
        ? mergeSceneIntoPromptParts(
            { ...request.promptParts, additional: request.sceneBaseAdditionalPrompt },
            latestScene.prompt
          )
        : request.promptParts
  }
}
