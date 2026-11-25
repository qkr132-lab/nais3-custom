import { describe, expect, it } from 'vitest'
import { handleAlarm } from '../../cloud/src/core/alarm'
import { ANLAS_UNKNOWN_ERROR, overlayMainPatch, runCloudStep } from '../../cloud/src/core/cloudgen'
import { mergeMainPatch } from '../../cloud/src/core/store'
import { mergePromptParts } from '../../src/shared/scene-request'
import type { GenerationRequest } from '../../src/shared/types'
import {
  Harness,
  NAI_TOKEN,
  T0,
  enableCloudGen,
  preparedItem,
  sampleRequest,
  sampleSceneRequest,
  seedPc,
  type Dict
} from './helpers/harness'
import { reply, zipReply, type NaiCall } from './helpers/nai'

// 클라우드 생성의 무료 보장·정확성 보강 (설계 7-2) — V5 매 장 확인, 잔액 필드 없음, 토큰 교체,
// 폰 편집 덧입히기, 429 notBefore, 조각 카운터

const V5 = 'nai-diffusion-5-full'

async function ready(): Promise<{ h: Harness; token: string }> {
  const h = new Harness()
  await seedPc(h)
  await enableCloudGen(h)
  return { h, token: await h.pair() }
}

const mainJob = (count: number): Dict => ({ target: { type: 'main' }, count, place: 'cloud' })
const sceneJob = (sceneId: number, count: number): Dict => ({
  target: { type: 'scene', sceneId },
  count,
  place: 'cloud'
})

async function start(h: Harness, token: string, body: Dict): Promise<string> {
  const made = await h.phoneJson(token, 'POST', '/api/jobs', body)
  expect(made.status, JSON.stringify(made.json)).toBe(200)
  return made.json.job.id
}

async function setPrepared(
  h: Harness,
  key: string,
  request: Record<string, unknown>
): Promise<void> {
  await h.pcJson('PUT', '/api/pc/prepared', {
    items: [preparedItem(key, request, `changed-${key}-${Math.random()}`)]
  })
}

const payloadOf = (call: NaiCall): Dict => JSON.parse(call.body as string)
const job = (h: Harness, id: string): Dict => h.jobRow(id)

describe('V5 는 매 장 생성 직전에 구독을 확인한다', () => {
  it('V5 4장: 장마다 확인 + 첫 장 직후 확인 한 번 = 5번', async () => {
    const { h, token } = await ready()
    await setPrepared(h, 'main', sampleRequest({ model: V5 }))
    const id = await start(h, token, mainJob(4))
    await h.runAlarms()
    expect(job(h, id)).toMatchObject({ state: 'done', done: 4 })
    expect(h.nai.generateCalls).toHaveLength(4)
    expect(h.nai.subscriptionCalls).toHaveLength(5)
    // 확인은 항상 생성보다 먼저 — 호출 순서: 구독, 생성, 구독(첫 장 직후), 구독, 생성, ...
    const order = h.nai.calls.map((c) => (c.path === '/ai/generate-image' ? 'g' : 's')).join('')
    expect(order).toBe('sgssgsgsg')
  })

  it('V5 가 아닌 모델은 예전처럼 첫 장 전·첫 장 뒤·5장마다만 확인한다', async () => {
    const { h, token } = await ready()
    const id = await start(h, token, mainJob(6))
    await h.runAlarms()
    expect(job(h, id)).toMatchObject({ state: 'done', done: 6 })
    expect(h.nai.subscriptionCalls).toHaveLength(3) // 1번째 전 · 1번째 뒤 · 6번째 전
  })

  it('무료 사용량이 도중에 바닥나면(0%) 다음 장은 보내지 않는다 — Anlas 가 한 번도 나가지 않는다', async () => {
    const { h, token } = await ready()
    await setPrepared(h, 'main', sampleRequest({ model: V5 }))
    h.nai.usage = { percent: 0.1, isNegative: false, timeUntilNextPercent: 100 }
    h.nai.spendPerImage = 20 // 사용량이 바닥난 뒤에 만들어지면 장당 20 Anlas 가 나가는 NAI
    // 첫 장을 만드는 순간 사용량이 0 이 된다 (한도 직전이었던 경우)
    h.nai.generateQueue.push(async (call) => {
      h.nai.usage = { percent: 0, isNegative: false, timeUntilNextPercent: 100 }
      return zipReply('first')(call)
    })
    const id = await start(h, token, mainJob(20))
    await h.runAlarms(60)
    expect(job(h, id)).toMatchObject({ state: 'failed', done: 1 })
    expect(String(job(h, id).error)).toContain('이번 달 무료 사용량이 확인되지 않아')
    expect(h.nai.generateCalls).toHaveLength(1)
    expect(h.nai.fixed).toBe(1000) // 잔액 그대로
  })

  it('사용량이 소진(isNegative)으로 바뀌어도 같다', async () => {
    const { h, token } = await ready()
    await setPrepared(h, 'main', sampleRequest({ model: V5 }))
    h.nai.generateQueue.push(zipReply('1'))
    h.nai.generateQueue.push(async (call) => {
      h.nai.usage = { percent: 3, isNegative: true, timeUntilNextPercent: 100 }
      return zipReply('2')(call)
    })
    const id = await start(h, token, mainJob(6))
    await h.runAlarms(60)
    expect(job(h, id)).toMatchObject({ state: 'failed', done: 2 })
    expect(String(job(h, id).error)).toContain('무료 사용량을 모두 써서')
    expect(h.nai.generateCalls).toHaveLength(2)
  })

  it('V5 에서 Anlas 가 직전 확인보다 줄었으면 바로 멈추고 클라우드 생성을 끈다 (첫 장 직후가 아니어도)', async () => {
    const { h, token } = await ready()
    await setPrepared(h, 'main', sampleRequest({ model: V5 }))
    h.nai.generateQueue.push(zipReply('1'))
    h.nai.generateQueue.push(zipReply('2'))
    h.nai.generateQueue.push(async (call) => {
      h.nai.fixed -= 7 // 세 번째 장에서 처음으로 Anlas 가 나갔다
      return zipReply('3')(call)
    })
    const id = await start(h, token, mainJob(10))
    await h.runAlarms(60)
    expect(job(h, id)).toMatchObject({ state: 'failed', done: 3 })
    expect(job(h, id).error).toBe('Anlas가 차감되어 중단했습니다')
    expect(h.nai.generateCalls).toHaveLength(3) // 네 번째 장 전의 확인에서 멈춘다
    expect((await h.pcJson('GET', '/api/pc/info')).json.settings.cloudGenEnabled).toBe(false)
  })
})

