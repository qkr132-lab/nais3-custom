/**
 * NAIS3 모바일 클라우드 워커 — /api/* 는 전부 허브(Durable Object)로 넘기고,
 * 그 밖의 경로는 정적 자산(폰 화면)이 처리한다. 인증·저장·라우팅은 허브가 한다.
 */
import { Hub, type Env } from './hub'

export { Hub }

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      return env.HUB.getByName('hub').fetch(request)
    }
    return env.ASSETS.fetch(request)
  }
} satisfies ExportedHandler<Env>
