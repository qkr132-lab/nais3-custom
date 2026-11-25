/** 모든 탭이 공유하는 틀 — 상단 상태줄과 하단 탭바 */
import { setTab } from '../actions'
import { useServerNow } from '../hooks'
import {
  cloudQuotaView,
  generationRoute,
  multiAccountSummary,
  queueText,
  showsCloudQuota
} from '../lib/format'
import { hasActiveJobs } from '../lib/poll'
import { useStore } from '../lib/store'
import { app, type TabId } from '../stores'
import { Icon, type IconName } from '../ui/icons'
import { QuotaLine } from '../ui/quota-line'

export function StatusBar() {
  const phone = useStore(app, (s) => s.phone)
  const offline = useStore(app, (s) => s.offline)
  const now = useServerNow()
  const online = phone?.pc.online ?? false
  const route = generationRoute(phone, 'auto', now)
  const queue = queueText(phone?.pc.queue)
  const info = phone?.library?.naiInfo
  const acctText = multiAccountSummary(info)
  // 클라우드가 생성하는(하려다 막힌) 상황에서만 무료 사용량을 보인다
  const quota =
    phone && showsCloudQuota(phone, route) ? cloudQuotaView(phone.cloudGen.quota, now) : null
  return (
    <header class="status">
      {offline && (
        <div class="status__offline" role="alert">
          <Icon name="wifiOff" size={16} />
          <span>연결 끊김</span>
          <span class="status__retry">다시 연결하는 중</span>
        </div>
      )}
      <div class="status__row">
        <span class={online ? 'dot dot--on' : 'dot'} aria-hidden="true" />
        <span class="status__pc">{phone ? (online ? 'PC 켜짐' : 'PC 꺼짐') : '상태 확인 중'}</span>
        {info?.turboEnabled && (
          <span class="status__turbo" title="다중 계정 고속 모드 켜짐">
            ⚡ 고속
          </span>
        )}
        {acctText && (
          <button
            type="button"
            class="status__acct"
            onClick={() => setTab('settings')}
            title="계정·게이지 상세 보기"
          >
            {acctText}
          </button>
        )}
        {queue && <span class="status__queue">{queue}</span>}
      </div>
      {phone && (
        <p class={`status__route status__route--${route.kind}`}>
          <Icon name={route.kind === 'cloud' ? 'cloud' : 'monitor'} size={14} />
          <span>{route.text}</span>
        </p>
      )}
      {quota && <QuotaLine view={quota} class="status__quota" />}
    </header>
  )
}

const TABS: readonly { id: TabId; label: string; icon: IconName }[] = [
  { id: 'scenes', label: '씬', icon: 'grid' },
  { id: 'create', label: '생성', icon: 'imagePlus' },
  { id: 'gallery', label: '갤러리', icon: 'image' },
  { id: 'jobs', label: '작업', icon: 'list' },
  { id: 'settings', label: '설정', icon: 'sliders' }
]

export function TabBar() {
  const tab = useStore(app, (s) => s.tab)
  const activeCount = useStore(
    app,
    (s) => s.phone?.jobs.filter((j) => hasActiveJobs([j])).length ?? 0
  )
  return (
    <nav class="tabbar" aria-label="주 메뉴">
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          class={t.id === tab ? 'tab is-on' : 'tab'}
          aria-current={t.id === tab ? 'page' : undefined}
          aria-label={
            t.id === 'jobs' && activeCount > 0 ? `${t.label} (진행 ${activeCount})` : t.label
          }
          onClick={() => setTab(t.id)}
        >
          <span class="tab__icon">
            <Icon name={t.icon} size={22} />
            {t.id === 'jobs' && activeCount > 0 && <span class="tab__count">{activeCount}</span>}
          </span>
          <span class="tab__label">{t.label}</span>
        </button>
      ))}
    </nav>
  )
}