describe('Anlas 잔액 필드를 못 읽으면 멈춘다 (불확실하면 생성하지 않는다)', () => {
  const noSteps = (): Response =>
    Response.json({ tier: 3, usage: { percent: 80, isNegative: false, timeUntilNextPercent: 10 } })

  for (const [name, body] of [
    [
      'trainingStepsLeft 가 없음',
      { tier: 3, usage: { percent: 80, isNegative: false, timeUntilNextPercent: 10 } }
    ],
    [
      '한 필드만 있음',
      {
        tier: 3,
        trainingStepsLeft: { fixedTrainingStepsLeft: 100 },
        usage: { percent: 80, isNegative: false, timeUntilNextPercent: 10 }
      }
    ],
    [
      'purchased 만 있음',
      {
        tier: 3,
        trainingStepsLeft: { purchasedTrainingSteps: 5 },
        usage: { percent: 80, isNegative: false, timeUntilNextPercent: 10 }
      }
    ],
    [
      '숫자가 아님(문자열)',
      {
        tier: 3,
        trainingStepsLeft: { fixedTrainingStepsLeft: '100', purchasedTrainingSteps: '0' },
        usage: { percent: 80, isNegative: false, timeUntilNextPercent: 10 }
      }
    ],
    [
      'null',
      {
        tier: 3,
        trainingStepsLeft: null,
        usage: { percent: 80, isNegative: false, timeUntilNextPercent: 10 }
      }
    ]
  ] as const) {
    it(`${name} → 한 장도 만들지 않고 「${ANLAS_UNKNOWN_ERROR}」`, async () => {
      for (const model of ['nai-diffusion-4-5-full', V5]) {
        const { h, token } = await ready()
        await setPrepared(h, 'main', sampleRequest({ model }))
        h.nai.subscriptionQueue.push(() => Response.json(body))
        const id = await start(h, token, mainJob(3))
        await h.runAlarms()
        expect(job(h, id), model).toMatchObject({
          state: 'failed',
          done: 0,
          error: ANLAS_UNKNOWN_ERROR
        })
        expect(h.nai.generateCalls, model).toHaveLength(0)
        // 잔액을 몰라서 멈춘 것 — 클라우드 생성을 끄지는 않는다
        expect((await h.pcJson('GET', '/api/pc/info')).json.settings.cloudGenEnabled, model).toBe(
          true
        )
      }
    })
  }

  it('예전 결함 재현: 잔액 필드가 없는 채로 장당 Anlas 가 빠지는 상황에서도 한 장도 보내지 않는다', async () => {
    const { h, token } = await ready()
    h.nai.spendPerImage = 5
    for (let i = 0; i < 10; i++) h.nai.subscriptionQueue.push(noSteps)
    const id = await start(h, token, mainJob(4))
    await h.runAlarms()
    expect(job(h, id).state).toBe('failed')
    expect(h.nai.generateCalls).toHaveLength(0)
    expect(h.nai.fixed).toBe(1000)
  })

  it('잔액이 0 이어도 숫자로 읽히면 통과한다 (0 은 「모름」이 아니다)', async () => {
    const { h, token } = await ready()
    h.nai.fixed = 0
    h.nai.purchased = 0
    const id = await start(h, token, mainJob(1))
    await h.runAlarms()
    expect(job(h, id)).toMatchObject({ state: 'done', done: 1 })
  })

  it('첫 장을 만든 직후의 확인에서 잔액 필드가 사라졌어도 나머지 장을 멈춘다', async () => {
    const { h, token } = await ready()
    // 첫 장 전 확인은 정상, 직후 확인에서 필드 없음
    h.nai.subscriptionQueue.push(() =>
      Response.json({
        tier: 3,
        trainingStepsLeft: { fixedTrainingStepsLeft: 1000, purchasedTrainingSteps: 0 },
        usage: { percent: 80, isNegative: false, timeUntilNextPercent: 10 }
      })
    )
    h.nai.subscriptionQueue.push(noSteps)
    const id = await start(h, token, mainJob(3))
    await h.runAlarms()
    expect(job(h, id)).toMatchObject({ state: 'failed', done: 1, error: ANLAS_UNKNOWN_ERROR })
    expect(h.nai.generateCalls).toHaveLength(1)
  })
})

