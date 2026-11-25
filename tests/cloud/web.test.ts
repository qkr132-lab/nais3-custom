/**
 * 폰 화면의 DOM 이 필요 없는 로직 시험 — cloud/web/lib/
 * (폴링 스케줄, 그림 캐시, zip 해제 래퍼, 상대 시간, 표시 문구·검증, API 오류·시간 제한, 갤러리 합치기,
 *  썸네일 인코딩 선택, 작업 요청 id)
 */
// 테스트는 앱 루트에서 돌아서 cloud/ 의 의존성을 경로로 가져온다
import { zipSync } from '../../cloud/node_modules/fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CloudCreateJobResponse,
  CloudImageItem,
  CloudJob,
  CloudPhoneState,
  CloudQuota
} from '@shared/cloud-contract'
import { ApiError, createApi, type Api } from '../../cloud/web/lib/api'
import {
  NOTICE_TOAST_MS,
  PAIR_CODE_LENGTH,
  QUOTA_FRESH_MS,
  clampCount,
  cloudNotReadyReason,
  cloudQuotaView,
  containsHangul,
  createJobToasts,
  deleteConfirmBody,
  exceedsFreePixels,
  generationRoute,
  isQuotaBlocking,
  jobDoneRatio,
  jobFailedRatio,
  jobNote,
  jobStateLabel,
  normalizePairCode,
  pairCodeFromHash,
  queueText,
  quotaExhaustedNotice,
  quotaView,
  showsCloudQuota,
  validateSceneName,
  validateSize
} from '../../cloud/web/lib/format'
import {
  appendUnique,
  comesAfter,
  loadMoreBackoffMs,
  mergeHead,
  resolveViewerIndex
} from '../../cloud/web/lib/gallery'
import { CancelledError, ImageCache, createLimiter } from '../../cloud/web/lib/image-cache'
import { Poller, hasActiveJobs, jobsSignature } from '../../cloud/web/lib/poll'
import { RequestIdKeeper, isAmbiguousFailure, newRequestId } from '../../cloud/web/lib/request-id'
import { createStore } from '../../cloud/web/lib/store'
import { encodeThumb } from '../../cloud/web/lib/thumb'
import { formatDateTime, relativeTime } from '../../cloud/web/lib/time'
import { extractFirstPng, isZipBytes } from '../../cloud/web/lib/zip'

// ── 도우미 ──────────────────────────────────────────────────────────

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

function job(patch: Partial<CloudJob> = {}): CloudJob {
  return {
    id: 'j1',
    target: { type: 'main' },
    label: '메인 생성',
    count: 4,
    done: 0,
    failed: 0,
    state: 'queued',
    place: 'auto',
    runner: 'pc',
    error: null,
    createdAt: 0,
    updatedAt: 0,
    ...patch
  }
}

function phone(patch: {
  online?: boolean
  ready?: boolean
  reason?: string | null
  enabled?: boolean
  hasNaiToken?: boolean
  quota?: CloudQuota | null
}): CloudPhoneState {
  return {
    protocol: 1,
    serverTime: 0,
    pc: { online: patch.online ?? false, lastSeen: null, queue: null },
    library: null,
    cloudGen: {
      enabled: patch.enabled ?? true,
      hasNaiToken: patch.hasNaiToken ?? true,
      ready: patch.ready ?? false,
      reason: patch.reason ?? null,
      quota: patch.quota ?? null
    },
    jobs: []
  }
}

function image(id: string, createdAt: number): CloudImageItem {
  return {
    id,
    source: 'pc',
    sceneId: null,
    presetId: null,
    jobId: null,
    seed: null,
    width: 832,
    height: 1216,
    createdAt,
    hasThumb: true,
    format: 'webp',
    pcPending: false
  }
}

// ── 상대 시간 ───────────────────────────────────────────────────────

describe('time', () => {
  const now = 1_000_000_000_000

  it('상대 시간 경계', () => {
    expect(relativeTime(now - 3_000, now)).toBe('방금')
    expect(relativeTime(now - 9_999, now)).toBe('방금')
    expect(relativeTime(now - 10_000, now)).toBe('10초 전')
    expect(relativeTime(now - 59_000, now)).toBe('59초 전')
    expect(relativeTime(now - 60_000, now)).toBe('1분 전')
    expect(relativeTime(now - 59 * 60_000, now)).toBe('59분 전')
    expect(relativeTime(now - 60 * 60_000, now)).toBe('1시간 전')
    expect(relativeTime(now - 23 * 3_600_000, now)).toBe('23시간 전')
    expect(relativeTime(now - 24 * 3_600_000, now)).toBe('1일 전')
    expect(relativeTime(now - 6 * 86_400_000, now)).toBe('6일 전')
  })

  it('일주일이 넘으면 날짜, 값이 없으면 안내', () => {
    const old = new Date(2026, 8, 3, 12, 0).getTime()
    expect(relativeTime(old, new Date(2026, 9, 23).getTime())).toBe('9월 3일')
    expect(relativeTime(null, now)).toBe('기록 없음')
    expect(relativeTime(undefined, now)).toBe('기록 없음')
  })

  it('기기 시계가 서버보다 빨라 미래가 되어도 「방금」', () => {
    expect(relativeTime(now + 5_000, now)).toBe('방금')
  })

  it('날짜·시각 표시는 시간대와 무관하게 로컬 값 그대로', () => {
    expect(formatDateTime(new Date(2026, 9, 23, 14, 5).getTime())).toBe('2026.10.23 14:05')
    expect(formatDateTime(new Date(2026, 0, 2, 3, 4).getTime())).toBe('2026.01.02 03:04')
    expect(formatDateTime(null)).toBe('-')
  })
})

// ── 폴링 스케줄 ─────────────────────────────────────────────────────

