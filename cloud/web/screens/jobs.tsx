/** 작업 탭 — 생성 작업 목록과 진행 상황 */
import type { CloudJob } from '@shared/cloud-contract'
import { useState } from 'preact/hooks'
import { cancelJob, errorMessage, toast } from '../actions'
import { useServerNow } from '../hooks'
import {
  isJobActive,
  jobDoneRatio,
  jobFailedRatio,
  jobNote,
  jobStateLabel,
  runnerLabel
} from '../lib/format'
import { useStore } from '../lib/store'
import { relativeTime } from '../lib/time'
import { app } from '../stores'
import { EmptyState, Spinner } from '../ui/primitives'

export function JobsTab() {
  const jobs = useStore(app, (s) => s.phone?.jobs ?? null)
  const pcOnline = useStore(app, (s) => s.phone?.pc.online ?? false)
  const now = useServerNow()
  if (!jobs) return null
  if (jobs.length === 0) {
    return (
      <EmptyState
        title="작업이 없습니다"
        body="씬이나 생성 탭에서 생성을 시작하면 여기에 보입니다."
      />
    )
  }
  return (
    <ul class="jobs">
      {jobs.map((job) => (
        <JobCard key={job.id} job={job} pcOnline={pcOnline} now={now} />
      ))}
    </ul>
  )
}

function JobCard({ job, pcOnline, now }: { job: CloudJob; pcOnline: boolean; now: number }) {
  const [cancelling, setCancelling] = useState(false)
  const active = isJobActive(job)
  const note = jobNote(job, pcOnline)
  const runner = runnerLabel(job)
  const doneRatio = jobDoneRatio(job)
  const failedRatio = jobFailedRatio(job)

  async function cancel(): Promise<void> {
    setCancelling(true)
    try {
      await cancelJob(job.id)
      toast('작업을 취소했습니다')
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setCancelling(false)
    }
  }

  return (
    <li class="job">
      <div class="job__top">
        <span class="job__label">{job.label}</span>
        <span class={`pill pill--${job.state}`}>{jobStateLabel(job)}</span>
      </div>
      <div
        class="bar"
        role="progressbar"
        aria-label={`${job.label} 진행`}
        aria-valuemin={0}
        aria-valuemax={job.count}
        aria-valuenow={job.done}
      >
        <span class="bar__fill" style={{ width: `${doneRatio * 100}%` }} />
        <span class="bar__fail" style={{ width: `${failedRatio * 100}%` }} />
      </div>
      <div class="job__meta">
        <span>
          {job.done}/{job.count}장{job.failed > 0 ? ` · 실패 ${job.failed}` : ''}
        </span>
        {runner && <span>{runner}</span>}
        <span class="job__time">{relativeTime(job.updatedAt, now)}</span>
      </div>
      {note && <p class="job__note">{note}</p>}
      {job.error && <p class="job__error">{job.error}</p>}
      {active && (
        <button
          type="button"
          class="btn btn--danger btn--block"
          aria-label={`${job.label} 작업 취소`}
          disabled={cancelling}
          onClick={() => void cancel()}
        >
          {cancelling ? <Spinner size={18} /> : null}
          취소
        </button>
      )}
    </li>
  )
}
