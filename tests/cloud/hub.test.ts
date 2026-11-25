import { describe, expect, it } from 'vitest'
import { PAIR_ALPHABET } from '../../cloud/src/core/auth'
import { sha256Hex } from '../../cloud/src/core/util'
import {
  Harness,
  NAI_TOKEN,
  ORIGIN,
  PC_SECRET,
  T0,
  base64UrlJson,
  enableCloudGen,
  preparedItem,
  sampleLibrary,
  sampleRequest,
  sampleScene,
  sampleSceneRequest,
  seedPc,
  uploadPcImage,
  type Dict
} from './helpers/harness'

const MIN = 60_000

/** 인증 없이 그대로 보내 본 응답이 한국어 오류 본문인지 확인 */
async function expectError(response: Response, status: number): Promise<Dict> {
  expect(response.status).toBe(status)
  const body = (await response.json()) as Dict
  expect(body.ok).toBe(false)
  expect(typeof body.error).toBe('string')
  expect(/[가-힣]/.test(body.error)).toBe(true)
  return body
}

describe('인증', () => {
  it('PC 비밀값이 없거나 틀리면 401, 맞으면 통과한다', async () => {
    const h = new Harness()
    await expectError(await h.call('GET', '/api/pc/info'), 401)
    await expectError(
      await h.call('GET', '/api/pc/info', { headers: { 'x-nais-pc': 'wrong' } }),
      401
    )
    await expectError(
      await h.call('GET', '/api/pc/info', { headers: { 'x-nais-pc': PC_SECRET + 'x' } }),
      401
    )
    const ok = await h.pcJson('GET', '/api/pc/info')
    expect(ok.status).toBe(200)
    expect(ok.json).toMatchObject({
      ok: true,
      protocol: 1,
      hasNaiToken: false,
      settings: { cloudGenEnabled: false, keepImages: 2000 },
      devices: 0,
      imagesStored: 0,
      cloudJobsActive: 0,
      quota: null
    })
  })

  it('서버에 PC 비밀값이 없거나 비어 있으면 503 — 빈 헤더든 아무 헤더든 PC 경로는 전부 막힌다', async () => {
    const message = '클라우드 PC 비밀값이 설정되지 않았습니다'
    // 빈 문자열 · 공백뿐 · 아예 없음(undefined)
    for (const secret of ['', '   ', undefined]) {
      const h = new Harness({ PC_SECRET: secret })
      for (const headers of [
        {},
        { 'x-nais-pc': '' },
        { 'x-nais-pc': 'anything' },
        { 'x-nais-pc': ' ' }
      ]) {
        for (const [method, path] of [
          ['GET', '/api/pc/info'],
          ['POST', '/api/pc/poll'],
          ['PUT', '/api/pc/nai-token'],
          ['POST', '/api/pc/pairing'],
          ['GET', '/api/pc/nothing']
        ]) {
          const body = await expectError(await h.call(method, path, { headers }), 503)
          expect(body.error).toBe(message)
        }
      }
      // 아무 일도 일어나지 않았다 — 토큰이 저장되지 않고 연결 코드도 안 만들어졌다
      expect(h.kv('secret:nai')).toBeNull()
      expect(h.sql.exec(`SELECT * FROM pairing`).toArray()).toHaveLength(0)
      expect(h.kv('pc:lastSeen')).toBeNull()
    }
  })

  it('PC 비밀값이 없어도 폰 경로의 인증은 그대로다 (페어링 코드는 PC 가 만들 수 없으니 막힘)', async () => {
    const h = new Harness({ PC_SECRET: undefined })
    await expectError(await h.call('GET', '/api/state'), 401)
    await expectError(
      await h.call('POST', '/api/pair', { body: { code: 'ABCDEFGH', name: 'x' } }),
      400
    )
  })

  it('폰 토큰이 없거나 틀리면 401', async () => {
    const h = new Harness()
    for (const [method, path] of [
      ['GET', '/api/me'],
      ['GET', '/api/state'],
      ['GET', '/api/scenes?presetId=1'],
      ['GET', '/api/images'],
      ['POST', '/api/jobs'],
      ['POST', '/api/logout']
    ]) {
      await expectError(await h.call(method, path), 401)
      await expectError(await h.call(method, path, { auth: 'not-a-real-token' }), 401)
    }
    // PC 비밀값으로는 폰 API 를 못 쓴다
    await expectError(await h.call('GET', '/api/state', { auth: PC_SECRET }), 401)
  })

  it('인증 전에는 없는 경로도 401 이고, 인증 뒤에야 404·405 가 나온다', async () => {
    const h = new Harness()
    await expectError(await h.call('GET', '/api/pc/nothing'), 401)
    await expectError(await h.call('GET', '/api/nothing'), 401)
    const token = await h.pair()
    await expectError(await h.call('GET', '/api/nothing', { auth: token }), 404)
    await expectError(await h.call('DELETE', '/api/state', { auth: token }), 405)
    await expectError(await h.call('GET', '/api/pc/nothing', { auth: 'pc' }), 404)
    await expectError(await h.call('POST', '/api/pc/info', { auth: 'pc' }), 405)
    // 같은 주소에 방식만 다른 /api/pair
    await expectError(await h.call('GET', '/api/pair'), 405)
  })

  it('응답은 캐시하지 않고 CORS 헤더가 없다', async () => {
    const h = new Harness()
    const token = await h.pair()
    for (const response of [
      await h.pc('GET', '/api/pc/info'),
      await h.phone(token, 'GET', '/api/state'),
      await h.call('GET', '/api/state'),
      await h.call('POST', '/api/pair', { body: {} })
    ]) {
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('access-control-allow-origin')).toBeNull()
    }
  })

  it('기기의 last_seen 은 1분에 한 번만 쓴다', async () => {
    const h = new Harness()
    const token = await h.pair()
    const lastSeen = (): number =>
      h.sql.exec<{ last_seen: number }>(`SELECT last_seen FROM devices`).one().last_seen
    expect(lastSeen()).toBe(T0)
    h.tick(10_000)
    await h.phone(token, 'GET', '/api/me')
    expect(lastSeen()).toBe(T0)
    h.tick(51_000)
    await h.phone(token, 'GET', '/api/me')
    expect(lastSeen()).toBe(T0 + 61_000)
  })
})