describe('Poller', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function make(
    opts: {
      visible?: { value: boolean }
      interval?: number
      run?: () => Promise<boolean | void>
    } = {}
  ) {
    const visible = opts.visible ?? { value: true }
    const run = vi.fn(opts.run ?? (async () => true))
    const poller = new Poller({
      run,
      intervalMs: opts.interval ?? 4000,
      isVisible: () => visible.value
    })
    return { poller, run, visible }
  }

  it('시작하면 바로 한 번 돌고, 끝난 뒤 간격마다 다시 돈다', async () => {
    const { poller, run } = make()
    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3_999)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(run).toHaveBeenCalledTimes(3)
    poller.stop()
  })

  it('한 번이 오래 걸려도 겹치지 않고, 끝난 시점부터 간격을 잰다', async () => {
    let release: () => void = () => {}
    const { poller, run } = make({
      run: () =>
        new Promise<boolean>((resolve) => {
          release = () => resolve(true)
        })
    })
    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10_000) // 아직 안 끝남
    expect(run).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(3_999)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(2)
    poller.stop()
  })

  it('화면이 가려지면 멈추고, 다시 보이면 바로 돈다', async () => {
    const visible = { value: true }
    const { poller, run } = make({ visible })
    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)

    visible.value = false
    poller.notifyVisibility()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(1)

    visible.value = true
    poller.notifyVisibility()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(2)
    poller.stop()
  })

  it('실행 중에 가려지면 끝난 뒤 다음 예약을 잡지 않는다', async () => {
    let release: () => void = () => {}
    const visible = { value: true }
    const { poller, run } = make({
      visible,
      run: () =>
        new Promise<boolean>((resolve) => {
          release = () => resolve(true)
        })
    })
    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    visible.value = false
    poller.notifyVisibility()
    release()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(run).toHaveBeenCalledTimes(1)
    poller.stop()
  })

  it('실패가 이어지면 간격이 늘고(상한 20초), 성공하면 원래대로', async () => {
    let ok = false
    const { poller, run } = make({ interval: 4000, run: async () => ok })
    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)
    expect(poller.failureCount).toBe(1)

    // 1번 실패 → 8초 뒤
    await vi.advanceTimersByTimeAsync(7_999)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(2)
    // 2번 실패 → 16초 뒤
    await vi.advanceTimersByTimeAsync(15_999)
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(3)
    // 3번 실패 → 상한 20초
    await vi.advanceTimersByTimeAsync(19_999)
    expect(run).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(4)

    ok = true
    await vi.advanceTimersByTimeAsync(20_000)
    expect(run).toHaveBeenCalledTimes(5)
    expect(poller.failureCount).toBe(0)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(run).toHaveBeenCalledTimes(6)
    poller.stop()
  })

  it('던져도 멈추지 않고 실패로 센다', async () => {
    const { poller, run } = make({
      run: async () => {
        throw new Error('끊김')
      }
    })
    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(poller.failureCount).toBe(1)
    await vi.advanceTimersByTimeAsync(8_000)
    expect(run).toHaveBeenCalledTimes(2)
    poller.stop()
  })

  it('stop 하면 더 돌지 않고, trigger 는 보이는 동안에만 바로 돈다', async () => {
    const visible = { value: true }
    const { poller, run } = make({ visible })
    poller.trigger() // 시작 전에는 무시
    await vi.advanceTimersByTimeAsync(0)
    expect(run).not.toHaveBeenCalled()

    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    poller.trigger()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(2)

    poller.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(2)
    expect(poller.isStarted).toBe(false)
  })

  it('간격을 바꾸면 다음 예약부터 적용', async () => {
    const { poller, run } = make({ interval: 4000 })
    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    poller.setIntervalMs(8000)
    await vi.advanceTimersByTimeAsync(4_000) // 이미 잡힌 4초 예약
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(7_999)
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(3)
    poller.stop()
  })

  it('응답 없이 멈춘 실행은 30초 뒤 버리고, 보이게 될 때 새로 돈다', async () => {
    let calls = 0
    const { poller, run } = make({
      run: () => (++calls === 1 ? new Promise<boolean>(() => {}) : Promise.resolve(true))
    })
    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)

    // 30초가 되기 전에는 겹쳐 돌지 않는다 (다시 보이게 돼도 기다린다)
    await vi.advanceTimersByTimeAsync(29_000)
    poller.notifyVisibility()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)

    // 30초가 지나 멈춘 것으로 보이면 버리고 바로 새로 돈다
    await vi.advanceTimersByTimeAsync(1_000)
    poller.notifyVisibility()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(2)
    expect(poller.failureCount).toBe(0)

    // 이후에는 평소 간격대로 이어진다 (영구 정지하지 않음)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(run).toHaveBeenCalledTimes(3)
    poller.stop()
  })

  it('버려진 실행이 늦게 끝나도 지금 상태를 건드리지 않는다', async () => {
    const releases: Array<(ok: boolean) => void> = []
    let calls = 0
    const { poller, run } = make({
      run: () =>
        ++calls === 1
          ? new Promise<boolean>((resolve) => releases.push(resolve))
          : Promise.resolve(true)
    })
    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(30_000)
    poller.trigger()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(2)
    expect(poller.failureCount).toBe(0)

    releases[0](false) // 버려진 첫 실행이 뒤늦게 실패로 끝남
    await vi.advanceTimersByTimeAsync(0)
    expect(poller.failureCount).toBe(0)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(run).toHaveBeenCalledTimes(3) // 간격도 흐트러지지 않는다
    poller.stop()
  })

  it('실행 중에 trigger 가 와도 겹치지 않고, 끝난 뒤 정상 간격으로 이어진다', async () => {
    let release: () => void = () => {}
    let calls = 0
    const { poller, run } = make({
      run: () =>
        ++calls === 1
          ? new Promise<boolean>((resolve) => {
              release = () => resolve(true)
            })
          : Promise.resolve(true)
    })
    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    poller.trigger()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(run).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(run).toHaveBeenCalledTimes(2)
    poller.stop()
  })
})

describe('작업 목록 도우미', () => {
  it('진행 중 작업이 있는지', () => {
    expect(hasActiveJobs([job({ state: 'done' }), job({ state: 'failed' })])).toBe(false)
    expect(hasActiveJobs([job({ state: 'done' }), job({ state: 'cloud' })])).toBe(true)
    expect(hasActiveJobs([job({ state: 'queued' })])).toBe(true)
    expect(hasActiveJobs([job({ state: 'pc' })])).toBe(true)
    expect(hasActiveJobs([job({ state: 'cancelled' })])).toBe(false)
    expect(hasActiveJobs(null)).toBe(false)
    expect(hasActiveJobs([])).toBe(false)
  })

  it('지문은 진행·상태가 바뀔 때만 달라지고 순서와 무관', () => {
    const a = job({ id: 'a', done: 1 })
    const b = job({ id: 'b', state: 'cloud', runner: 'cloud' })
    expect(jobsSignature([a, b])).toBe(jobsSignature([b, a]))
    expect(jobsSignature([a, b])).not.toBe(jobsSignature([{ ...a, done: 2 }, b]))
    expect(jobsSignature([a, b])).not.toBe(jobsSignature([a, { ...b, state: 'done' }]))
    // 갱신 시각만 바뀌면 같다
    expect(jobsSignature([a])).toBe(jobsSignature([{ ...a, updatedAt: 999 }]))
  })
})

// ── 그림 캐시 ───────────────────────────────────────────────────────

