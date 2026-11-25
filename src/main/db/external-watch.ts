import { getDb } from './index'

/**
 * 바깥 프로그램이 DB를 고쳤는지 지켜본다 (커스텀).
 *
 * SQLite의 data_version은 "다른 연결"이 커밋할 때만 바뀐다. 이 앱이 스스로 쓴 건 세지 않으므로,
 * 값이 바뀌었다면 스크립트·다른 도구가 씬 태그나 씬별 설정을 직접 고친 것이다.
 * 그때 onChange를 불러 화면이 씬 목록·설정을 다시 읽게 한다 — 앱을 껐다 켜지 않아도 바로 반영.
 */
export function watchExternalDbChanges(onChange: () => void, intervalMs = 1500): () => void {
  const db = getDb()
  let last = db.pragma('data_version', { simple: true }) as number
  const timer = setInterval(() => {
    let now: number
    try {
      now = db.pragma('data_version', { simple: true }) as number
    } catch {
      return // 종료 중 DB가 닫혔으면 조용히 넘어간다
    }
    if (now !== last) {
      last = now
      onChange()
    }
  }, intervalMs)
  return () => clearInterval(timer)
}