describe('페어링', () => {
  it('코드는 8자리 · 혼동 없는 32자이고 주소와 QR 이 함께 온다', async () => {
    const h = new Harness()
    expect(PAIR_ALPHABET).toHaveLength(31) // 0/O/1/I/L 제외
    const { status, json } = await h.pcJson('POST', '/api/pc/pairing')
    expect(status).toBe(200)
    expect(json.code).toMatch(new RegExp(`^[${PAIR_ALPHABET}]{8}$`))
    expect(json.code).not.toMatch(/[01OIL]/)
    expect(json.url).toBe(`${ORIGIN}/#pair=${json.code}`)
    expect(json.expiresAt).toBe(T0 + 10 * MIN)
    expect(json.qrSvg.startsWith('<svg')).toBe(true)
  })

  it('코드로 연결하면 토큰이 나오고 DO 에는 해시만 남는다. 같은 코드는 다시 못 쓴다', async () => {
    const h = new Harness()
    const made = await h.pcJson('POST', '/api/pc/pairing')
    const body = { code: made.json.code, name: '  내 폰  ' }
    const done = await h.read(await h.call('POST', '/api/pair', { body }))
    expect(done.status).toBe(200)
    expect(done.json.ok).toBe(true)
    expect(done.json.token.length).toBeGreaterThanOrEqual(40)
    expect(done.json.deviceId).toMatch(/^d[a-z0-9]{10}$/)

    const me = await h.phoneJson(done.json.token, 'GET', '/api/me')
    expect(me.json).toMatchObject({ ok: true, deviceId: done.json.deviceId, name: '내 폰' })

    const stored = h.sql.exec<{ token_hash: string }>(`SELECT token_hash FROM devices`).one()
    expect(stored.token_hash).toBe(await sha256Hex(done.json.token))
    expect(JSON.stringify(h.sql.exec(`SELECT * FROM devices`).toArray())).not.toContain(
      done.json.token
    )

    await expectError(await h.call('POST', '/api/pair', { body }), 400)
  })

  it('코드는 소문자·공백·하이픈을 섞어 적어도 받아 준다', async () => {
    const h = new Harness()
    const made = await h.pcJson('POST', '/api/pc/pairing')
    const code = String(made.json.code)
    const typed = `${code.slice(0, 4).toLowerCase()} - ${code.slice(4)}`
    const done = await h.call('POST', '/api/pair', { body: { code: typed, name: '폰' } })
    expect(done.status).toBe(200)
  })

  it('10분이 지나면 만료된다', async () => {
    const h = new Harness()
    const made = await h.pcJson('POST', '/api/pc/pairing')
    h.tick(10 * MIN + 1)
    await expectError(
      await h.call('POST', '/api/pair', { body: { code: made.json.code, name: '폰' } }),
      400
    )
    expect(h.sql.exec(`SELECT * FROM devices`).toArray()).toHaveLength(0)
  })

  it('기기 이름이 1~40자가 아니면 거절하지만 4번까지는 코드가 살아 있다', async () => {
    const h = new Harness()
    const made = await h.pcJson('POST', '/api/pc/pairing')
    const code = made.json.code
    for (const name of ['', '   ', 'a'.repeat(41), 7]) {
      await expectError(await h.call('POST', '/api/pair', { body: { code, name } }), 400)
    }
    const ok = await h.call('POST', '/api/pair', { body: { code, name: 'a'.repeat(40) } })
    expect(ok.status).toBe(200)
  })

  it('실패가 5번 쌓이면 올바른 이름으로도 그 코드는 못 쓴다', async () => {
    const h = new Harness()
    const made = await h.pcJson('POST', '/api/pc/pairing')
    const code = made.json.code
    for (let i = 0; i < 5; i++) {
      await expectError(await h.call('POST', '/api/pair', { body: { code, name: '' } }), 400)
    }
    expect(h.sql.exec(`SELECT * FROM pairing`).toArray()).toHaveLength(0)
    await expectError(await h.call('POST', '/api/pair', { body: { code, name: '폰' } }), 400)
  })

  it('틀린 코드를 5번 찍으면 살아 있는 코드도 폐기된다', async () => {
    const h = new Harness()
    const made = await h.pcJson('POST', '/api/pc/pairing')
    for (let i = 0; i < 5; i++) {
      await expectError(
        await h.call('POST', '/api/pair', { body: { code: 'ZZZZZZZZ', name: '폰' } }),
        400
      )
    }
    await expectError(
      await h.call('POST', '/api/pair', { body: { code: made.json.code, name: '폰' } }),
      400
    )
  })

  it('전체 시도는 시간당 30회로 막고 한 시간 뒤에 풀린다', async () => {
    const h = new Harness()
    for (let i = 0; i < 30; i++) {
      await expectError(
        await h.call('POST', '/api/pair', { body: { code: 'ZZZZZZZZ', name: '폰' } }),
        400
      )
    }
    await expectError(
      await h.call('POST', '/api/pair', { body: { code: 'ZZZZZZZZ', name: '폰' } }),
      429
    )
    // 맞는 코드도 한도 안에서만 통한다
    const made = await h.pcJson('POST', '/api/pc/pairing')
    await expectError(
      await h.call('POST', '/api/pair', { body: { code: made.json.code, name: '폰' } }),
      429
    )
    h.tick(60 * MIN + 1)
    const ok = await h.call('POST', '/api/pair', { body: { code: made.json.code, name: '폰' } })
    // 한 시간이 지나 코드도 만료됐다 — 한도는 풀렸고 코드가 틀린 것으로 400
    expect(ok.status).toBe(400)
    const again = await h.pcJson('POST', '/api/pc/pairing')
    const ok2 = await h.call('POST', '/api/pair', { body: { code: again.json.code, name: '폰' } })
    expect(ok2.status).toBe(200)
  })

  it('새 코드를 만들면 이전 코드는 폐기된다', async () => {
    const h = new Harness()
    const first = await h.pcJson('POST', '/api/pc/pairing')
    const second = await h.pcJson('POST', '/api/pc/pairing')
    expect(second.json.code).not.toBe(first.json.code)
    await expectError(
      await h.call('POST', '/api/pair', { body: { code: first.json.code, name: '폰' } }),
      400
    )
  })

  it('기기 목록·해제: PC 가 해제하면 그 토큰은 401, 폰이 로그아웃해도 마찬가지', async () => {
    const h = new Harness()
    const a = await h.pair('폰 A')
    h.tick(1)
    const b = await h.pair('폰 B')
    const list = await h.pcJson('GET', '/api/pc/devices')
    expect(list.json.items.map((d: Dict) => d.name)).toEqual(['폰 A', '폰 B'])
    expect(list.json.items[0]).toMatchObject({ createdAt: T0, lastSeen: T0 })
    expect((await h.pcJson('GET', '/api/pc/info')).json.devices).toBe(2)

    const removed = await h.pcJson('DELETE', `/api/pc/devices/${list.json.items[0].id}`)
    expect(removed.json.items.map((d: Dict) => d.name)).toEqual(['폰 B'])
    await expectError(await h.phone(a, 'GET', '/api/me'), 401)
    expect((await h.phone(b, 'GET', '/api/me')).status).toBe(200)

    expect((await h.phone(b, 'POST', '/api/logout')).status).toBe(200)
    await expectError(await h.phone(b, 'GET', '/api/me'), 401)
    expect((await h.pcJson('GET', '/api/pc/devices')).json.items).toEqual([])
  })
})

