/** 설정 탭 — 다중 계정·추가 게이지·PC 폴더 동기화·클라우드 생성 상태와 연결 해제 */
import { CLOUD_PROTOCOL, type CloudAccountInfo } from '@shared/cloud-contract'
import type { ComponentChildren } from 'preact'
import { useState } from 'preact/hooks'
import { askConfirm, errorMessage, logout, sendControl, toast } from '../actions'
import { useServerNow } from '../hooks'
import { pcControl } from '../lib/control'
import {
  cloudNotReadyReason,
  cloudQuotaView,
  isQuotaBlocking,
  opusQuotaView,
  queueText,
  quotaView,
  type QuotaView
} from '../lib/format'
import { useStore } from '../lib/store'
import { relativeTime } from '../lib/time'
import { app } from '../stores'
import { Icon } from '../ui/icons'
import { Spinner, Switch } from '../ui/primitives'
import { QuotaState } from '../ui/quota-line'

function Row({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <li class="row">
      <span class="row__title">{label}</span>
      <span class="row__value">{children}</span>
    </li>
  )
}

function QuotaGauge({ q }: { q: QuotaView }) {
  return (
    <div
      class={q.low ? 'gauge is-low' : 'gauge'}
      role="meter"
      aria-label="무료 사용량 남은 비율"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={q.percent}
    >
      <span class="gauge__fill" style={{ width: `${q.basePercent}%` }} />
      {q.extraPercent > 0 && (
        <span
          class="gauge__fill gauge__fill--extra"
          style={{ left: `${q.basePercent}%`, width: `${q.extraPercent}%` }}
        />
      )}
      {q.notches.map((n) => (
        <span key={n} class="gauge__notch" style={{ left: `${n}%` }} />
      ))}
    </div>
  )
}

function AccountCard({
  acct,
  turboEnabled,
  busy,
  onSwitch
}: {
  acct: CloudAccountInfo
  turboEnabled: boolean
  busy: boolean
  onSwitch: (id: string, label: string) => void
}) {
  const q = opusQuotaView(acct.opusUsage)
  return (
    <div class={acct.active ? 'acct-card is-active' : 'acct-card'}>
      <div class="acct-card__top">
        <div class="acct-card__title-wrap">
          <span class={acct.active ? 'dot dot--on' : 'dot'} aria-hidden="true" />
          <span class="acct-card__name">{acct.label}</span>
          {acct.tier && <span class="pill pill--done">{acct.tier}</span>}
          {acct.active && <span class="pill pill--pc">현재 기본</span>}
          {turboEnabled && <span class="pill pill--cloud">⚡ 병렬 참여</span>}
        </div>
        <div class="acct-card__actions">
          {acct.anlas != null && (
            <span class="acct-card__anlas">Anlas {acct.anlas.toLocaleString('ko-KR')}</span>
          )}
          {!acct.active && (
            <button
              type="button"
              class="chip"
              disabled={busy}
              onClick={() => onSwitch(acct.id, acct.label)}
            >
              사용 전환
            </button>
          )}
        </div>
      </div>

      {q ? (
        <>
          <div class="quota__head">
            <span class="muted">
              일반 <b>{q.rawPercent}%</b>
              {q.rawExtra > 0 && (
                <span class="quota__extra-badge">+{q.rawExtra}% 추가 게이지 적용</span>
              )}
            </span>
            <span class={q.low ? 'quota__text is-low' : 'quota__text'}>{q.text}</span>
          </div>
          <QuotaGauge q={q} />
          {q.refill && <p class="muted quota__foot">다음 1% 회복까지 {q.refill}</p>}
        </>
      ) : (
        <p class="muted">게이지 확인 중입니다 («잔액·게이지 새로고침»을 눌러 주세요)</p>
      )}
    </div>
  )
}

