/** 생성 막대 — 장수 스테퍼 + [생성] + (접어 둔) 생성 위치 고르기. 씬 시트와 생성 탭이 같이 쓴다 */
import {
  CLOUD_JOB_MAX_COUNT,
  type CloudJobPlace,
  type CloudJobTarget
} from '@shared/cloud-contract'
import { useState } from 'preact/hooks'
import { createJob, errorMessage, toast } from '../actions'
import { useServerNow } from '../hooks'
import {
  createJobToasts,
  exceedsFreePixels,
  formatSize,
  generationRoute,
  quotaExhaustedNotice
} from '../lib/format'
import { useStore } from '../lib/store'
import { app } from '../stores'
import { Icon } from '../ui/icons'
import { Segmented, Spinner, Stepper } from '../ui/primitives'

const PLACE_OPTIONS: readonly { value: CloudJobPlace; label: string }[] = [
  { value: 'auto', label: '자동' },
  { value: 'pc', label: 'PC' },
  { value: 'cloud', label: '클라우드' }
]

export function GenerateBar({
  target,
  beforeStart,
  size
}: {
  target: CloudJobTarget
  /** 생성 전에 할 일 (저장 안 한 편집 저장). false 를 돌려주면 생성하지 않는다 */
  beforeStart?: () => Promise<boolean>
  /** 클라우드 무료 범위 안내용 해상도 */
  size?: { width: number; height: number }
}) {
  const phone = useStore(app, (s) => s.phone)
  const [count, setCount] = useState(1)
  const [place, setPlace] = useState<CloudJobPlace>('auto')
  const [busy, setBusy] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const now = useServerNow()
  const route = generationRoute(phone, place, now)
  const overFree = route.kind === 'cloud' && size && exceedsFreePixels(size.width, size.height)
  // 클라우드가 만들 상황에서 무료 사용량이 소진으로 확인됐으면 버튼 가까이에서도 알린다
  const quotaNotice = quotaExhaustedNotice(phone, route, now)

  async function start(): Promise<void> {
    if (busy || route.blocked) return
    setBusy(true)
    try {
      if (beforeStart && !(await beforeStart())) return
      const { job, notice } = await createJob({ target, count, place })
      for (const t of createJobToasts({
        count,
        job,
        notice,
        pcOnline: phone?.pc.online ?? false
      })) {
        toast(t.text, 'info', t.durationMs)
      }
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="genbar">
      <div class="genbar__head">
        <p class={`genbar__route genbar__route--${route.kind}`}>
          <Icon name={route.kind === 'cloud' ? 'cloud' : 'monitor'} size={14} />
          <span>{route.text}</span>
        </p>
        <button
          type="button"
          class="genbar__toggle"
          aria-expanded={advanced}
          onClick={() => setAdvanced((v) => !v)}
        >
          고급
        </button>
      </div>
      {quotaNotice && (
        <p class={quotaNotice.blocking ? 'genbar__warn genbar__warn--blocked' : 'genbar__warn'}>
          {quotaNotice.text}
        </p>
      )}
      {advanced && (
        <div class="genbar__adv">
          <span class="field__label">생성 위치</span>
          <Segmented value={place} options={PLACE_OPTIONS} onChange={setPlace} label="생성 위치" />
        </div>
      )}
      {overFree && size && (
        <p class="genbar__warn">
          해상도 {formatSize(size.width, size.height)}: 클라우드 무료 범위(1024×1024 이하)를 넘어
          생성되지 않습니다.
        </p>
      )}
      <div class="genbar__row">
        <Stepper
          value={count}
          min={1}
          max={CLOUD_JOB_MAX_COUNT}
          onChange={setCount}
          label="생성 장수"
        />
        <button
          type="button"
          class="btn btn--primary btn--grow"
          disabled={busy || route.blocked}
          onClick={() => void start()}
        >
          {busy ? <Spinner size={18} /> : null}
          생성
        </button>
      </div>
    </div>
  )
}
