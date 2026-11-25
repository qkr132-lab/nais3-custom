/**
 * 요청 라우터 — 표준 Request → Response. Hub(DO)와 테스트가 똑같이 부른다.
 *
 * 인증은 경로 종류로 먼저 정한다: /api/pc/* = PC 비밀값, /api/pair = 인증 없음(페어링 코드),
 * 그 밖의 /api/* = 기기 토큰. 인증을 통과하기 전에는 경로가 있는지 없는지도 알려 주지 않는다.
 * 어떤 응답에도 NAI 토큰이 들어가지 않도록, 내보내기 전에 본문을 한 번 더 검사한다.
 */
import { requireDevice, requirePc, type DeviceInfo } from './auth'
import type { HubDeps } from './deps'
import type { Route } from './route'
import { pcRoutes } from './routes-pc'
import { pairRoute, phoneRoutes } from './routes-phone'
import { kvGet } from './store'
import { errorText, fail, HttpError, scrub, settleBody } from './util'

const GENERIC_ERROR = '서버 오류가 발생했습니다. 잠시 뒤에 다시 시도해 주세요'

export async function handleRequest(deps: HubDeps, request: Request): Promise<Response> {
  let response: Response
  try {
    response = await dispatch(deps, request)
  } catch (error) {
    if (error instanceof HttpError) {
      response = fail(error.status, error.message)
    } else {
      // 원인은 로그에만 (토큰이 섞여 있을 수 있어 가린다) — 응답에는 일반 문구만
      console.error('[nais3-cloud] 요청 처리 실패', scrub(errorText(error), safeToken(deps)))
      response = fail(500, GENERIC_ERROR)
    }
  }
  // 라우트가 읽지 않고 돌려보낸 본문(인증 실패·검사 실패 등)을 비운다 — 응답 뒤 런타임의 본문 읽기 오류를 막는다
  await settleBody(request)
  return guardSecrets(deps, response)
}

function safeToken(deps: HubDeps): string | null {
  try {
    return kvGet(deps.sql, 'secret:nai')
  } catch {
    return null
  }
}

async function dispatch(deps: HubDeps, request: Request): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  const method = request.method.toUpperCase()
  if (path !== '/api' && !path.startsWith('/api/'))
    throw new HttpError(404, '찾을 수 없는 주소입니다')

  let table: Route[]
  let device: DeviceInfo | undefined
  if (path.startsWith('/api/pc/')) {
    await requirePc(deps, request)
    table = pcRoutes
  } else if (path === '/api/pair') {
    table = [{ method: 'POST', pattern: /^\/api\/pair$/, handle: pairRoute }]
  } else {
    device = await requireDevice(deps, request)
    table = phoneRoutes
  }

  let pathMatched = false
  for (const route of table) {
    const match = route.pattern.exec(path)
    if (!match) continue
    pathMatched = true
    if (route.method !== method) continue
    return route.handle({ deps, request, url, params: match.slice(1), device })
  }
  throw pathMatched
    ? new HttpError(405, '허용되지 않는 요청 방식입니다')
    : new HttpError(404, '찾을 수 없는 주소입니다')
}

/** 글자 응답에 NAI 토큰이 들어 있으면 내보내지 않는다 (그림·zip 같은 이진 응답은 검사 대상이 아니다) */
async function guardSecrets(deps: HubDeps, response: Response): Promise<Response> {
  const type = (response.headers.get('content-type') ?? '').toLowerCase()
  if (!/json|text|xml|svg/.test(type)) return response
  const token = safeToken(deps)
  if (!token || token.length < 8) return response
  const body = await response.text()
  if (body.includes(token)) {
    console.error('[nais3-cloud] 응답에 비밀값이 섞여 막았습니다')
    return fail(500, GENERIC_ERROR)
  }
  return new Response(body, { status: response.status, headers: response.headers })
}
