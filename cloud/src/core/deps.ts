/**
 * 허브 핵심의 의존성 주입 인터페이스.
 *
 * 핵심 코드(cloud/src/core/**)는 Cloudflare 전용 API 를 직접 부르지 않고 이 모양만 안다.
 * 실제 실행에서는 Hub(Durable Object)가 ctx.storage.sql·R2·fetch 를 넘기고,
 * 테스트에서는 node:sqlite 어댑터·Map 모의·주입 fetch 를 넘긴다.
 */

export type SqlValue = string | number | null | ArrayBuffer

/** DO ctx.storage.sql.exec 가 돌려주는 커서와 같은 모양 (쓰는 것만) */
export interface SqlCursorLike<T = Record<string, SqlValue>> {
  toArray(): T[]
  one(): T
  readonly rowsWritten: number
}

/** DO ctx.storage.sql 과 같은 모양. 바인딩에 undefined 를 넣지 않는다 (null 로) */
export interface SqlLike {
  exec<T extends Record<string, SqlValue> = Record<string, SqlValue>>(
    query: string,
    ...bindings: unknown[]
  ): SqlCursorLike<T>
}

/** R2 객체에서 쓰는 부분 */
export interface BucketObjectLike {
  readonly size: number
  readonly body: ReadableStream<Uint8Array>
  arrayBuffer(): Promise<ArrayBuffer>
  text(): Promise<string>
}

/** R2 버킷에서 쓰는 부분 */
export interface BucketLike {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string,
    options?: { httpMetadata?: { contentType?: string } }
  ): Promise<unknown>
  get(key: string): Promise<BucketObjectLike | null>
  delete(keys: string | string[]): Promise<void>
}

export interface HubEnv {
  /** PC 앱이 x-nais-pc 헤더로 보내는 비밀값 */
  PC_SECRET: string
  /** NAI 서버 주소 (기본 https://image.novelai.net, 로컬 모의 서버로 바꿀 수 있다) */
  NAI_HOST: string
}

export interface HubDeps {
  sql: SqlLike
  bucket: BucketLike
  now(): number
  /** 0 이상 1 미만 — 시드·조각 선택에 쓴다 (보안용 무작위는 crypto 를 쓴다) */
  random(): number
  fetch: typeof fetch
  env: HubEnv
  /** DO 알람 예약 (하나만 걸린다 — 직접 부르지 말고 ensureAlarm 을 쓴다) */
  setAlarm(at: number): Promise<void> | void
  /** 요청 Origin (없으면 요청 URL 에서 읽는다) */
  origin?: string
}
