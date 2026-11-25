/** 클라우드가 확인한 무료 사용량 상태 표시 — 상태줄·설정 탭이 같이 쓴다 */
import type { CloudQuotaView } from '../lib/format'

/** 「남음」「소진」「확인 안 됨」 낱말 하나 (글자색도 상태마다 다르다) */
export function QuotaState({ view }: { view: CloudQuotaView }) {
  return <strong class={`qstate qstate--${view.state}`}>{view.label}</strong>
}

/** 「무료 사용량: 남음 · 3분 전 확인」 한 줄 */
export function QuotaLine({ view, class: extra }: { view: CloudQuotaView; class?: string }) {
  return (
    <p class={extra ? `qline ${extra}` : 'qline'}>
      <span>무료 사용량:</span> <QuotaState view={view} />
      {view.checked && <span class="qline__when"> · {view.checked}</span>}
    </p>
  )
}
