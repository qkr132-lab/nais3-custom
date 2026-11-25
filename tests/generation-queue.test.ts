import { describe, it, expect } from 'vitest'
import { GenerationQueue } from '../src/main/queue/generation-queue'
import { RateLimitError } from '../src/main/nai/client'
import type { GenerationRequest } from '../src/shared/types'

// GenerationRequest를 흉내낸 최소 객체 (큐는 seed 외 필드를 건드리지 않는다)
const mk = (label: string): any => ({ __label: label, seed: 0 })

function waitIdle(q: GenerationQueue): Promise<void> {
  return new Promise((resolve) => {
    if (!q.status().running) return resolve()
    const check = (st: { running: boolean }): void => {
      if (!st.running) {
        q.off('changed', check)
        resolve()
      }
    }
    q.on('changed', check)
  })
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
function deferred<T>(): { p: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const p = new Promise<T>((res) => (resolve = res))
  return { p, resolve }
}

describe('GenerationQueue — 우선 등록(enqueueNext)', () => {
  it('생성 중인 항목 바로 다음에 끼워넣어 다음 차례로 뽑는다', async () => {
    const calls: string[] = []
    const gate = deferred<void>()
    const q = new GenerationQueue(async (req: any) => {
      calls.push(req.__label)
      if (req.__label === 'A') await gate.p // A를 생성 중 상태로 붙잡아둔다
      return `/img/${req.__label}.png`
    })
    q.setDelayMs(0)
    q.enqueueMany([mk('A'), mk('B'), mk('C')])
    await tick() // A가 generating 상태로 진입
    q.enqueueNext([mk('X')]) // 지금 생성 중(A) 다음에 X
    gate.resolve()
    await waitIdle(q)
    expect(calls).toEqual(['A', 'X', 'B', 'C'])
  })

  it('생성 중인 항목이 없으면 맨 앞에 넣는다', async () => {
    const calls: string[] = []
    const q = new GenerationQueue(async (req: any) => {
      calls.push(req.__label)
      return `/img/${req.__label}.png`
    })
    q.setDelayMs(0)
    q.enqueueNext([mk('X'), mk('Y')])
    await waitIdle(q)
    expect(calls).toEqual(['X', 'Y'])
  })
})

describe('GenerationQueue — 429 재시도', () => {
  it('429는 실패로 버리지 않고 잠시 뒤 같은 항목을 재시도한다', async () => {
    let n = 0
    const q = new GenerationQueue(async () => {
      n++
      if (n <= 2) throw new RateLimitError(0) // 처음 2번은 429
      return '/img/ok.png'
    })
    q.setDelayMs(0)
    q.enqueueMany([mk('R')])
    await waitIdle(q)
    expect(n).toBe(3) // 2번 429 + 3번째 성공
    expect(q.status().items[0].state).toBe('done')
  })

  it('429가 상한을 넘으면 결국 실패 처리된다', async () => {
    let n = 0
    const q = new GenerationQueue(async () => {
      n++
      throw new RateLimitError(0)
    })
    q.setDelayMs(0)
    q.enqueueMany([mk('R')])
    await waitIdle(q)
    expect(q.status().items[0].state).toBe('failed')
    expect(n).toBe(7) // 최초 1 + 재시도 6 (MAX_RATE_RETRIES)
  })

  it('일반 오류는 즉시 실패 (재시도 없음)', async () => {
    let n = 0
    const q = new GenerationQueue(async () => {
      n++
      throw new Error('생성 실패 400: bad prompt')
    })
    q.setDelayMs(0)
    q.enqueueMany([mk('R')])
    await waitIdle(q)
    expect(q.status().items[0].state).toBe('failed')
    expect(n).toBe(1)
  })
})

describe('GenerationQueue — 큐 밖 요청 잡아두기(exclusive)', () => {
  it('생성 중인 한 장이 끝나길 기다렸다 돌고, 그동안 다음 항목을 시작하지 않는다', async () => {
    const log: string[] = []
    const gate = deferred<void>()
    const q = new GenerationQueue(async (req: any) => {
      log.push(`start ${req.__label}`)
      if (req.__label === 'A') await gate.p
      log.push(`end ${req.__label}`)
      return `/img/${req.__label}.png`
    })
    q.setDelayMs(0)
    q.enqueueMany([mk('A'), mk('B')])
    await tick() // A 생성 중
    const outside = q.exclusive(async () => {
      log.push('outside start')
      await new Promise((r) => setTimeout(r, 400))
      log.push('outside end')
      return 'ok'
    })
    gate.resolve()
    expect(await outside).toBe('ok')
    await waitIdle(q)
    // A가 끝난 뒤 바깥 요청, 바깥 요청이 끝난 뒤에야 B
    expect(log).toEqual(['start A', 'end A', 'outside start', 'outside end', 'start B', 'end B'])
  })

  it('기다리는 중에 중단되면 던지고 큐는 계속 돈다', async () => {
    const gate = deferred<void>()
    const q = new GenerationQueue(async (req: any) => {
      if (req.__label === 'A') await gate.p
      return `/img/${req.__label}.png`
    })
    q.setDelayMs(0)
    q.enqueueMany([mk('A'), mk('B')])
    await tick()
    const ac = new AbortController()
    const outside = q.exclusive(async () => 'never', ac.signal)
    ac.abort()
    await expect(outside).rejects.toThrow('중단')
    gate.resolve()
    await waitIdle(q)
    expect(q.status().items.every((i) => i.state === 'done')).toBe(true)
  })
})

describe('GenerationQueue — 폰 작업 묶기(idsByCloudJob)', () => {
  // 큐는 cloudJobId·seed 외 필드를 건드리지 않으므로 라벨만 단 최소 요청으로 시험한다
  const mkJob = (label: string, cloudJobId?: string): GenerationRequest =>
    ({
      __label: label,
      seed: 0,
      ...(cloudJobId ? { cloudJobId } : {})
    }) as unknown as GenerationRequest
  const labelOf = (req: GenerationRequest): string =>
    (req as unknown as { __label: string }).__label

  it('요청의 cloudJobId 가 같은 항목 id 를 상태와 무관하게(끝난 것·실패·취소 포함) 돌려준다', async () => {
    const gate = deferred<void>()
    const q = new GenerationQueue(async (req) => {
      if (labelOf(req) === 'A') await gate.p
      if (labelOf(req) === 'B') throw new Error('생성 실패')
      return `/img/${labelOf(req)}.png`
    })
    q.setDelayMs(0)
    const [a, b, c, d] = q.enqueueMany([
      mkJob('A', 'j1'),
      mkJob('B', 'j1'),
      mkJob('C', 'j2'),
      mkJob('D')
    ])
    await tick() // A 가 generating
    expect(q.idsByCloudJob('j1')).toEqual([a, b])
    expect(q.idsByCloudJob('j2')).toEqual([c])
    expect(q.idsByCloudJob('없는 작업')).toEqual([])
    expect(q.idsByCloudJob('')).toEqual([]) // cloudJobId 가 없는 항목(d)은 어느 작업에도 묶이지 않는다

    q.cancel([c])
    gate.resolve()
    await waitIdle(q)
    const states = Object.fromEntries(q.status().items.map((i) => [i.id, i.state]))
    expect(states).toEqual({ [a]: 'done', [b]: 'failed', [c]: 'cancelled', [d]: 'done' })
    // 다 끝난 뒤에도 그대로 찾는다
    expect(q.idsByCloudJob('j1')).toEqual([a, b])
    expect(q.idsByCloudJob('j2')).toEqual([c])
  })

  it('enqueue(count) 배치·enqueueNext 로 넣어도 장마다 같은 작업에 묶인다', async () => {
    const gate = deferred<void>()
    const q = new GenerationQueue(async (req) => {
      if (labelOf(req) === 'hold') await gate.p
      return `/img/${labelOf(req)}.png`
    })
    q.setDelayMs(0)
    const [hold] = q.enqueueMany([mkJob('hold')])
    await tick()
    const batch = q.enqueue(mkJob('E', 'j3'), 3)
    const next = q.enqueueNext([mkJob('F', 'j3')])
    expect(batch).toHaveLength(3)
    expect(new Set(q.idsByCloudJob('j3'))).toEqual(new Set([...batch, ...next]))
    expect(q.idsByCloudJob('j3')).toHaveLength(4)
    expect(q.idsByCloudJob('j3')).not.toContain(hold)
    gate.resolve()
    await waitIdle(q)
  })

  it('대기 항목의 요청을 교체해도(updatePending) 새 요청의 cloudJobId 를 따른다', async () => {
    const gate = deferred<void>()
    const q = new GenerationQueue(async (req) => {
      if (labelOf(req) === 'hold') await gate.p
      return '/img/x.png'
    })
    q.setDelayMs(0)
    const [, p] = q.enqueueMany([mkJob('hold'), mkJob('P', 'j4')])
    await tick()
    expect(q.idsByCloudJob('j4')).toEqual([p])
    q.updatePending([{ id: p, request: mkJob('P', 'j5') }])
    expect(q.idsByCloudJob('j4')).toEqual([])
    expect(q.idsByCloudJob('j5')).toEqual([p])
    gate.resolve()
    await waitIdle(q)
  })
})

describe('GenerationQueue — 요약 상태(statusLite)에 폰 작업 id', () => {
  const mkJob = (label: string, extra: object = {}): GenerationRequest =>
    ({ __label: label, seed: 0, ...extra }) as unknown as GenerationRequest

  it('폰 작업에서 온 항목에는 cloudJobId 를 싣고, 그 밖의 항목에는 싣지 않는다 (씬 id 는 그대로)', async () => {
    const gate = deferred<void>()
    const q = new GenerationQueue(async (req) => {
      if ((req as unknown as { __label: string }).__label === 'hold') await gate.p
      return '/img/x.png'
    })
    q.setDelayMs(0)
    const [hold, phone, own] = q.enqueueMany([
      mkJob('hold'),
      mkJob('P', { cloudJobId: 'j1', sceneId: 7 }),
      mkJob('O', { sceneId: 8 })
    ])
    await tick()
    const lite = Object.fromEntries(q.statusLite().items.map((i) => [i.id, i]))
    expect(lite[phone]).toMatchObject({ state: 'pending', sceneId: 7, cloudJobId: 'j1' })
    expect(lite[own]).toMatchObject({ sceneId: 8 })
    expect(lite[own].cloudJobId).toBeUndefined()
    expect(lite[hold].cloudJobId).toBeUndefined()
    // 대기 항목의 요청을 바꿔도 요약이 따라간다
    q.updatePending([{ id: phone, request: mkJob('P', { cloudJobId: 'j2', sceneId: 7 }) }])
    expect(q.statusLite().items.find((i) => i.id === phone)?.cloudJobId).toBe('j2')
    gate.resolve()
    await waitIdle(q)
    // 끝난 뒤에도 남는다
    expect(q.statusLite().items.find((i) => i.id === phone)).toMatchObject({
      state: 'done',
      cloudJobId: 'j2'
    })
  })
})
