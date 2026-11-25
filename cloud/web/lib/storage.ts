/** 브라우저 저장소 — 막혀 있거나 던져도 화면은 돌아가야 해서 전부 try/catch */

const TOKEN_KEY = 'nais3_cloud_token'

/** localStorage 가 안 될 때를 위한 메모리 사본 (새로고침하면 사라짐) */
let memoryToken: string | null = null

export function readToken(): string | null {
  try {
    const v = localStorage.getItem(TOKEN_KEY)
    if (v) return v
  } catch {
    /* 저장소 접근 불가 */
  }
  return memoryToken
}

export function writeToken(token: string | null): void {
  memoryToken = token
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* 저장소 접근 불가 */
  }
}

/** 화면 편의 값(고른 프리셋 등) — 없어도 된다 */
export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(`nais3_cloud_${key}`)
  } catch {
    return null
  }
}

export function writePref(key: string, value: string | null): void {
  try {
    if (value == null) localStorage.removeItem(`nais3_cloud_${key}`)
    else localStorage.setItem(`nais3_cloud_${key}`, value)
  } catch {
    /* 저장소 접근 불가 */
  }
}