export function SettingsTab() {
  const phone = useStore(app, (s) => s.phone)
  const device = useStore(app, (s) => s.device)
  const now = useServerNow()
  const [leaving, setLeaving] = useState(false)
  const [ctrlBusy, setCtrlBusy] = useState(false)
  if (!phone) return null

  const online = phone.pc.online
  const queue = queueText(phone.pc.queue)
  const quota = quotaView(phone.library?.naiInfo)
  const info = phone.library?.naiInfo
  const accounts = info?.accounts ?? []
  const turboEnabled = !!info?.turboEnabled
  const autoSwitchEnabled = !!info?.autoSwitchEnabled
  const cloudQuota = cloudQuotaView(phone.cloudGen.quota, now)
  // 서버가 「가능」이라도 방금 소진으로 확인됐으면 불가로 본다 (생성 막대와 같은 기준)
  const cloudReady = phone.cloudGen.ready && !isQuotaBlocking(phone.cloudGen.quota, now)

  async function runCtrl(fn: () => Promise<boolean>): Promise<void> {
    if (ctrlBusy) return
    setCtrlBusy(true)
    try {
      await fn()
    } finally {
      setCtrlBusy(false)
    }
  }

  async function leave(): Promise<void> {
    const ok = await askConfirm({
      title: '이 폰의 연결을 해제할까요?',
      body: '다시 쓰려면 PC에서 새 연결 코드를 만들어야 합니다.',
      confirmLabel: '연결 해제',
      danger: true
    })
    if (!ok) return
    setLeaving(true)
    try {
      await logout()
    } catch (err) {
      toast(errorMessage(err), 'error')
      setLeaving(false)
    }
  }

  return (
    <div class="stack stack--lg">
      {phone.protocol !== CLOUD_PROTOCOL && (
        <p class="callout callout--warn" role="alert">
          앱과 클라우드의 판이 다릅니다. PC의 NAIS3와 클라우드를 같은 판으로 맞춰 주세요.
        </p>
      )}

      <section class="stack" aria-label="NAI 다중 계정 및 게이지">
        <div class="section-head">
          <h3 class="section-title">NAI 계정 & 추가 게이지 ({accounts.length || 1}개 연결)</h3>
          <button
            type="button"
            class="chip"
            disabled={!online || ctrlBusy}
            onClick={() =>
              void runCtrl(() =>
                sendControl(
                  pcControl.refreshAccounts(),
                  'PC에 모든 계정 잔액·추가 게이지 새로고침을 요청했습니다'
                )
              )
            }
          >
            <Icon name="refresh" size={14} />
            잔액·게이지 새로고침
          </button>
        </div>

        {accounts.length > 0 ? (
          <div class="stack">
            {accounts.map((acct) => (
              <AccountCard
                key={acct.id}
                acct={acct}
                turboEnabled={turboEnabled}
                busy={!online || ctrlBusy}
                onSwitch={(id, label) =>
                  void runCtrl(() =>
                    sendControl(
                      pcControl.setActiveAccount(id),
                      `${label} 계정으로 전환을 요청했습니다`
                    )
                  )
                }
              />
            ))}
          </div>
        ) : quota ? (
          <div class="quota">
            <div class="quota__head">
              <span class="row__title">
                남은 비율
                {quota.rawExtra > 0 && (
                  <span class="quota__extra-badge">+{quota.rawExtra}% 추가 게이지</span>
                )}
              </span>
              <span class={quota.low ? 'quota__text is-low' : 'quota__text'}>{quota.text}</span>
            </div>
            <QuotaGauge q={quota} />
            <p class="muted quota__foot">
              {quota.refill ? `다음 1% 회복까지 ${quota.refill} · ` : ''}
              {info ? `PC 기준 · ${relativeTime(info.updatedAt, now)} 확인` : ''}
            </p>
          </div>
        ) : (
          <p class="muted">남은 비율은 PC가 켜지면 표시됩니다.</p>
        )}

        <ul class="rows">
          <Row label="⚡ 고속 모드 (다중 계정 동시 생성)">
            <Switch
              checked={turboEnabled}
              label="고속 모드"
              disabled={!online || ctrlBusy || accounts.length < 2}
              onChange={(next) =>
                void runCtrl(() =>
                  sendControl(
                    pcControl.setTurbo(next),
                    next ? '⚡ 고속 모드를 켰습니다' : '고속 모드를 껐습니다'
                  )
                )
              }
            />
          </Row>
          <Row label="자동 계정 전환 (소진 시 다음 계정)">
            <Switch
              checked={autoSwitchEnabled}
              label="자동 계정 전환"
              disabled={!online || ctrlBusy || accounts.length < 2}
              onChange={(next) =>
                void runCtrl(() =>
                  sendControl(
                    pcControl.setAutoSwitch(next),
                    next ? '자동 계정 전환을 켰습니다' : '자동 계정 전환을 껐습니다'
                  )
                )
              }
            />
          </Row>
        </ul>
        {info && (
          <p class="muted">
            마지막 게이지 동기화: {relativeTime(info.updatedAt, now)} 확인
          </p>
        )}
      </section>

      <section class="stack" aria-label="PC 그림 및 폴더 동기화">
        <h3 class="section-title">PC 그림 & 폴더 연동</h3>
        <div class="field-row">
          <button
            type="button"
            class="btn btn--grow"
            disabled={!online || ctrlBusy}
            onClick={() =>
              void runCtrl(() =>
                sendControl(
                  pcControl.uploadRecentImages(),
                  'PC에서 생성된 최근 그림 동기화를 요청했습니다'
                )
              )
            }
          >
            <Icon name="refresh" size={16} />
            PC 생성 그림 동기화
          </button>
          <button
            type="button"
            class="btn btn--grow"
            disabled={!online || ctrlBusy}
            onClick={() =>
              void runCtrl(() =>
                sendControl(pcControl.refreshDriveIndex(), 'PC 폴더 목록을 새로고침합니다')
              )
            }
          >
            <Icon name="folder" size={16} />
            폴더 목록 갱신
          </button>
        </div>
      </section>

      <section class="stack" aria-label="PC">
        <h3 class="section-title">PC 상태</h3>
        <ul class="rows">
          <Row label="상태">
            <span class={online ? 'dot dot--on' : 'dot'} aria-hidden="true" />
            {online ? '켜짐' : '꺼짐'}
          </Row>
          <Row label="마지막 접속">{relativeTime(phone.pc.lastSeen, now)}</Row>
          <Row label="생성 큐">{queue ?? '대기 없음'}</Row>
        </ul>
      </section>

      <section class="stack" aria-label="클라우드 생성">
        <h3 class="section-title">클라우드 생성</h3>
        <ul class="rows">
          <Row label="설정">{phone.cloudGen.enabled ? '켜짐' : '꺼짐'}</Row>
          <Row label="NAI 토큰">{phone.cloudGen.hasNaiToken ? '보관 중' : '없음'}</Row>
          <Row label="지금 생성">{cloudReady ? '가능 (무료 범위)' : '불가'}</Row>
          {!cloudReady && <Row label="이유">{cloudNotReadyReason(phone)}</Row>}
          <Row label="무료 사용량">
            <QuotaState view={cloudQuota} />
            {cloudQuota.checked && <span class="row__sub">{cloudQuota.checked}</span>}
          </Row>
          {info?.anlas != null && <Row label="Anlas">{info.anlas.toLocaleString('ko-KR')}</Row>}
        </ul>
      </section>

      <section class="stack" aria-label="기기">
        <h3 class="section-title">이 기기</h3>
        <ul class="rows">
          <Row label="기기 이름">{device?.name ?? '-'}</Row>
        </ul>
      </section>

      <button
        type="button"
        class="btn btn--danger btn--block"
        disabled={leaving}
        onClick={() => void leave()}
      >
        {leaving ? <Spinner size={18} /> : <Icon name="logout" size={18} />}
        연결 해제
      </button>
    </div>
  )
}