describe('라이브러리·씬 업로드와 미반영 편집', () => {
  it('업로드한 라이브러리와 씬을 폰이 읽는다 (정렬 · 최신 그림 · 편집 대기 표시)', async () => {
    const h = new Harness()
    await seedPc(h)
    const token = await h.pair()
    const state = await h.phoneJson(token, 'GET', '/api/state')
    expect(state.json.library.presets.map((p: Dict) => p.name)).toEqual(['기본 씬', '배경'])
    expect(state.json.protocol).toBe(1)
    expect(state.json.serverTime).toBe(T0)

    // 정렬: sortOrder 순
    await h.pcJson('PUT', '/api/pc/scenes', {
      presetId: 1,
      scenes: [sampleScene(5, 1, { sortOrder: 2 }), sampleScene(4, 1, { sortOrder: 1 })],
      hash: 'scenes-1b'
    })
    await uploadPcImage(h, 100, { sceneId: 4, createdAt: T0 + 1 })
    await uploadPcImage(h, 101, { sceneId: 4, createdAt: T0 + 5 })
    await uploadPcImage(h, 102, { sceneId: 5, createdAt: T0 + 3 })
    const scenes = await h.phoneJson(token, 'GET', '/api/scenes?presetId=1')
    expect(scenes.json.items.map((s: Dict) => [s.id, s.latestImageId, s.pendingEdit])).toEqual([
      [4, 'p101', false],
      [5, 'p102', false]
    ])
    await expectError(await h.phone(token, 'GET', '/api/scenes'), 400)
  })

  it('폰 편집은 PC 가 반영하기 전까지 PC 의 새 업로드 위에 다시 얹힌다', async () => {
    const h = new Harness()
    await seedPc(h)
    const token = await h.pair()

    const patched = await h.phoneJson(token, 'PATCH', '/api/scenes/1', {
      name: '  새 이름 ',
      prompt: 'new prompt',
      width: 1024,
      height: 1024
    })
    expect(patched.status).toBe(200)
    expect(patched.json.scene).toMatchObject({
      id: 1,
      name: '새 이름',
      prompt: 'new prompt',
      width: 1024,
      height: 1024,
      pendingEdit: true,
      latestImageId: null
    })
    await h.phoneJson(token, 'PATCH', '/api/characters/11', { enabled: true, prompt: 'duri v2' })
    await h.phoneJson(token, 'PATCH', '/api/main', {
      prompt: 'new main',
      negativePrompt: 'nn',
      promptParts: { base: 'b', additional: 'a', detail: 'd' }
    })

    // PC 가 옛 값 그대로 다시 올려도 폰 편집이 남는다
    await h.pcJson('PUT', '/api/pc/library', { library: sampleLibrary(), hash: 'lib-2' })
    await h.pcJson('PUT', '/api/pc/scenes', {
      presetId: 1,
      scenes: [sampleScene(1, 1), sampleScene(2, 1)],
      hash: 'scenes-1c'
    })
    const state = await h.phoneJson(token, 'GET', '/api/state')
    expect(state.json.library.characters[1]).toMatchObject({
      id: 11,
      enabled: true,
      prompt: 'duri v2'
    })
    expect(state.json.library.characters[0]).toMatchObject({
      id: 10,
      enabled: true,
      prompt: 'hana, black hair'
    })
    expect(state.json.library.main).toMatchObject({
      prompt: 'new main',
      negativePrompt: 'nn',
      promptParts: { base: 'b', additional: 'a', detail: 'd' }
    })
    const scenes = await h.phoneJson(token, 'GET', '/api/scenes?presetId=1')
    expect(scenes.json.items[0]).toMatchObject({
      id: 1,
      name: '새 이름',
      prompt: 'new prompt',
      width: 1024,
      pendingEdit: true
    })
    expect(scenes.json.items[1]).toMatchObject({ id: 2, name: '씬 2', pendingEdit: false })

    // poll 은 편집을 id 순으로 준다
    const poll = await h.pcPoll()
    expect(poll.ops.map((o) => o.type)).toEqual(['scene:update', 'char:update', 'main:update'])
    expect(poll.ops[0]).toMatchObject({ sceneId: 1, patch: { name: '새 이름', width: 1024 } })
    expect(poll.ops[1]).toMatchObject({ charId: 11, patch: { enabled: true, prompt: 'duri v2' } })
    expect(poll.ops.map((o) => o.id)).toEqual([...poll.ops.map((o) => o.id)].sort((x, y) => x - y))

    // PC 가 반영했다고 알린 뒤에는 PC 값이 이긴다
    await h.pcJson('POST', '/api/pc/ack', { opIds: poll.ops.map((o) => o.id), jobs: [] })
    expect((await h.pcPoll()).ops).toEqual([])
    const library = sampleLibrary()
    library.characters[1].enabled = false
    await h.pcJson('PUT', '/api/pc/library', { library, hash: 'lib-3' })
    await h.pcJson('PUT', '/api/pc/scenes', {
      presetId: 1,
      scenes: [sampleScene(1, 1, { name: 'PC 이름' }), sampleScene(2, 1)],
      hash: 'scenes-1d'
    })
    const after = await h.phoneJson(token, 'GET', '/api/state')
    expect(after.json.library.characters[1].enabled).toBe(false)
    expect(after.json.library.main.prompt).toBe('1girl, solo')
    const afterScenes = await h.phoneJson(token, 'GET', '/api/scenes?presetId=1')
    expect(afterScenes.json.items[0]).toMatchObject({ name: 'PC 이름', pendingEdit: false })
  })

  it('편집 값 검사: 해상도 64배수 · 이름 길이 · 빈 편집 · 없는 대상', async () => {
    const h = new Harness()
    await seedPc(h)
    const token = await h.pair()
    for (const body of [
      { width: 1000 },
      { height: 2112 },
      { width: 32 },
      { width: 512.5 },
      { name: '   ' },
      { name: 'a'.repeat(101) },
      { prompt: 5 },
      {}
    ]) {
      await expectError(await h.phone(token, 'PATCH', '/api/scenes/1', body), 400)
    }
    await expectError(await h.phone(token, 'PATCH', '/api/scenes/999', { name: 'x' }), 404)
    await expectError(await h.phone(token, 'PATCH', '/api/characters/999', { enabled: true }), 404)
    await expectError(await h.phone(token, 'PATCH', '/api/characters/10', { enabled: 'yes' }), 400)
    await expectError(
      await h.phone(token, 'PATCH', '/api/main', { promptParts: { base: 'x' } }),
      400
    )
    await expectError(await h.phone(token, 'PATCH', '/api/main', {}), 400)
    // 라이브러리가 없으면 캐릭터·메인 편집은 받을 수 없다
    const empty = new Harness()
    const t2 = await empty.pair()
    await expectError(await empty.phone(t2, 'PATCH', '/api/main', { prompt: 'x' }), 409)
    // 거절된 편집은 줄에 남지 않는다
    expect((await h.pcPoll()).ops).toEqual([])
    expect(
      (await h.phoneJson(token, 'PATCH', '/api/scenes/1', { width: 2048, height: 64 })).status
    ).toBe(200)
  })

  it('라이브러리에 없는 프리셋의 씬·해시는 라이브러리를 올릴 때 지워진다', async () => {
    const h = new Harness()
    await seedPc(h)
    const token = await h.pair()
    expect((await h.pcJson('GET', '/api/pc/hashes')).json.scenes).toEqual({
      '1': 'scenes-1',
      '2': 'scenes-2'
    })
    const library = sampleLibrary()
    library.presets = library.presets.filter((p) => p.id === 1)
    await h.pcJson('PUT', '/api/pc/library', { library, hash: 'lib-9' })
    const hashes = await h.pcJson('GET', '/api/pc/hashes')
    expect(hashes.json.library).toBe('lib-9')
    expect(hashes.json.scenes).toEqual({ '1': 'scenes-1' })
    expect((await h.phoneJson(token, 'GET', '/api/scenes?presetId=2')).json.items).toEqual([])
    expect((await h.phoneJson(token, 'GET', '/api/scenes?presetId=1')).json.items).toHaveLength(2)
  })

  it('씬 업로드는 그 프리셋을 통째로 바꾸고, 잘못된 내용은 이전 씬을 건드리지 않는다', async () => {
    const h = new Harness()
    await seedPc(h)
    const token = await h.pair()
    await h.pcJson('PUT', '/api/pc/scenes', { presetId: 1, scenes: [sampleScene(9, 1)], hash: 'x' })
    expect(
      (await h.phoneJson(token, 'GET', '/api/scenes?presetId=1')).json.items.map((s: Dict) => s.id)
    ).toEqual([9])
    const bad = await h.pcJson('PUT', '/api/pc/scenes', {
      presetId: 1,
      scenes: [sampleScene(10, 1), { name: 'id 없음' }],
      hash: 'y'
    })
    expect(bad.status).toBe(400)
    expect(
      (await h.phoneJson(token, 'GET', '/api/scenes?presetId=1')).json.items.map((s: Dict) => s.id)
    ).toEqual([9])
    expect((await h.pcJson('PUT', '/api/pc/library', { library: {}, hash: 'z' })).status).toBe(400)
    expect((await h.pcJson('PUT', '/api/pc/library', { library: sampleLibrary() })).status).toBe(
      400
    )
  })
})

