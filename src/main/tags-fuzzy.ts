/**
 * 한글 음차 퍼지 매칭 (커스텀) — "미드리프트"처럼 영어 발음을 한글로 친 질의를
 * 영어 태그(midriff)에 매칭한다.
 *
 * 원리: 양쪽을 같은 "발음 키"로 정규화한 뒤 바이그램 유사도로 비교.
 * - 한글: 자모 분해 → 자음은 로마자 계열로, 모음은 전부 '*' 하나로 붕괴
 *   (외래어 표기에서 모음이 제일 불안정하므로). ㅡ는 자음 사이 삽입모음이라 제거.
 * - 영어: f→p, v→b, l→r 등 한글 표기에서 구분 안 되는 소리를 합치고 모음은 '*'로.
 * 예: 미드리프트 → "m*dr*pt", midriff → "m*dr*p" → 유사도 높음.
 *
 * electron 의존 없는 순수 모듈 — 단위 테스트 가능.
 */

// 초성 19자
const CHO = ['k', 'k', 'n', 't', 't', 'r', 'm', 'p', 'p', 's', 's', '', 'j', 'j', 'ch', 'k', 't', 'p', 'h']
// 중성 21자 — ㅡ(18)는 삽입모음으로 보고 제거, 나머지는 '*'
const JUNG_EU = 18
// 종성 28자 (0 = 없음)
const JONG = ['', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'r', 'k', 'm', 'r', 'r', 'r', 'p', 'r', 'm', 'p', 'p', 's', 's', 'ng', 'j', 'ch', 'k', 't', 'p', 'h']

/** 한글 질의 → 발음 키. 한글이 아닌 글자(영문 등)는 영어 정규화 규칙을 따른다 */
export function hangulKey(query: string): string {
  let out = ''
  for (const ch of query) {
    const code = ch.codePointAt(0)!
    if (code >= 0xac00 && code <= 0xd7a3) {
      const idx = code - 0xac00
      const cho = Math.floor(idx / 588)
      const jung = Math.floor((idx % 588) / 28)
      const jong = idx % 28
      out += CHO[cho]
      if (jung !== JUNG_EU) out += '*'
      out += JONG[jong]
    } else if (/[a-zA-Z]/.test(ch)) {
      out += ch.toLowerCase()
    }
    // 공백/기호는 무시
  }
  return collapse(normalizeConsonants(out))
}

/** 영어 태그 → 발음 키 */
export function englishKey(tag: string): string {
  let s = tag.toLowerCase().replace(/[^a-z]/g, '')
  return collapse(normalizeConsonants(s))
}

/** 한글 표기에서 구분되지 않는 소리 통합 + 모음 붕괴.
 *  유/무성음을 무성음 쪽으로 통일 (d→t, g→k, b→p) — 한글 ㄷ/ㅌ, ㄱ/ㅋ, ㅂ/ㅍ 구분 흡수 */
function normalizeConsonants(s: string): string {
  return s
    .replace(/ph/g, 'p')
    .replace(/th/g, 't')
    .replace(/sh/g, 's')
    .replace(/ch/g, 'C') // ch 소리는 별도 클래스로 보존 (한글 ㅊ 포함)
    .replace(/ng/g, 'N') // 받침 ㅇ/영어 ng 보존
    .replace(/[fvb]/g, 'p')
    .replace(/d/g, 't')
    .replace(/[gqc]/g, 'k')
    .replace(/l/g, 'r')
    .replace(/z/g, 'j')
    .replace(/x/g, 'ks')
    .replace(/[aeiouwy]/g, '*')
}

/** 연속 중복 제거: '**'→'*', 'pp'→'p' */
function collapse(s: string): string {
  let out = ''
  for (const ch of s) if (ch !== out[out.length - 1]) out += ch
  return out
}

/** 바이그램 Dice 유사도 (0~1) + 접두 일치 보너스 + 길이 차 페널티 */
export function keySimilarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const ba = bigrams(a)
  const bb = bigrams(b)
  if (ba.size === 0 || bb.size === 0) return 0
  let common = 0
  for (const g of ba) if (bb.has(g)) common++
  let score = (2 * common) / (ba.size + bb.size)
  // 길이가 많이 다르면 같은 바이그램이 겹쳐도 다른 단어일 가능성이 큼
  score -= Math.abs(a.length - b.length) * 0.03
  // 한쪽이 다른 쪽의 접두면 보너스 (미드리프트 키가 midriff 키+어미인 경우)
  if (a.startsWith(b) || b.startsWith(a)) score = Math.max(score, 0.75)
  return score
}

function bigrams(s: string): Set<string> {
  const set = new Set<string>()
  if (s.length === 1) set.add(s)
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
  return set
}
