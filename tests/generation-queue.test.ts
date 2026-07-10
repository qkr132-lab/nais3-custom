import { describe, it, expect } from 'vitest'
import { GenerationQueue } from '../src/main/queue/generation-queue'
import { RateLimitError } from '../src/main/nai/client'

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
