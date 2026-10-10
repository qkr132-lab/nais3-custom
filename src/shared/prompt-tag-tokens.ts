import { commentStart } from './nai-presets'

/**
 * 프롬프트에서 "태그로 볼 글자 덩어리"와 그 위치를 뽑는다 (커스텀).
 *
 * 입력창에서 사전에 없는 덩어리를 빨갛게 보여 주기 위한 것 — 자연어 문장인지, 태그를 잘못 친 건지
 * 사용자가 바로 알아보게. 가중치 묶음(`1.3::a, b::`)·역할 접두사(`target#`)·괄호(`{}` `[]`)는
 * 벗겨서 안쪽만 보고, 조각(`<a1>`)·와일드카드(`a/b`, `{a|b}`)·주석(`# …`)·`Text:` 줄은 건너뛴다.
 */
export interface PromptTagToken {
  /** value 안의 시작·끝 (끝 제외) — 벗긴 뒤의 알맹이 위치 */
  start: number
  end: number
  /** 알맹이 글자 (앞뒤 공백 제거) */
  text: string
}

/**
 * NAI만 아는 태그 — 단보루 사전엔 없지만 틀린 게 아니다.
 * 품질·미학·연도·등급·복잡도(V5)·데이터셋·투명 배경, 그리고 NAI가 개명한 태그
 * (v→peace sign, :|→neutral face, |_|→bar eyes, eyepatch bikini→square bikini, tachi-e→character image …)
 */
export const NAI_KNOWN_TAG =
  /^(?:(?:best|amazing|great|normal|bad|worst) quality|very aesthetic|aesthetic|displeasing|very displeasing|masterpiece|absurdres|highres|lowres|year \d{4}|rating:(?:general|sensitive|questionable|explicit)|(?:low|medium|high|ultra) complexity|no text|location|top aesthetic|fur dataset|background dataset|transparent background|has alpha|alpha transparency|depthness|attractive male|meta:(?:novel|golden) era|visual novel (?:art|bg|cg|chibi|sprite)|peace sign|double peace|bar eyes|neutral face|neco-arc eyes|square bikini|character image|open \\m\/|text|english text|japanese text|chinese text)$/i

/** 콤마가 묶음 기호 안(`1.3::a, b::`)에 있어도 각 태그를 따로 보도록, 줄 하나를 덩어리들로 자른다 */
function splitLine(line: string, offset: number, out: PromptTagToken[]): void {
  // 주석은 # 앞까지만
  const hash = commentStart(line)
  const body = hash === -1 ? line : line.slice(0, hash)
  // 줄 전체가 Text: 지시면 (V4.5+ 글자 그리기) 태그가 아니다
  if (/^\s*text\s*:/i.test(body)) return
  let at = 0
  for (const piece of body.split(',')) {
    const pieceStart = at
    at += piece.length + 1
    let s = 0
    let e = piece.length
    while (s < e && /\s/.test(piece[s])) s++
    while (e > s && /\s/.test(piece[e - 1])) e--
    let inner = piece.slice(s, e)
    if (!inner) continue
    // 조각·와일드카드·선택지는 무엇이 뽑힐지 모르니 판단하지 않는다
    if (/[<>|/]/.test(inner)) continue
    // 큰따옴표 문구는 그릴 글자(Text:)다 — 태그가 아니다
    if (/["“”]/.test(inner)) continue
    // 앞 가중치 `1.3::` / 뒤 `::`
    const w = /^-?\d*\.?\d+::/.exec(inner)
    if (w) {
      s += w[0].length
      inner = inner.slice(w[0].length)
    }
    if (inner.endsWith('::')) {
      e -= 2
      inner = inner.slice(0, -2)
    }
    // 괄호 강조 { } [ ] ( ) 는 벗긴다
    while (inner && /^[{[(]/.test(inner)) {
      s++
      inner = inner.slice(1)
    }
    while (inner && /[}\])]$/.test(inner)) {
      e--
      inner = inner.slice(0, -1)
    }
    // 역할 접두사
    const role = /^(?:source|target|mutual)#/i.exec(inner)
    if (role) {
      s += role[0].length
      inner = inner.slice(role[0].length)
    }
    // 다시 앞뒤 공백
    let ts = 0
    let te = inner.length
    while (ts < te && /\s/.test(inner[ts])) ts++
    while (te > ts && /\s/.test(inner[te - 1])) te--
    const text = inner.slice(ts, te)
    if (!text) continue
    out.push({ start: offset + pieceStart + s + ts, end: offset + pieceStart + s + te, text })
  }
}

export function promptTagTokens(value: string): PromptTagToken[] {
  const out: PromptTagToken[] = []
  let offset = 0
  for (const line of value.split('\n')) {
    splitLine(line, offset, out)
    offset += line.length + 1
  }
  return out
}

/** 사전 조회용 이름 — 소문자, 밑줄은 공백, 공백 하나로 */
export const tagLookupKey = (text: string): string =>
  text.trim().toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ')

/**
 * 사전에 없는 덩어리의 범위 — known(이름) 이 true/false/undefined(아직 모름)를 돌려준다.
 * 모르는 것(조회 전)은 빨갛게 칠하지 않는다. NAI 전용 태그는 사전에 없어도 아는 것으로 친다.
 */
export function unknownTagRanges(
  value: string,
  known: (key: string) => boolean | undefined
): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = []
  for (const t of promptTagTokens(value)) {
    const k = tagLookupKey(t.text)
    if (NAI_KNOWN_TAG.test(k)) continue
    if (known(k) === false) out.push(t)
  }
  return out
}