describe('poll · ack', () => {
  it('저장소가 비었으면 needsFullSync, 올리고 나면 false. poll 은 켜짐 상태를 남긴다', async () => {
    const h = new Harness()
    const token = await h.pair()
    expect((await h.phoneJson(token, 'GET', '/api/state')).json.pc).toMatchObject({
      online: false,
      lastSeen: null,
      queue: null
    })
    const first = await h.pcJson('POST', '/api/pc/poll', {
      protocol: 1,
      appVersion: '1.2.3',
      queue: {
        running: true,
        pending: 4,
        generating: 1,
        done: 2,
        failed: 0,
        generatingSceneId: 7,
        updatedAt: T0
      },
      acceptsJobs: true
    })
    expect(first.json).toMatchObject({
      ok: true,
      protocol: 1,
      serverTime: T0,
      ops: [],
      jobs: [],
      needsFullSync: true
    })
    await h.pcJson('PUT', '/api/pc/library', { library: sampleLibrary(), hash: 'l' })
    expect((await h.pcPoll()).needsFullSync).toBe(false)

    const state = await h.phoneJson(token, 'GET', '/api/state')
    expect(state.json.pc.online).toBe(true)
    expect(state.json.pc.lastSeen).toBe(T0)
    expect(state.json.pc.queue).toMatchObject({ updatedAt: T0 })
    expect(h.kv('pc:appVersion')).toBe('test')

    h.tick(14_999)
    expect((await h.phoneJson(token, 'GET', '/api/state')).json.pc.online).toBe(true)
    h.tick(1)
    expect((await h.phoneJson(token, 'GET', '/api/state')).json.pc.online).toBe(false)
    // 렌더러가 준비되지 않았으면 켜져 있어도 작업을 받을 수 없다
    await h.pcPoll(false)
    expect((await h.phoneJson(token, 'GET', '/api/state')).json.pc.online).toBe(false)
  })

  it('ack: accepted → pc, 끝나면 개수와 함께 done · failed, 취소된 작업은 되살리지 않는다', async () => {
    const h = new Harness()
    await seedPc(h)
    const token = await h.pair()
    await h.pcPoll()
    const make = async (count: number): Promise<string> => {
      h.tick(1) // 만든 시각이 달라야 poll 순서가 정해진다
      const made = await h.phoneJson(token, 'POST', '/api/jobs', {
        target: { type: 'scene', sceneId: 1 },
        count,
        place: 'auto'
      })
      return made.json.job.id
    }

    const a = await make(3)
    const b = await make(2)
    const c = await make(1)
    const poll = await h.pcPoll()
    expect(poll.jobs.map((j) => j.id)).toEqual([a, b, c])

    await h.pcJson('POST', '/api/pc/ack', {
      opIds: [],
      jobs: [
        { id: a, state: 'accepted' },
        { id: b, state: 'accepted' },
        { id: c, state: 'accepted' },
        { id: 'jnone', state: 'accepted' }
      ]
    })
    expect((await h.pcPoll()).jobs).toEqual([])
    const jobs = (): Promise<Dict> =>
      h.phoneJson(token, 'GET', '/api/state').then((r) => r.json.jobs)
    expect((await jobs()).map((j: Dict) => j.state).sort()).toEqual(['pc', 'pc', 'pc'])

    h.tick(1000)
    await h.phoneJson(token, 'POST', `/api/jobs/${c}/cancel`)
    await h.pcJson('POST', '/api/pc/ack', {
      opIds: [],
      jobs: [
        { id: a, state: 'done', done: 3, failed: 0 },
        { id: b, state: 'failed', done: 1, failed: 1, error: '큐가 비었습니다' },
        { id: c, state: 'done', done: 1, failed: 0 }
      ]
    })
    const byId = Object.fromEntries((await jobs()).map((j: Dict) => [j.id, j]))
    expect(byId[a]).toMatchObject({ state: 'done', done: 3, failed: 0, error: null })
    expect(byId[b]).toMatchObject({ state: 'failed', done: 1, failed: 1, error: '큐가 비었습니다' })
    expect(byId[c]).toMatchObject({ state: 'cancelled', done: 1 })
    // 끝난 작업에 늦은 accepted 가 와도 상태는 그대로
    await h.pcJson('POST', '/api/pc/ack', { opIds: [], jobs: [{ id: a, state: 'accepted' }] })
    expect(h.jobRow(a).state).toBe('done')
  })

  it('반영 끝난 편집 줄은 하루 뒤에 지워진다', async () => {
    const h = new Harness()
    await seedPc(h)
    const token = await h.pair()
    await h.phoneJson(token, 'PATCH', '/api/main', { prompt: 'p' })
    const poll = await h.pcPoll()
    await h.pcJson('POST', '/api/pc/ack', { opIds: poll.ops.map((o) => o.id), jobs: [] })
    expect(h.sql.exec(`SELECT * FROM ops`).toArray()).toHaveLength(1)
    // 정리는 ack 마다가 아니라 하루 한 번(poll 이나 알람이 부른다)
    h.tick(24 * 60 * MIN + 1)
    await h.pcJson('POST', '/api/pc/ack', { opIds: [], jobs: [] })
    expect(h.sql.exec(`SELECT * FROM ops`).toArray()).toHaveLength(1)
    await h.pcPoll()
    expect(h.sql.exec(`SELECT * FROM ops`).toArray()).toHaveLength(0)
  })
})

