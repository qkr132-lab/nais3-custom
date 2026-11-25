import type { DeviceInfo } from './auth'
import type { HubDeps } from './deps'

/** 경로 하나의 처리기가 받는 것 */
export interface RouteCtx {
  deps: HubDeps
  request: Request
  url: URL
  /** 경로 정규식의 캡처 그룹 (순서대로) */
  params: string[]
  /** 폰 API 에서만 — 인증된 기기 */
  device?: DeviceInfo
}

export interface Route {
  method: string
  pattern: RegExp
  handle: (ctx: RouteCtx) => Promise<Response> | Response
}
