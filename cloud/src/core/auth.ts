/**
 * 인증과 페어링 (설계 3절).
 * PC: 헤더 x-nais-pc = PC_SECRET (상수 시간 비교).
 * 폰: authorization: Bearer <기기 토큰> — DO 에는 SHA-256 hex 만 저장.
 * 연결(페어링): PC 가 8자리 코드(10분·1회용) → 폰이 코드 + 기기 이름으로 토큰을 받는다.
 */
import type { HubDeps } from './deps'
import { makeQrSvg } from './qr'
import {
  HttpError,
  ID_ALPHABET,
  isRecord,
  randomString,
  randomToken,
  secretEquals,
  sha256Hex
} from './util'

/** 혼동 없는 32자 (0/O, 1/I/L 제외) */
export const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const PAIR_CODE_LENGTH = 8
export const PAIR_TTL_MS = 10 * 60 * 1000
/** 코드 하나가 이 횟수 실패하면 폐기 */
export const PAIR_MAX_FAILURES = 5
/** 전체 페어링 시도 상한 (시간당) */
export const PAIR_HOURLY_LIMIT = 30
const HOUR_MS = 60 * 60 * 1000
/** last_seen 은 이 간격으로만 쓴다 */
const LAST_SEEN_INTERVAL_MS = 60 * 1000

export interface DeviceInfo {
  id: string
  name: string
}

export async function requirePc(deps: HubDeps, request: Request): Promise<void> {
  const secret: unknown = deps.env.PC_SECRET
  // 서버 쪽 비밀값이 없거나 비어 있으면(배포 때 빠뜨림) 아무도 통과시키지 않는다 —
  // 빈 헤더와 빈 비밀값이 서로 같다고 열리는 일이 없도록 헤더를 보기 전에 먼저 막는다
  if (typeof secret !== 'string' || secret.trim() === '')
    throw new HttpError(503, '클라우드 PC 비밀값이 설정되지 않았습니다')
  const given = request.headers.get('x-nais-pc')
  if (!given || !(await secretEquals(given, secret)))
    throw new HttpError(401, '인증에 실패했습니다')
}

export async function requireDevice(deps: HubDeps, request: Request): Promise<DeviceInfo> {
  const header = request.headers.get('authorization') ?? ''
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header)
  if (!match) throw new HttpError(401, '연결이 필요합니다. 폰을 다시 연결해 주세요')
  const hash = await sha256Hex(match[1])
  const row = deps.sql
    .exec<{ id: string; name: string }>(`SELECT id, name FROM devices WHERE token_hash = ?`, hash)
    .toArray()[0]
  if (!row) throw new HttpError(401, '연결이 해제됐습니다. 폰을 다시 연결해 주세요')
  const now = deps.now()
  deps.sql.exec(
    `UPDATE devices SET last_seen = ? WHERE id = ? AND (last_seen IS NULL OR last_seen < ?)`,
    now,
    row.id,
    now - LAST_SEEN_INTERVAL_MS
  )
  return { id: row.id, name: row.name }
}

/** PC 가 연결 코드를 만든다. 새 코드가 나가면 이전 코드는 폐기한다 (한 번에 하나만) */
export function createPairing(
  deps: HubDeps,
  request: Request
): { code: string; url: string; expiresAt: number; qrSvg: string } {
  const now = deps.now()
  deps.sql.exec(`DELETE FROM pairing`)
  const code = randomString(PAIR_CODE_LENGTH, PAIR_ALPHABET)
  const expiresAt = now + PAIR_TTL_MS
  deps.sql.exec(
    `INSERT INTO pairing (code, expires_at, attempts) VALUES (?, ?, 0)`,
    code,
    expiresAt
  )
  const origin = deps.origin ?? new URL(request.url).origin
  const url = `${origin}/#pair=${code}`
  let qrSvg = ''
  try {
    qrSvg = makeQrSvg(url)
  } catch {
    // 주소가 QR 용량을 넘으면 그림 없이 코드·주소만 준다
  }
  return { code, url, expiresAt, qrSvg }
}