describe('NAI 토큰이 바뀌면 진행 중인 작업은 다음 장 전에 반드시 다시 확인한다', () => {
  const NEW_TOKEN = 'pst-new-account-0123456789abcdef'

  /** 10장짜리 작업을 3장까지 진행시킨 상태 (다음 장은 index 3 이라 원래는 확인하지 않는 자리) */
  async function threeDone(): Promise<{ h: Harness; token: string; id: string }> {
    const { h, token } = await ready()
    const id = await start(h, token, mainJob(10))
    for (let i = 0; i < 3; i++) await handleAlarm(h.deps)
    expect(job(h, id)).toMatchObject({ state: 'cloud', done: 3 })
    expect(h.nai.subscriptionCalls).toHaveLength(2) // 첫 장 전 · 첫 장 직후
    return { h, token, id }
  }

  it('다른 계정의 토큰으로 바뀌면 다음 장 전에 구독을 확인하고, 새 토큰으로 보낸다. 잔액이 달라도 감소로 오해하지 않는다', async () => {
    const { h, id } = await threeDone()
    const epoch = Number(h.kv('nai:epoch'))
    expect(h.kv(`anlas:${id}`)).toBe(`${epoch}:1000`) // 확인을 마친 세대와 그때의 잔액이 함께 묶여 있다
    expect((await h.pcJson('PUT', '/api/pc/nai-token', { token: NEW_TOKEN })).status).toBe(200)
    expect(Number(h.kv('nai:epoch'))).toBe(epoch + 1) // 토큰이 바뀌면 세대가 올라간다 — 작업 기록은 낡은 세대가 된다
    expect(h.kv(`anlas:${id}`)).toBe(`${epoch}:1000`) // 작업 기록은 건드리지 않는다 (판단은 생성 쪽이 한다)
    h.nai.fixed = 400 // 새 계정의 잔액은 더 적다 — 감소가 아니다

    await handleAlarm(h.deps)
    expect(h.nai.subscriptionCalls).toHaveLength(3)
    expect(h.nai.subscriptionCalls[2].headers['authorization']).toBe(`Bearer ${NEW_TOKEN}`)
    expect(h.nai.generateCalls).toHaveLength(4)
    expect(h.nai.generateCalls[3].headers['authorization']).toBe(`Bearer ${NEW_TOKEN}`)
    expect(job(h, id)).toMatchObject({ state: 'cloud', done: 4 })
    expect(h.kv(`verify:${id}`)).toBeNull()
    expect(h.kv(`anlas:${id}`)).toBe(`${epoch + 1}:400`) // 새 세대·새 기준값

    // 이후는 평소대로 (5장째 index 4 는 확인 자리가 아니다)
    await handleAlarm(h.deps)
    expect(h.nai.subscriptionCalls).toHaveLength(3)
    // 새 계정에서 Anlas 가 줄면 그때는 멈춘다
    h.nai.fixed = 300
    await h.runAlarms(60)
    expect(job(h, id).error).toBe('Anlas가 차감되어 중단했습니다')
  })

  it('Opus 가 아닌 계정으로 바뀌면 그 다음 장은 한 장도 보내지 않는다', async () => {
    const { h, id } = await threeDone()
    await h.pcJson('PUT', '/api/pc/nai-token', { token: NEW_TOKEN })
    h.nai.tier = 2
    await h.runAlarms()
    expect(job(h, id)).toMatchObject({ state: 'failed', done: 3 })
    expect(String(job(h, id).error)).toContain('Opus 구독이 아니어서')
    expect(h.nai.generateCalls).toHaveLength(3)
  })

  it('무료 사용량이 바닥난 계정(V5)으로 바뀌어도 막는다', async () => {
    const { h, token } = await ready()
    await setPrepared(h, 'main', sampleRequest({ model: V5 }))
    const id = await start(h, token, mainJob(5))
    for (let i = 0; i < 2; i++) await handleAlarm(h.deps)
    await h.pcJson('PUT', '/api/pc/nai-token', { token: NEW_TOKEN })
    h.nai.usage = { percent: 2, isNegative: true, timeUntilNextPercent: 10 }
    await h.runAlarms()
    expect(job(h, id)).toMatchObject({ state: 'failed', done: 2 })
    expect(h.nai.generateCalls).toHaveLength(2)
  })

  it('같은 토큰을 다시 올리면(PC 가 켜질 때마다 그럴 수 있다) 세대도 그대로이고 확인을 강제하지 않는다', async () => {
    const { h, id } = await threeDone()
    const epoch = h.kv('nai:epoch')
    await h.pcJson('PUT', '/api/pc/nai-token', { token: NAI_TOKEN })
    expect(h.kv('nai:epoch')).toBe(epoch)
    await handleAlarm(h.deps)
    expect(h.nai.subscriptionCalls).toHaveLength(2)
    expect(job(h, id).done).toBe(4)
  })

  it('다른 토큰을 거쳐 같은 토큰으로 되돌려도 세대는 둘 다 올라가 다시 확인한다 (그 사이 다른 계정이었다)', async () => {
    const { h, id } = await threeDone()
    const epoch = Number(h.kv('nai:epoch'))
    await h.pcJson('PUT', '/api/pc/nai-token', { token: NEW_TOKEN })
    await h.pcJson('PUT', '/api/pc/nai-token', { token: NAI_TOKEN })
    expect(Number(h.kv('nai:epoch'))).toBe(epoch + 2)
    await handleAlarm(h.deps)
    expect(h.nai.subscriptionCalls).toHaveLength(3)
    expect(h.nai.subscriptionCalls[2].headers['authorization']).toBe(`Bearer ${NAI_TOKEN}`)
    expect(job(h, id).done).toBe(4)
    expect(h.kv(`anlas:${id}`)).toBe(`${epoch + 2}:1000`)
  })

  it('토큰을 지우면 세대가 올라가고, 작업은 실패로 닫히며 작업별 임시값도 남지 않는다', async () => {
    const { h, id } = await threeDone()
    await h.pcJson('PUT', '/api/pc/nai-token', { token: NEW_TOKEN })
    const epoch = Number(h.kv('nai:epoch'))
    await h.pcJson('DELETE', '/api/pc/nai-token')
    expect(Number(h.kv('nai:epoch'))).toBe(epoch + 1)
    expect(job(h, id)).toMatchObject({ state: 'failed', error: 'NAI 토큰이 없음' })
    expect(
      h.sql.exec(`SELECT k FROM kv WHERE k LIKE 'anlas:%' OR k LIKE 'verify:%'`).toArray()
    ).toEqual([])
  })

  it('작업이 없어도 세대는 올라가기만 한다 (값이 없으면 0 에서 시작)', async () => {
    const h = new Harness()
    expect(h.kv('nai:epoch')).toBeNull()
    await h.pcJson('PUT', '/api/pc/nai-token', { token: NAI_TOKEN })
    expect(h.kv('nai:epoch')).toBe('1')
    await h.pcJson('PUT', '/api/pc/nai-token', { token: NEW_TOKEN })
    await h.pcJson('DELETE', '/api/pc/nai-token')
    await h.pcJson('PUT', '/api/pc/nai-token', { token: NEW_TOKEN })
    expect(h.kv('nai:epoch')).toBe('4')
  })
})

