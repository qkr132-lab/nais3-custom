import { describe, expect, it } from 'vitest'
import { Harness, sampleLibrary, seedPc } from './helpers/harness'

/**
 * 폰 편집이 PC에 반영되지 못해도(반영 실패 → ack 직후 PC 가 꺼짐) 폰 사본이 PC 실제 값으로 돌아오게 —
 * 워커는 반영 실패 줄의 ack 를 받을 때 그 대상 해시를 지우고, PC 는 다음 동기화(다시 켰을 때 포함)에서
 * 해시가 달라 실제 값을 다시 올린다. 폰 편집만으로는 해시를 지우지 않는다 (PC 가 반영하면 어차피 해시가 바뀐다)
 */
describe('반영 실패 ack 뒤 해시 지움 (되돌림 보장)', () => {
  async function setup(): Promise<{ h: Harness; token: string }> {
    const h = new Harness()
    await seedPc(h)
    const token = await h.pair()
    return { h, token }
  }

  async function hashes(h: Harness): Promise<Record<string, unknown>> {
    const { json } = await h.pcJson('GET', '/api/pc/hashes')
    return json
  }

  /** PC 의 poll — 이번에 받은 편집 줄 번호 */
  async function pollOps(h: Harness): Promise<number[]> {
    const poll = (
      await h.pcJson('POST', '/api/pc/poll', {
        protocol: 1,
        appVersion: 't',
        queue: {
          running: false,
          pending: 0,
          generating: 0,
          done: 0,
          failed: 0,
          generatingSceneId: null,
          updatedAt: h.clock
        },
        acceptsJobs: true,
        activeJobIds: []
      })
    ).json
    return (poll.ops as { id: number }[]).map((op) => op.id)
  }

  it('폰 편집만으로는 해시를 지우지 않는다', async () => {
    const { h, token } = await setup()
    const chars = (await h.phoneJson(token, 'GET', '/api/state')).json.library.characters
    expect((await h.phone(token, 'PATCH', '/api/scenes/1', { name: '폰' })).status).toBe(200)
    expect(
      (await h.phone(token, 'PATCH', `/api/characters/${chars[0].id}`, { enabled: false })).status
    ).toBe(200)
    expect((await h.phone(token, 'PATCH', '/api/main', { prompt: 'x' })).status).toBe(200)
    const after = await hashes(h)
    expect(after.scenes).toEqual({ '1': 'scenes-1', '2': 'scenes-2' })
    expect(after.library).toBe('lib-1')
  })

  it('씬 편집의 반영 실패 ack 는 그 프리셋 해시만 지우고, 다른 프리셋·라이브러리 해시는 그대로', async () => {
    const { h, token } = await setup()
    await h.phone(token, 'PATCH', '/api/scenes/1', { name: '폰에서 바꾼 이름' })
    const [opId] = await pollOps(h)
    await h.pcJson('POST', '/api/pc/ack', { opIds: [opId], failedOpIds: [opId], jobs: [] })
    const after = await hashes(h)
    expect(after.scenes).toEqual({ '2': 'scenes-2' })
    expect(after.library).toBe('lib-1')
  })

  it('반영에 성공한 ack 는 해시를 지우지 않는다. 이미 ack 된 줄을 실패로 다시 보내도 지우지 않는다', async () => {
    const { h, token } = await setup()
    await h.phone(token, 'PATCH', '/api/main', { prompt: '반영된 메인' })
    const [opId] = await pollOps(h)
    await h.pcJson('POST', '/api/pc/ack', { opIds: [opId], jobs: [] })
    expect((await hashes(h)).library).toBe('lib-1')
    await h.pcJson('POST', '/api/pc/ack', { opIds: [opId], failedOpIds: [opId], jobs: [] })
    expect((await hashes(h)).library).toBe('lib-1')
  })

  it('캐릭터·메인 편집의 반영 실패 ack 는 라이브러리 해시를 지운다', async () => {
    const { h, token } = await setup()
    const chars = (await h.phoneJson(token, 'GET', '/api/state')).json.library.characters
    await h.phone(token, 'PATCH', `/api/characters/${chars[0].id}`, { enabled: false })
    let [opId] = await pollOps(h)
    await h.pcJson('POST', '/api/pc/ack', { opIds: [opId], failedOpIds: [opId], jobs: [] })
    expect((await hashes(h)).library).toBeNull()

    // PC 가 실제 값으로 다시 올리면 해시가 돌아오고, 메인 편집의 반영 실패는 다시 지운다
    await h.pcJson('PUT', '/api/pc/library', { library: sampleLibrary(), hash: 'lib-1' })
    expect((await hashes(h)).library).toBe('lib-1')
    await h.phone(token, 'PATCH', '/api/main', { prompt: 'x' })
    ;[opId] = await pollOps(h)
    await h.pcJson('POST', '/api/pc/ack', { opIds: [opId], failedOpIds: [opId], jobs: [] })
    expect((await hashes(h)).library).toBeNull()
  })

  it('반영 실패로 ack 된 편집은 PC 의 재업로드로 PC 값이 된다 (워커 재시작 뒤에도)', async () => {
    const { h, token } = await setup()
    const before = (await h.phoneJson(token, 'GET', '/api/state')).json.library.characters[0]
    await h.phone(token, 'PATCH', `/api/characters/${before.id}`, { enabled: !before.enabled })
    // PC 가 받아 반영 실패 → ack (failedOpIds 로 알림)
    const [opId] = await pollOps(h)
    await h.pcJson('POST', '/api/pc/ack', { opIds: [opId], failedOpIds: [opId], jobs: [] })
    h.restartInstance()
    // 해시가 지워져 있으니 PC 는 다음 동기화(앱 재시작 포함)에서 실제 라이브러리를 다시 올린다
    expect((await hashes(h)).library).toBeNull()
    await h.pcJson('PUT', '/api/pc/library', { library: sampleLibrary(), hash: 'lib-1' })
    const now = (await h.phoneJson(token, 'GET', '/api/state')).json.library.characters[0]
    expect(now.enabled).toBe(before.enabled)
  })

  it('반영 실패한 메인 편집은 클라우드 생성 덧입힘(main:lastPatch)에 남지 않는다', async () => {
    const { h, token } = await setup()
    await h.phone(token, 'PATCH', '/api/main', { prompt: '폰이 고친 메인' })
    const [opId] = await pollOps(h)
    await h.pcJson('POST', '/api/pc/ack', { opIds: [opId], failedOpIds: [opId], jobs: [] })
    const row = h.sql
      .exec<{ v: string }>(`SELECT v FROM kv WHERE k = 'main:lastPatch'`)
      .toArray()[0]
    expect(row).toBeUndefined()

    // 성공한 편집은 그대로 남는다 (대조)
    await h.phone(token, 'PATCH', '/api/main', { prompt: '반영된 메인' })
    const [id2] = await pollOps(h)
    await h.pcJson('POST', '/api/pc/ack', { opIds: [id2], jobs: [] })
    const row2 = h.sql
      .exec<{ v: string }>(`SELECT v FROM kv WHERE k = 'main:lastPatch'`)
      .toArray()[0]
    expect(JSON.parse(row2.v).patch.prompt).toBe('반영된 메인')
  })
})