describe('작업 배정', () => {
  const sceneJob = { target: { type: 'scene', sceneId: 1 }, count: 2, place: 'auto' }

  it('PC 가 켜져 있으면 PC 에 넘긴다 (queued · runner pc · 라벨은 씬 이름)', async () => {
    const h = new Harness()
    await seedPc(h)
    const token = await h.pair()
    await h.pcPoll()
    const { status, json } = await h.phoneJson(token, 'POST', '/api/jobs', sceneJob)
    expect(status).toBe(200)
    expect(json.job).toMatchObject({
      target: { type: 'scene', sceneId: 1 },
      label: '씬 1',
      count: 2,
      done: 0,
      failed: 0,
      state: 'queued',
      place: 'auto',
      runner: 'pc',
      error: null,
      createdAt: T0
    })
    expect(json.notice).toBeUndefined()
    const main = await h.phoneJson(token, 'POST', '/api/jobs', {
      target: { type: 'main' },
      count: 1,
      place: 'pc'
    })
    expect(main.json.job).toMatchObject({ label: '메인 생성', runner: 'pc', state: 'queued' })
  })

  it('PC 가 꺼져 있고 클라우드 생성이 준비됐으면 클라우드로 보내고 알람을 건다', async () => {
    const h = new Harness()
    await seedPc(h)
    await enableCloudGen(h)
    const token = await h.pair()
    const { json } = await h.phoneJson(token, 'POST', '/api/jobs', sceneJob)
    expect(json.job).toMatchObject({ state: 'cloud', runner: 'cloud', place: 'auto' })
    expect(h.pendingAlarm).toBe(T0)
    // 메인도 같다
    const main = await h.phoneJson(token, 'POST', '/api/jobs', {
      target: { type: 'main' },
      count: 1,
      place: 'auto'
    })
    expect(main.json.job).toMatchObject({ state: 'cloud', label: '메인 생성' })
  })

  it('PC 는 켜졌어도 렌더러가 준비 안 됐으면(acceptsJobs 아님) 클라우드로 간다', async () => {
    const h = new Harness()
    await seedPc(h)
    await enableCloudGen(h)
    const token = await h.pair()
    await h.pcPoll(false)
    const { json } = await h.phoneJson(token, 'POST', '/api/jobs', sceneJob)
    expect(json.job.runner).toBe('cloud')
  })

  it('PC 가 15초 넘게 poll 안 하면 꺼진 것으로 본다', async () => {
    const h = new Harness()
    await seedPc(h)
    await enableCloudGen(h)
    const token = await h.pair()
    await h.pcPoll()
    h.tick(14_000)
    expect((await h.phoneJson(token, 'POST', '/api/jobs', sceneJob)).json.job.runner).toBe('pc')
    h.tick(1_000)
    expect((await h.phoneJson(token, 'POST', '/api/jobs', sceneJob)).json.job.runner).toBe('cloud')
  })

  it('place 를 정하면 그대로: pc 는 꺼져 있어도 queued(알림 포함), cloud 는 켜져 있어도 클라우드', async () => {
    const h = new Harness()
    await seedPc(h)
    await enableCloudGen(h)
    const token = await h.pair()
    const offline = await h.phoneJson(token, 'POST', '/api/jobs', { ...sceneJob, place: 'pc' })
    expect(offline.json.job).toMatchObject({ state: 'queued', runner: 'pc', place: 'pc' })
    expect(offline.json.notice).toContain('PC가 꺼져')
    await h.pcPoll()
    const cloud = await h.phoneJson(token, 'POST', '/api/jobs', { ...sceneJob, place: 'cloud' })
    expect(cloud.json.job).toMatchObject({ state: 'cloud', runner: 'cloud', place: 'cloud' })
  })

  it('클라우드 생성이 준비 안 됐으면 400 과 이유를 준다 (꺼짐 · 토큰 없음 · 완성 요청 없음)', async () => {
    const h = new Harness()
    await seedPc(h)
    const token = await h.pair()
    const off = await h.phone(token, 'POST', '/api/jobs', sceneJob)
    expect((await expectError(off, 400)).error).toContain('클라우드 생성이 꺼져 있습니다')

    await h.pcJson('PUT', '/api/pc/settings', { cloudGenEnabled: true, keepImages: 2000 })
    const noToken = await h.phone(token, 'POST', '/api/jobs', { ...sceneJob, place: 'cloud' })
    expect((await expectError(noToken, 400)).error).toContain('NAI 토큰')

    await h.pcJson('PUT', '/api/pc/nai-token', { token: NAI_TOKEN })
    await h.pcJson('PUT', '/api/pc/prepared', { items: [], allKeys: ['main'] })
    const noPrepared = await h.phone(token, 'POST', '/api/jobs', sceneJob)
    expect((await expectError(noPrepared, 400)).error).toContain(
      'PC가 이 씬의 생성 정보를 아직 안 올렸습니다'
    )
    // 거절된 작업은 남지 않는다
    expect(h.sql.exec(`SELECT * FROM jobs`).toArray()).toHaveLength(0)
  })

  it('요청 검사: 장수 1~20 · 대상 · 위치 · 없는 씬', async () => {
    const h = new Harness()
    await seedPc(h)
    const token = await h.pair()
    for (const body of [
      { ...sceneJob, count: 0 },
      { ...sceneJob, count: 21 },
      { ...sceneJob, count: 1.5 },
      { ...sceneJob, place: 'moon' },
      { ...sceneJob, target: { type: 'scene' } },
      { ...sceneJob, target: { type: 'album' } },
      {}
    ]) {
      await expectError(await h.phone(token, 'POST', '/api/jobs', body), 400)
    }
    await expectError(
      await h.phone(token, 'POST', '/api/jobs', {
        ...sceneJob,
        target: { type: 'scene', sceneId: 404 }
      }),
      404
    )
    expect(
      (await h.phoneJson(token, 'POST', '/api/jobs', { ...sceneJob, count: 20, place: 'pc' }))
        .status
    ).toBe(200)
  })

  it('PC 에 넘긴 auto 작업이 45초 안에 안 가져가지고 PC 가 꺼졌으면 클라우드로 넘어간다', async () => {
    const h = new Harness()
    await seedPc(h)
    await enableCloudGen(h)
    const token = await h.pair()
    await h.pcPoll()
    const made = await h.phoneJson(token, 'POST', '/api/jobs', { ...sceneJob, count: 1 })
    const id = made.json.job.id
    expect(made.json.job.runner).toBe('pc')
    expect(h.pendingAlarm).toBe(T0 + 46_000)

    await h.runAlarms()
    const job = h.jobRow(id)
    expect(job.runner).toBe('cloud')
    expect(job.state).toBe('done') // 같은 알람에서 이어서 생성까지 마쳤다
    expect(h.nai.generateCalls).toHaveLength(1)
  })

  it('PC 가 계속 켜져 있으면 넘기지 않고 그대로 둔다', async () => {
    const h = new Harness()
    await seedPc(h)
    await enableCloudGen(h)
    const token = await h.pair()
    await h.pcPoll()
    const id = (await h.phoneJson(token, 'POST', '/api/jobs', sceneJob)).json.job.id
    h.clock = T0 + 40_000
    await h.pcPoll() // 아직 살아 있다
    await h.runAlarms(1)
    expect(h.jobRow(id)).toMatchObject({ state: 'queued', runner: 'pc' })
    expect(h.nai.calls).toHaveLength(0)
    expect(h.pendingAlarm).not.toBeNull() // 꺼지는 순간을 놓치지 않게 계속 살핀다
  })

  it('place 가 pc 인 작업은 PC 가 꺼져도 클라우드로 넘기지 않는다', async () => {
    const h = new Harness()
    await seedPc(h)
    await enableCloudGen(h)
    const token = await h.pair()
    const id = (await h.phoneJson(token, 'POST', '/api/jobs', { ...sceneJob, place: 'pc' })).json
      .job.id
    h.tick(10 * MIN)
    await h.runAlarms()
    expect(h.jobRow(id)).toMatchObject({ state: 'queued', runner: 'pc' })
  })

  it('넘기려는데 클라우드 생성이 준비 안 됐으면 queued 로 둔다', async () => {
    const h = new Harness()
    await seedPc(h)
    const token = await h.pair()
    await h.pcPoll()
    const id = (await h.phoneJson(token, 'POST', '/api/jobs', sceneJob)).json.job.id
    h.tick(60_000)
    await h.runAlarms()
    expect(h.jobRow(id)).toMatchObject({ state: 'queued', runner: 'pc' })
  })

  it('취소: PC 작업은 job:cancel 편집이 줄에 서고, 끝난 작업은 그대로', async () => {
    const h = new Harness()
    await seedPc(h)
    await enableCloudGen(h)
    const token = await h.pair()
    await h.pcPoll()
    const id = (await h.phoneJson(token, 'POST', '/api/jobs', sceneJob)).json.job.id
    await h.pcJson('POST', '/api/pc/ack', { opIds: [], jobs: [{ id, state: 'accepted' }] })
    const cancelled = await h.phoneJson(token, 'POST', `/api/jobs/${id}/cancel`)
    expect(cancelled.json.job).toMatchObject({ id, state: 'cancelled' })
    const poll = await h.pcPoll()
    expect(poll.ops).toMatchObject([{ type: 'job:cancel', jobId: id }])
    expect(poll.jobs).toEqual([])

    // 클라우드 작업은 줄에 세우지 않고 바로 취소
    h.tick(20_000)
    const cloud = (await h.phoneJson(token, 'POST', '/api/jobs', sceneJob)).json.job
    expect(cloud.runner).toBe('cloud')
    expect((await h.phoneJson(token, 'POST', `/api/jobs/${cloud.id}/cancel`)).json.job.state).toBe(
      'cancelled'
    )
    expect((await h.pcPoll()).ops).toHaveLength(1)
    await h.runAlarms()
    expect(h.nai.generateCalls).toHaveLength(0)

    // 이미 끝난 작업을 또 취소해도 그대로 돌려준다
    const again = await h.phoneJson(token, 'POST', `/api/jobs/${cloud.id}/cancel`)
    expect(again.json.job.state).toBe('cancelled')
    await expectError(await h.phone(token, 'POST', '/api/jobs/jnone/cancel'), 404)
  })

  it('폰 상태의 작업 목록은 최근 30개를 갱신 순으로 준다', async () => {
    const h = new Harness()
    await seedPc(h)
    const token = await h.pair()
    await h.pcPoll()
    const ids: string[] = []
    for (let i = 0; i < 33; i++) {
      h.tick(1000)
      ids.push(
        (await h.phoneJson(token, 'POST', '/api/jobs', { ...sceneJob, count: 1, place: 'pc' })).json
          .job.id
      )
    }
    const jobs = (await h.phoneJson(token, 'GET', '/api/state')).json.jobs
    expect(jobs).toHaveLength(30)
    expect(jobs[0].id).toBe(ids[32])
    expect(jobs[29].id).toBe(ids[3])
  })
})