// 예전 결함: 토큰을 바꾸면 작업마다 verify 표시를 세웠고, 구독 확인이 끝나면 그 표시를 지웠다.
// 확인 응답을 기다리는 사이 토큰이 바뀌면 새 표시가 지워져 V5 가 아닌 모델에서 확인 없이 최대 4장이 나갔다.
describe('구독 확인 응답을 기다리는 사이 토큰이 바뀌어도 다음 장 전에 반드시 다시 확인한다 (경합)', () => {
  const NEW_TOKEN = 'pst-new-account-0123456789abcdef'
  const bearer = (call: NaiCall): string => call.headers['authorization']

  /** 다음 구독 확인의 응답을 기다리는 사이 PC 가 다른 계정의 토큰을 맡기는 NAI */
  function swapDuringNextCheck(h: Harness): void {
    h.nai.subscriptionQueue.push(async () => {
      expect((await h.pcJson('PUT', '/api/pc/nai-token', { token: NEW_TOKEN })).status).toBe(200)
      return h.nai.subscriptionReply()
    })
  }
  const normalCheck = (h: Harness): void =>
    void h.nai.subscriptionQueue.push(() => h.nai.subscriptionReply())

  it('첫 장 전 확인 중에 바뀌면: 첫 장은 확인한 옛 토큰으로 나가고, 그다음 장 전에 새 토큰으로 다시 확인한다 (Opus 가 아니면 한 장도 더 안 나간다)', async () => {
    const { h, token } = await ready()
    const id = await start(h, token, mainJob(10))
    swapDuringNextCheck(h)
    await handleAlarm(h.deps)
    expect(job(h, id)).toMatchObject({ state: 'cloud', done: 1 })
    // 첫 장 전 확인과 첫 장 직후 확인은 둘 다 그 장을 시작할 때의 토큰(확인이 끝난 옛 계정)으로 갔다
    expect(h.nai.subscriptionCalls.map(bearer)).toEqual([
      `Bearer ${NAI_TOKEN}`,
      `Bearer ${NAI_TOKEN}`
    ])
    expect(bearer(h.nai.generateCalls[0])).toBe(`Bearer ${NAI_TOKEN}`)

    h.nai.tier = 2 // 새 계정은 Opus 가 아니다
    await h.runAlarms()
    expect(h.nai.subscriptionCalls).toHaveLength(3)
    expect(bearer(h.nai.subscriptionCalls[2])).toBe(`Bearer ${NEW_TOKEN}`)
    expect(job(h, id)).toMatchObject({ state: 'failed', done: 1 })
    expect(String(job(h, id).error)).toContain('Opus 구독이 아니어서')
    expect(h.nai.generateCalls).toHaveLength(1) // 두 번째 장은 나가지 않았다
  })

  it('첫 장 직후 확인 중에 바뀌어도 같다 — 예전에는 여기서 표시가 지워져 4장이 확인 없이 나갔다', async () => {
    const { h, token } = await ready()
    const id = await start(h, token, mainJob(10))
    normalCheck(h) // 첫 장 전
    swapDuringNextCheck(h) // 첫 장 직후
    await handleAlarm(h.deps)
    expect(job(h, id)).toMatchObject({ state: 'cloud', done: 1 })
    expect(h.nai.subscriptionCalls).toHaveLength(2)

    h.nai.tier = 2
    await h.runAlarms()
    expect(h.nai.subscriptionCalls).toHaveLength(3)
    expect(bearer(h.nai.subscriptionCalls[2])).toBe(`Bearer ${NEW_TOKEN}`)
    expect(job(h, id)).toMatchObject({ state: 'failed', done: 1 })
    expect(h.nai.generateCalls).toHaveLength(1)
  })

  it('5장째(index 5)의 정기 확인 중에 바뀌어도 같다', async () => {
    const { h, token } = await ready()
    const id = await start(h, token, mainJob(10))
    for (let i = 0; i < 5; i++) await handleAlarm(h.deps)
    expect(job(h, id)).toMatchObject({ state: 'cloud', done: 5 })
    expect(h.nai.subscriptionCalls).toHaveLength(2) // 첫 장 전 · 첫 장 직후
    swapDuringNextCheck(h) // 6번째 장(index 5) 전 확인
    await handleAlarm(h.deps)
    expect(job(h, id)).toMatchObject({ state: 'cloud', done: 6 })
    expect(h.nai.subscriptionCalls).toHaveLength(3)

    h.nai.tier = 2
    await h.runAlarms()
    expect(h.nai.subscriptionCalls).toHaveLength(4)
    expect(bearer(h.nai.subscriptionCalls[3])).toBe(`Bearer ${NEW_TOKEN}`)
    expect(job(h, id)).toMatchObject({ state: 'failed', done: 6 })
    expect(h.nai.generateCalls).toHaveLength(6)
  })

  it('확인 중에 바뀌고 새 계정이 Opus 라면 이어 간다. 새 계정의 잔액이 더 적어도 감소로 오해하지 않고, 확인은 한 번만 더 한다', async () => {
    const { h, token } = await ready()
    const id = await start(h, token, mainJob(10))
    normalCheck(h)
    swapDuringNextCheck(h)
    await handleAlarm(h.deps)
    const epoch = Number(h.kv('nai:epoch'))
    expect(h.kv(`anlas:${id}`)).toBe(`${epoch - 1}:1000`) // 낡은 세대에서 잰 기준값

    h.nai.fixed = 400
    await handleAlarm(h.deps)
    expect(job(h, id)).toMatchObject({ state: 'cloud', done: 2 })
    expect(h.nai.subscriptionCalls).toHaveLength(3)
    expect(bearer(h.nai.generateCalls[1])).toBe(`Bearer ${NEW_TOKEN}`)
    expect(h.kv(`anlas:${id}`)).toBe(`${epoch}:400`)

    await handleAlarm(h.deps) // 세대가 맞으니 평소대로 (index 2 는 확인 자리가 아니다)
    expect(h.nai.subscriptionCalls).toHaveLength(3)
    expect(job(h, id).done).toBe(3)
    // 새 세대의 기준값으로는 감소를 알아본다
    h.nai.fixed = 300
    await h.runAlarms(60)
    expect(job(h, id).error).toBe('Anlas가 차감되어 중단했습니다')
  })

  it('확인 중에 토큰을 지우면 작업은 실패로 닫히고 더 보내지 않는다', async () => {
    const { h, token } = await ready()
    const id = await start(h, token, mainJob(10))
    h.nai.subscriptionQueue.push(async () => {
      await h.pcJson('DELETE', '/api/pc/nai-token')
      return h.nai.subscriptionReply()
    })
    await handleAlarm(h.deps)
    await h.runAlarms()
    expect(job(h, id).state).toBe('failed')
    expect(h.nai.generateCalls.length).toBeLessThanOrEqual(1)
  })

  it('작업 기록이 없거나 옛 형식(세대 없음)이면 평소 자리가 아니어도 한 번 확인하고 새 형식으로 쓴다', async () => {
    const { h, token } = await ready()
    const id = await start(h, token, mainJob(10))
    for (let i = 0; i < 3; i++) await handleAlarm(h.deps)
    expect(h.nai.subscriptionCalls).toHaveLength(2)
    const epoch = Number(h.kv('nai:epoch'))
    h.sql.exec(`UPDATE kv SET v = '1000' WHERE k = ?`, `anlas:${id}`) // 세대가 없던 옛 기준값
    await handleAlarm(h.deps)
    expect(h.nai.subscriptionCalls).toHaveLength(3)
    expect(h.kv(`anlas:${id}`)).toBe(`${epoch}:1000`)
    h.sql.exec(`DELETE FROM kv WHERE k = ?`, `anlas:${id}`)
    await handleAlarm(h.deps)
    expect(h.nai.subscriptionCalls).toHaveLength(4)
    expect(h.kv(`anlas:${id}`)).toBe(`${epoch}:1000`)
  })
})

