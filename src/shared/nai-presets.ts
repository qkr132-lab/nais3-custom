import type { UcPresetIndex } from './types'

/**
 * NAI 웹이 클라이언트에서 병합하는 프리셋 텍스트 (실캡처 확정).
 * payload 조립(메인)과 토큰 카운트 표시(렌더러)가 공유한다 —
 * 카운트는 병합 "후" 텍스트 기준이어야 웹 표시와 일치한다.
 */

/** 실캡처 확정 (V4.5 full): 프롬프트 "뒤"에 그대로 이어 붙는다 */
export const QUALITY_TAGS_SUFFIX = ', very aesthetic, masterpiece, no text'

const UC_HEAVY =
  'nsfw, lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page'

/** 인덱스 매핑 (실캡처): 0=Heavy, 1=Light, 3=Human Focus, 4=None. 2는 미사용 */
export const UC_PRESETS_V45_FULL: Record<UcPresetIndex, string> = {
  0: UC_HEAVY,
  1: 'nsfw, lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page',
  2: '',
  3: UC_HEAVY + ', @_@, mismatched pupils, glowing eyes, bad anatomy',
  4: ''
}

/**
 * 한 줄에서 주석이 시작되는 '#' 위치 (없으면 -1).
 * 규칙: '#'이 줄 맨 앞이거나 바로 앞이 공백일 때만 주석. 'target#mating press'처럼
 * 토큰 중간의 '#'(NAI V4 액션 태그)은 주석으로 보지 않는다.
 */
export function commentStart(line: string): number {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '#' && (i === 0 || /\s/.test(line[i - 1]))) return i
  }
  return -1
}

/** 주석 제거 — #부터 그 줄 끝(줄바꿈 전)까지. # 앞 내용은 유지, 줄 전체가 주석이면 줄 삭제 */
export function removeComments(prompt: string): string {
  const out: string[] = []
  for (const line of prompt.split('\n')) {
    const i = commentStart(line)
    if (i === -1) {
      out.push(line)
      continue
    }
    const before = line.slice(0, i)
    if (before.trim()) out.push(before)
  }
  return out.join('\n')
}

export function mergeQualityTags(prompt: string, qualityToggle: boolean): string {
  if (!qualityToggle) return prompt
  return prompt + QUALITY_TAGS_SUFFIX
}

/** 캡처 확정: 프리셋 텍스트 + ", " + 유저 네거티브 순서로 병합 */
export function mergeUcPreset(negativePrompt: string, ucPreset: UcPresetIndex): string {
  const preset = UC_PRESETS_V45_FULL[ucPreset]
  if (!preset) return negativePrompt
  return negativePrompt ? preset + ', ' + negativePrompt : preset
}