describe('ImageCache', () => {
  function makeCache(
    opts: { maxIdleBytes?: number; maxIdleCount?: number; concurrency?: number } = {}
  ) {
    let seq = 0
    const created: string[] = []
    const revoked: string[] = []
    const cache = new ImageCache({
      ...opts,
      createUrl: () => {
        const url = `blob:${++seq}`
        created.push(url)
        return url
      },
      revokeUrl: (url) => {
        revoked.push(url)
      }
    })
    return { cache, created, revoked }
  }
  const blobOf = (n: number): Blob => new Blob([new Uint8Array(n)])

  it('같은 키를 동시에 요청하면 한 번만 가져온다', async () => {
    const { cache, created } = makeCache()
    const load = vi.fn(async () => blobOf(10))
    const [a, b] = await Promise.all([cache.acquire('k', load), cache.acquire('k', load)])
    expect(a).toBe(b)
    expect(load).toHaveBeenCalledTimes(1)
    expect(created).toEqual(['blob:1'])
  })

  it('참조가 0 이 돼도 한도 안이면 URL 을 유지하고, 다시 요청하면 다시 받지 않는다', async () => {
    const { cache, revoked } = makeCache()
    const load = vi.fn(async () => blobOf(10))
    const url = await cache.acquire('k', load)
    cache.release('k')
    expect(revoked).toEqual([])
    expect(await cache.acquire('k', load)).toBe(url)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('참조가 남아 있는 동안에는 지우지 않는다', async () => {
    const { cache, revoked } = makeCache({ maxIdleCount: 0 })
    await cache.acquire('k', async () => blobOf(10))
    await cache.acquire('k', async () => blobOf(10)) // 참조 2
    cache.release('k') // 1 남음
    expect(revoked).toEqual([])
    cache.release('k') // 0 → 한도 0 이라 바로 정리
    expect(revoked).toEqual(['blob:1'])
  })

  it('놀고 있는 개수 한도를 넘으면 오래된 것부터 revoke', async () => {
    const { cache, revoked } = makeCache({ maxIdleCount: 2 })
    for (const k of ['a', 'b', 'c']) {
      await cache.acquire(k, async () => blobOf(10))
      cache.release(k)
    }
    expect(revoked).toEqual(['blob:1']) // a
    expect(cache.stats().idle).toBe(2)
  })

  it('놀고 있는 크기 한도를 넘으면 오래된 것부터 revoke', async () => {
    const { cache, revoked } = makeCache({ maxIdleBytes: 100 })
    await cache.acquire('a', async () => blobOf(60))
    cache.release('a')
    await cache.acquire('b', async () => blobOf(60))
    cache.release('b') // 합 120 > 100 → a 정리
    expect(revoked).toEqual(['blob:1'])
    expect(cache.stats().idleBytes).toBe(60)
  })

  it('다시 쓰인 항목은 가장 최근으로 밀려 늦게 지워진다', async () => {
    const { cache, revoked } = makeCache({ maxIdleCount: 2 })
    for (const k of ['a', 'b']) {
      await cache.acquire(k, async () => blobOf(10))
      cache.release(k)
    }
    await cache.acquire('a', async () => blobOf(10)) // a 를 다시 씀
    cache.release('a')
    await cache.acquire('c', async () => blobOf(10))
    cache.release('c') // 가장 오래된 것은 b
    expect(revoked).toEqual(['blob:2'])
  })

  it('시작 전에 모두 놓은 요청은 가져오지 않고 취소된다', async () => {
    const { cache } = makeCache({ concurrency: 1 })
    let release: () => void = () => {}
    const slow = cache.acquire(
      'slow',
      () =>
        new Promise<Blob>((resolve) => {
          release = () => resolve(blobOf(10))
        })
    )
    const load = vi.fn(async () => blobOf(10))
    const queued = cache.acquire('queued', load)
    const rejected = expect(queued).rejects.toBeInstanceOf(CancelledError)
    cache.release('queued') // 아직 대기열에서 시작 전
    release()
    await slow
    await rejected
    expect(load).not.toHaveBeenCalled()
    // 취소된 키는 다시 요청하면 새로 가져온다
    await cache.acquire('queued', load)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('가져오는 중에 모두 놓으면 끝난 뒤 놀고 있는 목록으로 간다', async () => {
    const { cache, revoked } = makeCache({ maxIdleCount: 0 })
    let release: () => void = () => {}
    const p = cache.acquire(
      'k',
      () =>
        new Promise<Blob>((resolve) => {
          release = () => resolve(blobOf(10))
        })
    )
    await flush()
    cache.release('k')
    release()
    await p
    expect(revoked).toEqual(['blob:1']) // 한도 0 이라 바로 정리
  })

  it('실패하면 항목이 남지 않아 다시 시도할 수 있다', async () => {
    const { cache } = makeCache()
    await expect(
      cache.acquire('k', async () => {
        throw new Error('404')
      })
    ).rejects.toThrow('404')
    expect(cache.stats().entries).toBe(0)
    await expect(cache.acquire('k', async () => blobOf(5))).resolves.toMatch(/^blob:/)
  })

  it('peekBlob 은 가져온 blob 을 돌려준다', async () => {
    const { cache } = makeCache()
    const blob = blobOf(7)
    expect(cache.peekBlob('k')).toBeNull()
    await cache.acquire('k', async () => blob)
    expect(cache.peekBlob('k')).toBe(blob)
  })

  it('clear 는 전부 revoke', async () => {
    const { cache, revoked } = makeCache()
    await cache.acquire('a', async () => blobOf(1))
    await cache.acquire('b', async () => blobOf(1))
    cache.release('b')
    cache.clear()
    expect(revoked.sort()).toEqual(['blob:1', 'blob:2'])
    expect(cache.stats().entries).toBe(0)
  })
})

describe('createLimiter', () => {
  it('동시에 max 개까지만 실행하고 순서를 지킨다', async () => {
    const limit = createLimiter(2)
    const releases: Array<() => void> = []
    const started: number[] = []
    const run = (n: number) =>
      limit(
        () =>
          new Promise<number>((resolve) => {
            started.push(n)
            releases.push(() => resolve(n))
          })
      )
    const all = [run(1), run(2), run(3), run(4)]
    await flush()
    expect(started).toEqual([1, 2])
    releases[0]()
    await flush()
    expect(started).toEqual([1, 2, 3])
    releases[1]()
    releases[2]()
    await flush()
    expect(started).toEqual([1, 2, 3, 4])
    releases[3]()
    expect(await Promise.all(all)).toEqual([1, 2, 3, 4])
  })

  it('front 옵션은 대기열 맨 앞으로 끼어든다', async () => {
    const limit = createLimiter(1)
    const order: string[] = []
    let release: () => void = () => {}
    const first = limit(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const a = limit(async () => void order.push('a'))
    const urgent = limit(async () => void order.push('urgent'), { front: true })
    release()
    await Promise.all([first, a, urgent])
    expect(order).toEqual(['urgent', 'a'])
  })

  it('한 작업이 실패해도 다음 작업이 이어진다', async () => {
    const limit = createLimiter(1)
    const bad = limit(async () => {
      throw new Error('실패')
    })
    const good = limit(async () => 'ok')
    await expect(bad).rejects.toThrow('실패')
    await expect(good).resolves.toBe('ok')
  })
})

// ── zip 해제 ────────────────────────────────────────────────────────

describe('zip', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6])

  it('첫 PNG 를 꺼낸다', () => {
    const zip = zipSync({ 'image_0.png': png })
    expect(Array.from(extractFirstPng(zip))).toEqual(Array.from(png))
  })

  it('압축 없이 저장된 zip(level 0)도 푼다', () => {
    const zip = zipSync({ 'image_0.png': [png, { level: 0 }] })
    expect(Array.from(extractFirstPng(zip))).toEqual(Array.from(png))
  })

  it('PNG 가 아닌 파일은 건너뛰고, 여러 장이면 첫 장만', () => {
    const second = new Uint8Array([9, 9, 9])
    const zip = zipSync({
      'meta.txt': new Uint8Array([104, 105]),
      'image_0.png': png,
      'image_1.png': second
    })
    expect(Array.from(extractFirstPng(zip))).toEqual(Array.from(png))
  })

  it('확장자 대소문자는 가리지 않는다', () => {
    const zip = zipSync({ 'IMAGE_0.PNG': png })
    expect(Array.from(extractFirstPng(zip))).toEqual(Array.from(png))
  })

  it('PNG 가 없거나 zip 이 아니면 한국어 오류', () => {
    expect(() => extractFirstPng(zipSync({ 'a.txt': new Uint8Array([1]) }))).toThrow(
      '압축 파일 안에 그림이 없습니다'
    )
    expect(() => extractFirstPng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(
      '그림 압축 파일을 열 수 없습니다'
    )
    expect(() => extractFirstPng(new Uint8Array(0))).toThrow('그림 압축 파일을 열 수 없습니다')
  })

  it('zip 판별은 PK 시그니처', () => {
    expect(isZipBytes(zipSync({ 'a.png': png }))).toBe(true)
    expect(isZipBytes(png)).toBe(false)
    expect(isZipBytes(new Uint8Array(0))).toBe(false)
    expect(isZipBytes(new Uint8Array([0x50, 0x4b]))).toBe(false)
  })
})

// ── 표시 문구·검증 ──────────────────────────────────────────────────

describe('연결 코드', () => {
  it('소문자·공백·기호를 정리하고 8자로 자른다', () => {
    expect(normalizePairCode('abcd efgh')).toBe('ABCDEFGH')
    expect(normalizePairCode('ab-cd_23 45 678')).toBe('ABCD2345')
    expect(normalizePairCode('')).toBe('')
    expect(normalizePairCode('A'.repeat(20))).toHaveLength(PAIR_CODE_LENGTH)
  })

  it('연결 주소를 통째로 붙여 넣어도 코드만 남는다', () => {
    expect(normalizePairCode('https://nais3-cloud.example.workers.dev/#pair=ABCD2345')).toBe(
      'ABCD2345'
    )
    expect(normalizePairCode('#pair=abcd2345')).toBe('ABCD2345')
  })

  it('주소 해시에서 코드를 꺼낸다', () => {
    expect(pairCodeFromHash('#pair=ABCD2345')).toBe('ABCD2345')
    expect(pairCodeFromHash('#x=1&pair=abcd2345')).toBe('ABCD2345')
    expect(pairCodeFromHash('#pair=ABCD%202345')).toBe('ABCD2345')
    expect(pairCodeFromHash('')).toBe('')
    expect(pairCodeFromHash('#other=1')).toBe('')
  })
})

describe('생성 위치 안내', () => {
  it('PC 켜짐 → PC 가 생성', () => {
    expect(generationRoute(phone({ online: true, ready: true }))).toEqual({
      kind: 'pc',
      text: 'PC가 생성',
      blocked: false
    })
  })

  it('PC 꺼짐 + 클라우드 가능 → 클라우드가 생성 (무료 범위)', () => {
    const r = generationRoute(phone({ online: false, ready: true }))
    expect(r).toEqual({ kind: 'cloud', text: '클라우드가 생성 (무료 범위)', blocked: false })
  })

  it('PC 꺼짐 + 클라우드 불가 → 이유와 함께 막힘', () => {
    const r = generationRoute(
      phone({ online: false, ready: false, reason: '이번 달 무료 사용량이 확인되지 않음' })
    )
    expect(r.kind).toBe('blocked')
    expect(r.blocked).toBe(true)
    expect(r.text).toBe('지금은 생성 불가: 이번 달 무료 사용량이 확인되지 않음')
  })

  it('이유가 비어 있으면 상태로 추정', () => {
    expect(generationRoute(phone({ ready: false, enabled: false })).text).toContain('꺼져 있음')
    expect(generationRoute(phone({ ready: false, hasNaiToken: false })).text).toContain('NAI 토큰')
  })

  it('PC 를 직접 고르면 꺼져 있어도 막지 않고 기다린다고 알린다', () => {
    const r = generationRoute(phone({ online: false, ready: false }), 'pc')
    expect(r.blocked).toBe(false)
    expect(r.text).toContain('PC가 꺼져 있음')
    expect(generationRoute(phone({ online: true }), 'pc').text).toBe('PC가 생성')
  })

  it('클라우드를 직접 고르면 PC 가 켜져 있어도 클라우드 사정을 본다', () => {
    expect(generationRoute(phone({ online: true, ready: true }), 'cloud').kind).toBe('cloud')
    const r = generationRoute(phone({ online: true, ready: false, reason: '토큰 없음' }), 'cloud')
    expect(r.blocked).toBe(true)
  })

  it('상태를 아직 못 받았으면 막는다', () => {
    expect(generationRoute(null).blocked).toBe(true)
  })
})

describe('작업 표시', () => {
  it('PC 큐 문구는 할 일이 있을 때만', () => {
    const q = {
      running: true,
      pending: 4,
      generating: 1,
      done: 0,
      failed: 0,
      generatingSceneId: 3,
      updatedAt: 0
    }
    expect(queueText(q)).toBe('생성 중 1 · 대기 4')
    expect(queueText({ ...q, generating: 0, pending: 2 })).toBe('생성 중 0 · 대기 2')
    expect(queueText({ ...q, generating: 0, pending: 0 })).toBeNull()
    expect(queueText(null)).toBeNull()
  })

  it('상태 라벨', () => {
    expect(jobStateLabel(job({ state: 'queued' }))).toBe('대기 중')
    expect(jobStateLabel(job({ state: 'pc' }))).toBe('PC에서 생성 중')
    expect(jobStateLabel(job({ state: 'cloud' }))).toBe('클라우드에서 생성 중')
    expect(jobStateLabel(job({ state: 'done' }))).toBe('완료')
    expect(jobStateLabel(job({ state: 'done', failed: 1 }))).toBe('일부 실패')
    expect(jobStateLabel(job({ state: 'failed' }))).toBe('실패')
    expect(jobStateLabel(job({ state: 'cancelled' }))).toBe('취소됨')
  })

  it('PC 가 꺼져 있을 때 대기 중인 작업에만 보충 설명', () => {
    expect(jobNote(job({ state: 'queued' }), false)).toBe('PC가 꺼져 있어 켜지면 시작합니다')
    expect(jobNote(job({ state: 'queued' }), true)).toBeNull()
    expect(jobNote(job({ state: 'cloud' }), false)).toBeNull()
  })

  it('진행 비율은 0~1 로 자르고 실패분은 남은 칸을 넘지 않는다', () => {
    expect(jobDoneRatio(job({ count: 4, done: 1 }))).toBe(0.25)
    expect(jobDoneRatio(job({ count: 0, done: 3 }))).toBe(0)
    expect(jobDoneRatio(job({ count: 2, done: 5 }))).toBe(1)
    expect(jobFailedRatio(job({ count: 4, done: 1, failed: 1 }))).toBe(0.25)
    expect(jobFailedRatio(job({ count: 4, done: 3, failed: 3 }))).toBe(0.25)
  })
})

describe('장수·해상도·이름 검증', () => {
  it('장수는 1~20 정수로 자른다', () => {
    expect(clampCount(0)).toBe(1)
    expect(clampCount(-3)).toBe(1)
    expect(clampCount(7.6)).toBe(8)
    expect(clampCount(99)).toBe(20)
    expect(clampCount(NaN)).toBe(1)
  })

  it('해상도는 64 배수·64~2048', () => {
    expect(validateSize(832, 1216)).toBeNull()
    expect(validateSize(64, 2048)).toBeNull()
    expect(validateSize(100, 1216)).toContain('64의 배수')
    expect(validateSize(832, 32)).toContain('64~2048')
    expect(validateSize(2112, 832)).toContain('64~2048')
    expect(validateSize(NaN, 832)).toContain('정수')
    expect(validateSize(832.5, 832)).toContain('정수')
  })

  it('클라우드 무료 픽셀 수(1024×1024) 초과 판정', () => {
    expect(exceedsFreePixels(1024, 1024)).toBe(false)
    expect(exceedsFreePixels(832, 1216)).toBe(false) // 1011712 < 1048576
    expect(exceedsFreePixels(1216, 1216)).toBe(true)
    expect(exceedsFreePixels(1088, 1024)).toBe(true)
  })

  it('씬 이름은 공백을 뺀 1~100자', () => {
    expect(validateSceneName('벚꽃')).toBeNull()
    expect(validateSceneName('   ')).toContain('입력')
    expect(validateSceneName('가'.repeat(100))).toBeNull()
    expect(validateSceneName('가'.repeat(101))).toContain('100자')
  })
})

describe('무료 사용량 표시', () => {
  const info = (
    usage: {
      percent: number
      purchasedPercent?: number
      isNegative: boolean
      timeUntilNextPercent: number
    } | null
  ) => ({
    tier: null,
    anlas: null,
    opusUsage: usage,
    updatedAt: 0
  })

  it('남은 비율과 대략의 장수', () => {
    const v = quotaView(info({ percent: 73, isNegative: false, timeUntilNextPercent: 4800 }))
    expect(v?.percent).toBe(73)
    expect(v?.low).toBe(false)
    expect(v?.text).toBe('73% 남음 (약 1,263장)')
    expect(v?.refill).toBe('1시간 20분')
  })

  it('5% 미만이면 경고, 초과 사용이면 0%', () => {
    expect(quotaView(info({ percent: 3, isNegative: false, timeUntilNextPercent: 0 }))?.low).toBe(
      true
    )
    const over = quotaView(info({ percent: 10, isNegative: true, timeUntilNextPercent: 100 }))
    expect(over?.percent).toBe(0)
    expect(over?.text).toBe('무료 사용량을 모두 썼습니다')
  })

  it('정보가 없으면 null', () => {
    expect(quotaView(null)).toBeNull()
    expect(quotaView(info(null))).toBeNull()
  })

  // 충전 아이템 추가분 (커스텀) — PC 게이지와 같은 식
  const extra = (
    percent: number,
    purchasedPercent: number,
    isNegative = false
  ): ReturnType<typeof info> =>
    info({ percent, purchasedPercent, isNegative, timeUntilNextPercent: 4800 })

  it('추가분이 있으면 문구에 붙이고 장수는 합으로, 눈금은 max(100, 합)', () => {
    const v = quotaView(extra(0, 100))
    expect(v?.text).toBe('0% 남음 · +100% 추가 게이지 (약 1,730장)')
    expect(v?.percent).toBe(100)
    expect(v?.low).toBe(false) // 일반분은 바닥이어도 추가분이 5% 이상
    const big = quotaView(extra(73, 300))
    expect(big?.text).toBe('73% 남음 · +300% 추가 게이지 (약 6,453장)')
    expect(big?.percent).toBe(100) // 막대가 칸 밖으로 넘치지 않는다
    expect(quotaView(extra(0, 3))?.low).toBe(true)
  })

  it('일반분이 100%를 넘어도 자르지 않고, 막대는 100 안 · 회복은 멈춤', () => {
    const v = quotaView(info({ percent: 120, isNegative: false, timeUntilNextPercent: 4800 }))
    expect(v?.text).toBe('120% 남음 (약 2,076장)')
    expect(v?.percent).toBe(100)
    expect(v?.refill).toBeNull()
  })

  it('키가 없거나 0이면 예전 표시 그대로, 초과 사용이면 모두 썼다', () => {
    expect(quotaView(extra(73, 0))).toEqual(
      quotaView(info({ percent: 73, isNegative: false, timeUntilNextPercent: 4800 }))
    )
    const over = quotaView(extra(0, 0, true))
    expect(over?.text).toBe('무료 사용량을 모두 썼습니다')
    expect(over?.percent).toBe(0)
  })
})

describe('클라우드 무료 사용량 상태', () => {
  const now = 1_000_000_000_000
  const q = (state: CloudQuota['state'], agoMs = 0): CloudQuota => ({
    state,
    checkedAt: now - agoMs
  })

  it('남음·소진·확인 안 됨 낱말과 확인 시각', () => {
    expect(cloudQuotaView(q('available', 180_000), now)).toEqual({
      state: 'available',
      label: '남음',
      checked: '3분 전 확인',
      text: '무료 사용량: 남음 · 3분 전 확인'
    })
    expect(cloudQuotaView(q('exhausted', 3_000), now).text).toBe('무료 사용량: 소진 · 방금 확인')
    expect(cloudQuotaView(q('unknown', 7_200_000), now).text).toBe(
      '무료 사용량: 확인 안 됨 · 2시간 전 확인'
    )
  })

  it('확인한 적이 없으면(null) 시각 없이 「확인 안 됨」', () => {
    expect(cloudQuotaView(null, now)).toEqual({
      state: 'unknown',
      label: '확인 안 됨',
      checked: null,
      text: '무료 사용량: 확인 안 됨'
    })
    expect(cloudQuotaView(undefined, now).label).toBe('확인 안 됨')
  })

  it('모르는 상태값이나 깨진 시각은 「확인 안 됨」·시각 없음으로 본다', () => {
    const odd = { state: 'weird', checkedAt: NaN } as unknown as CloudQuota
    const v = cloudQuotaView(odd, now)
    expect(v.state).toBe('unknown')
    expect(v.checked).toBeNull()
  })

  it('소진으로 확인한 지 30분 안일 때만 막는다', () => {
    expect(isQuotaBlocking(q('exhausted', 60_000), now)).toBe(true)
    expect(isQuotaBlocking(q('exhausted', QUOTA_FRESH_MS - 1), now)).toBe(true)
    expect(isQuotaBlocking(q('exhausted', QUOTA_FRESH_MS), now)).toBe(false)
    expect(isQuotaBlocking(q('available'), now)).toBe(false)
    expect(isQuotaBlocking(q('unknown'), now)).toBe(false)
    expect(isQuotaBlocking(null, now)).toBe(false)
  })

  it('클라우드가 생성하는(하려다 막힌) 상황에서만 보인다', () => {
    const pcOn = phone({ online: true, ready: true })
    expect(showsCloudQuota(pcOn, generationRoute(pcOn, 'auto', now))).toBe(false)

    const cloud = phone({ online: false, ready: true })
    expect(showsCloudQuota(cloud, generationRoute(cloud, 'auto', now))).toBe(true)
    // PC 가 켜져 있어도 클라우드를 직접 고르면 클라우드가 생성
    expect(showsCloudQuota(pcOn, generationRoute(pcOn, 'cloud', now))).toBe(true)

    const blocked = phone({ online: false, ready: false, reason: '막힘' })
    expect(showsCloudQuota(blocked, generationRoute(blocked, 'auto', now))).toBe(true)

    // 클라우드 생성을 안 켰거나 토큰이 없으면 무료 사용량은 상관없다
    const off = phone({ online: false, enabled: false, ready: false })
    expect(showsCloudQuota(off, generationRoute(off, 'auto', now))).toBe(false)
    const noToken = phone({ online: false, hasNaiToken: false, ready: false })
    expect(showsCloudQuota(noToken, generationRoute(noToken, 'auto', now))).toBe(false)

    expect(showsCloudQuota(null, generationRoute(null))).toBe(false)
  })

  it('서버가 「가능」이어도 방금 소진이면 생성 버튼을 막고 이유를 말한다', () => {
    const p = phone({ online: false, ready: true, quota: q('exhausted', 60_000) })
    const r = generationRoute(p, 'auto', now)
    expect(r.kind).toBe('blocked')
    expect(r.blocked).toBe(true)
    expect(r.text).toBe('지금은 생성 불가: 이번 달 무료 사용량을 모두 썼습니다')
  })

  it('소진으로 확인된 지 오래됐으면 막지 않는다 (서버가 생성 때 다시 확인)', () => {
    const p = phone({ online: false, ready: true, quota: q('exhausted', QUOTA_FRESH_MS + 1) })
    const r = generationRoute(p, 'auto', now)
    expect(r.kind).toBe('cloud')
    expect(r.blocked).toBe(false)
  })

  it('남음·확인 안 됨은 서버 판단(ready)을 따른다', () => {
    expect(
      generationRoute(phone({ ready: true, quota: q('available') }), 'auto', now).blocked
    ).toBe(false)
    expect(generationRoute(phone({ ready: true, quota: q('unknown') }), 'auto', now).blocked).toBe(
      false
    )
    expect(
      generationRoute(phone({ ready: false, quota: q('available') }), 'auto', now).blocked
    ).toBe(true)
  })

  it('PC 가 생성하면 소진이어도 막지 않는다', () => {
    const p = phone({ online: true, ready: false, quota: q('exhausted', 1000) })
    expect(generationRoute(p, 'auto', now)).toEqual({
      kind: 'pc',
      text: 'PC가 생성',
      blocked: false
    })
  })

  it('이유가 비어 있어도 소진이면 소진으로 말한다', () => {
    expect(cloudNotReadyReason(phone({ ready: false, quota: q('exhausted') }))).toBe(
      '이번 달 무료 사용량을 모두 썼습니다'
    )
    // 서버가 준 이유가 먼저
    expect(cloudNotReadyReason(phone({ reason: '서버 이유', quota: q('exhausted') }))).toBe(
      '서버 이유'
    )
  })

  it('생성 버튼 가까이 안내: 막힘(빨강)·오래된 소진(주의)·해당 없음', () => {
    const fresh = phone({ online: false, ready: true, quota: q('exhausted', 120_000) })
    const n = quotaExhaustedNotice(fresh, generationRoute(fresh, 'auto', now), now)
    expect(n?.blocking).toBe(true)
    expect(n?.text).toContain('클라우드 생성 불가: 무료 사용량 소진 (2분 전 확인)')

    const stale = phone({ online: false, ready: true, quota: q('exhausted', 3 * 3_600_000) })
    const s = quotaExhaustedNotice(stale, generationRoute(stale, 'auto', now), now)
    expect(s?.blocking).toBe(false)
    expect(s?.text).toContain('소진으로 확인됐습니다 (3시간 전 확인)')

    const ok = phone({ online: false, ready: true, quota: q('available') })
    expect(quotaExhaustedNotice(ok, generationRoute(ok, 'auto', now), now)).toBeNull()

    // PC 가 생성하는 상황이면 안내하지 않는다
    const pc = phone({ online: true, ready: true, quota: q('exhausted') })
    expect(quotaExhaustedNotice(pc, generationRoute(pc, 'auto', now), now)).toBeNull()
    expect(quotaExhaustedNotice(null, generationRoute(null), now)).toBeNull()
  })
})

// ── API ─────────────────────────────────────────────────────────────

describe('createApi', () => {
  function setup(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const onUnauthorized = vi.fn()
    const api = createApi({
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} })
        return handler(String(input), init ?? {})
      }) as typeof fetch,
      getToken: () => 'tok-test',
      onUnauthorized
    })
    return { api, calls, onUnauthorized }
  }
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('토큰을 Authorization 헤더에 싣는다', async () => {
    const { api, calls } = setup(() => json({ ok: true, deviceId: 'd1', name: '내 폰' }))
    const me = await api.me()
    expect(me.name).toBe('내 폰')
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer tok-test')
  })

  it('연결(pair) 요청에는 토큰을 싣지 않고 본문을 JSON 으로 보낸다', async () => {
    const { api, calls } = setup(() => json({ ok: true, token: 't', deviceId: 'd' }))
    await api.pair('ABCD2345', '내 폰')
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.authorization).toBeUndefined()
    expect(headers['content-type']).toBe('application/json')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ code: 'ABCD2345', name: '내 폰' })
    expect(calls[0].url).toBe('/api/pair')
  })

  it('실패 본문의 한국어 문장을 오류로 올린다', async () => {
    const { api } = setup(() => json({ ok: false, error: '연결 코드가 맞지 않습니다' }, 400))
    const err = await api.pair('XXXXXXXX', 'a').catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(400)
    expect(err.message).toBe('연결 코드가 맞지 않습니다')
  })

  it('본문이 JSON 이 아니면 상태별 기본 문장', async () => {
    const { api } = setup(() => new Response('oops', { status: 502 }))
    const err = await api.me().catch((e) => e)
    expect(err.message).toBe('서버에 문제가 생겼습니다')
    const { api: api2 } = setup(() => new Response('x', { status: 429 }))
    expect((await api2.me().catch((e) => e)).message).toContain('요청이 너무 많습니다')
  })

  it('401 이면 onUnauthorized 를 부른다 (연결 요청은 제외)', async () => {
    const { api, onUnauthorized } = setup(() => json({ ok: false, error: '인증 필요' }, 401))
    const err = await api.me().catch((e) => e)
    expect(err.status).toBe(401)
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    await api.pair('ABCD2345', 'a').catch(() => {})
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('네트워크가 끊기면 status 0 의 한국어 오류', async () => {
    const { api } = setup(() => {
      throw new TypeError('Failed to fetch')
    })
    const err = await api.state().catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.isNetwork).toBe(true)
    expect(err.message).toBe('네트워크에 연결할 수 없습니다')
  })

  it('ok:false 가 200 으로 와도 오류로 본다', async () => {
    const { api } = setup(() => json({ ok: false, error: '막힘' }))
    await expect(api.me()).rejects.toThrow('막힘')
  })

  it('작업 만들기: 본문을 보내고 job·notice 를 CloudCreateJobResponse 그대로 돌려준다', async () => {
    const created = job({ id: 'j9', count: 3, place: 'pc' })
    const reply: CloudCreateJobResponse = {
      job: created,
      notice: 'PC가 꺼져 있습니다. PC가 켜지면 생성합니다.'
    }
    const { api, calls } = setup(() => json({ ok: true, ...reply }))
    const res: CloudCreateJobResponse = await api.createJob({
      target: { type: 'scene', sceneId: 7 },
      count: 3,
      place: 'pc'
    })
    expect(res).toEqual({ ok: true, ...reply })
    expect(res.notice).toBe('PC가 꺼져 있습니다. PC가 켜지면 생성합니다.')
    expect(calls[0].url).toBe('/api/jobs')
    expect(calls[0].init.method).toBe('POST')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      target: { type: 'scene', sceneId: 7 },
      count: 3,
      place: 'pc'
    })
  })

  it('작업 만들기: notice 가 없으면 job 만 온다', async () => {
    const { api } = setup(() => json({ ok: true, job: job() }))
    const res = await api.createJob({ target: { type: 'main' }, count: 1, place: 'auto' })
    expect(res.job.id).toBe('j1')
    expect(res.notice).toBeUndefined()
  })

  it('이미지 목록 질의 문자열은 값이 있는 것만', async () => {
    const { api, calls } = setup(() => json({ ok: true, items: [], next: null }))
    await api.images({ sceneId: 7, presetId: null, before: '123', limit: 45 })
    expect(calls[0].url).toBe('/api/images?sceneId=7&before=123&limit=45')
    await api.images()
    expect(calls[1].url).toBe('/api/images')
  })

  it('이미지 바이트와 content-type 을 돌려준다', async () => {
    const { api, calls } = setup(
      () =>
        new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'application/zip' } })
    )
    const res = await api.imageBytes('cabc', 'full')
    expect(Array.from(res.bytes)).toEqual([1, 2, 3])
    expect(res.contentType).toBe('application/zip')
    await api.imageBytes('cabc', 'thumb')
    expect(calls[1].url).toBe('/api/images/cabc/thumb')
  })

  it('썸네일 올리기는 PUT + image/webp', async () => {
    const { api, calls } = setup(() => json({ ok: true }))
    await api.putThumb('cabc', new Blob([new Uint8Array([1, 2])], { type: 'image/webp' }))
    expect(calls[0].init.method).toBe('PUT')
    expect((calls[0].init.headers as Record<string, string>)['content-type']).toBe('image/webp')
    expect(calls[0].url).toBe('/api/images/cabc/thumb')
  })

  it('WebP 를 못 만드는 기기의 JPEG 썸네일은 image/jpeg 로 올린다', async () => {
    const { api, calls } = setup(() => json({ ok: true }))
    await api.putThumb('cabc', new Blob([new Uint8Array([1, 2])], { type: 'image/jpeg' }))
    expect((calls[0].init.headers as Record<string, string>)['content-type']).toBe('image/jpeg')
  })

  it('작업 만들기: requestId 를 본문에 그대로 싣는다', async () => {
    const { api, calls } = setup(() => json({ ok: true, job: job() }))
    await api.createJob({ target: { type: 'main' }, count: 2, place: 'auto', requestId: 'req-1' })
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      target: { type: 'main' },
      count: 2,
      place: 'auto',
      requestId: 'req-1'
    })
  })

  it('그림 삭제: 기본은 그냥, 강제는 ?force=1', async () => {
    const { api, calls } = setup(() => json({ ok: true }))
    await api.deleteImage('cabc')
    await api.deleteImage('cabc', { force: true })
    expect(calls[0].url).toBe('/api/images/cabc')
    expect(calls[0].init.method).toBe('DELETE')
    expect(calls[1].url).toBe('/api/images/cabc?force=1')
  })

  it('PC로 옮기지 않은 그림 삭제가 409 면 서버 문장을 그대로 올린다', async () => {
    const { api } = setup(() =>
      json(
        { ok: false, error: 'PC로 아직 옮기지 않은 그림입니다. 지우면 다시 받을 수 없습니다' },
        409
      )
    )
    const err = await api.deleteImage('cabc').catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(409)
    expect(err.message).toContain('PC로 아직 옮기지 않은 그림')
  })
})