describe('폰에서 고친 메인 프롬프트는 클라우드 생성에 얹힌다 (PC 가 반영하기 전에도)', () => {
  it('메인 작업: 통짜 프롬프트와 네거티브', async () => {
    const { h, token } = await ready()
    expect(
      (
        await h.phone(token, 'PATCH', '/api/main', {
          prompt: 'EDITED_PROMPT',
          negativePrompt: 'EDITED_NEG'
        })
      ).status
    ).toBe(200)
    await start(h, token, mainJob(1))
    await h.runAlarms()
    const payload = payloadOf(h.nai.generateCalls[0])
    expect(payload.input).toBe('EDITED_PROMPT')
    expect(payload.parameters.negative_prompt).toBe('EDITED_NEG')
    // 대조: 편집 전 값은 어디에도 없다
    expect(h.nai.generateCalls[0].body).not.toContain('1girl, solo')
    expect(h.nai.generateCalls[0].body).not.toContain('lowres')
  })

  it('메인 작업: 분할 모드면 세 칸을 합친 프롬프트로', async () => {
    const { h, token } = await ready()
    const parts = { base: 'b0', additional: 'a0', detail: 'd0' }
    await setPrepared(
      h,
      'main',
      sampleRequest({ prompt: mergePromptParts(parts), promptParts: parts })
    )
    const edited = { base: 'B1', additional: 'A1', detail: 'D1' }
    await h.phone(token, 'PATCH', '/api/main', { promptParts: edited })
    await start(h, token, mainJob(1))
    await h.runAlarms()
    expect(payloadOf(h.nai.generateCalls[0]).input).toBe(mergePromptParts(edited))
  })

  it('씬 작업: 메인 프롬프트가 기본 부분에 얹히고, 폰에서 고친 씬 프롬프트와 함께 다시 합쳐진다', async () => {
    const { h, token } = await ready()
    await h.phone(token, 'PATCH', '/api/main', { prompt: 'NEW BASE', negativePrompt: 'NEW NEG' })
    await h.phone(token, 'PATCH', '/api/scenes/1', {
      prompt: 'scene EDITED',
      negativePrompt: 'scene neg'
    })
    await start(h, token, sceneJob(1, 1))
    await h.runAlarms()
    const payload = payloadOf(h.nai.generateCalls[0])
    expect(payload.input).toBe('NEW BASE, scene EDITED')
    expect(payload.parameters.negative_prompt).toBe('NEW NEG, scene neg')
  })

  it('씬 작업 · 분할 모드: 세 칸 + 씬 프롬프트(디테일 뒤)', async () => {
    const { h, token } = await ready()
    const parts = { base: 'b0', additional: 'a0', detail: 'd0' }
    await setPrepared(
      h,
      'scene:1',
      sampleSceneRequest(1, {
        prompt: 'b0, a0, d0, scene prompt 1',
        promptParts: { base: 'b0', additional: 'a0', detail: 'd0, scene prompt 1' },
        sceneBasePrompt: mergePromptParts(parts),
        sceneBasePromptParts: parts,
        sceneBaseAdditionalPrompt: 'a0'
      })
    )
    const edited = { base: 'B1', additional: 'A1', detail: 'D1' }
    await h.phone(token, 'PATCH', '/api/main', { promptParts: edited })
    await start(h, token, sceneJob(1, 1))
    await h.runAlarms()
    expect(payloadOf(h.nai.generateCalls[0]).input).toBe('B1, A1, D1, scene prompt 1')
  })

  it('PC 가 반영(ack)한 뒤에도 PC 가 새 완성 요청을 올리기 전까지는 계속 얹는다 — 올라온 뒤에는 그 값이 쓰인다', async () => {
    const { h, token } = await ready()
    await h.phone(token, 'PATCH', '/api/main', { prompt: 'EDITED_PROMPT' })
    const polled = await h.pcPoll()
    await h.pcJson('POST', '/api/pc/ack', { opIds: polled.ops.map((o) => o.id), jobs: [] })
    expect(h.sql.exec(`SELECT COUNT(*) AS n FROM ops WHERE acked = 0`).one().n).toBe(0)
    // ack 직후 (완성 요청은 아직 옛 것 '1girl, solo') — 예전에는 옛 프롬프트로 나갔다
    await start(h, token, mainJob(1))
    await h.runAlarms()
    expect(payloadOf(h.nai.generateCalls[0]).input).toBe('EDITED_PROMPT')
    // PC 가 새 완성 요청을 올리면(PC 에서 더 고친 값) 그 값이 쓰인다 — 옛 패치로 되돌리지 않는다
    h.tick(20_000)
    await setPrepared(h, 'main', sampleRequest({ prompt: 'PC_LATER_EDIT' }))
    await start(h, token, mainJob(1))
    await h.runAlarms()
    expect(payloadOf(h.nai.generateCalls[1]).input).toBe('PC_LATER_EDIT')
  })

  it('캐릭터 편집은 완성 요청에 얹지 못한다 — 생성은 올라온 캐릭터 그대로이고 응답에 안내가 온다', async () => {
    const { h, token } = await ready()
    await setPrepared(
      h,
      'main',
      sampleRequest({
        characterPrompts: [
          {
            prompt: 'hana, black hair',
            negativePrompt: '',
            enabled: true,
            center: { x: 0.5, y: 0.5 }
          }
        ]
      })
    )
    await h.phone(token, 'PATCH', '/api/characters/10', { enabled: false, prompt: 'changed hana' })
    const made = await h.phoneJson(token, 'POST', '/api/jobs', mainJob(1))
    expect(made.json.notice).toBe('캐릭터 편집은 PC가 켜져 반영된 뒤부터 클라우드 생성에 쓰입니다')
    await h.runAlarms()
    const body = h.nai.generateCalls[0].body as string
    expect(body).toContain('hana, black hair')
    expect(body).not.toContain('changed hana')
  })
})