describe('그림', () => {
  it('PC 가 올린 그림이 폰 목록 · 원본 · 썸네일로 나온다', async () => {
    const h = new Harness()
    await seedPc(h)
    const token = await h.pair()
    const bytes = new Uint8Array([82, 73, 70, 70, 9, 8, 7, 6, 87, 69, 66, 80])
    expect(
      (await uploadPcImage(h, 1, { sceneId: 1, createdAt: T0 + 1, seed: 11 }, bytes)).status
    ).toBe(200)
    await uploadPcImage(h, 2, { sceneId: 1, createdAt: T0 + 2, seed: null })
    await uploadPcImage(h, 3, { sceneId: 2, presetId: 1, createdAt: T0 + 3 })
    await uploadPcImage(h, 4, { sceneId: null, presetId: null, createdAt: T0 + 4, kind: 't2i' })

    const all = await h.phoneJson(token, 'GET', '/api/images')
    expect(all.json.items.map((i: Dict) => i.id)).toEqual(['p4', 'p3', 'p2', 'p1'])
    expect(all.json.next).toBeNull()
    expect(all.json.items[3]).toEqual({
      id: 'p1',
      source: 'pc',
      sceneId: 1,
      presetId: 1,
      jobId: null,
      seed: 11,
      width: 832,
      height: 1216,
      createdAt: T0 + 1,
      hasThumb: false,
      format: 'webp',
      pcPending: false
    })
    const scene1 = await h.phoneJson(token, 'GET', '/api/images?sceneId=1')
    expect(scene1.json.items.map((i: Dict) => i.id)).toEqual(['p2', 'p1'])
    const preset = await h.phoneJson(token, 'GET', '/api/images?presetId=1&limit=2')
    expect(preset.json.items.map((i: Dict) => i.id)).toEqual(['p3', 'p2'])

    // 원본: 바이트와 content-type 이 정확해야 한다
    const file = await h.phone(token, 'GET', '/api/images/p1')
    expect(file.status).toBe(200)
    expect(file.headers.get('content-type')).toBe('image/webp')
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes)
    expect(h.bucket.files.get('img/p1.webp')?.contentType).toBe('image/webp')

    // 썸네일: PC 가 올리면 보인다
    await expectError(await h.phone(token, 'GET', '/api/images/p1/thumb'), 404)
    const thumb = new Uint8Array([1, 2, 3, 4])
    expect(
      (
        await h.call('PUT', '/api/pc/images/p1/thumb', {
          auth: 'pc',
          raw: thumb as unknown as BodyInit
        })
      ).status
    ).toBe(200)
    const got = await h.phone(token, 'GET', '/api/images/p1/thumb')
    expect(got.headers.get('content-type')).toBe('image/webp')
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(thumb)
    expect((await h.phoneJson(token, 'GET', '/api/images?sceneId=1')).json.items[1].hasThumb).toBe(
      true
    )

    // 같은 id 를 다시 올리면 덮어쓴다 (썸네일 표시는 그대로)
    await uploadPcImage(
      h,
      1,
      { sceneId: 2, createdAt: T0 + 9 },
      new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80])
    )
    const row = h.sql.exec<Dict>(`SELECT * FROM images WHERE id = 'p1'`).one()
    expect(row).toMatchObject({ scene_id: 2, created_at: T0 + 9, has_thumb: 1 })
    expect(h.sql.exec(`SELECT * FROM images`).toArray()).toHaveLength(4)
  })

  it('페이지 넘기기: next 로 이어 가면 같은 시각의 그림도 빠지지 않는다', async () => {
    const h = new Harness()
    await seedPc(h)
    const token = await h.pair()
    // 같은 created_at 이 섞인 7장
    const times = [10, 10, 10, 20, 20, 30, 40]
    for (let i = 0; i < times.length; i++)
      await uploadPcImage(h, i + 1, { createdAt: T0 + times[i] })
    const seen: string[] = []
    let before = ''
    for (let guard = 0; guard < 10; guard++) {
      const page = await h.phoneJson(token, 'GET', `/api/images?limit=2${before}`)
      seen.push(...page.json.items.map((i: Dict) => i.id))
      if (!page.json.next) break
      before = `&before=${encodeURIComponent(page.json.next)}`
    }
    expect(seen).toEqual(['p7', 'p6', 'p5', 'p4', 'p3', 'p2', 'p1'])
    // created_at 숫자만 넘겨도 (이전 쪽 마지막 시각) 그보다 오래된 것부터 준다
    const plain = await h.phoneJson(token, 'GET', `/api/images?before=${T0 + 20}`)
    expect(plain.json.items.map((i: Dict) => i.id)).toEqual(['p3', 'p2', 'p1'])
    await expectError(await h.phone(token, 'GET', '/api/images?before=abc'), 400)
    await expectError(await h.phone(token, 'GET', '/api/images?sceneId=x'), 400)
    // limit 은 최대 100
    expect((await h.phoneJson(token, 'GET', '/api/images?limit=5000')).json.items).toHaveLength(7)
  })

  it('업로드 검사: id 형식 · 메타 · 크기 · 인증', async () => {
    const h = new Harness()
    const body = new Uint8Array([1, 2, 3])
    const meta = { 'x-nais-meta': 'e30' } // {}
    await expectError(
      await h.call('PUT', '/api/pc/images/p1', { raw: body as unknown as BodyInit }),
      401
    )
    await expectError(
      await h.call('PUT', '/api/pc/images/x1', {
        auth: 'pc',
        raw: body as unknown as BodyInit,
        headers: meta
      }),
      400
    )
    await expectError(
      await h.call('PUT', '/api/pc/images/p1', { auth: 'pc', raw: body as unknown as BodyInit }),
      400
    )
    await expectError(
      await h.call('PUT', '/api/pc/images/p1', {
        auth: 'pc',
        raw: body as unknown as BodyInit,
        headers: meta
      }),
      400
    )
    // 메타의 번호와 주소의 번호가 다르면 거절
    const wrong = await uploadPcImage(h, 5, {})
    expect(wrong.status).toBe(200)
    const mismatched = await h.call('PUT', '/api/pc/images/p6', {
      auth: 'pc',
      raw: body as unknown as BodyInit,
      headers: {
        'x-nais-meta': base64UrlJson({
          pcImageId: 5,
          sceneId: null,
          presetId: null,
          seed: null,
          width: 8,
          height: 8,
          createdAt: 1,
          kind: 'x'
        })
      }
    })
    await expectError(mismatched, 400)
    // 10MB 초과는 413
    const big = new Uint8Array(10 * 1024 * 1024 + 1)
    await expectError(await uploadPcImage(h, 7, {}, big), 413)
    expect((await uploadPcImage(h, 8, {}, new Uint8Array(10 * 1024 * 1024))).status).toBe(200)
    // 썸네일: 512KB 초과 413 · 없는 그림 404 · 클라우드 id 거절
    const thumbUrl = '/api/pc/images/p8/thumb'
    await expectError(
      await h.call('PUT', thumbUrl, {
        auth: 'pc',
        raw: new Uint8Array(512 * 1024 + 1) as unknown as BodyInit
      }),
      413
    )
    await expectError(
      await h.call('PUT', '/api/pc/images/p99/thumb', {
        auth: 'pc',
        raw: body as unknown as BodyInit
      }),
      404
    )
    await expectError(
      await h.call('PUT', '/api/pc/images/cabc/thumb', {
        auth: 'pc',
        raw: body as unknown as BodyInit
      }),
      400
    )
    expect(
      (
        await h.call('PUT', thumbUrl, {
          auth: 'pc',
          raw: new Uint8Array(512 * 1024) as unknown as BodyInit
        })
      ).status
    ).toBe(200)
  })

  it('삭제: 클라우드 사본(R2 + 행)만 지운다', async () => {
    const h = new Harness()
    await seedPc(h)
    const token = await h.pair()
    await uploadPcImage(h, 1)
    await h.call('PUT', '/api/pc/images/p1/thumb', {
      auth: 'pc',
      raw: new Uint8Array([1]) as unknown as BodyInit
    })
    expect(h.bucket.keys()).toEqual(['img/p1.webp', 'thumb/p1.webp'])
    expect((await h.phone(token, 'DELETE', '/api/images/p1')).status).toBe(200)
    expect(h.bucket.keys()).toEqual([])
    await expectError(await h.phone(token, 'GET', '/api/images/p1'), 404)
    await expectError(await h.phone(token, 'DELETE', '/api/images/p1'), 404)
    // 형식이 이상한 id 는 R2 를 건드리지 않고 404
    await expectError(await h.phone(token, 'GET', '/api/images/..%2Fsecret'), 404)
  })
})