/** 실패 한 번을 지금 유효한 코드 전부에 센다 — 5번이면 그 코드를 지운다 */
function countFailure(deps: HubDeps, code: string | null): void {
  const sql = deps.sql
  if (code) {
    sql.exec(`UPDATE pairing SET attempts = attempts + 1 WHERE code = ?`, code)
  } else {
    sql.exec(`UPDATE pairing SET attempts = attempts + 1 WHERE expires_at > ?`, deps.now())
  }
  sql.exec(`DELETE FROM pairing WHERE attempts >= ?`, PAIR_MAX_FAILURES)
}

/**
 * 시간당 전체 시도 제한 — 맞든 틀리든 센다. 인증 없는 /api/pair 가 본문을 읽기 **전에** 먼저 건다
 * (그래야 커다란 본문을 계속 보내는 공격이 메모리를 쓰기 전에 막힌다). 넘으면 429
 */
export function consumePairAttempt(deps: HubDeps): void {
  const sql = deps.sql
  const now = deps.now()
  const limit = sql
    .exec<{ n: number; reset_at: number }>(`SELECT n, reset_at FROM ratelimit WHERE k = 'pair'`)
    .toArray()[0]
  if (!limit || limit.reset_at <= now) {
    sql.exec(
      `INSERT INTO ratelimit (k, n, reset_at) VALUES ('pair', 1, ?)
       ON CONFLICT(k) DO UPDATE SET n = 1, reset_at = excluded.reset_at`,
      now + HOUR_MS
    )
  } else if (limit.n >= PAIR_HOURLY_LIMIT) {
    throw new HttpError(429, '연결 시도가 너무 많습니다. 한 시간 뒤에 다시 시도해 주세요')
  } else {
    sql.exec(`UPDATE ratelimit SET n = n + 1 WHERE k = 'pair'`)
  }
}

/** /api/pair 본문 한도 (바이트) — 코드 8자 + 기기 이름 40자면 충분하다 */
export const PAIR_MAX_BODY_BYTES = 2048

/**
 * 폰이 코드로 기기를 등록한다. 성공하면 토큰(한 번만 보여 줌)과 기기 id.
 * 시간당 시도 제한은 부르는 쪽이 먼저 consumePairAttempt 로 건다
 */
export async function redeemPairing(
  deps: HubDeps,
  body: unknown
): Promise<{ token: string; deviceId: string }> {
  const sql = deps.sql
  // await 는 검사·기록 전에 끝낸다 — 그 뒤는 끊김 없이 이어져야 같은 코드가 두 번 쓰이지 않는다
  const token = randomToken(32)
  const tokenHash = await sha256Hex(token)
  const now = deps.now()
  sql.exec(`DELETE FROM pairing WHERE expires_at <= ?`, now)

  const wrong = (): never => {
    countFailure(deps, null)
    throw new HttpError(400, '연결 코드가 틀렸거나 만료됐습니다')
  }
  if (!isRecord(body) || typeof body.code !== 'string') return wrong()
  const code = body.code.toUpperCase().replace(/[\s-]/g, '')
  const row = sql
    .exec<{ code: string }>(`SELECT code FROM pairing WHERE code = ? AND expires_at > ?`, code, now)
    .toArray()[0]
  if (!row) return wrong()

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (name.length < 1 || name.length > 40) {
    countFailure(deps, code)
    throw new HttpError(400, '기기 이름은 1~40자로 적어 주세요')
  }

  const deviceId = 'd' + randomString(10, ID_ALPHABET)
  sql.exec(
    `INSERT INTO devices (id, name, token_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?)`,
    deviceId,
    name,
    tokenHash,
    now,
    now
  )
  sql.exec(`DELETE FROM pairing WHERE code = ?`, code) // 1회용
  return { token, deviceId }
}