// 예전 결함: 폰의 main:update 덧입힘이 PC 가 ack 하기 전 편집에만 걸려, ack 한 뒤 PC 가 새 완성 요청을 올리기 전(약 20초)에는
// 옛 프롬프트로 생성됐다. 이제 ack 된 패치와 ack 시각을 main:lastPatch 에 남기고, 그 완성 요청 행이 ack 뒤로 새로 올라오기 전까지 얹는다.
describe('ack 된 메인 편집은 완성 요청이 새로 올라오기 전까지 계속 얹힌다 (ack 직후 틈)', () => {
  /** PC 가 poll 로 받은 편집을 전부 반영(ack)한다 → 그 줄 번호들 */
  async function pcAcksEdits(h: Harness): Promise<number[]> {
    const polled = await h.pcPoll()
    const opIds = polled.ops.map((o) => o.id)
    await h.pcJson('POST', '/api/pc/ack', { opIds, jobs: [] })
    return opIds
  }
  const lastPatch = (h: Harness): Dict | null => {
    const saved = h.kv('main:lastPatch')
    return saved ? JSON.parse(saved) : null
  }
  const updatedAt = (h: Harness, key: string): number | null =>
    h.sql
      .exec<{ updated_at: number | null }>(`SELECT updated_at FROM prepared WHERE key = ?`, key)
      .one().updated_at
  const inputOf = (h: Harness, index: number): string => payloadOf(h.nai.generateCalls[index]).input
  const negativeOf = (h: Harness, index: number): string =>
    payloadOf(h.nai.generateCalls[index]).parameters.negative_prompt

  it('ack 한 패치와 ack 시각이 main:lastPatch 에 남고, 같은 ack 를 다시 보내도 시각이 밀리지 않는다', async () => {
    const { h, token } = await ready()
    expect(h.kv('main:lastPatch')).toBeNull()
    await h.phone(token, 'PATCH', '/api/main', { prompt: 'P1', negativePrompt: 'N1' })
    h.tick(3000)
    const ids = await pcAcksEdits(h)
    expect(lastPatch(h)).toEqual({
      patch: { prompt: 'P1', negativePrompt: 'N1' },
      ackedAt: h.clock
    })
    const saved = h.kv('main:lastPatch')
    h.tick(10_000)
    await h.pcJson('POST', '/api/pc/ack', { opIds: ids, jobs: [] }) // ack 재시도
    expect(h.kv('main:lastPatch')).toBe(saved)
  })

  it('main:update 가 아닌 줄만 ack 하면 남기지 않는다', async () => {
    const { h, token } = await ready()
    await h.phone(token, 'PATCH', '/api/scenes/1', { prompt: 'only scene' })
    await pcAcksEdits(h)
    expect(h.kv('main:lastPatch')).toBeNull()
  })

  it('메인 작업: ack 직후(완성 요청은 아직 옛 것)에도 고친 프롬프트·네거티브로 나간다', async () => {
    const { h, token } = await ready()
    await h.phone(token, 'PATCH', '/api/main', {
      prompt: 'EDITED_PROMPT',
      negativePrompt: 'EDITED_NEG'
    })
    await pcAcksEdits(h)
    await start(h, token, mainJob(2))
    await h.runAlarms()
    for (const index of [0, 1]) {
      expect(inputOf(h, index)).toBe('EDITED_PROMPT')
      expect(negativeOf(h, index)).toBe('EDITED_NEG')
    }
    expect(h.nai.generateCalls[0].body).not.toContain('1girl, solo')
  })

  it('씬 작업도 ack 직후에 메인 편집 + 씬 프롬프트로 나간다 (씬 완성 요청의 기본 부분에 얹힘)', async () => {
    const { h, token } = await ready()
    await h.phone(token, 'PATCH', '/api/main', { prompt: 'NEW BASE', negativePrompt: 'NEW NEG' })
    await pcAcksEdits(h)
    await start(h, token, sceneJob(1, 1))
    await h.runAlarms()
    expect(inputOf(h, 0)).toBe('NEW BASE, scene prompt 1')
    expect(negativeOf(h, 0)).toBe('NEW NEG')
  })

  it('분할 모드: ack 직후에도 세 칸 + 씬 프롬프트로 나간다', async () => {
    const { h, token } = await ready()
    const parts = { base: 'b0', additional: 'a0', detail: 'd0' }
    await setPrepared(
      h,
      'scene:1',
      sampleSceneRequest(1, {
        prompt: 'b0, a0, d0, scene prompt 1',
        promptParts: { base: 'b0', additional: 'a0', detail: 'd0, scene prompt 1' },
        sceneBasePrompt: mergePromptParts(parts),
        sceneBasePromptParts: parts,
        sceneBaseAdditionalPrompt: 'a0'
      })
    )
    await h.phone(token, 'PATCH', '/api/main', {
      promptParts: { base: 'B1', additional: 'A1', detail: 'D1' }
    })
    await pcAcksEdits(h)
    await start(h, token, sceneJob(1, 1))
    await h.runAlarms()
    expect(inputOf(h, 0)).toBe('B1, A1, D1, scene prompt 1')
  })

  it('PC 가 그 완성 요청 행을 ack 뒤에 다시 올리면 덧입힘을 멈춘다 — PC 에서 더 고친 값을 옛 패치로 되돌리지 않는다', async () => {
    const { h, token } = await ready()
    await h.phone(token, 'PATCH', '/api/main', { prompt: 'FROM_PHONE' })
    await pcAcksEdits(h)
    await start(h, token, mainJob(1))
    await h.runAlarms()
    expect(inputOf(h, 0)).toBe('FROM_PHONE')
    h.tick(25_000)
    await setPrepared(h, 'main', sampleRequest({ prompt: 'FROM_PC_LATER' }))
    expect(updatedAt(h, 'main')).toBe(h.clock)
    await start(h, token, mainJob(1))
    await h.runAlarms()
    expect(inputOf(h, 1)).toBe('FROM_PC_LATER')
  })

  it('행마다 따로 본다 — 메인이 먼저 올라와도 아직 안 올라온 씬에는 계속 얹고, 올라온 씬은 PC 값을 쓴다', async () => {
    const { h, token } = await ready()
    await h.phone(token, 'PATCH', '/api/main', { prompt: 'NEW BASE' })
    await pcAcksEdits(h)
    h.tick(20_000)
    await setPrepared(h, 'main', sampleRequest({ prompt: 'NEW BASE' })) // 메인만 먼저 올라온 첫 묶음
    await start(h, token, sceneJob(1, 1))
    await h.runAlarms()
    expect(inputOf(h, 0)).toBe('NEW BASE, scene prompt 1') // 씬 1 의 완성 요청은 아직 옛 것 → 계속 얹음

    h.tick(1000)
    await setPrepared(
      h,
      'scene:1',
      sampleSceneRequest(1, { prompt: 'PC BASE, scene prompt 1', sceneBasePrompt: 'PC BASE' })
    )
    await start(h, token, sceneJob(1, 1))
    h.tick(1) // 작업 순서(만든 시각)를 가른다
    await start(h, token, sceneJob(2, 1))
    await h.runAlarms()
    expect(inputOf(h, 1)).toBe('PC BASE, scene prompt 1') // 올라온 씬은 PC 값
    expect(inputOf(h, 2)).toBe('NEW BASE, scene prompt 2') // 아직인 씬은 계속 얹음
  })

  it('내용이 그대로인 재전송은 갱신으로 치지 않고 행의 시각도 그대로다 (쓰기 행도 늘지 않는다)', async () => {
    const { h, token } = await ready()
    await h.phone(token, 'PATCH', '/api/main', { prompt: 'EDITED_PROMPT' })
    await pcAcksEdits(h)
    expect(updatedAt(h, 'main')).toBe(T0) // seedPc 가 올린 시각
    h.tick(5000)
    h.sql.resetStats()
    // seedPc 와 해시·내용이 같은 'main' 을 다시 보낸다
    await h.pcJson('PUT', '/api/pc/prepared', { items: [preparedItem('main', sampleRequest())] })
    expect(h.sql.stats().written).toBe(0)
    expect(updatedAt(h, 'main')).toBe(T0)
    await start(h, token, mainJob(1))
    await h.runAlarms()
    expect(inputOf(h, 0)).toBe('EDITED_PROMPT')
  })

  it('prepared.updated_at 은 내용이 바뀐 행만 갱신한다', async () => {
    const { h } = await ready()
    expect(updatedAt(h, 'scene:1')).toBe(T0)
    h.tick(7000)
    await setPrepared(h, 'main', sampleRequest({ prompt: 'changed' }))
    expect(updatedAt(h, 'main')).toBe(T0 + 7000)
    expect(updatedAt(h, 'scene:1')).toBe(T0) // 건드리지 않은 행
    expect(updatedAt(h, 'scene:2')).toBe(T0)
  })

  it('시각이 없는 옛 행은 어떤 ack 보다도 오래된 것으로 본다 (그래서 계속 얹는다)', async () => {
    const { h, token } = await ready()
    h.sql.exec(`UPDATE prepared SET updated_at = NULL`)
    await h.phone(token, 'PATCH', '/api/main', { prompt: 'EDITED_PROMPT' })
    await pcAcksEdits(h)
    await start(h, token, mainJob(1))
    await h.runAlarms()
    expect(inputOf(h, 0)).toBe('EDITED_PROMPT')
  })

  it('완성 요청이 올라오기 전에 ack 된 편집이 연달아 오면 합쳐서 얹는다 (한 쪽 칸만 남기는 규칙 포함)', async () => {
    const { h, token } = await ready()
    await h.phone(token, 'PATCH', '/api/main', { prompt: 'A' })
    await pcAcksEdits(h)
    h.tick(5000)
    await h.phone(token, 'PATCH', '/api/main', { negativePrompt: 'B' })
    await pcAcksEdits(h)
    expect(lastPatch(h)).toEqual({ patch: { prompt: 'A', negativePrompt: 'B' }, ackedAt: h.clock })
    await start(h, token, mainJob(1))
    await h.runAlarms()
    expect(inputOf(h, 0)).toBe('A')
    expect(negativeOf(h, 0)).toBe('B')

    h.tick(1000)
    const parts = { base: 'x', additional: 'y', detail: 'z' }
    await h.phone(token, 'PATCH', '/api/main', { promptParts: parts })
    await pcAcksEdits(h)
    expect(lastPatch(h)?.patch).toEqual({ negativePrompt: 'B', promptParts: parts }) // 분할이 통짜를 대신한다
  })

  it('완성 요청이 이미 새로 올라온 뒤의 ack 는 옛 패치를 이어 받지 않는다', async () => {
    const { h, token } = await ready()
    await h.phone(token, 'PATCH', '/api/main', { prompt: 'A' })
    await pcAcksEdits(h)
    h.tick(25_000)
    await setPrepared(h, 'main', sampleRequest({ prompt: 'PC_NOW' })) // PC 가 A 를 반영하고 다시 고친 값
    h.tick(60_000)
    await h.phone(token, 'PATCH', '/api/main', { negativePrompt: 'B' })
    await pcAcksEdits(h)
    expect(lastPatch(h)?.patch).toEqual({ negativePrompt: 'B' }) // 옛 프롬프트 A 는 끝난 패치 — 버린다
    await start(h, token, mainJob(1))
    await h.runAlarms()
    expect(inputOf(h, 0)).toBe('PC_NOW')
    expect(negativeOf(h, 0)).toBe('B')
  })

  it('아직 PC 가 받지 않은 새 편집이 있으면 그것이 ack 된 패치보다 우선한다', async () => {
    const { h, token } = await ready()
    await h.phone(token, 'PATCH', '/api/main', { prompt: 'ACKED', negativePrompt: 'ACKED_NEG' })
    await pcAcksEdits(h)
    await h.phone(token, 'PATCH', '/api/main', { prompt: 'NEWER' }) // 미반영
    await start(h, token, mainJob(1))
    await h.runAlarms()
    expect(inputOf(h, 0)).toBe('NEWER')
    expect(negativeOf(h, 0)).toBe('ACKED_NEG') // 미반영 편집에 없는 칸은 ack 된 패치가 채운다
  })

  it('씬 프롬프트·해상도 편집(scene:update)은 ack 직후에도 DO 사본 씬으로 다시 합쳐져 문제없다', async () => {
    const { h, token } = await ready()
    await h.phone(token, 'PATCH', '/api/scenes/1', {
      prompt: 'scene EDITED',
      negativePrompt: 'scene neg',
      width: 640,
      height: 960
    })
    await pcAcksEdits(h)
    expect(h.sql.exec(`SELECT COUNT(*) AS n FROM ops WHERE acked = 0`).one().n).toBe(0)
    // 완성 요청의 씬 부분은 옛 값 그대로 — 생성은 DO 의 씬 사본(폰 편집이 이미 들어 있다)으로 다시 합친다
    await start(h, token, sceneJob(1, 1))
    await h.runAlarms()
    expect(inputOf(h, 0)).toBe('base tags, scene EDITED')
    expect(negativeOf(h, 0)).toBe('lowres, scene neg')
    const sent = payloadOf(h.nai.generateCalls[0]).parameters
    expect([sent.width, sent.height]).toEqual([640, 960])
  })
})