describe('보관 정리', () => {
  async function putCloudImage(
    h: Harness,
    id: string,
    createdAt: number,
    imported = 0
  ): Promise<void> {
    await h.bucket.put(`img/${id}.zip`, new Uint8Array([80, 75, 3, 4]))
    h.sql.exec(
      `INSERT INTO images (id, source, scene_id, preset_id, job_id, seed, width, height, created_at, has_thumb, format, r2_key, sent_payload, imported, pc_image_id)
       VALUES (?, 'cloud', NULL, NULL, 'j1', 1, 8, 8, ?, 0, 'zip', ?, '{}', ?, NULL)`,
      id,
      createdAt,
      `img/${id}.zip`,
      imported
    )
  }

  it('keepImages 를 넘으면 오래된 것부터 지우고, PC 가 안 가져간 클라우드 생성분은 건드리지 않는다', async () => {
    const h = new Harness()
    await h.pcJson('PUT', '/api/pc/settings', { cloudGenEnabled: false, keepImages: 100 })
    // 아주 오래된 미수신 클라우드 생성분 2장 + 오래된 수신 완료 1장
    await putCloudImage(h, 'cold1', T0 - 5000)
    await putCloudImage(h, 'cold2', T0 - 4000)
    await putCloudImage(h, 'coldimp', T0 - 3000, 1)
    for (let i = 1; i <= 105; i++) {
      await uploadPcImage(h, i, { createdAt: T0 + i })
      await h.call('PUT', `/api/pc/images/p${i}/thumb`, {
        auth: 'pc',
        raw: new Uint8Array([1]) as unknown as BodyInit
      })
    }
    const ids = h.sql
      .exec<{ id: string }>(`SELECT id FROM images ORDER BY created_at ASC`)
      .toArray()
      .map((r) => r.id)
    // 미수신 2장은 세지 않는다 → 센 것(수신 완료 1 + PC 105)이 100장이 되도록 오래된 6장이 지워짐
    expect(ids).toHaveLength(102)
    expect(ids.slice(0, 2)).toEqual(['cold1', 'cold2'])
    expect(ids).not.toContain('coldimp')
    expect(ids).not.toContain('p1')
    expect(ids).not.toContain('p5')
    expect(ids).toContain('p6')
    expect(h.bucket.files.has('img/cold1.zip')).toBe(true)
    expect(h.bucket.files.has('img/coldimp.zip')).toBe(false)
    expect(h.bucket.files.has('img/p1.webp')).toBe(false)
    expect(h.bucket.files.has('thumb/p1.webp')).toBe(false)
    expect(h.bucket.files.has('thumb/p6.webp')).toBe(true)

    // 가져간 뒤에는 세어지고, 넘치면 가장 오래된 것부터 지워진다
    await h.pcJson('POST', '/api/pc/cloud-images/cold1/imported', { pcImageId: 42 })
    await uploadPcImage(h, 106, { createdAt: T0 + 106 })
    expect(h.sql.exec(`SELECT * FROM images WHERE id = 'cold1'`).toArray()).toHaveLength(0)
    expect(h.sql.exec(`SELECT * FROM images WHERE id = 'cold2'`).toArray()).toHaveLength(1)
    expect(h.bucket.files.has('img/cold1.zip')).toBe(false)
  })

  it('보관 장수 설정은 100~20000 정수만 받는다', async () => {
    const h = new Harness()
    for (const keepImages of [99, 20001, 150.5, '500', null]) {
      await expectError(
        await h.pc('PUT', '/api/pc/settings', { cloudGenEnabled: false, keepImages }),
        400
      )
    }
    await expectError(
      await h.pc('PUT', '/api/pc/settings', { cloudGenEnabled: 'yes', keepImages: 500 }),
      400
    )
    expect(
      (await h.pcJson('PUT', '/api/pc/settings', { cloudGenEnabled: false, keepImages: 20000 }))
        .status
    ).toBe(200)
    expect((await h.pcJson('GET', '/api/pc/info')).json.settings).toEqual({
      cloudGenEnabled: false,
      keepImages: 20000
    })
  })
})

describe('생성 정보(prepared) · 조각', () => {
  it('upsert 하고 allKeys 밖의 키는 지운다. 한 번에 200개 · 2MB 를 넘으면 413', async () => {
    const h = new Harness()
    const put = (items: unknown[], allKeys?: string[]): Promise<{ status: number; json: Dict }> =>
      h.pcJson('PUT', '/api/pc/prepared', { items, ...(allKeys ? { allKeys } : {}) })
    expect(
      (
        await put([
          preparedItem('main', sampleRequest()),
          preparedItem('scene:1', sampleSceneRequest(1)),
          preparedItem('scene:2', sampleSceneRequest(2))
        ])
      ).status
    ).toBe(200)
    expect((await h.pcJson('GET', '/api/pc/hashes')).json.prepared).toEqual({
      main: 'h-main',
      'scene:1': 'h-scene:1',
      'scene:2': 'h-scene:2'
    })
    // 덮어쓰기 + 정리
    await put(
      [preparedItem('scene:1', sampleSceneRequest(1, { steps: 20 }), 'new')],
      ['main', 'scene:1']
    )
    expect((await h.pcJson('GET', '/api/pc/hashes')).json.prepared).toEqual({
      main: 'h-main',
      'scene:1': 'new'
    })
    expect(
      JSON.parse(
        h.sql.exec<{ request: string }>(`SELECT request FROM prepared WHERE key = 'scene:1'`).one()
          .request
      ).steps
    ).toBe(20)

    const many = Array.from({ length: 201 }, (_, i) => preparedItem(`scene:${i}`, sampleRequest()))
    await expectError(await h.pc('PUT', '/api/pc/prepared', { items: many }), 413)
    expect((await put(many.slice(0, 200))).status).toBe(200)
    const huge = [preparedItem('main', sampleRequest({ prompt: 'x'.repeat(2 * 1024 * 1024) }))]
    await expectError(await h.pc('PUT', '/api/pc/prepared', { items: huge }), 413)
    // 모양이 틀린 항목
    await expectError(
      await h.pc('PUT', '/api/pc/prepared', { items: [{ key: 'weird', hash: 'x', request: {} }] }),
      400
    )
    await expectError(
      await h.pc('PUT', '/api/pc/prepared', { items: [{ key: 'main', hash: '', request: {} }] }),
      400
    )
    await expectError(await h.pc('PUT', '/api/pc/prepared', { items: [], allKeys: 'main' }), 400)
    // 키가 아주 많아도 정리된다 (DO 는 쿼리당 바인딩 100개 제한)
    await put([], ['main'])
    expect(Object.keys((await h.pcJson('GET', '/api/pc/hashes')).json.prepared)).toEqual(['main'])
  })

  it('조각 파일은 R2 meta/fragments.json 에 올라가고 해시가 기록된다', async () => {
    const h = new Harness()
    expect((await h.pcJson('GET', '/api/pc/hashes')).json).toMatchObject({
      library: null,
      fragments: null
    })
    const byPath = { colors: ['red', 'blue'], '폴더/의상': ['교복', '체육복'] }
    expect((await h.pcJson('PUT', '/api/pc/fragments', { byPath, hash: 'frag-1' })).status).toBe(
      200
    )
    expect(
      JSON.parse(new TextDecoder().decode(h.bucket.files.get('meta/fragments.json')!.bytes))
    ).toEqual(byPath)
    expect((await h.pcJson('GET', '/api/pc/hashes')).json.fragments).toBe('frag-1')
    await expectError(
      await h.pc('PUT', '/api/pc/fragments', { byPath: { a: 'x' }, hash: 'h' }),
      400
    )
    await expectError(await h.pc('PUT', '/api/pc/fragments', { byPath: [], hash: 'h' }), 400)
    await expectError(await h.pc('PUT', '/api/pc/fragments', { byPath, hash: '' }), 400)
  })
})

