/**
 * 클라우드 워커 호출 (커스텀).
 * 헤더 x-nais-pc 에 PC 비밀값을 싣고, 응답 JSON 을 파싱하고, 오류를 한국어 Error 로 바꾼다.
 * 비밀값·NAI 토큰은 오류 메시지에 절대 넣지 않는다(서버가 보낸 문구도 비밀값이 섞였으면 가린다).
 */

/** 요청 한 번의 제한 시간 (그림 올리기처럼 큰 본문은 호출하는 쪽이 늘린다) */
export const CLOUD_TIMEOUT_MS = 20_000

export class CloudError extends Error {
  constructor(
    message: string,
    /** HTTP 상태. 0 = 서버에 닿지 못함 */
    readonly status: number
  ) {
    super(message)
    this.name = 'CloudError'
  }
}

export interface CloudRequestInit {
  method?: string
  /** JSON 본문 */
  json?: unknown
  /** 바이트 본문 (그림) */
  body?: Uint8Array
  headers?: Record<string, string>
  timeoutMs?: number
}

export interface CloudClientDeps {
  fetch: typeof fetch
  /** 워커 주소 (끝의 / 는 알아서 뗀다) */
  url: () => string
  secret: () => string | null
}

export interface CloudClient {
  /** JSON 응답 — `{ ok: true, ...값 }` 에서 그대로 돌려준다 */
  request<T = Record<string, unknown>>(path: string, init?: CloudRequestInit): Promise<T>
  /** 바이트 응답 (zip 등) */
  requestBytes(path: string, init?: CloudRequestInit): Promise<Uint8Array>
  /** 글자열에서 PC 비밀값을 가린다 */
  redact(text: string): string
}

export function createCloudClient(deps: CloudClientDeps): CloudClient {
  const redact = (text: string): string => {
    const secret = deps.secret()
    return secret ? text.split(secret).join('***') : text
  }

  async function send(path: string, init: CloudRequestInit): Promise<Response> {
    const secret = deps.secret()
    if (!secret) throw new CloudError('클라우드 연결 정보가 없습니다', 0)
    const headers: Record<string, string> = { ...init.headers, 'x-nais-pc': secret }
    let body: BodyInit | undefined
    if (init.json !== undefined) {
      body = JSON.stringify(init.json)
      headers['content-type'] = 'application/json'
    } else if (init.body) {
      body = init.body as BodyInit
    }
    let res: Response
    try {
      res = await deps.fetch(deps.url().replace(/\/+$/, '') + path, {
        method: init.method ?? (body === undefined ? 'GET' : 'POST'),
        headers,
        body,
        signal: AbortSignal.timeout(init.timeoutMs ?? CLOUD_TIMEOUT_MS)
      })
    } catch (e) {
      // 원래 오류 문구는 쓰지 않는다 — 주소·헤더가 섞일 수 있다
      const name = e instanceof Error ? e.name : ''
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new CloudError('클라우드 응답이 없습니다 (시간 초과)', 0)
      }
      throw new CloudError('클라우드에 연결하지 못했습니다', 0)
    }
    if (!res.ok) throw await failure(res)
    return res
  }

  async function failure(res: Response): Promise<CloudError> {
    let detail = ''
    try {
      const data = (await res.json()) as { error?: unknown }
      if (typeof data?.error === 'string') detail = redact(data.error).slice(0, 200)
    } catch {
      // 본문이 JSON 이 아니면 상태 숫자만
    }
    const head = res.status === 401 ? '클라우드 연결 실패' : '클라우드 요청 실패'
    return new CloudError(`${head} (${res.status})${detail ? ` — ${detail}` : ''}`, res.status)
  }

  return {
    redact,
    async request<T>(path: string, init: CloudRequestInit = {}): Promise<T> {
      const res = await send(path, init)
      let data: unknown
      try {
        data = await res.json()
      } catch {
        throw new CloudError('클라우드 응답을 읽지 못했습니다', res.status)
      }
      const record = data as { ok?: unknown; error?: unknown } | null
      if (record && record.ok === false) {
        const detail = typeof record.error === 'string' ? redact(record.error).slice(0, 200) : ''
        throw new CloudError(
          `클라우드 요청 실패 (${res.status})${detail ? ` — ${detail}` : ''}`,
          res.status
        )
      }
      return data as T
    },
    async requestBytes(path: string, init: CloudRequestInit = {}): Promise<Uint8Array> {
      const res = await send(path, init)
      try {
        return new Uint8Array(await res.arrayBuffer())
      } catch (e) {
        // 헤더는 받았는데 본문을 읽다 끊기거나 시간이 다 됐다 — 원래 오류 문구는 쓰지 않는다(영문이고 주소가 섞일 수 있다)
        const name = e instanceof Error ? e.name : ''
        if (name === 'TimeoutError' || name === 'AbortError') {
          throw new CloudError('클라우드 응답이 없습니다 (시간 초과)', 0)
        }
        throw new CloudError('클라우드 응답을 끝까지 받지 못했습니다', 0)
      }
    }
  }
}