describe('mergeMainPatch (순수 함수)', () => {
  const parts = { base: 'b', additional: 'a', detail: 'd' }

  it('새 값이 이기고, 안 건드린 칸은 남는다', () => {
    expect(mergeMainPatch({ prompt: 'x', negativePrompt: 'n' }, { negativePrompt: 'm' })).toEqual({
      prompt: 'x',
      negativePrompt: 'm'
    })
  })

  it('새 패치가 분할이면 옛 통짜를, 통짜면 옛 분할을 버린다', () => {
    expect(mergeMainPatch({ prompt: 'x', negativePrompt: 'n' }, { promptParts: parts })).toEqual({
      negativePrompt: 'n',
      promptParts: parts
    })
    expect(mergeMainPatch({ promptParts: parts }, { prompt: 'y' })).toEqual({ prompt: 'y' })
    // 둘 다 오면 둘 다 둔다
    expect(mergeMainPatch({ prompt: 'x' }, { prompt: 'y', promptParts: parts })).toEqual({
      prompt: 'y',
      promptParts: parts
    })
  })

  it('입력을 바꾸지 않는다', () => {
    const old = { prompt: 'x' }
    mergeMainPatch(old, { promptParts: parts })
    expect(old).toEqual({ prompt: 'x' })
  })
})

describe('overlayMainPatch (순수 함수)', () => {
  const base = (over: Partial<GenerationRequest> = {}): GenerationRequest =>
    sampleRequest(over) as unknown as GenerationRequest

  it('메인: 비어 있는 패치는 그대로, 네거티브만 바꿀 수 있다', () => {
    const request = base()
    expect(overlayMainPatch(request, {}, { type: 'main' })).toEqual(request)
    expect(overlayMainPatch(request, { negativePrompt: 'n' }, { type: 'main' })).toMatchObject({
      prompt: '1girl, solo',
      negativePrompt: 'n'
    })
  })

  it('메인 · 후타 재조립 계획이 실린 요청은 폰에서 고친 글에도 같은 치환을 다시 적용한다', () => {
    const request = base({
      prompt: '2girls, futa with female, kiss',
      futaPlan: {
        counts: { futa: 1, female: 1, male: 0 },
        viewFix: true,
        dedupePenis: false
      }
    })
    const out = overlayMainPatch(request, { prompt: '1girl, 1boy, hetero, kiss' }, { type: 'main' })
    expect(out.prompt).toBe('2girls, futa with female, kiss')
    // 계획이 없으면 폰에서 고친 글 그대로다
    expect(
      overlayMainPatch(base(), { prompt: '1girl, 1boy, hetero, kiss' }, { type: 'main' }).prompt
    ).toBe('1girl, 1boy, hetero, kiss')
  })

  it('메인 · 분할: 분할 프롬프트는 칸으로, 통짜 프롬프트만 오면 첫 칸으로 (PC 의 규칙)', () => {
    const parts = { base: 'b', additional: 'a', detail: 'd' }
    const request = base({ prompt: 'b, a, d', promptParts: parts })
    const byParts = overlayMainPatch(
      request,
      { promptParts: { base: '1', additional: '2', detail: '3' } },
      { type: 'main' }
    )
    expect(byParts).toMatchObject({
      prompt: '1, 2, 3',
      promptParts: { base: '1', additional: '2', detail: '3' }
    })
    const byText = overlayMainPatch(request, { prompt: 'only text' }, { type: 'main' })
    expect(byText.prompt).toBe('only text')
    expect(byText.promptParts).toEqual({ base: 'only text', additional: '', detail: '' })
    // 분할이 아닌 요청에 분할 패치만 오면 합친 글로
    const plain = overlayMainPatch(base(), { promptParts: parts }, { type: 'main' })
    expect(plain.prompt).toBe('b, a, d')
    expect(plain.promptParts).toBeUndefined()
  })

  it('씬: 예약 당시 기본 부분(sceneBase*)에 얹고 실제 prompt 는 refreshScenePrompts 가 다시 만들게 둔다', () => {
    const request = base({
      sceneId: 1,
      prompt: 'base tags, scene',
      sceneBasePrompt: 'base tags',
      sceneBaseNegativePrompt: 'lowres'
    })
    const out = overlayMainPatch(
      request,
      { prompt: 'NEW', negativePrompt: 'NEG' },
      { type: 'scene', sceneId: 1 }
    )
    expect(out).toMatchObject({
      sceneBasePrompt: 'NEW',
      sceneBaseNegativePrompt: 'NEG',
      prompt: 'base tags, scene'
    })
  })

  it('씬 · 기본 부분이 없는 옛 요청은 건드리지 않는다', () => {
    const request = base({ sceneId: 1 })
    expect(overlayMainPatch(request, { prompt: 'NEW' }, { type: 'scene', sceneId: 1 })).toEqual(
      request
    )
  })
})