describe('createApi 시간 제한', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** 신호를 받으면 거절하는 fetch — 브라우저처럼 abort 를 따른다 */
  const abortable = (): typeof fetch =>
    ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        )
      })) as typeof fetch

  function make(fetchImpl: typeof fetch): Api {
    return createApi({ fetch: fetchImpl, getToken: () => 'tok', onUnauthorized: vi.fn() })
  }

  it('응답이 없으면 15초 뒤 끊고 네트워크 오류(status 0)로 다룬다', async () => {
    const api = make(abortable())
    let settled: unknown = null
    const p = api.state().catch((e) => (settled = e))
    await vi.advanceTimersByTimeAsync(14_999)
    expect(settled).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    await p
    expect(settled).toBeInstanceOf(ApiError)
    expect((settled as ApiError).isNetwork).toBe(true)
    expect((settled as ApiError).message).toContain('서버 응답이 없습니다')
  })

  it('요청에 취소 신호를 달고, 끝나면 시간 제한 타이머를 남기지 않는다', async () => {
    let signal: AbortSignal | undefined
    const api = make((async (_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Response(JSON.stringify({ ok: true, deviceId: 'd', name: 'n' }), {
        headers: { 'content-type': 'application/json' }
      })
    }) as typeof fetch)
    await api.me()
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(signal?.aborted).toBe(false)
  })

  it('헤더는 왔는데 본문이 멈춰도 같은 시간 제한이 끊는다', async () => {
    const api = make(((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('The operation was aborted.', 'AbortError'))
            )
          })
      } as unknown as Response)) as typeof fetch)
    let settled: unknown = null
    const p = api.state().catch((e) => (settled = e))
    await vi.advanceTimersByTimeAsync(15_000)
    await p
    expect((settled as ApiError).isNetwork).toBe(true)
    expect((settled as ApiError).message).toContain('서버 응답이 없습니다')
  })

  it('그림 바이트는 60초까지 기다린다', async () => {
    const api = make(abortable())
    let settled: unknown = null
    const p = api.imageBytes('cabc', 'full').catch((e) => (settled = e))
    await vi.advanceTimersByTimeAsync(59_999)
    expect(settled).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    await p
    expect((settled as ApiError).isNetwork).toBe(true)
  })

  it('썸네일 올리기도 60초 제한', async () => {
    const api = make(abortable())
    let settled: unknown = null
    const p = api
      .putThumb('cabc', new Blob([new Uint8Array([1])], { type: 'image/jpeg' }))
      .catch((e) => (settled = e))
    await vi.advanceTimersByTimeAsync(59_999)
    expect(settled).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    await p
    expect((settled as ApiError).isNetwork).toBe(true)
  })

  it('시간 제한은 deps 로 바꿀 수 있다', async () => {
    const api = createApi({
      fetch: abortable(),
      getToken: () => 'tok',
      onUnauthorized: vi.fn(),
      timeoutMs: { json: 1_000 }
    })
    const p = api.me().catch((e) => e)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await p).toBeInstanceOf(ApiError)
  })
})

