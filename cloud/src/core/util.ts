/** 작은 공용 도구 — 응답 만들기, 본문 읽기, 해시·무작위·상수 시간 비교 */

/** 던지면 라우터가 `{ ok: false, error }` 로 바꿔 내보낸다 (error 는 사람에게 보이는 한국어 문장) */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/** 모든 응답은 캐시하지 않는다 (CORS 헤더는 일부러 없음 — 같은 출처 SPA 만 쓴다) */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  })
}

export function ok(extra: Record<string, unknown> = {}, status = 200): Response {
  return json({ ok: true, ...extra }, status)
}

export function fail(status: number, error: string): Response {
  return json({ ok: false, error }, status)
}

/** 이진 응답 (그림·zip) — content-type 을 정확히 */
export function binary(
  body: BodyInit | null,
  contentType: string,
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': contentType, 'cache-control': 'no-store', ...extraHeaders }
  })
}

/** 한도를 넘었거나 읽지 않고 돌려보내는 요청 본문을 이만큼까지는 끝까지 읽어 버린다 (그보다 크면 취소) */
export const DRAIN_LIMIT_BYTES = 64 * 1024
/** 본문을 버리며 기다리는 최대 시간 — 조금씩만 보내며 버티는 연결이 응답을 붙들어 두지 못하게 */
export const DRAIN_TIMEOUT_MS = 2000

/**
 * 남은 요청 본문을 읽어서 버린다. 워커→DO 로 넘어온 본문을 읽지 않은 채 응답하면 런타임이 응답 뒤에
 * 그 본문을 계속 읽으려다 「Can't read from request stream after response has been sent」 오류를 낸다
 * (로컬 wrangler dev 는 이 오류에 세션이 죽는다). 작은 본문은 끝까지 비워 그 오류를 막고,
 * 예산(DRAIN_LIMIT_BYTES)이나 시간(DRAIN_TIMEOUT_MS)을 넘으면 더 읽지 않고 취소한다 — 메모리는 쓰지 않는다
 */
async function discardRest(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  alreadyRead: number
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), DRAIN_TIMEOUT_MS)
  })
  try {
    let read = alreadyRead
    while (read <= DRAIN_LIMIT_BYTES) {
      const next = await Promise.race([reader.read(), timeout])
      if (next === 'timeout') break
      if (next.done) return // 끝까지 비웠다
      read += next.value.byteLength
    }
    await reader.cancel()
  } catch {
    // 이미 끊긴 스트림
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 라우트가 읽지 않은 요청 본문을 정리한다 (router 가 응답 직전에 부른다) */
export async function settleBody(request: Request): Promise<void> {
  const body = request.body
  if (!body || request.bodyUsed || body.locked) return
  await discardRest(body.getReader(), 0)
}

/**
 * 본문을 한도 안에서만 읽는다 (DO 메모리 128MB 를 지키려고 — 한도를 넘는 본문은 끝까지 받지 않는다).
 * Content-Length 가 한도를 넘으면 읽기 전에 413. 없거나 거짓이면 스트림으로 읽다가 누적이 한도를 넘는 즉시
 * 모으기를 멈추고 413 (남은 본문은 discardRest 로 버린다)
 */
async function readLimited(
  request: Request,
  maxBytes: number,
  tooBigMessage: string
): Promise<Uint8Array> {
  const declared = request.headers.get('content-length')
  if (declared != null && declared.trim() !== '') {
    const length = Number(declared)
    // 본문은 건드리지 않는다 — 작으면 router 가 비우고, 크면 취소한다
    if (Number.isFinite(length) && length > maxBytes) throw new HttpError(413, tooBigMessage)
  }
  const body = request.body
  if (!body) return new Uint8Array(0)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await discardRest(reader, total)
      throw new HttpError(413, tooBigMessage)
    }
    chunks.push(value)
  }
  if (chunks.length === 1) return chunks[0]
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of chunks) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

/**
 * JSON 본문 읽기. 너무 크면 413, 깨졌으면 400. 본문이 비어 있으면 빈 객체.
 * maxChars = 글자 수 한도, maxBytes = 받는 바이트 한도(기본 maxChars 의 3배 — UTF-8 한 글자는 최대 3바이트).
 */
export async function readJson(
  request: Request,
  maxChars = 1_000_000,
  maxBytes = maxChars * 3
): Promise<unknown> {
  const bytes = await readLimited(request, maxBytes, '요청이 너무 큽니다')
  const text = new TextDecoder().decode(bytes)
  if (text.length > maxChars) throw new HttpError(413, '요청이 너무 큽니다')
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, '요청 본문이 올바른 JSON이 아닙니다')
  }
}

/** 이진 본문 읽기. maxBytes 를 넘으면 413 (Content-Length 가 없거나 거짓이어도 읽는 도중에 막는다) */
export async function readBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  return readLimited(request, maxBytes, '파일이 너무 큽니다')
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

// ── 해시·무작위 ─────────────────────────────────────────────────────

const encoder = new TextEncoder()

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** 비밀값 비교 — 둘 다 SHA-256 으로 길이를 맞춘 뒤 상수 시간으로 비교한다 */
export async function secretEquals(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b))
  ])
  const x = new Uint8Array(ha)
  const y = new Uint8Array(hb)
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
  return diff === 0
}

export function toBase64Url(bytes: Uint8Array): string {
  let text = ''
  for (const b of bytes) text += String.fromCharCode(b)
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

/** 무작위 바이트 → base64url (토큰용 — 32바이트) */
export function randomToken(byteLength = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)))
}

/** 알파벳에서 len 글자 무작위 (편향 없이) */
export function randomString(len: number, alphabet: string): string {
  const limit = 256 - (256 % alphabet.length)
  let out = ''
  while (out.length < len) {
    for (const b of crypto.getRandomValues(new Uint8Array(len * 2))) {
      if (b >= limit) continue
      out += alphabet[b % alphabet.length]
      if (out.length === len) break
    }
  }
  return out
}

export const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** 오류 문구·로그에서 토큰 문자열을 가린다 */
export function scrub(text: string, secret: string | null | undefined): string {
  if (!secret || secret.length < 4) return text
  return text.split(secret).join('***')
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 배열을 n 개씩 자른다 (DO SQL 은 쿼리당 바인딩 100개 제한) */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