describe('429 — Retry-After 를 notBefore 로 저장해 어떤 알람이 와도 그 전에는 만들지 않는다', () => {
  it('429 직후 새 작업을 만들어 알람이 당겨져도 NAI 를 부르지 않고, 때가 되면 이어 간다', async () => {
    const { h, token } = await ready()
    h.nai.generateQueue.push(reply(429, 'slow', { 'retry-after': '120' }))
    const a = await start(h, token, mainJob(1))
    await handleAlarm(h.deps)
    expect(h.kv('nai:notBefore')).toBe(String(T0 + 120_000))
    expect(h.pendingAlarm).toBe(T0 + 120_000)
    expect(h.nai.generateCalls).toHaveLength(1)
    expect(h.kv(`rl:${a}`)).toBe('1')
    const subscriptions = h.nai.subscriptionCalls.length

    h.tick(20_000)
    const b = await start(h, token, mainJob(1)) // ensureAlarm(now) 이 알람을 당긴다
    expect(h.pendingAlarm).toBe(T0 + 20_000)
    expect(await h.runAlarms(1)).toBe(1)
    expect(h.nai.generateCalls).toHaveLength(1) // 쉬는 중 — 생성도
    expect(h.nai.subscriptionCalls).toHaveLength(subscriptions) // 구독 확인도 하지 않는다
    expect(h.kv(`rl:${a}`)).toBe('1') // 재시도 횟수도 소모되지 않았다
    expect(h.pendingAlarm).toBe(T0 + 120_000) // 풀리는 시각으로 다시 건다
    expect(job(h, a).attempts).toBe(0)

    await h.runAlarms()
    expect(job(h, a).state).toBe('done')
    expect(job(h, b).state).toBe('done')
    expect(h.nai.generateCalls).toHaveLength(3)
    expect(h.kv('nai:notBefore')).toBeNull() // 성공하면 지운다
  })

  it('runCloudStep 을 직접 불러도 쉬는 동안은 아무것도 하지 않고 남은 시간을 돌려준다', async () => {
    const { h, token } = await ready()
    h.nai.generateQueue.push(reply(429, '', { 'retry-after': '60' }))
    await start(h, token, mainJob(1))
    await handleAlarm(h.deps)
    h.tick(10_000)
    const calls = h.nai.calls.length
    expect(await runCloudStep(h.deps)).toEqual({ again: true, delayMs: 50_000 })
    expect(h.nai.calls).toHaveLength(calls)
  })

  it('쉬는 시간이 지난 뒤에는 막지 않는다. 6번 넘게 429 면 그 장을 건너뛴다 (기존 동작)', async () => {
    const { h, token } = await ready()
    for (let i = 0; i < 7; i++) h.nai.generateQueue.push(reply(429, '', { 'retry-after': '1' }))
    const id = await start(h, token, mainJob(1))
    await h.runAlarms(30)
    expect(job(h, id)).toMatchObject({ state: 'failed', failed: 1 })
    expect(h.nai.generateCalls).toHaveLength(7)
  })

  it('생성이 꺼지거나 토큰이 없으면 쉬는 중이어도 작업을 실패로 닫는다', async () => {
    const { h, token } = await ready()
    h.nai.generateQueue.push(reply(429, '', { 'retry-after': '300' }))
    const id = await start(h, token, mainJob(2))
    await handleAlarm(h.deps)
    await h.pcJson('PUT', '/api/pc/settings', { cloudGenEnabled: false, keepImages: 2000 })
    h.tick(1000)
    await handleAlarm(h.deps)
    expect(job(h, id).state).toBe('failed')
  })
})

describe('순차 조각 카운터는 그림 저장에 성공한 뒤에만 저장한다', () => {
  async function withSeq(): Promise<{ h: Harness; token: string }> {
    const { h, token } = await ready()
    await h.pcJson('PUT', '/api/pc/fragments', { byPath: { seq: ['A1', 'B2', 'C3'] }, hash: 'f1' })
    await setPrepared(h, 'main', sampleRequest({ prompt: '<*seq>' }))
    return { h, token }
  }
  const inputs = (h: Harness): string[] => h.nai.generateCalls.map((c) => payloadOf(c).input)

  it('429 로 다시 시도해도 줄이 소모되지 않는다 (A1 이 두 번 나가고 그림은 A1, B2, C3)', async () => {
    const { h, token } = await withSeq()
    h.nai.generateQueue.push(reply(429, '', { 'retry-after': '1' }))
    const id = await start(h, token, mainJob(3))
    await h.runAlarms()
    expect(inputs(h)).toEqual(['A1', 'A1', 'B2', 'C3'])
    expect(job(h, id)).toMatchObject({ state: 'done', done: 3 })
    expect(h.kv('seq:seq')).toBe('3')
    // 저장된 그림의 요청도 A1, B2, C3 순서
    expect(h.imageRows().map((r) => JSON.parse(r.sent_payload as string).input)).toEqual([
      'A1',
      'B2',
      'C3'
    ])
  })

  it('네트워크 예외로 다시 시도해도 소모되지 않는다', async () => {
    const { h, token } = await withSeq()
    h.nai.generateQueue.push(() => {
      throw new TypeError('fetch failed')
    })
    await start(h, token, mainJob(2))
    await h.runAlarms()
    expect(inputs(h)).toEqual(['A1', 'A1', 'B2'])
    expect(h.kv('seq:seq')).toBe('2')
  })

  it('NAI 가 오류로 답해 그 장을 건너뛰면 그 줄은 쓰이지 않은 것이다', async () => {
    const { h, token } = await withSeq()
    h.nai.generateQueue.push(reply(500, 'boom'))
    const id = await start(h, token, mainJob(3))
    await h.runAlarms()
    expect(inputs(h)).toEqual(['A1', 'A1', 'B2'])
    expect(job(h, id)).toMatchObject({ state: 'done', done: 2, failed: 1 })
    expect(h.kv('seq:seq')).toBe('2')
  })

  it('만드는 동안 작업이 취소돼 결과를 버렸으면 카운터도 그대로', async () => {
    const { h, token } = await withSeq()
    let release: () => void = () => undefined
    h.nai.generateQueue.push(async (call) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return zipReply('late')(call)
    })
    const id = await start(h, token, mainJob(1))
    const running = handleAlarm(h.deps)
    await new Promise((r) => setTimeout(r, 0))
    await h.phoneJson(token, 'POST', `/api/jobs/${id}/cancel`)
    release()
    await running
    expect(job(h, id).state).toBe('cancelled')
    expect(h.kv('seq:seq')).toBeNull()
  })
})
