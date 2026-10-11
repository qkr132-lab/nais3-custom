import type { UcPresetIndex } from './types'

/**
 * NAI 웹이 클라이언트에서 병합하는 프리셋 텍스트 (실캡처 확정).
 * payload 조립(메인)과 토큰 카운트 표시(렌더러)가 공유한다 —
 * 카운트는 병합 "후" 텍스트 기준이어야 웹 표시와 일치한다.
 */

/** 실캡처 확정 (V4.5 full): 프롬프트 "뒤"에 그대로 이어 붙는다 */
export const QUALITY_TAGS_SUFFIX = ', very aesthetic, masterpiece, no text'
/** 글자를 그리는 프롬프트(Text: 블록)엔 `no text`를 빼고 붙인다 — 글자 렌더링을 막기 때문 */
export const QUALITY_TAGS_SUFFIX_TEXT = ', very aesthetic, masterpiece'

/**
 * `Text:` 블록이 시작하는 위치 (없으면 -1) — 줄 처음·콤마 뒤·공백 뒤 어디든.
 * NAI는 여기부터 프롬프트 끝까지를 그릴 글자로 보므로, 이 뒤에 붙는 태그는 전부 글자가 된다.
 */
export function textBlockStart(prompt: string): number {
  const m = /(?:^|[\s,])text:/i.exec(prompt)
  return m ? m.index + m[0].length - 'text:'.length : -1
}

/** 프롬프트를 본문과 `Text:` 꼬리(접두사 뗀 글자 내용)로 가른다. 꼬리가 없으면 text는 '' */
export function splitTextTail(prompt: string): { body: string; text: string } {
  const at = textBlockStart(prompt)
  if (at < 0) return { body: prompt, text: '' }
  return {
    body: prompt.slice(0, at).replace(/[\s,]+$/, ''),
    text: prompt.slice(at + 'text:'.length).trim()
  }
}

/**
 * 프롬프트 뒤에 덩어리를 붙인다 — 경계의 중복 콤마 정리, 앞쪽 마지막 줄이 주석이면 줄바꿈으로.
 * 어느 쪽에 `Text:` 블록이 있어도 **합친 결과의 맨 끝**으로 보낸다 (여럿이면 빈 줄로 이어 한 블록).
 * 3분할 병합·씬 프롬프트·검열 태그·캐릭터 카드+복장+자리 태그가 전부 이걸로 붙으므로
 * 어디에 적어도 글자 블록 뒤에 태그가 따라붙지 않는다.
 */
export function appendPromptPiece(base: string, add: string): string {
  const b = splitTextTail(base)
  const a = splitTextTail(add)
  const body = joinBodies(b.body, a.body)
  const texts = [b.text, a.text].filter(Boolean)
  if (texts.length === 0) return body
  return (body ? body + '\n' : '') + 'Text: ' + texts.join('\n\n')
}

function joinBodies(base: string, add: string): string {
  const b = base.trim().replace(/,\s*$/, '')
  const a = add.trim().replace(/^,\s*/, '')
  if (!b) return a
  if (!a) return b
  if (commentStart(b.slice(b.lastIndexOf('\n') + 1)) !== -1) return `${b}\n${a}`
  return `${b}, ${a}`
}

/** 큰따옴표(" " “ ”)로 감싼 문구들 — 줄을 넘지 않는 것만, 빈 것은 뺀다 */
export function quotedPhrases(prompt: string): string[] {
  const out: string[] = []
  for (const m of prompt.matchAll(/["“]([^"“”\n]*)["”]/g)) {
    const t = m[1].trim()
    if (t) out.push(t)
  }
  return out
}

/**
 * 따옴표 문구 → `Text:` 블록 (커스텀 · V5 웹이 하는 자동 변환을 API 전송 쪽에서 대신).
 * 이미 `Text:`를 적었으면 손대지 않는다. 문구가 여럿이면 빈 줄로 나눠 한 블록에 넣는다(공식 문서 방식).
 * 따옴표 자체는 그대로 둔다 — 말풍선 위치·대사 짝이 문맥에 남아야 한다.
 */
export function withTextBlock(prompt: string): string {
  if (textBlockStart(prompt) >= 0) return prompt
  const phrases = quotedPhrases(prompt)
  if (phrases.length === 0) return prompt
  return prompt.replace(/\s+$/, '') + '\nText: ' + phrases.join('\n\n')
}

/** 병합 프롬프트에서 자동 품질 태그를 벗겨 원문과 토글 상태를 돌려준다 (메타데이터 판독용) */
export function splitQualityTags(prompt: string): { prompt: string; qualityToggle: boolean } {
  if (prompt.endsWith(QUALITY_TAGS_SUFFIX))
    return { prompt: prompt.slice(0, -QUALITY_TAGS_SUFFIX.length), qualityToggle: true }
  const at = textBlockStart(prompt)
  if (at > 0) {
    const head = prompt.slice(0, at).replace(/[\s,]+$/, '')
    if (head.endsWith(QUALITY_TAGS_SUFFIX_TEXT))
      return {
        prompt: head.slice(0, -QUALITY_TAGS_SUFFIX_TEXT.length) + '\n' + prompt.slice(at),
        qualityToggle: true
      }
  }
  return { prompt, qualityToggle: false }
}

const WEB_UC_HEAVY =
  'nsfw, lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page'
const WEB_UC_LIGHT =
  'nsfw, lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page'

/** NAI 웹 원본 UC. 과거 이미지 메타데이터 판독과 실캡처 회귀 테스트에 사용한다. */
export const UC_PRESETS_V45_WEB_FULL: Record<UcPresetIndex, string> = {
  0: WEB_UC_HEAVY,
  1: WEB_UC_LIGHT,
  2: '',
  3: WEB_UC_HEAVY + ', @_@, mismatched pupils, glowing eyes, bad anatomy',
  4: ''
}

/** 커스텀판은 NSFW 생성을 억제하지 않도록 자동 UC의 선두 nsfw만 제외한다. */
const withoutNsfw = (preset: string): string => preset.replace(/^nsfw,\s*/, '')
const UC_HEAVY = withoutNsfw(WEB_UC_HEAVY)

/** 실제 앱 병합값: 0=Heavy, 1=Light, 3=Human Focus, 4=None. 2는 미사용 */
export const UC_PRESETS_V45_FULL: Record<UcPresetIndex, string> = {
  0: UC_HEAVY,
  1: withoutNsfw(WEB_UC_LIGHT),
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
  const at = textBlockStart(prompt)
  if (at < 0) return prompt + QUALITY_TAGS_SUFFIX
  // Text: 블록 뒤에 붙은 말은 글자로 그려진다 → 품질 태그는 블록 앞에, `no text`는 뺀다
  return (
    prompt.slice(0, at).replace(/[\s,]+$/, '') + QUALITY_TAGS_SUFFIX_TEXT + '\n' + prompt.slice(at)
  )
}

/** 캡처 확정: 프리셋 텍스트 + ", " + 유저 네거티브 순서로 병합 */
export function mergeUcPreset(negativePrompt: string, ucPreset: UcPresetIndex): string {
  const preset = UC_PRESETS_V45_FULL[ucPreset]
  if (!preset) return negativePrompt
  return negativePrompt ? preset + ', ' + negativePrompt : preset
}
