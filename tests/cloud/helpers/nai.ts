// 테스트 전용 — 가짜 NAI 서버. 주입 fetch 로 구독 확인(/user/subscription)과 생성(/ai/generate-image)을 흉내 낸다.
// 진짜 NAI 는 절대 부르지 않는다.
import JSZip from 'jszip'

export interface NaiCall {
  url: string
  path: string
  method: string
  headers: Record<string, string>
  body: string | null
}

type Responder = (call: NaiCall) => Response | Promise<Response>

/** zip 한 장 (안에 가짜 PNG 하나) — NAI 생성 응답과 같은 모양 */
export async function fakeZip(label = 'image'): Promise<Uint8Array> {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...new TextEncoder().encode(label)])
  return new JSZip().file('image_0.png', png).generateAsync({ type: 'uint8array' })
}

export class FakeNai {
  /** 구독 등급 (3 = Opus) */
  tier = 3
  fixed = 1000
  purchased = 0
  /** null 이면 usage 필드를 아예 내려 주지 않는다 */
  usage: unknown = { percent: 80, isNegative: false, timeUntilNextPercent: 3600 }
  /** 생성이 한 번 성공할 때마다 fixed 에서 뺄 Anlas (Anlas 감소 안전망 시험용) */
  spendPerImage = 0
  /** 몇 번째 생성부터 Anlas 를 빼기 시작할지 (1 = 처음부터) */
  spendFromImage = 1
  /** 앞에서부터 하나씩 쓰는 생성 응답. 비면 기본 성공(zip) */
  generateQueue: Responder[] = []
  /** 앞에서부터 하나씩 쓰는 구독 응답. 비면 기본 응답 */
  subscriptionQueue: Responder[] = []
  calls: NaiCall[] = []

  get generateCalls(): NaiCall[] {
    return this.calls.filter((c) => c.path === '/ai/generate-image')
  }
  get subscriptionCalls(): NaiCall[] {
    return this.calls.filter((c) => c.path === '/user/subscription')
  }

  /** 지금 설정(등급·잔액·사용량)대로의 구독 응답 하나 — 응답을 기다리는 사이 다른 일이 일어나게 하는 시험이 마지막에 돌려준다 */
  subscriptionReply(): Response {
    return Response.json({
      tier: this.tier,
      trainingStepsLeft: {
        fixedTrainingStepsLeft: this.fixed,
        purchasedTrainingSteps: this.purchased
      },
      ...(this.usage == null ? {} : { usage: this.usage })
    })
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => (headers[key.toLowerCase()] = value))
    const call: NaiCall = {
      url,
      path: new URL(url).pathname,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers,
      body: typeof init?.body === 'string' ? init.body : null
    }
    this.calls.push(call)
    if (call.path === '/user/subscription') {
      const queued = this.subscriptionQueue.shift()
      if (queued) return queued(call)
      return this.subscriptionReply()
    }
    if (call.path === '/ai/generate-image') {
      const queued = this.generateQueue.shift()
      if (queued) return queued(call)
      if (this.generateCalls.length >= this.spendFromImage) this.fixed -= this.spendPerImage
      return new Response((await fakeZip(`g${this.generateCalls.length}`)) as unknown as BodyInit, {
        headers: { 'content-type': 'application/x-zip-compressed' }
      })
    }
    return new Response('not found', { status: 404 })
  }
}

/** 상태 코드와 본문을 정한 응답 하나 */
export function reply(
  status: number,
  body: string | Uint8Array = '',
  headers: Record<string, string> = {}
): Responder {
  return () => new Response(body as BodyInit, { status, headers })
}

/** 정상 zip 응답 하나 */
export function zipReply(label = 'queued'): Responder {
  return async () =>
    new Response((await fakeZip(label)) as unknown as BodyInit, {
      headers: { 'content-type': 'application/x-zip-compressed' }
    })
}
