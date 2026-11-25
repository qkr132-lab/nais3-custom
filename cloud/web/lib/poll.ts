/**
 * 폴링 스케줄 — 화면이 보일 때만 돈다.
 * 한 번의 실행이 끝난 뒤에 다음 실행을 잡아서 겹치지 않고, 실패하면 간격을 점점 늘린다.
 * 실행 하나가 끝나지 않고 멈춰도(요청이 응답 없이 걸림) 일정 시간이 지나면 버리고 새로 돈다.
 */
import type { CloudJob } from '@shared/cloud-contract'

export interface PollerOptions {
  /** 한 번의 갱신. false 를 돌려주거나 던지면 실패로 센다 */
  run: () => Promise<boolean | void>
  intervalMs: number
  /** 지금 화면이 보이는가 (document.visibilityState === 'visible') */
  isVisible: () => boolean
  /** 실패가 이어질 때 간격의 상한 (기본 20초) */
  maxBackoffMs?: number
  /** 한 번의 실행이 이 시간을 넘기면 멈춘 것으로 보고 버린다 (기본 30초) */
  staleAfterMs?: number
}

export class Poller {
  private timer: ReturnType<typeof setTimeout> | null = null
  private started = false
  private inFlight = false
  private inFlightSince = 0
  /** 실행마다 올라간다 — 버려진 실행의 늦은 결과가 지금 상태를 건드리지 않게 한다 */
  private generation = 0
  private failures = 0
  private interval: number

  constructor(private readonly opts: PollerOptions) {
    this.interval = opts.intervalMs
  }

  /** 연속 실패 횟수 */
  get failureCount(): number {
    return this.failures
  }

  get isStarted(): boolean {
    return this.started
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.schedule(0)
  }

  stop(): void {
    this.started = false
    this.clear()
  }

  /** 간격을 바꾼다. 다음 예약부터 적용 */
  setIntervalMs(ms: number): void {
    this.interval = ms
  }

  /** 지금 바로 한 번 (보이는 동안만) */
  trigger(): void {
    if (this.started && this.opts.isVisible()) this.schedule(0)
  }

  /** visibilitychange 때 부른다. 보이게 되면 바로 갱신, 가려지면 예약을 끊는다 */
  notifyVisibility(): void {
    if (!this.started) return
    if (this.opts.isVisible()) this.schedule(0)
    else this.clear()
  }

  private clear(): void {
    if (this.timer != null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private schedule(delay: number): void {
    this.clear()
    if (!this.started || !this.opts.isVisible()) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick()
    }, delay)
  }

  private nextDelay(): number {
    if (this.failures === 0) return this.interval
    const cap = this.opts.maxBackoffMs ?? 20_000
    return Math.min(cap, this.interval * 2 ** Math.min(this.failures, 6))
  }

  private async tick(): Promise<void> {
    if (!this.started) return
    if (this.inFlight) {
      const stale = this.opts.staleAfterMs ?? 30_000
      if (Date.now() - this.inFlightSince < stale) {
        this.schedule(this.interval) // 아직 도는 중 — 끝나면 어차피 다음 예약을 잡는다
        return
      }
      this.failures += 1 // 멈춘 실행은 버리고 실패로 센다
    }
    const mine = ++this.generation
    this.inFlight = true
    this.inFlightSince = Date.now()
    let failed = false
    try {
      failed = (await this.opts.run()) === false
    } catch {
      failed = true
    }
    if (mine !== this.generation) return // 그 사이 새 실행이 이어받았다
    this.inFlight = false
    this.failures = failed ? this.failures + 1 : 0
    if (this.started) this.schedule(this.nextDelay())
  }
}

/** 아직 끝나지 않은 작업이 있는가 */
export function hasActiveJobs(jobs: readonly CloudJob[] | null | undefined): boolean {
  return !!jobs?.some((j) => j.state === 'queued' || j.state === 'pc' || j.state === 'cloud')
}

/** 작업 목록이 바뀌었는지 비교하는 지문 (id·상태·진행) */
export function jobsSignature(jobs: readonly CloudJob[]): string {
  return jobs
    .map((j) => `${j.id}:${j.state}:${j.done}:${j.failed}:${j.runner ?? '-'}`)
    .sort()
    .join('|')
}
