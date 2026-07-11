import type { GenerationRequest } from './types'

/** 기본 프롬프트 뒤에 씬 프롬프트를 붙이되 경계의 중복 콤마만 정리한다. */
export function appendPrompt(base: string, add: string): string {
  const b = base.trim().replace(/,\s*$/, '')
  const a = add.trim().replace(/^,\s*/, '')
  if (!b) return a
  if (!a) return b
  return `${b}, ${a}`
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
      request.promptParts && request.sceneBaseDetailPrompt != null
        ? {
            ...request.promptParts,
            detail: appendPrompt(request.sceneBaseDetailPrompt, latestScene.prompt)
          }
        : request.promptParts
  }
}
