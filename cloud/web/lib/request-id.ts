/**
 * 작업 만들기 요청 id — 응답이 도중에 끊겨도 다시 눌렀을 때 같은 작업이 두 번 생기지 않게 한다.
 * 서버는 같은 id 가 10분 안에 다시 오면 새로 만들지 않고 앞서 만든 작업을 돌려준다.
 *
 * - 작업 버튼을 누를 때마다 새 id 를 쓴다.
 * - 결과를 알 수 없는 실패(네트워크 끊김·시간 초과·서버 오류)로 끝났으면, 같은 내용으로 다시 누를 때 같은 id 를 쓴다.
 * - 성공했거나 서버가 분명히 거절했으면(4xx) 다음 누름은 새 id.
 */
import type { CloudCreateJob } from '@shared/cloud-contract'

/** 무작위 16바이트를 소문자 16진수 32자로 */
export function newRequestId(): string {
  const bytes = new Uint8Array(16)
  try {
    crypto.getRandomValues(bytes)
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** 요청 내용이 같은지 가리는 서명 (requestId 는 뺀다) */
export function jobSignature(body: Omit<CloudCreateJob, 'requestId'>): string {
  const target = body.target.type === 'scene' ? `scene:${body.target.sceneId}` : 'main'
  return `${target}|${body.count}|${body.place}`
}

/** 결과를 알 수 없는 실패인가 (응답이 유실됐을 수 있어 서버에는 작업이 생겼을 수 있다) */
export function isAmbiguousFailure(status: number): boolean {
  return status === 0 || status >= 500
}

export class RequestIdKeeper {
  private last: { signature: string; id: string } | null = null

  constructor(private readonly make: () => string = newRequestId) {}

  /** 이 내용으로 요청할 때 쓸 id. 같은 내용으로 실패한 직후면 그때의 id */
  idFor(body: Omit<CloudCreateJob, 'requestId'>): string {
    const signature = jobSignature(body)
    if (this.last?.signature === signature) return this.last.id
    this.last = { signature, id: this.make() }
    return this.last.id
  }

  /** 요청이 끝났다. 성공이거나 분명한 거절이면 id 를 버려 다음 누름이 새 id 를 쓰게 한다 */
  settle(failureStatus: number | null): void {
    if (failureStatus === null || !isAmbiguousFailure(failureStatus)) this.last = null
  }
}
