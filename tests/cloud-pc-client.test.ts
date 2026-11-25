import { describe, expect, it, vi } from 'vitest'
import { CloudError, createCloudClient, type CloudClient } from '../src/main/cloud/client'

/**
 * 모바일 클라우드 — 워커 호출 클라이언트 (커스텀). 가짜 fetch 만 쓴다.
 */

const SECRET = 'fake-secret-ZYXWVUTSRQ'

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function make(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
  opts: { secret?: string | null; url?: string } = {}
): { client: CloudClient; fetchMock: ReturnType<typeof vi.fn> } {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    respond(String(input), init ?? {})
  )
  const client = createCloudClient({
    fetch: fetchMock as unknown as typeof fetch,
    url: () => opts.url ?? 'https://cloud.test/',
    secret: () => (opts.secret === undefined ? SECRET : opts.secret)
  })
  return { client, fetchMock }
}

describe('cloud client', () => {
  it('주소 끝의 / 를 정리하고, x-nais-pc 헤더와 JSON 본문을 보낸다', async () => {
    const { client, fetchMock } = make(() => json({ ok: true, value: 1 }))
    const res = await client.request<{ ok: boolean; value: number }>('/api/pc/poll', {
      method: 'POST',
      json: { a: 1 },
      headers: { 'x-extra': 'e' }
    })
    expect(res).toEqual({ ok: true, value: 1 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('https://cloud.test/api/pc/poll')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe('{"a":1}')
    expect(init?.headers).toMatchObject({
      'x-nais-pc': SECRET,
      'content-type': 'application/json',
      'x-extra': 'e'
    })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('호출하는 쪽 헤더가 비밀값 헤더를 덮어쓰지 못한다', async () => {
    const { client, fetchMock } = make(() => json({ ok: true }))
    await client.request('/x', { headers: { 'x-nais-pc': 'other' } })
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>)['x-nais-pc']).toBe(
      SECRET
    )
  })

  it('본문이 없으면 GET, 바이트 본문이 있으면 그대로 싣는다', async () => {
    const { client, fetchMock } = make(() => json({ ok: true }))
    await client.request('/a')
    expect(fetchMock.mock.calls[0][1]?.method).toBe('GET')
    const bytes = new Uint8Array([1, 2, 3])
    await client.request('/b', { method: 'PUT', body: bytes })
    expect(fetchMock.mock.calls[1][1]?.body).toBe(bytes)
    expect(
      (fetchMock.mock.calls[1][1]?.headers as Record<string, string>)['content-type']
    ).toBeUndefined()
  })

  it('바이트 응답', async () => {
    const { client } = make(() => new Response(new Uint8Array([9, 8, 7]), { status: 200 }))
    expect(Array.from(await client.requestBytes('/file'))).toEqual([9, 8, 7])
  })

  it('401 은 「클라우드 연결 실패 (401)」, 그 밖의 오류는 「클라우드 요청 실패 (코드)」 + 서버 문구', async () => {
    const { client } = make((url) =>
      url.endsWith('/auth')
        ? json({ ok: false, error: '인증 실패' }, 401)
        : json({ ok: false, error: '본문이 너무 큽니다' }, 413)
    )
    await expect(client.request('/auth')).rejects.toMatchObject({
      message: '클라우드 연결 실패 (401) — 인증 실패',
      status: 401
    })
    await expect(client.request('/big')).rejects.toMatchObject({
      message: '클라우드 요청 실패 (413) — 본문이 너무 큽니다',
      status: 413
    })
  })

  it('서버 본문이 JSON 이 아니면 상태 숫자만', async () => {
    const { client } = make(() => new Response('<html>502</html>', { status: 502 }))
    await expect(client.request('/x')).rejects.toThrow(/^클라우드 요청 실패 \(502\)$/)
    await expect(client.requestBytes('/x')).rejects.toThrow(/\(502\)/)
  })

  it('200 이어도 ok:false 면 오류', async () => {
    const { client } = make(() => json({ ok: false, error: '거절' }))
    await expect(client.request('/x')).rejects.toThrow('거절')
  })

  it('서버가 보낸 문구에 비밀값이 섞여 있으면 가린다', async () => {
    const { client } = make(() => json({ ok: false, error: `잘못된 값 ${SECRET}` }, 400))
    const err = await client.request('/x').catch((e: unknown) => e as Error)
    expect(err).toBeInstanceOf(CloudError)
    expect((err as Error).message).not.toContain(SECRET)
    expect((err as Error).message).toContain('***')
    expect(client.redact(`a ${SECRET} b ${SECRET}`)).toBe('a *** b ***')
  })

  it('네트워크 실패·시간 초과는 원래 문구 없이 한국어로', async () => {
    const down = make(() => {
      throw new TypeError(`fetch failed for ${SECRET}`)
    })
    const e1 = await down.client.request('/x').catch((e: unknown) => e as CloudError)
    expect(e1.message).toBe('클라우드에 연결하지 못했습니다')
    expect(e1.status).toBe(0)

    const slow = make(() => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError'
      })
    })
    const e2 = await slow.client.request('/x').catch((e: unknown) => e as CloudError)
    expect(e2.message).toBe('클라우드 응답이 없습니다 (시간 초과)')
  })

  it('바이트 응답을 읽다 끊기거나 시간이 다 되면 CloudError(상태 0) 한국어로 — 영문 원본 예외를 내보내지 않는다', async () => {
    const broken = (error: Error): Response =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(error)
          }
        }),
        { status: 200 }
      )
    const timedOut = make(() =>
      broken(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    )
    const e1 = await timedOut.client.requestBytes('/file').catch((e: unknown) => e as CloudError)
    expect(e1).toBeInstanceOf(CloudError)
    expect(e1.status).toBe(0)
    expect(e1.message).toBe('클라우드 응답이 없습니다 (시간 초과)')

    const cut = make(() => broken(new TypeError(`terminated ${SECRET}`)))
    const e2 = await cut.client.requestBytes('/file').catch((e: unknown) => e as CloudError)
    expect(e2).toBeInstanceOf(CloudError)
    expect(e2.status).toBe(0)
    expect(e2.message).toBe('클라우드 응답을 끝까지 받지 못했습니다')
    expect(e2.message).not.toContain(SECRET)
  })

  it('응답이 JSON 이 아니면 읽지 못했다는 오류', async () => {
    const { client } = make(() => new Response('hello', { status: 200 }))
    await expect(client.request('/x')).rejects.toThrow('응답을 읽지 못했습니다')
  })

  it('비밀값이 없으면 요청하지 않는다', async () => {
    const { client, fetchMock } = make(() => json({ ok: true }), { secret: null })
    await expect(client.request('/x')).rejects.toThrow('연결 정보가 없습니다')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('제한 시간을 정할 수 있다', async () => {
    const { client, fetchMock } = make(() => json({ ok: true }))
    await client.request('/x', { timeoutMs: 123 })
    const signal = fetchMock.mock.calls[0][1]?.signal as AbortSignal
    expect(signal.aborted).toBe(false)
  })
})