// ── 갤러리 목록 합치기 ──────────────────────────────────────────────

describe('갤러리 합치기', () => {
  const ids = (items: CloudImageItem[]): string[] => items.map((i) => i.id)

  it('다음 페이지를 이어 붙일 때 중복 id 는 건너뛴다', () => {
    const merged = appendUnique([image('a', 30), image('b', 20)], [image('b', 20), image('c', 10)])
    expect(ids(merged)).toEqual(['a', 'b', 'c'])
  })

  it('첫 페이지만 보고 있었으면 새 첫 페이지로 통째로 바꾼다', () => {
    const current = { items: [image('b', 20), image('c', 10)], next: null }
    const head = { items: [image('a', 30), image('b', 20), image('c', 10)], next: null }
    expect(mergeHead(current, head)).toEqual(head)
  })

  it('더 내려가 있었으면 새 첫 페이지 + 그보다 오래된 기존 항목, 다음 표식은 유지', () => {
    const current = {
      items: [image('c', 30), image('d', 25), image('e', 20), image('f', 15)],
      next: '15'
    }
    const head = { items: [image('a', 50), image('b', 40)], next: '40' } // 새로 둘 올라옴
    const merged = mergeHead(current, head)
    expect(ids(merged.items)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(merged.next).toBe('15')
  })

  it('첫 페이지와 겹치는 항목은 새 것만 남긴다', () => {
    const current = { items: [image('b', 40), image('c', 30), image('d', 20)], next: '20' }
    const head = { items: [image('a', 50), image('b', 40)], next: '40' }
    expect(ids(mergeHead(current, head).items)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('새 첫 페이지가 비면(필터에 해당 없음) 목록도 비운다', () => {
    const current = { items: [image('a', 10), image('b', 5)], next: null }
    expect(mergeHead(current, { items: [], next: null })).toEqual({ items: [], next: null })
  })

  it('같은 시각의 그림은 id 순서까지 따져 빠뜨리지 않는다 (PC 그림 시각은 초 단위)', () => {
    // 서버 정렬: 시각 내림차순, 같으면 id 내림차순. p3·p2·p1 이 같은 시각
    const current = {
      items: [image('p9', 50), image('p3', 40), image('p2', 40), image('p1', 40), image('p0', 30)],
      next: '30:p0'
    }
    // 새 그림 p10 이 올라와 첫 페이지(3장)가 한 칸 밀림: p10·p9·p3 — p2·p1 은 head 에 없고 p3 와 같은 시각
    const head = { items: [image('p10', 60), image('p9', 50), image('p3', 40)], next: '40:p3' }
    const merged = mergeHead(current, head)
    expect(ids(merged.items)).toEqual(['p10', 'p9', 'p3', 'p2', 'p1', 'p0'])
    expect(merged.next).toBe('30:p0')
  })

  it('목록 순서 비교는 시각, 같으면 id', () => {
    expect(comesAfter({ createdAt: 10, id: 'a' }, { createdAt: 20, id: 'z' })).toBe(true)
    expect(comesAfter({ createdAt: 30, id: 'a' }, { createdAt: 20, id: 'z' })).toBe(false)
    expect(comesAfter({ createdAt: 20, id: 'p1' }, { createdAt: 20, id: 'p2' })).toBe(true)
    expect(comesAfter({ createdAt: 20, id: 'p2' }, { createdAt: 20, id: 'p1' })).toBe(false)
    expect(comesAfter({ createdAt: 20, id: 'p1' }, { createdAt: 20, id: 'p1' })).toBe(false)
  })

  it('다음 페이지 재시도 대기: 3초부터 두 배씩, 60초 상한', () => {
    expect(loadMoreBackoffMs(0)).toBe(0)
    expect(loadMoreBackoffMs(1)).toBe(3_000)
    expect(loadMoreBackoffMs(2)).toBe(6_000)
    expect(loadMoreBackoffMs(3)).toBe(12_000)
    expect(loadMoreBackoffMs(5)).toBe(48_000)
    expect(loadMoreBackoffMs(6)).toBe(60_000)
    expect(loadMoreBackoffMs(50)).toBe(60_000)
  })
})

describe('전체 화면 보기 위치', () => {
  const list = (...idList: string[]): { id: string }[] => idList.map((id) => ({ id }))

  it('보던 그림의 id 로 찾는다 — 앞에 새 그림이 끼어도 같은 그림', () => {
    const before = list('a', 'b', 'c', 'd')
    expect(resolveViewerIndex(before, 'c', 2)).toBe(2)
    const after = list('n1', 'n2', 'a', 'b', 'c', 'd') // 새 그림 둘이 앞에 붙음
    expect(resolveViewerIndex(after, 'c', 2)).toBe(4)
  })

  it('보던 그림이 지워졌으면 마지막 위치에서 가까운 그림', () => {
    expect(resolveViewerIndex(list('a', 'b', 'd'), 'c', 2)).toBe(2) // 다음 그림 d
    expect(resolveViewerIndex(list('a', 'b'), 'c', 2)).toBe(1) // 끝이었으면 앞 그림
    expect(resolveViewerIndex(list('a', 'b'), null, 9)).toBe(1)
  })

  it('목록이 비면 -1', () => {
    expect(resolveViewerIndex([], 'a', 0)).toBe(-1)
  })
})

describe('썸네일 인코딩 선택', () => {
  const blob = (type: string, size = 100): Blob => new Blob([new Uint8Array(size)], { type })

  it('WebP 가 되면 WebP', async () => {
    const encode = vi.fn(async (type: string) => blob(type))
    const out = await encodeThumb(encode)
    expect(out?.type).toBe('image/webp')
    expect(encode).toHaveBeenCalledTimes(1)
  })

  it('WebP 를 못 만드는 기기(canvas 가 PNG 를 돌려줌, iOS Safari)는 JPEG 로 폴백', async () => {
    const encode = vi.fn(async (type: string) =>
      type === 'image/webp' ? blob('image/png') : blob(type)
    )
    const out = await encodeThumb(encode)
    expect(out?.type).toBe('image/jpeg')
    // WebP 는 한 번만 시도해 보고 곧바로 JPEG
    expect(encode.mock.calls.map((c) => c[0])).toEqual(['image/webp', 'image/jpeg'])
  })

  it('품질을 낮춰 가며 용량 한도 안의 첫 결과를 쓴다', async () => {
    const sizes = [300_000, 200_000, 100_000]
    const qualities: number[] = []
    const out = await encodeThumb(async (type, quality) => {
      qualities.push(quality)
      return blob(type, sizes[qualities.length - 1])
    }, 256 * 1024)
    expect(out?.size).toBe(200_000)
    expect(qualities).toEqual([0.82, 0.62])
  })

  it('WebP 로 한도를 못 맞추면 JPEG 를 시도하고, 둘 다 안 되면 null', async () => {
    const huge = vi.fn(async (type: string) => blob(type, 999_999))
    expect(await encodeThumb(huge, 1_000)).toBeNull()
    expect(huge).toHaveBeenCalledTimes(6)
    const none = vi.fn(async () => null)
    expect(await encodeThumb(none)).toBeNull()
    expect(none).toHaveBeenCalledTimes(2) // 형식마다 한 번씩 보고 접는다
  })
})

describe('작업 요청 id', () => {
  const body = { target: { type: 'scene', sceneId: 3 } as const, count: 2, place: 'auto' } as const

  it('무작위 16진수 32자', () => {
    const a = newRequestId()
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(newRequestId()).not.toBe(a)
  })

  it('누를 때마다 새 id — 성공하면 다음 누름은 다른 값', () => {
    let n = 0
    const keeper = new RequestIdKeeper(() => `id${++n}`)
    const first = keeper.idFor(body)
    keeper.settle(null)
    expect(keeper.idFor(body)).not.toBe(first)
  })

  it('응답을 모르는 실패(끊김·시간 초과·서버 오류) 뒤 같은 내용으로 다시 누르면 같은 id', () => {
    let n = 0
    const keeper = new RequestIdKeeper(() => `id${++n}`)
    const first = keeper.idFor(body)
    keeper.settle(0)
    expect(keeper.idFor(body)).toBe(first)
    keeper.settle(503)
    expect(keeper.idFor(body)).toBe(first)
  })

  it('서버가 분명히 거절한 뒤(4xx)에는 새 id', () => {
    let n = 0
    const keeper = new RequestIdKeeper(() => `id${++n}`)
    const first = keeper.idFor(body)
    keeper.settle(400)
    expect(keeper.idFor(body)).not.toBe(first)
  })

  it('내용이 다르면(장수·위치·대상) 실패 뒤라도 새 id', () => {
    let n = 0
    const keeper = new RequestIdKeeper(() => `id${++n}`)
    const first = keeper.idFor(body)
    keeper.settle(0)
    expect(keeper.idFor({ ...body, count: 3 })).not.toBe(first)
    keeper.settle(0)
    const other = keeper.idFor({ target: { type: 'main' }, count: 2, place: 'auto' })
    expect(other).not.toBe(first)
  })

  it('결과를 모르는 상태 구분', () => {
    expect(isAmbiguousFailure(0)).toBe(true)
    expect(isAmbiguousFailure(500)).toBe(true)
    expect(isAmbiguousFailure(502)).toBe(true)
    expect(isAmbiguousFailure(400)).toBe(false)
    expect(isAmbiguousFailure(409)).toBe(false)
    expect(isAmbiguousFailure(429)).toBe(false)
  })
})

describe('삭제 확인·작업 안내·연결 코드 자판', () => {
  it('PC로 옮기지 않은 그림은 별도 확인 문구', () => {
    expect(deleteConfirmBody(false)).toBe(
      '클라우드 사본만 지웁니다. PC에 있는 원본은 그대로 남습니다.'
    )
    expect(deleteConfirmBody(true)).toBe(
      'PC로 아직 옮기지 않은 그림입니다. 지우면 다시 받을 수 없습니다.'
    )
  })

  it('작업을 만든 직후 안내: 기본 한 줄', () => {
    expect(
      createJobToasts({ count: 3, job: { state: 'pc' }, pcOnline: true }).map((t) => t.text)
    ).toEqual(['3장 생성을 시작했습니다'])
  })

  it('서버 notice 는 따로 길게 보이고, 기본 안내도 함께 (캐릭터 편집 안내)', () => {
    const notice = '캐릭터 편집은 PC가 켜져 반영된 뒤부터 클라우드 생성에 쓰입니다'
    const out = createJobToasts({ count: 2, job: { state: 'cloud' }, notice, pcOnline: false })
    expect(out).toEqual([
      { text: '2장 생성을 시작했습니다' },
      { text: notice, durationMs: NOTICE_TOAST_MS }
    ])
  })

  it('PC가 꺼져 기다리는 작업은 notice 만 (같은 사실을 두 번 말하지 않음)', () => {
    const notice = 'PC가 꺼져 있습니다. PC가 켜지면 생성합니다.'
    expect(
      createJobToasts({ count: 1, job: { state: 'queued' }, notice, pcOnline: false }).map(
        (t) => t.text
      )
    ).toEqual([notice])
    // notice 가 없으면 기본 안내가 대신 말한다
    expect(
      createJobToasts({ count: 1, job: { state: 'queued' }, pcOnline: false }).map((t) => t.text)
    ).toEqual(['PC가 꺼져 있어 켜질 때까지 기다립니다'])
    // PC가 켜져 있으면 queued 여도 시작 안내
    expect(
      createJobToasts({ count: 1, job: { state: 'queued' }, pcOnline: true }).map((t) => t.text)
    ).toEqual(['1장 생성을 시작했습니다'])
  })

  it('빈 notice 는 없는 것으로 본다', () => {
    expect(
      createJobToasts({ count: 1, job: { state: 'cloud' }, notice: '  ', pcOnline: false })
    ).toEqual([{ text: '1장 생성을 시작했습니다' }])
  })

  it('한글 자모·음절 판별', () => {
    expect(containsHangul('ㅁㅠㅊㅇ')).toBe(true)
    expect(containsHangul('가')).toBe(true)
    expect(containsHangul('AB12')).toBe(false)
    expect(containsHangul('')).toBe(false)
    expect(containsHangul('ABㅁ')).toBe(true)
    // 한글을 지운 결과는 비어 있다 (그래서 입력이 사라진 것처럼 보였다)
    expect(normalizePairCode('ㅁㅠㅊㅇ')).toBe('')
  })
})

// ── 상태 저장소 ─────────────────────────────────────────────────────

describe('createStore', () => {
  it('값을 합쳐 바꾸고 구독자에게 알린다', () => {
    const store = createStore({ a: 1, b: 'x' })
    const seen: number[] = []
    const off = store.subscribe(() => seen.push(store.get().a))
    store.set({ a: 2 })
    store.set((s) => ({ a: s.a + 1 }))
    expect(store.get()).toEqual({ a: 3, b: 'x' })
    expect(seen).toEqual([2, 3])
    off()
    store.set({ a: 9 })
    expect(seen).toEqual([2, 3])
  })

  it('알리는 도중 구독을 해제해도 안전하다', () => {
    const store = createStore({ n: 0 })
    const calls: string[] = []
    const offA = store.subscribe(() => {
      calls.push('a')
      offB()
    })
    const offB = store.subscribe(() => calls.push('b'))
    store.set({ n: 1 })
    expect(calls).toEqual(['a', 'b']) // 복사본을 돌므로 이번 알림에는 b 도 받는다
    store.set({ n: 2 })
    expect(calls).toEqual(['a', 'b', 'a'])
    offA()
  })
})
