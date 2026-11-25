import { describe, expect, it } from 'vitest'
import type {
  CloudCreateJobResponse,
  CloudLibrary,
  CloudNaiInfo,
  CloudQuota
} from '../../src/shared/cloud-contract'
import {
  Harness,
  NAI_TOKEN,
  T0,
  enableCloudGen,
  sampleLibrary,
  seedPc,
  type Dict
} from './helpers/harness'

const MIN = 60_000

const usage = (percent: number, isNegative = false): CloudNaiInfo['opusUsage'] => ({
  percent,
  isNegative,
  timeUntilNextPercent: 3600
})

/** PC 가 잔액 조회 결과를 library.naiInfo 로 올린다 */
async function putNaiInfo(h: Harness, info: CloudNaiInfo | null): Promise<void> {
  const library: CloudLibrary = { ...sampleLibrary(), naiInfo: info }
  await h.pcJson('PUT', '/api/pc/library', { library, hash: `lib-${h.clock}` })
}

/** 클라우드가 NAI 구독을 확인하고 남긴 값(kv nai:quota)을 직접 놓는다 */
function putCloudQuota(h: Harness, value: unknown): void {
  h.sql.exec(
    `INSERT INTO kv (k, v) VALUES ('nai:quota', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
    typeof value === 'string' ? value : JSON.stringify(value)
  )
}

/** PC 용 정보와 폰 상태가 같은 값을 주는지까지 함께 본다 */
async function quotaOf(h: Harness, token: string): Promise<CloudQuota | null> {
  const fromPc = (await h.pcJson('GET', '/api/pc/info')).json.quota as CloudQuota | null
  const fromPhone = (await h.phoneJson(token, 'GET', '/api/state')).json.cloudGen
    .quota as CloudQuota | null
  expect(fromPhone).toEqual(fromPc)
  return fromPc
}

describe('무료 사용량(quota) 알림', () => {
  it('클라우드가 확인한 적도, PC 가 올린 값도 없으면 null', async () => {
    const h = new Harness()
    const token = await h.pair()
    expect(await quotaOf(h, token)).toBeNull()
    // 라이브러리가 올라와도 naiInfo 가 없으면 그대로 null
    await putNaiInfo(h, null)
    expect(await quotaOf(h, token)).toBeNull()
  })

  it('클라우드가 30분 안에 확인한 값이 PC 가 올린 값보다 먼저다', async () => {
    const h = new Harness()
    const token = await h.pair()
    await putNaiInfo(h, { tier: 'Opus', anlas: 4000, opusUsage: usage(80), updatedAt: T0 })
    putCloudQuota(h, { state: 'exhausted', checkedAt: T0 })
    h.tick(30 * MIN - 1)
    expect(await quotaOf(h, token)).toEqual({ state: 'exhausted', checkedAt: T0 })
    // 30분이 되면 그 값은 묵은 것 — PC 가 올린 값으로 바뀐다
    h.tick(1)
    expect(await quotaOf(h, token)).toEqual({ state: 'available', checkedAt: T0 })
  })

  it('PC 가 올린 Opus 사용량을 quotaState 로 바꾼다 (checkedAt = naiInfo.updatedAt)', async () => {
    const h = new Harness()
    const token = await h.pair()
    const cases: [CloudNaiInfo['opusUsage'], CloudQuota['state']][] = [
      [usage(40), 'available'],
      [usage(0), 'unknown'], // 0% 이면서 초과 사용도 아님 — 장담 못 함
      [usage(12, true), 'exhausted']
    ]
    for (const [opusUsage, state] of cases) {
      const updatedAt = T0 - 5 * MIN
      await putNaiInfo(h, { tier: 'Opus', anlas: 100, opusUsage, updatedAt })
      expect(await quotaOf(h, token)).toEqual({ state, checkedAt: updatedAt })
    }
  })

  it('PC 가 새로 올리면 다음 조회부터 바뀐 값이 보인다', async () => {
    const h = new Harness()
    const token = await h.pair()
    await putNaiInfo(h, { tier: 'Opus', anlas: 100, opusUsage: usage(40), updatedAt: T0 })
    expect(await quotaOf(h, token)).toMatchObject({ state: 'available' })
    h.tick(MIN)
    await putNaiInfo(h, { tier: 'Opus', anlas: 100, opusUsage: usage(3, true), updatedAt: h.clock })
    expect(await quotaOf(h, token)).toEqual({ state: 'exhausted', checkedAt: h.clock })
  })

  it('PC 가 사용량(opusUsage)을 모르거나 모양이 깨져 있으면 없는 것으로 본다', async () => {
    const h = new Harness()
    const token = await h.pair()
    await putNaiInfo(h, { tier: 'Opus', anlas: 100, opusUsage: null, updatedAt: T0 })
    expect(await quotaOf(h, token)).toBeNull()
    // 모양이 깨진 값 (JSON 을 거치므로 타입은 믿을 수 없다)
    const broken = {
      tier: 'Opus',
      anlas: 1,
      opusUsage: { percent: 'many' },
      updatedAt: T0
    } as unknown as CloudNaiInfo
    await putNaiInfo(h, broken)
    expect(await quotaOf(h, token)).toBeNull()
    await putNaiInfo(h, { ...broken, opusUsage: usage(50), updatedAt: 'now' as unknown as number })
    expect(await quotaOf(h, token)).toBeNull()
  })

  it('PC 값이 없고 클라우드 확인값이 묵었으면, 그 값을 checkedAt 과 함께 그대로 알려 준다', async () => {
    const h = new Harness()
    const token = await h.pair()
    putCloudQuota(h, { state: 'available', checkedAt: T0 })
    h.tick(3 * 60 * MIN)
    expect(await quotaOf(h, token)).toEqual({ state: 'available', checkedAt: T0 })
  })

  it('kv 값이 깨졌거나 모양이 틀리면 없는 것으로 본다', async () => {
    const h = new Harness()
    const token = await h.pair()
    for (const bad of [
      'not json',
      '[]',
      'null',
      { state: 'maybe', checkedAt: T0 },
      { state: 'available' },
      { state: 'available', checkedAt: 'now' }
    ]) {
      putCloudQuota(h, bad)
      expect(await quotaOf(h, token)).toBeNull()
    }
    // 깨진 kv 가 있어도 PC 가 올린 값이 있으면 그걸 쓴다
    putCloudQuota(h, { state: 'available' })
    await putNaiInfo(h, { tier: 'Opus', anlas: 100, opusUsage: usage(20), updatedAt: T0 })
    expect(await quotaOf(h, token)).toEqual({ state: 'available', checkedAt: T0 })
  })

  it('토큰을 다시 올리면 클라우드 확인값이 지워져 PC 가 올린 값으로 돌아간다', async () => {
    const h = new Harness()
    const token = await h.pair()
    await putNaiInfo(h, { tier: 'Opus', anlas: 100, opusUsage: usage(60), updatedAt: T0 - MIN })
    putCloudQuota(h, { state: 'exhausted', checkedAt: T0 })
    expect(await quotaOf(h, token)).toEqual({ state: 'exhausted', checkedAt: T0 })
    await h.pcJson('PUT', '/api/pc/nai-token', { token: NAI_TOKEN })
    expect(await quotaOf(h, token)).toEqual({ state: 'available', checkedAt: T0 - MIN })
  })

  it('실제 클라우드 생성이 확인한 값이 곧바로 PC 정보·폰 상태에 실린다', async () => {
    const h = new Harness()
    await seedPc(h)
    await enableCloudGen(h)
    const token = await h.pair()
    expect(await quotaOf(h, token)).toBeNull()
    h.nai.usage = { percent: 55, isNegative: false, timeUntilNextPercent: 100 }
    await h.phoneJson(token, 'POST', '/api/jobs', {
      target: { type: 'main' },
      count: 1,
      place: 'cloud'
    })
    await h.runAlarms()
    expect(await quotaOf(h, token)).toEqual({ state: 'available', checkedAt: T0 })
  })

  it('폰의 「지금 불가」 이유는 클라우드가 직접 확인한 최근 값만 따른다 (PC 가 올린 값은 표시용)', async () => {
    const h = new Harness()
    const token = await h.pair()
    await h.pcJson('PUT', '/api/pc/settings', { cloudGenEnabled: true, keepImages: 2000 })
    await h.pcJson('PUT', '/api/pc/nai-token', { token: NAI_TOKEN })
    await putNaiInfo(h, { tier: 'Opus', anlas: 100, opusUsage: usage(9, true), updatedAt: T0 })
    const cloudGen = async (): Promise<Dict> =>
      (await h.phoneJson(token, 'GET', '/api/state')).json.cloudGen
    expect(await cloudGen()).toEqual({
      enabled: true,
      hasNaiToken: true,
      ready: true,
      reason: null,
      quota: { state: 'exhausted', checkedAt: T0 }
    })
    putCloudQuota(h, { state: 'exhausted', checkedAt: T0 })
    expect(await cloudGen()).toMatchObject({
      ready: false,
      reason: '이번 달 무료 사용량을 모두 썼습니다',
      quota: { state: 'exhausted', checkedAt: T0 }
    })
  })

  it('quota 는 어떤 응답에도 토큰을 싣지 않는다', async () => {
    const h = new Harness()
    const token = await h.pair()
    await h.pcJson('PUT', '/api/pc/nai-token', { token: NAI_TOKEN })
    putCloudQuota(h, { state: 'available', checkedAt: T0 })
    const texts = [
      await (await h.pc('GET', '/api/pc/info')).text(),
      await (await h.phone(token, 'GET', '/api/state')).text()
    ]
    for (const text of texts) expect(text).not.toContain(NAI_TOKEN)
  })
})

describe('POST /api/jobs 응답 (CloudCreateJobResponse)', () => {
  const JOB_KEYS = [
    'count',
    'createdAt',
    'done',
    'error',
    'failed',
    'id',
    'label',
    'place',
    'runner',
    'state',
    'target',
    'updatedAt'
  ]

  it('{ ok, job } 에 PC 가 꺼진 채 pc 로 보낸 때만 notice 가 붙는다', async () => {
    const h = new Harness()
    await seedPc(h)
    await enableCloudGen(h)
    const token = await h.pair()
    const make = async (place: string): Promise<{ status: number; json: Dict }> =>
      h.phoneJson(token, 'POST', '/api/jobs', {
        target: { type: 'scene', sceneId: 1 },
        count: 1,
        place
      })

    // PC 꺼짐 + pc 지정 → 안내가 붙는다
    const offline = await make('pc')
    expect(offline.status).toBe(200)
    expect(Object.keys(offline.json).sort()).toEqual(['job', 'notice', 'ok'])
    const typed = offline.json as { ok: true } & CloudCreateJobResponse
    expect(typed.notice).toBe('PC가 꺼져 있습니다. PC가 켜지면 생성합니다.')
    expect(Object.keys(typed.job).sort()).toEqual(JOB_KEYS)

    // 클라우드 지정 → notice 키 자체가 없다
    const cloud = await make('cloud')
    expect(Object.keys(cloud.json).sort()).toEqual(['job', 'ok'])
    expect(Object.keys(cloud.json.job).sort()).toEqual(JOB_KEYS)

    // PC 켜짐 + pc 지정 → notice 없음
    await h.pcPoll()
    const online = await make('pc')
    expect(Object.keys(online.json).sort()).toEqual(['job', 'ok'])
    expect(online.json.job).toMatchObject({ state: 'queued', runner: 'pc' })
  })
})
