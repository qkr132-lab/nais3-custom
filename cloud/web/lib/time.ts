/** 시간 표시 — DOM 없이 쓰는 순수 함수 */

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 「방금」「3분 전」「2일 전」… 일주일이 넘으면 날짜. now 는 서버 시각 보정을 거친 값을 넘긴다 */
export function relativeTime(ts: number | null | undefined, now: number = Date.now()): string {
  if (ts == null || !Number.isFinite(ts)) return '기록 없음'
  const sec = Math.floor((now - ts) / 1000)
  if (sec < 10) return '방금'
  if (sec < 60) return `${sec}초 전`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}분 전`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour}시간 전`
  const day = Math.floor(hour / 24)
  if (day < 7) return `${day}일 전`
  const d = new Date(ts)
  return `${d.getMonth() + 1}월 ${d.getDate()}일`
}

/** 2026.10.23 14:05 (기기 시간대) */
export function formatDateTime(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts)) return '-'
  const d = new Date(ts)
  return `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