describe('NAI 토큰', () => {
  it('저장만 되고 어떤 응답에도 나오지 않는다 — 모든 경로의 응답을 문자열로 검사', async () => {
    const h = new Harness()
    await seedPc(h)
    const token = await h.pair()
    const put = await h.pc('PUT', '/api/pc/nai-token', { token: `  ${NAI_TOKEN}  ` })
    expect(put.status).toBe(200)
    expect(await put.text()).not.toContain(NAI_TOKEN)
    expect(h.kv('secret:nai')).toBe(NAI_TOKEN) // 앞뒤 공백은 제거
    expect((await h.pcJson('GET', '/api/pc/info')).json.hasNaiToken).toBe(true)
    await h.pcJson('PUT', '/api/pc/settings', { cloudGenEnabled: true, keepImages: 2000 })
    await uploadPcImage(h, 1)

    const job = (
      await h.phoneJson(token, 'POST', '/api/jobs', {
        target: { type: 'scene', sceneId: 1 },
        count: 1,
        place: 'auto'
      })
    ).json.job
    await h.runAlarms()
    expect(h.jobRow(job.id).state).toBe('done')

    const responses: [string, string, unknown?][] = [
      ['pc', '/api/pc/info'],
      ['pc', '/api/pc/hashes'],
      ['pc', '/api/pc/devices'],
      ['pc', '/api/pc/cloud-images'],
      ['pc', '/api/pc/poll'],
      ['pc', '/api/pc/pairing'],
      ['phone', '/api/me'],
      ['phone', '/api/state'],
      ['phone', '/api/scenes?presetId=1'],
      ['phone', '/api/images'],
      ['phone', '/api/images/p1']
    ]
    for (const [who, path] of responses) {
      const method = path.endsWith('poll') || path.endsWith('pairing') ? 'POST' : 'GET'
      const response =
        who === 'pc'
          ? await h.pc(method, path, method === 'POST' ? {} : undefined)
          : await h.phone(token, method, path)
      const bytes = new Uint8Array(await response.arrayBuffer())
      expect(new TextDecoder().decode(bytes), `${method} ${path}`).not.toContain(NAI_TOKEN)
    }
    // 오류 응답에도
    expect(
      await (await h.call('GET', '/api/pc/info', { headers: { 'x-nais-pc': NAI_TOKEN } })).text()
    ).not.toContain(NAI_TOKEN)
    // 비교용: 이 시점에 토큰이 DO 안에는 있다 (그래야 위 검사가 의미 있다)
    expect(h.kv('secret:nai')).toBe(NAI_TOKEN)
  })

  it('방어 코드: 응답 본문에 토큰이 섞이면 내보내지 않고 500 일반 문구로 바꾼다', async () => {
    const h = new Harness()
    await seedPc(h)
    const token = await h.pair()
    await h.pcJson('PUT', '/api/pc/nai-token', { token: NAI_TOKEN })
    // 씬 이름에 토큰이 들어가 버린 경우를 만든다 (이 값이 응답으로 나가면 안 된다)
    await h.pcJson('PUT', '/api/pc/scenes', {
      presetId: 1,
      scenes: [sampleScene(1, 1, { name: `유출 ${NAI_TOKEN}` })],
      hash: 'leak'
    })
    const leaked = await h.phone(token, 'GET', '/api/scenes?presetId=1')
    const text = await leaked.text()
    expect(leaked.status).toBe(500)
    expect(text).not.toContain(NAI_TOKEN)
    expect(JSON.parse(text)).toEqual({
      ok: false,
      error: '서버 오류가 발생했습니다. 잠시 뒤에 다시 시도해 주세요'
    })
    // 다른 응답은 정상
    expect((await h.phone(token, 'GET', '/api/me')).status).toBe(200)
  })

  it('예상 못 한 예외의 응답에는 원인을 싣지 않는다', async () => {
    const broken = new Harness()
    broken.deps.sql.exec(`DROP TABLE kv`)
    const res = await broken.call('GET', '/api/pc/info', { auth: 'pc' })
    expect(res.status).toBe(500)
    expect(JSON.parse(await res.text()).error).toBe(
      '서버 오류가 발생했습니다. 잠시 뒤에 다시 시도해 주세요'
    )
  })

  it('토큰 검사: 빈 값 · 문자열 아님은 400, 삭제하면 클라우드 작업이 「NAI 토큰이 없음」으로 실패한다', async () => {
    const h = new Harness()
    await seedPc(h)
    await expectError(await h.pc('PUT', '/api/pc/nai-token', { token: '   ' }), 400)
    await expectError(await h.pc('PUT', '/api/pc/nai-token', { token: 5 }), 400)
    await expectError(await h.pc('PUT', '/api/pc/nai-token', {}), 400)
    await enableCloudGen(h)
    const phone = await h.pair()
    const cloud = (
      await h.phoneJson(phone, 'POST', '/api/jobs', {
        target: { type: 'main' },
        count: 3,
        place: 'cloud'
      })
    ).json.job
    const queued = (
      await h.phoneJson(phone, 'POST', '/api/jobs', {
        target: { type: 'main' },
        count: 1,
        place: 'pc'
      })
    ).json.job
    expect((await h.pcJson('DELETE', '/api/pc/nai-token')).status).toBe(200)
    expect(h.kv('secret:nai')).toBeNull()
    expect(h.jobRow(cloud.id)).toMatchObject({ state: 'failed', error: 'NAI 토큰이 없음' })
    expect(h.jobRow(queued.id)).toMatchObject({ state: 'queued' }) // PC 작업은 그대로
    expect((await h.pcJson('GET', '/api/pc/info')).json).toMatchObject({
      hasNaiToken: false,
      cloudJobsActive: 0
    })
    await h.runAlarms()
    expect(h.nai.calls).toHaveLength(0)
  })

  it('토큰을 다시 올리면 이전 무료 사용량 확인 결과는 버린다', async () => {
    const h = new Harness()
    await h.pcJson('PUT', '/api/pc/nai-token', { token: NAI_TOKEN })
    h.sql.exec(`INSERT INTO kv (k, v) VALUES ('nai:quota', '{"state":"exhausted","checkedAt":1}')`)
    await h.pcJson('PUT', '/api/pc/nai-token', { token: NAI_TOKEN + '2' })
    expect(h.kv('nai:quota')).toBeNull()
  })
})

describe('폰 상태의 클라우드 생성 안내', () => {
  it('꺼짐 · 토큰 없음 · 최근 무료 사용량 확인 결과를 이유로 알려 준다', async () => {
    const h = new Harness()
    const token = await h.pair()
    const cloudGen = async (): Promise<Dict> =>
      (await h.phoneJson(token, 'GET', '/api/state')).json.cloudGen
    expect(await cloudGen()).toEqual({
      enabled: false,
      hasNaiToken: false,
      ready: false,
      reason: '클라우드 생성이 꺼져 있습니다',
      quota: null
    })
    await h.pcJson('PUT', '/api/pc/settings', { cloudGenEnabled: true, keepImages: 2000 })
    expect((await cloudGen()).reason).toBe('NAI 토큰이 클라우드에 없습니다')
    await h.pcJson('PUT', '/api/pc/nai-token', { token: NAI_TOKEN })
    expect(await cloudGen()).toEqual({
      enabled: true,
      hasNaiToken: true,
      ready: true,
      reason: null,
      quota: null
    })
    h.sql.exec(
      `INSERT INTO kv (k, v) VALUES ('nai:quota', ?)`,
      JSON.stringify({ state: 'exhausted', checkedAt: h.clock })
    )
    expect(await cloudGen()).toMatchObject({
      ready: false,
      reason: '이번 달 무료 사용량을 모두 썼습니다'
    })
    h.tick(31 * MIN) // 오래된 확인 결과는 막지 않는다
    expect((await cloudGen()).ready).toBe(true)
  })
})
