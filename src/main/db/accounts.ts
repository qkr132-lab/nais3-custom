import { safeStorage } from 'electron'
import { getSetting, setSetting, setNaiToken } from './settings'

/**
 * NAI 계정 여러 개 보관 (커스텀).
 *
 * V5부터 Opus 무료 생성분이 한도제로 바뀌면서, 한도를 다 쓰면 Anlas가 나간다.
 * 계정을 두 개 이상 두고 한도가 바닥난 계정에서 남아 있는 계정으로 갈아타기 위한 저장소다.
 *
 * 토큰은 계정마다 safeStorage로 암호화해 넣는다 (settings.ts와 같은 방식).
 * 활성 계정의 토큰은 기존 `nai_token_encrypted`에도 그대로 써준다 — 생성·업스케일·
 * 잔액 조회 등 기존 경로가 전부 그 키를 읽으므로, 그쪽을 건드리지 않고 갈아탈 수 있다.
 */

const ACCOUNTS_KEY = 'nai_accounts'
const ACTIVE_KEY = 'nai_active_account'

interface StoredAccount {
  id: string
  label: string
  /** safeStorage 암호문 (base64) */
  token: string
}

/** UI로 내보내는 형태 — 토큰 본문은 절대 내보내지 않는다 */
export interface AccountInfo {
  id: string
  label: string
  /** 앞 4글자만 (식별용) */
  prefix: string
  active: boolean
}

function encrypt(token: string): string {
  const trimmed = token.trim()
  return safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(trimmed).toString('base64')
    : Buffer.from(trimmed).toString('base64')
}

function decrypt(stored: string): string | null {
  const buf = Buffer.from(stored, 'base64')
  try {
    return safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(buf)
      : buf.toString('utf-8')
  } catch {
    return null
  }
}

function readAll(): StoredAccount[] {
  const raw = getSetting(ACCOUNTS_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as StoredAccount[]
    return Array.isArray(parsed) ? parsed.filter((a) => a?.id && a?.token) : []
  } catch {
    return []
  }
}

function writeAll(accounts: StoredAccount[]): void {
  setSetting(ACCOUNTS_KEY, JSON.stringify(accounts))
}

export function activeAccountId(): string | null {
  return getSetting(ACTIVE_KEY)
}

export function listAccounts(): AccountInfo[] {
  const active = activeAccountId()
  return readAll().map((a) => {
    const token = decrypt(a.token)
    return {
      id: a.id,
      label: a.label,
      prefix: token ? token.slice(0, 4) : '',
      active: a.id === active
    }
  })
}

export function accountToken(id: string): string | null {
  const found = readAll().find((a) => a.id === id)
  return found ? decrypt(found.token) : null
}

/** 계정 추가. 첫 계정이면 바로 활성으로 삼는다 */
export function addAccount(label: string, token: string): AccountInfo[] {
  const accounts = readAll()
  const id = `acc_${Date.now().toString(36)}_${accounts.length}`
  accounts.push({ id, label: label.trim() || `계정 ${accounts.length + 1}`, token: encrypt(token) })
  writeAll(accounts)
  if (!activeAccountId()) setActiveAccount(id)
  return listAccounts()
}

export function renameAccount(id: string, label: string): AccountInfo[] {
  writeAll(readAll().map((a) => (a.id === id ? { ...a, label: label.trim() || a.label } : a)))
  return listAccounts()
}

export function removeAccount(id: string): AccountInfo[] {
  const rest = readAll().filter((a) => a.id !== id)
  writeAll(rest)
  // 활성 계정을 지웠으면 남은 첫 계정으로 넘긴다
  if (activeAccountId() === id) {
    if (rest.length) setActiveAccount(rest[0].id)
    else setSetting(ACTIVE_KEY, '')
  }
  return listAccounts()
}

/** 활성 계정 전환 — 기존 토큰 키까지 갱신해 모든 호출 경로가 새 계정을 쓰게 한다 */
export function setActiveAccount(id: string): boolean {
  const token = accountToken(id)
  if (!token) return false
  setSetting(ACTIVE_KEY, id)
  setNaiToken(token)
  return true
}

/**
 * 지금 토큰을 계정 목록에 아직 안 넣었다면 '계정 1'로 흡수한다.
 * (계정 기능이 생기기 전부터 토큰만 넣어 쓰던 사용자를 위한 1회성 승격)
 */
export function adoptLegacyToken(token: string | null): void {
  if (!token || readAll().length) return
  addAccount('계정 1', token)
}
