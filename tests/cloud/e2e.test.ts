import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recountImages } from '../../cloud/src/core/store'
import { runCloudChaos, runPcChaos } from './helpers/e2e-chaos'
import { reply } from './helpers/nai'
import {
  NAI_TOKEN,
  ORIGIN,
  PC_SECRET,
  World,
  makeScene,
  pressCancelAll,
  sceneRequest,
  sleep,
  type Dict,
  type Pc
} from './helpers/e2e-world'

/**
 * 모바일 클라우드 종단 통합 시험 (커스텀).
 *
 * 한 시험 안에서 실제 코드를 맞물린다:
 *  - 워커: cloud/src/core 의 handleRequest · runCloudStep · handleAlarm (node:sqlite · R2 모의 · 가짜 NAI)
 *  - PC 메인: src/main/cloud/sync.ts 의 createCloudSync + 실제 GenerationQueue (가짜 generate)
 *  - 가상 렌더러: cloud:work 를 받아 가짜 DB 를 고치고 큐에 넣고 workDone 을 부른다
 *  - 폰: 워커 handleRequest 에 Request 를 직접
 * 진짜 NAI·네트워크는 쓰지 않고, 비밀값·NAI 토큰은 가짜 값이다.
 */

vi.setConfig({ testTimeout: 20_000 })

let world: World

beforeEach(() => {
  world = new World()
})

afterEach(() => {
  world.dispose()
})

// ── 도우미 ──────────────────────────────────────────────────────────

/** PC 를 켜고 폰을 연결한 뒤 첫 동기화까지 */
async function boot(): Promise<Pc> {
  const pc = world.startPc()
  await world.pairPhone(pc)
  await pc.sync.syncNow()
  await world.settle()
  return pc
}

const preparedKeys = (): string[] =>
  world.cloud.sql
    .exec<{ key: string }>(`SELECT key FROM prepared ORDER BY key`)
    .toArray()
    .map((r) => r.key)

/** 클라우드 생성을 켜고 완성 요청이 올라갈 때까지 */
async function bootWithCloudGen(): Promise<Pc> {
  const pc = await boot()
  await pc.sync.setCloudGen(true)
  await world.settle()
  await world.waitFor(() =>
    expect(preparedKeys()).toEqual(['main', 'scene:1', 'scene:2', 'scene:3'])
  )
  return pc
}

/** PC 가 꺼졌다 — 앱 종료 + 마지막 poll 로부터 20초 */
function powerOff(pc: Pc): void {
  pc.kill()
  world.tick(20_000)
}

const sceneTarget = (sceneId: number): { type: 'scene'; sceneId: number } => ({
  type: 'scene',
  sceneId
})

const pollBodies = (): Dict[] =>
  world.requests.filter((r) => r.method === 'POST' && r.path === '/api/pc/poll').map((r) => r.json!)

const ackBodies = (): Dict[] =>
  world.requests.filter((r) => r.method === 'POST' && r.path === '/api/pc/ack').map((r) => r.json!)

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47]

// ── ① 페어링 ────────────────────────────────────────────────────────

describe('① 페어링 → 폰 토큰 → /api/me', () => {
  it('PC 가 코드를 만들고 폰이 연결하면 토큰으로 /api/me 를 읽는다 (코드는 1회용 · 해제하면 막힌다)', async () => {
    const pc = world.startPc()
    const pairing = await pc.sync.pairing()
    expect(pairing.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{8}$/)
    expect(pairing.url).toBe(`${ORIGIN}/#pair=${pairing.code}`)
    expect(pairing.expiresAt).toBe(world.cloud.clock + 10 * 60 * 1000)
    expect(pairing.qrSvg).toContain('<svg')

    // 연결 전·엉뚱한 토큰은 막힌다
    expect((await world.phone('GET', '/api/me', undefined, '')).status).toBe(401)
    expect((await world.phone('GET', '/api/me', undefined, 'bogus-token')).status).toBe(401)

    const paired = await world.phone('POST', '/api/pair', { code: pairing.code, name: '내 폰' }, '')
    expect(paired.status).toBe(200)
    expect(paired.json.ok).toBe(true)
    const token = paired.json.token as string
    expect(token.length).toBeGreaterThanOrEqual(40)

    const me = await world.phone('GET', '/api/me', undefined, token)
    expect(me.status).toBe(200)
    expect(me.json).toMatchObject({ ok: true, deviceId: paired.json.deviceId, name: '내 폰' })

    // 코드는 한 번만 쓸 수 있다
    const again = await world.phone(
      'POST',
      '/api/pair',
      { code: pairing.code, name: '다른 폰' },
      ''
    )
    expect(again.status).toBe(400)

    // 저장소에는 토큰이 아니라 해시만 있다
    const hashes = world.cloud.sql
      .exec<{ token_hash: string }>(`SELECT token_hash FROM devices`)
      .toArray()
    expect(hashes).toHaveLength(1)
    expect(hashes[0].token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(world.dumpCloudStorage()).not.toContain(token)

    // PC 쪽에서도 기기가 보인다
    const devices = await pc.sync.devices()
    expect(devices.items).toHaveLength(1)
    expect(devices.items[0]).toMatchObject({ id: paired.json.deviceId, name: '내 폰' })
    expect(pc.sync.status().devices).toBe(1)

    // 폰이 연결을 해제하면 토큰이 죽고 PC 의 기기 목록도 빈다
    expect((await world.phone('POST', '/api/logout', undefined, token)).status).toBe(200)
    expect((await world.phone('GET', '/api/me', undefined, token)).status).toBe(401)
    expect((await pc.sync.devices()).items).toHaveLength(0)

    // PC 에서 기기를 해제해도 그 폰의 토큰이 죽는다
    const second = await world.pairPhone(pc, '태블릿')
    expect((await world.phone('GET', '/api/me', undefined, second)).json.name).toBe('태블릿')
    const listed = await pc.sync.devices()
    expect(listed.items.map((d) => d.name)).toEqual(['태블릿'])
    expect((await pc.sync.revokeDevice(listed.items[0].id)).items).toEqual([])
    expect((await world.phone('GET', '/api/me', undefined, second)).status).toBe(401)
    expect(pc.sync.status().devices).toBe(0)

    world.assertNoSecrets()
  })
})

// ── ② PC 첫 동기화 ──────────────────────────────────────────────────

describe('② PC 첫 동기화 → 폰에 라이브러리·씬', () => {
  it('첫 동기화 뒤 /api/state · /api/scenes 에 PC 의 프리셋·씬·캐릭터·메인이 보이고, 두 번째는 올리지 않는다', async () => {
    const pc = world.startPc()
    await world.pairPhone(pc)

    // 올라오기 전: 라이브러리 없음 · PC 꺼짐으로 보임
    const empty = await world.phone('GET', '/api/state')
    expect(empty.json.library).toBeNull()
    expect(empty.json.pc.online).toBe(false)
    expect(empty.json.cloudGen).toMatchObject({ enabled: false, ready: false })

    await pc.sync.syncNow()
    await world.settle()

    const state = await world.phone('GET', '/api/state')
    expect(state.status).toBe(200)
    expect(state.json.pc.online).toBe(true)
    expect(state.json.pc.lastSeen).toBe(world.cloud.clock)
    expect(state.json.pc.queue).toMatchObject({ running: false, pending: 0, generating: 0 })
    const library = state.json.library
    expect(library.presets.map((p: Dict) => [p.id, p.name, p.kind, p.sceneCount])).toEqual([
      [1, '기본 씬', 'scene', 2],
      [2, '배경', 'background', 1]
    ])
    expect(library.characters.map((c: Dict) => [c.id, c.name, c.enabled])).toEqual([
      [10, '하나', true],
      [11, '두리', false]
    ])
    expect(library.outfits).toEqual([{ id: 1, name: '교복' }])
    expect(library.main).toMatchObject({
      prompt: '1girl, solo',
      negativePrompt: 'lowres',
      model: 'nai-diffusion-4-5-full',
      width: 832,
      height: 1216,
      steps: 28,
      promptSplit: false
    })
    expect(library.naiInfo).toMatchObject({ tier: 'opus' })

    const scenes = await world.phone('GET', '/api/scenes?presetId=1')
    expect(scenes.json.items.map((s: Dict) => [s.id, s.name, s.prompt])).toEqual([
      [1, '숲속', 'forest path, daylight'],
      [2, '바닷가', 'beach, smile']
    ])
    for (const scene of scenes.json.items) {
      expect(scene).toMatchObject({
        presetId: 1,
        width: 832,
        height: 1216,
        imageCount: 0,
        latestImageId: null,
        pendingEdit: false
      })
    }
    const background = await world.phone('GET', '/api/scenes?presetId=2')
    expect(background.json.items).toHaveLength(1)
    expect(background.json.items[0]).toMatchObject({ id: 3, name: '교실', kind: 'background' })
    expect((await world.phone('GET', '/api/scenes?presetId=99')).json.items).toEqual([])

    // PC 전용 주소는 폰 토큰으로 못 연다
    expect((await world.phone('GET', '/api/pc/info')).status).toBe(401)

    // 올라간 것: 라이브러리 1 · 씬 묶음 2 · 조각 1 (조각은 R2 파일로) · 씬별 그림 수 1 (씬 본문과 따로)
    const puts = world.requests.filter((r) => r.method === 'PUT').map((r) => r.path)
    expect(puts).toEqual([
      '/api/pc/library',
      '/api/pc/scenes',
      '/api/pc/scenes',
      '/api/pc/fragments',
      '/api/pc/scene-counts'
    ])
    // 씬 본문에는 그림 수가 없다 (그림 수가 바뀔 때마다 씬 전체를 다시 올리게 되므로)
    for (const body of world.requestsOf('PUT', '/api/pc/scenes')) {
      for (const scene of body.json!.scenes as Dict[])
        expect(scene).not.toHaveProperty('imageCount')
    }
    expect(world.requestsOf('PUT', '/api/pc/scene-counts')[0].json).toEqual({
      counts: { '1': 0, '2': 0, '3': 0 }
    })
    const fragments = world.cloud.bucket.files.get('meta/fragments.json')
    expect(JSON.parse(new TextDecoder().decode(fragments!.bytes))).toEqual({
      hair: ['long hair', 'short hair']
    })

    // 바뀐 게 없으면 다시 올리지 않는다
    const before = world.requests.filter((r) => r.method === 'PUT').length
    expect(await pc.sync.syncOnce()).toBe(true)
    expect(world.requests.filter((r) => r.method === 'PUT')).toHaveLength(before)

    world.assertNoSecrets()
  })
})

// ── ③ 폰 편집 ───────────────────────────────────────────────────────

describe('③ 폰 편집 → PC poll → 가상 렌더러 반영 → ack → 다음 스냅샷 뒤에도 유지', () => {
  it('씬·캐릭터·메인 편집이 미반영 동안 PC 옛 스냅샷에 덮이지 않고, 반영 뒤 PC 값이 기준이 된다', async () => {
    const pc = await boot()

    const patched = await world.phone('PATCH', '/api/scenes/1', {
      prompt: 'forest path, sunlight',
      name: '숲속 아침'
    })
    expect(patched.status).toBe(200)
    expect(patched.json.scene).toMatchObject({
      id: 1,
      prompt: 'forest path, sunlight',
      name: '숲속 아침',
      pendingEdit: true
    })
    expect((await world.phone('PATCH', '/api/characters/11', { enabled: true })).status).toBe(200)
    expect((await world.phone('PATCH', '/api/main', { prompt: '1girl, solo, smile' })).status).toBe(
      200
    )
    expect(world.unackedOps()).toBe(3)

    // 아직 PC 가 반영하기 전에 PC 가 옛 값으로 전부 다시 올려도 폰 편집이 덧입혀져 남는다
    expect(await pc.sync.syncOnce(true)).toBe(true)
    let scenes = await world.phone('GET', '/api/scenes?presetId=1')
    expect(scenes.json.items[0]).toMatchObject({
      prompt: 'forest path, sunlight',
      name: '숲속 아침',
      pendingEdit: true
    })
    let state = await world.phone('GET', '/api/state')
    expect(state.json.library.characters[1].enabled).toBe(true)
    expect(state.json.library.main.prompt).toBe('1girl, solo, smile')
    // 이 시점 PC 의 가짜 DB 는 아직 그대로
    expect(world.db.scene(1)!.prompt).toBe('forest path, daylight')

    // PC poll → ops 전달 → 가상 렌더러 반영 → workDone → ack
    await pc.sync.pollOnce()
    await world.settle()
    const works = pc.channel<Dict>('cloud:work')
    expect(works).toHaveLength(1)
    const opIds = works[0].ops.map((o: Dict) => o.id)
    expect(opIds).toEqual([...opIds].sort((a: number, b: number) => a - b))
    expect(works[0].ops.map((o: Dict) => o.type)).toEqual([
      'scene:update',
      'char:update',
      'main:update'
    ])
    expect(pc.renderer.errors).toEqual([])
    expect(world.db.scene(1)).toMatchObject({ prompt: 'forest path, sunlight', name: '숲속 아침' })
    expect(world.db.characters[1].enabled).toBe(true)
    expect(world.db.main.prompt).toBe('1girl, solo, smile')
    expect(world.unackedOps()).toBe(0)
    expect(ackBodies().at(-1)!.opIds).toEqual(opIds)

    // 한 번 반영한 편집은 다시 넘기지 않는다
    await pc.sync.pollOnce()
    await world.settle()
    expect(pc.channel('cloud:work')).toHaveLength(1)

    // 반영된 편집은 폰에서 「대기」 표시가 사라진다
    scenes = await world.phone('GET', '/api/scenes?presetId=1')
    expect(scenes.json.items[0]).toMatchObject({
      prompt: 'forest path, sunlight',
      pendingEdit: false
    })

    // 다음 PC 스냅샷 (PC 값이 기준)
    const scenePuts = (): number =>
      world.requests.filter((r) => r.method === 'PUT' && r.path === '/api/pc/scenes').length
    const putsBefore = scenePuts()
    expect(await pc.sync.syncOnce()).toBe(true)
    expect(scenePuts()).toBe(putsBefore + 1) // 프리셋 1 만 바뀜
    const lastScenePut = world.requests
      .filter((r) => r.method === 'PUT' && r.path === '/api/pc/scenes')
      .at(-1)!.json!
    expect(lastScenePut.presetId).toBe(1)
    expect(lastScenePut.scenes[0]).toMatchObject({
      prompt: 'forest path, sunlight',
      name: '숲속 아침'
    })

    scenes = await world.phone('GET', '/api/scenes?presetId=1')
    expect(scenes.json.items[0]).toMatchObject({
      prompt: 'forest path, sunlight',
      name: '숲속 아침',
      pendingEdit: false
    })
    state = await world.phone('GET', '/api/state')
    expect(state.json.library.characters[1].enabled).toBe(true)
    expect(state.json.library.main.prompt).toBe('1girl, solo, smile')

    world.assertNoSecrets()
  })
})

// ── ③-2 반영 못 한 폰 편집 되돌리기 ──────────────────────────────────

describe('③-2 PC 가 반영 못 한 폰 편집 → 실패 줄의 ack 가 워커에 닿은 뒤에야 폰 사본이 PC 값으로 돌아온다', () => {
  /** 다음 n번 ack 가 서버 오류로 유실된다 */
  const failAck = (times = 1): void =>
    world.inject(
      (m, p) => m === 'POST' && p === '/api/pc/ack',
      () => Response.json({ ok: false, error: '일시 오류' }, { status: 503 }),
      times
    )
  const libraryPuts = (): number => world.requestsOf('PUT', '/api/pc/library').length
  const scenePuts = (): World['requests'] => world.requestsOf('PUT', '/api/pc/scenes')
  /** 폰이 보는 두리(11번)의 켜짐 */
  const phoneSees = async (charId: number): Promise<boolean> => {
    const state = await world.phone('GET', '/api/state')
    return (state.json.library.characters as Dict[]).find((c) => c.id === charId)!
      .enabled as boolean
  }
  const phoneScene = async (id: number): Promise<Dict> => {
    const scenes = await world.phone('GET', '/api/scenes?presetId=1')
    return (scenes.json.items as Dict[]).find((s) => s.id === id)!
  }
  /** 요청 기록을 「메서드 경로 상태」 글자로 */
  const trail = (): string[] => world.requests.map((r) => `${r.method} ${r.path} ${r.status}`)

  it('캐릭터: 상한 때문에 못 켠 편집의 ack 가 한 번 유실돼도 폰의 두리는 PC 값(꺼짐)으로 돌아온다', async () => {
    const pc = await boot()
    pc.renderer.maxCharacters = 1 // 하나가 이미 켜져 있어 두리를 더 켤 수 없다
    expect((await world.phone('PATCH', '/api/characters/11', { enabled: true })).status).toBe(200)
    expect(await phoneSees(11)).toBe(true)

    failAck(1)
    await pc.sync.pollOnce()
    await world.settle()
    // 렌더러가 반영하지 못했고(PC 는 그대로), 그 줄의 ack 는 유실돼 워커에는 아직 미반영이다
    expect(world.db.characters[1].enabled).toBe(false)
    expect([...pc.renderer.appliedOps.values()]).toEqual([false])
    expect(world.unackedOps()).toBe(1)
    expect(world.requestsOf('POST', '/api/pc/ack').map((r) => r.status)).toEqual([503])

    const putsBefore = libraryPuts()
    expect(await pc.sync.syncOnce(false)).toBe(true)
    await pc.sync.pollOnce()
    await world.settle()
    expect(await pc.sync.syncOnce(false)).toBe(true)

    expect(world.unackedOps()).toBe(0)
    expect(await phoneSees(11)).toBe(false)
    expect(libraryPuts()).toBe(putsBefore + 1)
    // 되돌리는 라이브러리 업로드는 ack 가 닿은 뒤에 나갔다 (그 전에 올리면 워커가 미반영 줄을 다시 덧입힌다)
    const log = trail()
    expect(log.lastIndexOf('POST /api/pc/ack 200')).toBeLessThan(
      log.lastIndexOf('PUT /api/pc/library 200')
    )
    // 한 번만 강제한다
    expect(await pc.sync.syncOnce(false)).toBe(true)
    expect(libraryPuts()).toBe(putsBefore + 1)
    world.assertNoSecrets()
  })

  it('캐릭터, ack 지연: ack 가 아직 안 닿은 동안은 올리지 않고 플래그를 지켰다가, 닿은 뒤 첫 동기화에서 되돌린다', async () => {
    const pc = await boot()
    pc.renderer.maxCharacters = 1
    await world.phone('PATCH', '/api/characters/11', { enabled: true })

    // 렌더러의 보고와 첫 동기화가 먼저 보내 보는 ack 가 둘 다 유실된다
    failAck(2)
    await pc.sync.pollOnce()
    await world.settle()
    const putsBefore = libraryPuts()
    expect(await pc.sync.syncOnce(false)).toBe(true)
    expect(world.requestsOf('POST', '/api/pc/ack').map((r) => r.status)).toEqual([503, 503])
    expect(libraryPuts()).toBe(putsBefore) // ack 가 안 닿았으니 올리지 않는다
    expect(world.unackedOps()).toBe(1)
    expect(await phoneSees(11)).toBe(true) // 미반영 줄이라 폰은 아직 자기 편집을 본다

    // ack 가 닿는다 → 다음 동기화가 되돌린다
    await pc.sync.pollOnce()
    await world.settle()
    expect(world.unackedOps()).toBe(0)
    expect(await pc.sync.syncOnce(false)).toBe(true)
    expect(libraryPuts()).toBe(putsBefore + 1)
    expect(await phoneSees(11)).toBe(false)

    await pc.sync.syncOnce(false)
    expect(libraryPuts()).toBe(putsBefore + 1)
    world.assertNoSecrets()
  })

  it('캐릭터, ack 가 계속 유실되면 동기화를 몇 번 해도 올리지 않다가 닿는 즉시 되돌린다', async () => {
    const pc = await boot()
    pc.renderer.maxCharacters = 1
    await world.phone('PATCH', '/api/characters/11', { enabled: true })
    failAck(5)
    await pc.sync.pollOnce()
    await world.settle()
    const putsBefore = libraryPuts()
    for (let i = 0; i < 3; i++) await pc.sync.syncOnce(false)
    expect(libraryPuts()).toBe(putsBefore)
    expect(await phoneSees(11)).toBe(true)

    // 남은 유실 횟수를 다 쓰고 나면 ack 가 닿는다
    for (let i = 0; i < 4 && world.unackedOps() > 0; i++) await pc.sync.syncOnce(false)
    await pc.sync.pollOnce()
    await world.settle()
    expect(world.unackedOps()).toBe(0)
    await pc.sync.syncOnce(false)
    expect(await phoneSees(11)).toBe(false)
    expect(libraryPuts()).toBe(putsBefore + 1)
  })

  it('씬: 반영 못 한 scene:update 는 프리셋 해시가 같아도 그 프리셋만 다시 올려 폰의 씬이 PC 값으로 돌아온다', async () => {
    const pc = await boot()
    pc.renderer.failOp = (op) => op.type === 'scene:update'
    const edited = await world.phone('PATCH', '/api/scenes/1', {
      prompt: 'phone edit',
      name: '폰이 고친 이름'
    })
    expect(edited.status).toBe(200)
    expect(await phoneScene(1)).toMatchObject({ prompt: 'phone edit', pendingEdit: true })

    failAck(1)
    await pc.sync.pollOnce()
    await world.settle()
    expect(world.db.scene(1)).toMatchObject({ prompt: 'forest path, daylight', name: '숲속' })
    expect(world.unackedOps()).toBe(1)

    const putsBefore = scenePuts().length
    expect(await pc.sync.syncOnce(false)).toBe(true)
    // 씬이 든 프리셋(1)만 — 해시는 그대로인데도 올라간다
    expect(
      scenePuts()
        .slice(putsBefore)
        .map((r) => r.json!.presetId)
    ).toEqual([1])
    await pc.sync.pollOnce()
    await world.settle()
    expect(await pc.sync.syncOnce(false)).toBe(true)

    expect(world.unackedOps()).toBe(0)
    expect(await phoneScene(1)).toMatchObject({
      prompt: 'forest path, daylight',
      name: '숲속',
      pendingEdit: false
    })
    // 한 번만 올린다
    expect(scenePuts().length).toBe(putsBefore + 1)
    const log = trail()
    expect(log.lastIndexOf('POST /api/pc/ack 200')).toBeLessThan(
      log.lastIndexOf('PUT /api/pc/scenes 200')
    )
    world.assertNoSecrets()
  })

  it('씬, ack 지연: ack 가 안 닿은 동안은 씬도 올리지 않고, 닿은 뒤 첫 동기화에서 되돌린다', async () => {
    const pc = await boot()
    pc.renderer.failOp = (op) => op.type === 'scene:update'
    await world.phone('PATCH', '/api/scenes/1', { prompt: 'phone edit' })

    failAck(2)
    await pc.sync.pollOnce()
    await world.settle()
    const putsBefore = scenePuts().length
    expect(await pc.sync.syncOnce(false)).toBe(true)
    expect(scenePuts().length).toBe(putsBefore)
    expect(await phoneScene(1)).toMatchObject({ prompt: 'phone edit', pendingEdit: true })

    await pc.sync.pollOnce()
    await world.settle()
    expect(await pc.sync.syncOnce(false)).toBe(true)
    expect(
      scenePuts()
        .slice(putsBefore)
        .map((r) => r.json!.presetId)
    ).toEqual([1])
    expect(await phoneScene(1)).toMatchObject({
      prompt: 'forest path, daylight',
      pendingEdit: false
    })
  })

  it('씬: 되돌리는 업로드가 실패하면 플래그를 지키고, 다음 동기화에서 다시 올린다', async () => {
    const pc = await boot()
    pc.renderer.failOp = (op) => op.type === 'scene:update'
    await world.phone('PATCH', '/api/scenes/1', { prompt: 'phone edit' })
    await pc.sync.pollOnce()
    await world.settle()
    expect(world.unackedOps()).toBe(0) // ack 는 닿았다

    world.inject(
      (m, p) => m === 'PUT' && p === '/api/pc/scenes',
      () => Response.json({ ok: false, error: '일시 오류' }, { status: 503 })
    )
    expect(await pc.sync.syncOnce(false)).toBe(false)
    expect(await phoneScene(1)).toMatchObject({ prompt: 'phone edit' }) // 아직 안 돌아왔다
    expect(await pc.sync.syncOnce(false)).toBe(true)
    expect(await phoneScene(1)).toMatchObject({ prompt: 'forest path, daylight' })
  })

  it('실패 줄의 ack 가 닿은 직후 PC 가 꺼져도(되돌림 플래그 유실) 다시 켠 PC 의 첫 동기화가 폰 사본을 PC 값으로 되돌린다', async () => {
    const pc = await boot()
    pc.renderer.maxCharacters = 1
    pc.renderer.failOp = (op) => op.type === 'scene:update'
    await world.phone('PATCH', '/api/characters/11', { enabled: true })
    await world.phone('PATCH', '/api/scenes/1', { prompt: 'phone edit' })
    await pc.sync.pollOnce()
    await world.settle()
    expect(world.unackedOps()).toBe(0) // 실패 줄의 ack 는 닿았다
    pc.kill() // 되돌리는 동기화 전에 꺼진다 — 메모리의 되돌림 플래그는 사라진다
    expect(await phoneSees(11)).toBe(true)
    expect(await phoneScene(1)).toMatchObject({ prompt: 'phone edit' })

    const pc2 = world.startPc()
    expect(await pc2.sync.syncOnce(false)).toBe(true)
    expect(await phoneSees(11)).toBe(false)
    expect(await phoneScene(1)).toMatchObject({
      prompt: 'forest path, daylight',
      pendingEdit: false
    })
    // 되돌린 뒤에는 해시가 같아 더 올리지 않는다
    const puts = world.requests.filter((r) => r.method === 'PUT').length
    expect(await pc2.sync.syncOnce(false)).toBe(true)
    expect(world.requests.filter((r) => r.method === 'PUT')).toHaveLength(puts)
    pc2.sync.stop()
    world.assertNoSecrets()
  })

  it('반영 못 한 편집과 반영된 편집이 섞여 있으면 실패한 줄만 PC 값으로 돌아오고 반영된 줄은 그대로다', async () => {
    const pc = await boot()
    pc.renderer.maxCharacters = 1
    await world.phone('PATCH', '/api/characters/11', { enabled: true }) // 못 켠다
    await world.phone('PATCH', '/api/main', { prompt: '1girl, solo, smile' }) // 반영된다
    failAck(1)
    await pc.sync.pollOnce()
    await world.settle()
    expect(world.db.main.prompt).toBe('1girl, solo, smile')
    await pc.sync.syncOnce(false)
    await pc.sync.pollOnce()
    await world.settle()
    await pc.sync.syncOnce(false)

    expect(world.unackedOps()).toBe(0)
    expect(await phoneSees(11)).toBe(false)
    const state = await world.phone('GET', '/api/state')
    expect(state.json.library.main.prompt).toBe('1girl, solo, smile')
    world.assertNoSecrets()
  })
})

// ── ④ PC 켜짐에서 폰 작업 ───────────────────────────────────────────

describe('④ PC 켜짐: 폰 작업 2장 → PC 큐 → 생성 → 그림 업로드', () => {
  it('큐에 cloudJobId 를 단 2장이 들어가고, 끝나면 그림 2장이 폰 갤러리에 뜨고 작업은 done', async () => {
    const pc = await boot()
    pc.hold() // 생성을 붙들어 두고 중간 상태를 본다

    const made = await world.createJob(sceneTarget(1), 2, 'auto')
    expect(made.status).toBe(200)
    expect(made.json.job).toMatchObject({
      state: 'queued',
      runner: 'pc',
      place: 'auto',
      count: 2,
      label: '숲속'
    })
    expect(made.json.notice).toBeUndefined()
    const id = made.id

    await pc.sync.pollOnce()
    await world.settle()
    expect(pc.channel<Dict>('cloud:work')).toHaveLength(1)
    expect(pc.channel<Dict>('cloud:work')[0].jobs.map((j: Dict) => j.id)).toEqual([id])
    expect(pc.enqueueCalls).toHaveLength(1)
    expect(pc.enqueueCalls[0]).toHaveLength(2)
    for (const request of pc.enqueueCalls[0]) {
      expect(request).toMatchObject({ cloudJobId: id, sceneId: 1 })
    }
    expect((await world.phoneJob(id)).state).toBe('pc') // accepted ack 가 갔다
    expect(pc.queue.idsByCloudJob(id)).toHaveLength(2)

    // 다음 poll 은 추적 중인 작업 id 를 실어 보내고, 폰은 PC 큐 진행을 본다
    await pc.sync.pollOnce()
    expect(pollBodies().at(-1)).toMatchObject({ acceptsJobs: true, activeJobIds: [id] })
    const mid = await world.phone('GET', '/api/state')
    expect(mid.json.pc.queue).toMatchObject({ generating: 1, pending: 1, generatingSceneId: 1 })
    expect(mid.json.jobs[0]).toMatchObject({ id, state: 'pc', done: 0 })

    pc.release()
    await world.queueIdle(pc)
    await world.waitFor(() =>
      expect(world.job(id)).toMatchObject({ state: 'done', done: 2, failed: 0 })
    )
    await world.drain(pc)

    // 작업 결과
    expect(await world.phoneJob(id)).toMatchObject({
      state: 'done',
      done: 2,
      failed: 0,
      runner: 'pc',
      error: null
    })
    expect(pc.generated).toHaveLength(2)
    expect(pc.sync.status()).toMatchObject({ pendingUploads: 0, failedUploads: 0 })
    expect(world.config.state.uploaded).toEqual([100, 101])

    // 폰 갤러리: 최신순 2장, PC 가 올린 WebP + 썸네일
    const gallery = await world.phone('GET', '/api/images')
    expect(gallery.json.items.map((i: Dict) => i.id)).toEqual(['p101', 'p100'])
    for (const item of gallery.json.items) {
      expect(item).toMatchObject({
        source: 'pc',
        sceneId: 1,
        presetId: 1,
        jobId: null,
        width: 832,
        height: 1216,
        hasThumb: true,
        format: 'webp'
      })
    }
    expect(gallery.json.items.map((i: Dict) => i.seed)).toEqual([1001, 1000])
    const file = await world.phoneBytes('/api/images/p100')
    expect(file.type).toBe('image/webp')
    expect(new TextDecoder().decode(file.bytes)).toContain('img-100')
    expect((await world.phoneBytes('/api/images/p101/thumb')).status).toBe(200)
    const scenes = await world.phone('GET', '/api/scenes?presetId=1')
    expect(scenes.json.items[0].latestImageId).toBe('p101')

    // 끝난 작업은 더 이상 activeJobIds 에 없다
    await pc.sync.pollOnce()
    expect(pollBodies().at(-1)!.activeJobIds).toEqual([])

    // 씬의 그림 수는 씬 본문과 따로, 60초가 지난 뒤 다음 동기화에 오른다 (자세한 건 ㉛)
    expect(await pc.sync.syncOnce()).toBe(true)
    expect((await world.phone('GET', '/api/scenes?presetId=1')).json.items[0].imageCount).toBe(0)
    world.tick(60_000)
    expect(await pc.sync.syncOnce()).toBe(true)
    const after = await world.phone('GET', '/api/scenes?presetId=1')
    expect(after.json.items[0].imageCount).toBe(2)

    world.assertNoSecrets()
  })

  it('생성이 바로 끝나는 경우에도 같은 결과 (workDone 보다 먼저 끝나도 놓치지 않는다)', async () => {
    const pc = await boot()
    const { id } = await world.createJob(sceneTarget(2), 3, 'pc')
    await pc.sync.pollOnce()
    await world.waitFor(() =>
      expect(world.job(id)).toMatchObject({ state: 'done', done: 3, failed: 0 })
    )
    await world.drain(pc)
    expect((await world.phone('GET', '/api/images')).json.items).toHaveLength(3)
    expect(pc.enqueueCalls).toHaveLength(1)
    world.assertNoSecrets()
  })
})

// ── ⑤ PC 꺼짐에서 클라우드 생성 ─────────────────────────────────────

describe('⑤ PC 꺼짐: 클라우드 생성 → 폰 갤러리 → PC 다시 켜면 가져오기', () => {
  it('클라우드가 알람으로 한 장씩 만들고 zip 을 보관하고, PC 가 켜지면 saveGeneratedImage 로 가져가 imported 가 된다', async () => {
    const pc = await bootWithCloudGen()

    // 클라우드 생성이 켜졌다: 토큰은 맡겼지만 어디에도 돌려주지 않는다
    const info = await world.cloud.pcJson('GET', '/api/pc/info')
    expect(info.json).toMatchObject({ hasNaiToken: true, settings: { cloudGenEnabled: true } })
    expect(JSON.stringify(info.json)).not.toContain(NAI_TOKEN)
    expect(pc.sync.status().cloudGen).toMatchObject({ enabled: true, hasToken: true })

    powerOff(pc)
    const off = await world.phone('GET', '/api/state')
    expect(off.json.pc.online).toBe(false)
    expect(off.json.cloudGen).toMatchObject({ enabled: true, hasNaiToken: true, ready: true })

    // PC 가 꺼진 사이 폰이 씬을 고친다 (조각 토큰 포함)
    const edit = await world.phone('PATCH', '/api/scenes/1', {
      prompt: 'night city, <hair>',
      negativePrompt: 'blurry'
    })
    expect(edit.status).toBe(200)

    const made = await world.createJob(sceneTarget(1), 2, 'auto')
    expect(made.json.job).toMatchObject({
      state: 'cloud',
      runner: 'cloud',
      count: 2,
      label: '숲속'
    })
    const id = made.id
    expect(world.cloud.alarmLog.length).toBeGreaterThan(0)

    await world.runAlarms()
    expect(world.job(id)).toMatchObject({ state: 'done', done: 2, failed: 0, in_flight: 0 })

    // NAI 호출: 두 번 · 폰에서 고친 프롬프트 · 조각 치환 · 켜진 캐릭터만 · 토큰은 Authorization 으로만
    const calls = world.cloud.nai.generateCalls
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.headers['authorization']).toBe(`Bearer ${NAI_TOKEN}`)
      const payload = JSON.parse(call.body!) as Dict
      expect(payload.input).toContain('night city')
      expect(payload.input).toMatch(/(long|short) hair/)
      expect(payload.input).not.toContain('<hair>')
      expect(payload.input).not.toContain('forest path')
      expect(payload.parameters.negative_prompt).toContain('blurry')
      expect(call.body).toContain('hana, black hair')
      expect(call.body).not.toContain('duri')
      expect(call.body).not.toContain(NAI_TOKEN)
    }
    expect(world.cloud.nai.subscriptionCalls.length).toBeGreaterThanOrEqual(1)

    // 폰 갤러리: cloud 항목 2개 (zip)
    const gallery = await world.phone('GET', '/api/images')
    expect(gallery.json.items).toHaveLength(2)
    for (const item of gallery.json.items) {
      expect(item).toMatchObject({
        source: 'cloud',
        format: 'zip',
        jobId: id,
        sceneId: 1,
        presetId: 1,
        width: 832,
        height: 1216,
        hasThumb: false
      })
      expect(item.id).toMatch(/^c[a-z0-9]{12}$/)
    }
    const zipFile = await world.phoneBytes(`/api/images/${gallery.json.items[0].id}`)
    expect(zipFile.type).toBe('application/zip')
    const zip = await JSZip.loadAsync(zipFile.bytes)
    const first = Object.values(zip.files).find((f) => !f.dir)!
    expect([...(await first.async('uint8array')).subarray(0, 4)]).toEqual(PNG_HEAD)
    const done = await world.phoneJob(id)
    expect(done).toMatchObject({ state: 'done', done: 2, failed: 0, runner: 'cloud' })
    const stateAfter = await world.phone('GET', '/api/state')
    expect(stateAfter.json.cloudGen.quota).toMatchObject({ state: 'available' })

    // 아직 PC 가 안 가져간 상태
    const waiting = await world.cloud.pcJson('GET', '/api/pc/cloud-images')
    expect(waiting.json.items).toHaveLength(2)

    // PC 다시 켜짐 (새 프로세스) → 동기화 + 폰 편집 반영 + 가져오기
    const pc2 = world.startPc()
    await pc2.sync.syncNow()
    await world.settle()
    await world.drain(pc2)

    expect(world.saveGenerated).toHaveBeenCalledTimes(2)
    const inputs = world.saveGenerated.mock.calls.map((c) => c[0])
    inputs.forEach((input, i) => {
      expect(Buffer.isBuffer(input.png)).toBe(true)
      expect([...input.png.subarray(0, 4)]).toEqual(PNG_HEAD)
      expect(input.sentPayload).toBe(calls[i].body) // 클라우드가 NAI 에 보낸 그대로
      expect(input.seed).toBe((JSON.parse(calls[i].body!) as Dict).parameters.seed)
      expect(input).toMatchObject({
        kind: 'scene',
        format: 'png',
        sceneId: 1,
        sceneName: '숲속',
        scenePresetName: '기본 씬'
      })
    })

    // 클라우드 쪽 imported 표시 · PC 그림 번호 기록
    const savedIds = await Promise.all(world.saveGenerated.mock.results.map((r) => r.value))
    const rows = world.cloud.imageRows()
    expect(rows).toHaveLength(2) // 클라우드 사본은 남는다
    expect(rows.map((r) => [r.imported, r.pc_image_id])).toEqual(
      savedIds.map((s) => [1, (s as { id: number }).id])
    )
    expect((await world.cloud.pcJson('GET', '/api/pc/cloud-images')).json.items).toEqual([])
    expect(pc2.sync.status().importedCount).toBe(2)
    expect(pc2.sync.status().cloudGen.quota).toBe('available') // 클라우드가 확인한 무료 사용량
    expect(pc2.channel<Dict>('scenes:changed')).toHaveLength(2)
    expect(pc2.channel<Dict>('scenes:changed')[0].sceneId).toBe(1)

    // 가져온 그림은 다시 클라우드로 올리지 않는다
    expect(world.requests.filter((r) => r.method === 'PUT' && /\/images\//.test(r.path))).toEqual(
      []
    )
    expect(world.cloud.imageRows().filter((r) => r.source === 'pc')).toHaveLength(0)
    expect(world.config.state.uploaded).toEqual(
      expect.arrayContaining(savedIds.map((s) => (s as { id: number }).id))
    )

    // 꺼진 사이의 폰 편집도 PC 에 반영됐다
    expect(world.db.scene(1)!.prompt).toBe('night city, <hair>')
    expect(world.unackedOps()).toBe(0)
    expect((await world.phone('GET', '/api/images')).json.items).toHaveLength(2)

    world.assertNoSecrets()
  })

  it('가져오기 전에 PC 에서 씬이 지워졌으면 씬 없이 일반 그림(t2i)으로 저장한다', async () => {
    const pc = await bootWithCloudGen()
    powerOff(pc)
    const { id } = await world.createJob(sceneTarget(2), 1, 'auto')
    await world.runAlarms()
    expect(world.job(id)).toMatchObject({ state: 'done', done: 1 })

    world.db.scenes = world.db.scenes.filter((s) => s.id !== 2) // PC 에서 삭제
    const pc2 = world.startPc()
    await pc2.sync.syncNow()
    await world.drain(pc2)

    expect(world.saveGenerated).toHaveBeenCalledTimes(1)
    const input = world.saveGenerated.mock.calls[0][0]
    expect(input.kind).toBe('t2i')
    expect(input.sceneId).toBeUndefined()
    expect(input.sceneName).toBeUndefined()
    expect(pc2.channel('scenes:changed')).toHaveLength(0)
    expect(world.cloud.imageRows()[0]).toMatchObject({ imported: 1 })
    world.assertNoSecrets()
  })
})

// ── ⑥ 무료 조건 ─────────────────────────────────────────────────────

describe('⑥ 무료 조건 위반이면 NAI 생성 호출 0회', () => {
  it('폰에서 해상도를 1216×1216 으로 고친 씬은 만들지 않고 실패 이유를 알린다 (조건에 맞는 씬은 만든다)', async () => {
    const pc = await bootWithCloudGen()
    powerOff(pc)

    const edit = await world.phone('PATCH', '/api/scenes/2', { width: 1216, height: 1216 })
    expect(edit.status).toBe(200)
    const { id } = await world.createJob(sceneTarget(2), 2, 'cloud')
    await world.runAlarms()

    expect(world.cloud.nai.generateCalls).toHaveLength(0)
    expect(world.cloud.nai.subscriptionCalls).toHaveLength(0) // 구독 확인 전에 거른다
    const failed = await world.phoneJob(id)
    expect(failed).toMatchObject({ state: 'failed', done: 0 })
    expect(failed.error).toContain('무료 범위')
    expect(failed.error).toContain('1216×1216')
    expect((await world.phone('GET', '/api/images')).json.items).toEqual([])
    // 클라우드 생성 자체는 그대로 켜져 있다
    expect((await world.phone('GET', '/api/state')).json.cloudGen).toMatchObject({ enabled: true })

    // 대조: 832×1216 씬은 같은 조건에서 만든다
    const ok = await world.createJob(sceneTarget(1), 1, 'cloud')
    await world.runAlarms()
    expect(world.cloud.nai.generateCalls).toHaveLength(1)
    expect(await world.phoneJob(ok.id)).toMatchObject({ state: 'done', done: 1 })
    world.assertNoSecrets()
  })

  it('PC 가 올린 완성 요청의 스텝이 28 을 넘어도 만들지 않는다', async () => {
    const pc = await bootWithCloudGen()
    world.db.main.steps = 40
    pc.renderer.touch() // 생성 설정이 바뀌었다 → 완성 요청 다시 올림
    await world.settle()
    await world.waitFor(() => {
      const row = world.cloud.sql
        .exec<{ request: string }>(`SELECT request FROM prepared WHERE key = 'main'`)
        .one()
      expect(JSON.parse(row.request).steps).toBe(40)
    })
    powerOff(pc)

    const { id } = await world.createJob({ type: 'main' }, 1, 'cloud')
    await world.runAlarms()
    expect(world.cloud.nai.generateCalls).toHaveLength(0)
    const failed = await world.phoneJob(id)
    expect(failed.state).toBe('failed')
    expect(failed.error).toContain('스텝')
    world.assertNoSecrets()
  })
})

// ── ⑦ PC 재시작 ─────────────────────────────────────────────────────

describe('⑦ PC 재시작 → activeJobIds 빈 목록 → 60초 뒤 작업 failed', () => {
  it('앱을 다시 켜서 큐를 잃으면 60초 유예 뒤 그 작업은 「PC가 작업을 잃었습니다」로 정리되고, 이후 새 작업은 정상', async () => {
    const pc = await boot()
    pc.hold()
    const { id } = await world.createJob(sceneTarget(1), 2, 'pc')
    await pc.sync.pollOnce()
    await world.settle()
    expect(world.job(id).state).toBe('pc')
    expect(pc.queue.idsByCloudJob(id)).toHaveLength(2)

    // 앱 종료 → 재시작: 새 sync · 빈 큐
    pc.kill()
    const pc2 = world.startPc()
    expect(pc2.queue.statusLite().items).toEqual([])
    world.tick(1000)
    await pc2.sync.pollOnce()
    expect(pollBodies().at(-1)).toMatchObject({ acceptsJobs: true, activeJobIds: [] })
    expect(world.job(id).state).toBe('pc') // 유예 안

    world.tick(58_000) // 받은 지 59초
    await pc2.sync.pollOnce()
    expect(world.job(id).state).toBe('pc')

    world.tick(2000) // 61초
    await pc2.sync.pollOnce()
    await world.settle()
    expect(world.job(id)).toMatchObject({
      state: 'failed',
      error: 'PC가 작업을 잃었습니다 (앱을 다시 켰거나 큐를 비움)'
    })
    expect(await world.phoneJob(id)).toMatchObject({ state: 'failed' })

    // 정리 뒤에도 서비스는 정상 — 새 작업이 새 프로세스에서 끝까지 간다
    const next = await world.createJob(sceneTarget(1), 1, 'pc')
    await pc2.sync.pollOnce()
    await world.waitFor(() =>
      expect(world.job(next.id)).toMatchObject({ state: 'done', done: 1, failed: 0 })
    )
    await world.drain(pc2)
    expect(world.job(id).state).toBe('failed') // 되살아나지 않는다
    expect((await world.phone('GET', '/api/images')).json.items).toHaveLength(1)
    world.assertNoSecrets()
  })
})

// ── ⑧ 렌더러 새로고침 ───────────────────────────────────────────────

describe('⑧ 렌더러 새로고침 → 이미 큐에 있는 작업은 다시 넘기지 않는다', () => {
  it('큐에 넣은 뒤 workDone 전에 새로고침돼도 enqueue 는 한 번뿐이고 큐 진행을 이어 받아 done 까지 간다', async () => {
    const pc = await boot()
    pc.hold()
    pc.renderer.dropWorkDone = true // 큐에 넣고 workDone 을 부르기 전에 새로고침됐다
    const { id } = await world.createJob(sceneTarget(2), 2, 'pc')
    await pc.sync.pollOnce()
    await world.settle()
    expect(pc.enqueueCalls).toHaveLength(1)
    expect(pc.queue.idsByCloudJob(id)).toHaveLength(2)
    expect(world.job(id).state).toBe('queued') // accepted 가 아직 안 갔다
    expect(pc.channel('cloud:work')).toHaveLength(1)

    // 렌더러 새로고침 (메모리의 처리 기록이 사라짐)
    const fresh = pc.reloadRenderer()
    expect(fresh.doneJobs.size).toBe(0)
    await pc.sync.pollOnce()
    await world.settle()

    // 같은 작업이 다시 넘어오지 않고, 큐에 다시 넣지도 않았다
    expect(pc.channel('cloud:work')).toHaveLength(1)
    expect(fresh.works).toHaveLength(0)
    expect(pc.enqueueCalls).toHaveLength(1)
    expect(pc.queue.statusLite().items).toHaveLength(2)
    expect(world.job(id).state).toBe('pc') // 이어 받으며 accepted 가 갔다
    await pc.sync.pollOnce()
    expect(pollBodies().at(-1)!.activeJobIds).toEqual([id])

    // 끝까지: 장수 그대로 done
    pc.release()
    await world.queueIdle(pc)
    await world.waitFor(() =>
      expect(world.job(id)).toMatchObject({ state: 'done', done: 2, failed: 0 })
    )
    await world.drain(pc)
    expect(pc.generated).toHaveLength(2)
    expect(pc.enqueueCalls).toHaveLength(1)
    expect((await world.phone('GET', '/api/images')).json.items).toHaveLength(2)
    world.assertNoSecrets()
  })
})

// ── ⑨ 폰 취소 ───────────────────────────────────────────────────────

describe('⑨ 폰 취소 → PC 큐 항목 취소', () => {
  it('PC 가 맡은 작업을 폰이 취소하면 생성 중·대기 항목이 모두 취소되고 작업은 cancelled 로 남는다', async () => {
    const pc = await boot()
    pc.hold()
    const { id } = await world.createJob(sceneTarget(1), 3, 'pc')
    await pc.sync.pollOnce()
    await world.settle()
    expect(world.job(id).state).toBe('pc')
    const queueIds = pc.queue.idsByCloudJob(id)
    expect(queueIds).toHaveLength(3)
    expect(pc.queue.statusLite().items.map((i) => i.state)).toEqual([
      'generating',
      'pending',
      'pending'
    ])

    const cancelled = await world.phone('POST', `/api/jobs/${id}/cancel`)
    expect(cancelled.status).toBe(200)
    expect(cancelled.json.job).toMatchObject({ id, state: 'cancelled' })
    expect(world.unackedOps()).toBe(1)

    await pc.sync.pollOnce()
    await world.settle()
    await world.queueIdle(pc)
    expect(pc.queue.statusLite().items.map((i) => i.state)).toEqual([
      'cancelled',
      'cancelled',
      'cancelled'
    ])
    expect(pc.generated).toHaveLength(0) // 그림은 하나도 만들어지지 않았다
    expect(world.unackedOps()).toBe(0)
    // 취소 op 는 렌더러에 넘기지 않고 메인이 직접 처리했다
    expect(pc.channel<Dict>('cloud:work').flatMap((w) => w.ops)).toHaveLength(0)

    // 큐가 정리된 뒤에도 클라우드의 끝 상태를 덮어쓰지 않는다. 다만 PC 가 센 장수(취소된 3장 = 실패 3)는 알린다
    await sleep(300)
    await pc.sync.pollOnce()
    await world.settle()
    expect(world.job(id)).toMatchObject({ state: 'cancelled', done: 0, failed: 3 })
    const mine = ackBodies()
      .flatMap((a) => a.jobs as Dict[])
      .filter((j) => j.id === id)
    expect(mine).toEqual([
      { id, state: 'accepted' },
      { id, state: 'failed', done: 0, failed: 3, error: '취소됨' }
    ])
    expect(pollBodies().at(-1)!.activeJobIds).toEqual([])
    expect(world.cloud.imageRows()).toHaveLength(0)
    expect((await world.phoneJob(id)).state).toBe('cancelled')
    world.assertNoSecrets()
  })

  it('한 장 만든 뒤 취소하면 작업은 cancelled 인 채로 만든 1장과 취소된 2장을 폰 목록에 그대로 보인다', async () => {
    const pc = await boot()
    pc.hold()
    const { id } = await world.createJob(sceneTarget(1), 3, 'pc')
    await pc.sync.pollOnce()
    await world.settle()
    // 첫 장만 만들고 둘째 장에서 다시 붙든다 (release 가 첫 장을 풀고, 곧바로 건 새 문이 둘째 장을 막는다)
    pc.release()
    pc.hold()
    await world.waitFor(() => expect(pc.generated).toHaveLength(1))

    const cancelled = await world.phone('POST', `/api/jobs/${id}/cancel`)
    expect(cancelled.json.job).toMatchObject({ state: 'cancelled' })
    await pc.sync.pollOnce()
    await world.settle()
    await world.queueIdle(pc)
    await world.drain(pc)

    expect(pc.generated).toHaveLength(1)
    expect(world.job(id)).toMatchObject({ state: 'cancelled', done: 1, failed: 2 })
    expect(await world.phoneJob(id)).toMatchObject({ state: 'cancelled', done: 1, failed: 2 })
    // PC 가 센 결과(하나라도 만들었으면 done)를 보내되, 클라우드는 취소 상태를 되살리지 않는다
    expect(
      ackBodies()
        .flatMap((a) => a.jobs as Dict[])
        .filter((j) => j.id === id)
        .at(-1)
    ).toEqual({ id, state: 'done', done: 1, failed: 2 })
    expect((await world.phone('GET', '/api/images')).json.items).toHaveLength(1)
    world.assertNoSecrets()
  })
})

// ── ⑩ 비밀값 ────────────────────────────────────────────────────────

describe('⑩ 비밀값은 어디에도 안 나온다', () => {
  it('NAI 오류 본문·PC 생성 오류·서버 오류 문구에 토큰이 섞여도 응답·broadcast·상태·저장소에 없다', async () => {
    const pc = await bootWithCloudGen()
    const secretText = `${NAI_TOKEN} ${PC_SECRET}`

    // (a) PC 큐 생성 오류에 토큰·비밀값이 섞였다
    pc.failGenerateWith = `HTTP 401 ${secretText}`
    const pcJob = await world.createJob(sceneTarget(1), 1, 'pc')
    await pc.sync.pollOnce()
    await world.waitFor(() => expect(world.job(pcJob.id).state).toBe('failed'))
    await world.drain(pc)
    const pcFailed = await world.phoneJob(pcJob.id)
    expect(pcFailed.error).toContain('HTTP 401')
    expect(pcFailed.error).toContain('***')

    // (b) 서버 오류 문구에 PC 비밀값이 섞였고, 연결도 한 번 끊겼다
    world.inject(
      (m, p) => m === 'GET' && p === '/api/pc/info',
      () => Response.json({ ok: false, error: `서버 내부 오류 ${PC_SECRET}` }, { status: 500 })
    )
    await pc.sync.refreshInfo()
    const afterServerError = pc.sync.status()
    expect(afterServerError.connected).toBe(false)
    expect(afterServerError.error).toContain('***')
    world.inject(
      (m, p) => m === 'POST' && p === '/api/pc/poll',
      () => new TypeError(`fetch failed ${secretText}`)
    )
    await pc.sync.pollOnce()
    const afterNetworkError = pc.sync.status()
    expect(afterNetworkError.error).toBe('클라우드에 연결하지 못했습니다')
    await pc.sync.pollOnce()
    expect(pc.sync.status()).toMatchObject({ connected: true, error: null })

    // (c) PC 가 꺼진 뒤 클라우드 생성: NAI 가 토큰을 되풀이하는 오류 본문을 준다
    powerOff(pc)
    // NAI 는 PC 비밀값을 모른다 — 되풀이할 수 있는 건 자기 토큰뿐
    world.cloud.nai.generateQueue.push(reply(500, `invalid api key ${NAI_TOKEN}`))
    world.cloud.nai.generateQueue.push(
      reply(200, JSON.stringify({ message: `bad token ${NAI_TOKEN}` }), {
        'content-type': 'application/json'
      })
    )
    const cloudJob = await world.createJob(sceneTarget(1), 3, 'cloud')
    await world.runAlarms()
    const row = world.job(cloudJob.id)
    expect(row).toMatchObject({ state: 'done', done: 1, failed: 2 })
    expect(String(row.error)).toContain('***')
    const cloudView = await world.phoneJob(cloudJob.id)
    expect(cloudView.error).toContain('***')

    // (d) 토큰을 지우면 맡긴 토큰도 지워진다
    const pc2 = world.startPc()
    world.naiToken = null
    await pc2.sync.onNaiTokenChanged()
    await world.settle()
    expect(world.cloud.kv('secret:nai')).toBeNull()

    world.assertNoSecrets([
      ['정리 전 상태 오류', afterServerError.error ?? ''],
      ['네트워크 오류 상태', afterNetworkError.error ?? ''],
      ['폰 작업 오류(PC)', pcFailed.error ?? ''],
      ['폰 작업 오류(클라우드)', cloudView.error ?? '']
    ])
    // 대조: 맡겨 둔 동안에는 저장소에 토큰이 있었다 (검사가 헛돌지 않았다는 증거)
    expect(world.cloud.nai.generateCalls[0].headers['authorization']).toBe(`Bearer ${NAI_TOKEN}`)
  })
})

// ── ⑪ 클라우드 저장소가 비었을 때 ───────────────────────────────────

describe('⑪ 클라우드 저장소가 비면 전부 다시 올린다', () => {
  it('poll 이 needsFullSync 를 주면 라이브러리·씬·조각과 완성 요청까지 다시 올라간다', async () => {
    const pc = await bootWithCloudGen()
    expect(preparedKeys()).toHaveLength(4)

    // 워커 저장소가 사라졌다 (배포 직후·초기화)
    world.cloud.sql.exec(`DELETE FROM kv WHERE k IN ('library', 'hash:library', 'hash:fragments')`)
    world.cloud.sql.exec(`DELETE FROM scenes`)
    world.cloud.sql.exec(`DELETE FROM scene_hash`)
    world.cloud.sql.exec(`DELETE FROM prepared`)
    expect((await world.phone('GET', '/api/state')).json.library).toBeNull()

    await pc.sync.pollOnce()
    await world.settle()
    expect(pc.channel('cloud:needPrepared')).toContainEqual({ full: true })
    await world.waitFor(() =>
      expect(preparedKeys()).toEqual(['main', 'scene:1', 'scene:2', 'scene:3'])
    )
    const state = await world.phone('GET', '/api/state')
    expect(state.json.library.presets).toHaveLength(2)
    expect((await world.phone('GET', '/api/scenes?presetId=1')).json.items).toHaveLength(2)
    expect(world.cloud.kv('hash:fragments')).not.toBeNull()
    world.assertNoSecrets()
  })
})

// ── 덧붙인 시나리오: 경계·복구 ──────────────────────────────────────

describe('⑫ Anlas 감소 안전망 → PC 도 따라 끈다', () => {
  it('클라우드가 Anlas 감소를 보고 스스로 멈추면, PC 가 켜질 때 클라우드 생성 설정을 같이 끈다', async () => {
    const pc = await bootWithCloudGen()
    powerOff(pc)
    world.cloud.nai.spendPerImage = 5 // 생성할 때마다 Anlas 가 빠진다

    const { id } = await world.createJob(sceneTarget(1), 3, 'cloud')
    await world.runAlarms()
    expect(world.job(id)).toMatchObject({
      state: 'failed',
      done: 1,
      error: 'Anlas가 차감되어 중단했습니다'
    })
    expect(world.cloud.nai.generateCalls).toHaveLength(1) // 더 만들지 않는다
    expect((await world.cloud.pcJson('GET', '/api/pc/info')).json.settings.cloudGenEnabled).toBe(
      false
    )
    expect((await world.phone('GET', '/api/state')).json.cloudGen).toMatchObject({
      enabled: false,
      ready: false
    })

    // PC 가 켜진다: 클라우드가 끈 것을 따르고, 이미 만든 한 장은 가져간다
    expect(world.config.state.gen).toBe(true)
    const pc2 = world.startPc()
    await pc2.sync.syncNow()
    await world.drain(pc2)
    expect(world.config.state.gen).toBe(false)
    expect(pc2.sync.status().cloudGen.enabled).toBe(false)
    expect(pc2.channel<Dict>('cloud:status').at(-1)!.cloudGen.enabled).toBe(false)
    expect(world.saveGenerated).toHaveBeenCalledTimes(1)

    // 꺼진 동안 클라우드 생성 요청은 이유와 함께 거절된다
    const refused = await world.createJob(sceneTarget(1), 1, 'cloud')
    expect(refused.status).toBe(400)
    expect(refused.json.error).toContain('클라우드 생성이 꺼져 있습니다')
    world.assertNoSecrets()
  })
})

describe('⑬ auto 작업 45초 넘김', () => {
  it('PC 가 가져가기 전에 꺼지면 45초 뒤 알람이 클라우드로 넘겨 생성한다', async () => {
    const pc = await bootWithCloudGen()
    world.tick(2000) // 마지막 poll 2초 뒤 — 아직 켜진 것으로 보인다
    const made = await world.createJob(sceneTarget(1), 1, 'auto')
    expect(made.json.job).toMatchObject({ state: 'queued', runner: 'pc', place: 'auto' })
    pc.kill() // 가져가기 전에 꺼졌다
    expect(world.cloud.pendingAlarm).toBe(world.cloud.clock + 46_000)

    await world.runAlarms()
    expect(world.job(made.id)).toMatchObject({
      state: 'done',
      runner: 'cloud',
      place: 'auto',
      done: 1,
      failed: 0
    })
    expect(world.cloud.nai.generateCalls).toHaveLength(1)
    expect(await world.phoneJob(made.id)).toMatchObject({ runner: 'cloud', state: 'done' })
    world.assertNoSecrets()
  })
})

describe('⑭ PC 가 꺼진 동안의 요청', () => {
  it('「PC에서만」 작업은 안내와 함께 기다렸다가 PC 가 켜지면 처리되고, 클라우드 생성이 꺼진 auto 는 이유와 함께 거절된다', async () => {
    const pc = await boot() // 클라우드 생성은 꺼져 있다
    powerOff(pc)

    const waiting = await world.createJob(sceneTarget(1), 2, 'pc')
    expect(waiting.status).toBe(200)
    expect(waiting.json.job).toMatchObject({ state: 'queued', runner: 'pc' })
    expect(waiting.json.notice).toContain('PC가 켜지면')
    const refused = await world.createJob(sceneTarget(1), 1, 'auto')
    expect(refused.status).toBe(400)
    expect(refused.json.error).toContain('PC가 꺼져 있습니다')
    expect(refused.json.error).toContain('클라우드 생성이 꺼져 있습니다')

    const pc2 = world.startPc()
    await pc2.sync.syncNow()
    await world.waitFor(() =>
      expect(world.job(waiting.id)).toMatchObject({ state: 'done', done: 2, failed: 0 })
    )
    await world.drain(pc2)
    expect((await world.phone('GET', '/api/images')).json.items).toHaveLength(2)
    world.assertNoSecrets()
  })
})

describe('⑮ 메인 생성 작업', () => {
  it('PC 켜짐: 메인 설정으로 만들고 씬 없는 그림으로 올라온다', async () => {
    const pc = await boot()
    const made = await world.createJob({ type: 'main' }, 2, 'pc')
    expect(made.json.job).toMatchObject({ label: '메인 생성', target: { type: 'main' } })
    await pc.sync.pollOnce()
    await world.waitFor(() =>
      expect(world.job(made.id)).toMatchObject({ state: 'done', done: 2, failed: 0 })
    )
    await world.drain(pc)
    expect(pc.enqueueCalls[0][0]).toMatchObject({ prompt: '1girl, solo', cloudJobId: made.id })
    expect(pc.enqueueCalls[0][0].sceneId).toBeUndefined()
    const items = (await world.phone('GET', '/api/images')).json.items as Dict[]
    expect(items).toHaveLength(2)
    for (const item of items) {
      expect(item).toMatchObject({ source: 'pc', sceneId: null, presetId: null })
    }
    world.assertNoSecrets()
  })

  it('PC 꺼짐: 클라우드가 메인 완성 요청으로 만들고, PC 가 켜지면 일반 그림(t2i)으로 가져간다', async () => {
    const pc = await bootWithCloudGen()
    powerOff(pc)
    const made = await world.createJob({ type: 'main' }, 1, 'auto')
    expect(made.json.job).toMatchObject({ state: 'cloud', label: '메인 생성' })
    await world.runAlarms()
    expect(world.job(made.id)).toMatchObject({ state: 'done', done: 1 })
    const call = world.cloud.nai.generateCalls[0]
    expect((JSON.parse(call.body!) as Dict).input).toContain('1girl, solo')
    expect(world.cloud.imageRows()[0]).toMatchObject({ scene_id: null, preset_id: null })

    const pc2 = world.startPc()
    await pc2.sync.syncNow()
    await world.drain(pc2)
    expect(world.saveGenerated).toHaveBeenCalledTimes(1)
    const input = world.saveGenerated.mock.calls[0][0]
    expect(input.kind).toBe('t2i')
    expect(input.sceneId).toBeUndefined()
    expect(world.cloud.imageRows()[0]).toMatchObject({ imported: 1 })
    world.assertNoSecrets()
  })
})

describe('⑯ 끝 ack 유실', () => {
  it('끝 ack 가 가지 못한 작업은 activeJobIds 에 남아 60초가 지나도 잃은 것으로 처리되지 않고, 다음 poll 에서 done', async () => {
    const pc = await boot()
    pc.hold()
    const { id } = await world.createJob(sceneTarget(1), 2, 'pc')
    await pc.sync.pollOnce()
    await world.settle()
    expect(world.job(id).state).toBe('pc')

    // 끝났다고 알리는 ack 한 번이 서버 오류로 유실된다
    world.inject(
      (m, p) => m === 'POST' && p === '/api/pc/ack',
      () => Response.json({ ok: false, error: '일시 오류' }, { status: 503 })
    )
    pc.release()
    await world.queueIdle(pc)
    await world.waitFor(() =>
      expect(
        world.requests.filter((r) => r.path === '/api/pc/ack' && r.status === 503)
      ).toHaveLength(1)
    )
    await world.drain(pc)
    expect(world.job(id).state).toBe('pc') // 클라우드는 아직 모른다

    world.tick(70_000) // 유예(60초)보다 오래
    await pc.sync.pollOnce()
    expect(pollBodies().at(-1)!.activeJobIds).toEqual([id])
    await world.settle()
    expect(world.job(id)).toMatchObject({ state: 'done', done: 2, failed: 0, error: null })

    // 다 전달됐으니 이제 목록에서 빠진다
    await pc.sync.pollOnce()
    expect(pollBodies().at(-1)!.activeJobIds).toEqual([])
    world.assertNoSecrets()
  })
})

describe('⑰ NAI 토큰 교체·삭제', () => {
  const NEW_TOKEN = 'pst-test-NEW-9876543210zyxwvutsr'

  it('토큰을 바꾸면 클라우드에 새 토큰이 맡겨지고 다음 클라우드 생성에 쓰인다', async () => {
    const pc = await bootWithCloudGen()
    world.naiToken = NEW_TOKEN
    await pc.sync.onNaiTokenChanged()
    expect(world.cloud.kv('secret:nai')).toBe(NEW_TOKEN)
    powerOff(pc)

    await world.createJob(sceneTarget(1), 1, 'cloud')
    await world.runAlarms()
    expect(world.cloud.nai.generateCalls).toHaveLength(1)
    expect(world.cloud.nai.generateCalls[0].headers['authorization']).toBe(`Bearer ${NEW_TOKEN}`)
    for (const call of world.cloud.nai.calls) {
      expect(call.headers['authorization']).not.toContain(NAI_TOKEN)
    }
    world.assertNoSecrets([], [NEW_TOKEN])
  })

  it('토큰을 지우면 맡긴 토큰도 지워지고, 대기 중이던 클라우드 작업은 실패하며 클라우드 생성이 꺼진다', async () => {
    const pc = await bootWithCloudGen()
    powerOff(pc)
    const { id } = await world.createJob(sceneTarget(1), 2, 'cloud') // 알람이 아직 안 울렸다
    expect(world.job(id).state).toBe('cloud')

    const pc2 = world.startPc()
    world.naiToken = null
    await pc2.sync.onNaiTokenChanged()
    await world.settle()
    expect(world.cloud.kv('secret:nai')).toBeNull()
    expect(world.job(id)).toMatchObject({ state: 'failed', error: 'NAI 토큰이 없음' })
    expect((await world.cloud.pcJson('GET', '/api/pc/info')).json).toMatchObject({
      hasNaiToken: false,
      settings: { cloudGenEnabled: false }
    })
    expect(world.config.state.gen).toBe(false)

    await world.runAlarms()
    expect(world.cloud.nai.calls).toHaveLength(0) // NAI 에는 아무것도 보내지 않았다
    world.assertNoSecrets()
  })
})

describe('⑱ 잔액 정보', () => {
  it('PC 가 올린 Opus 사용량이 폰의 라이브러리·무료 사용량 표시에 반영된다', async () => {
    const pc = await boot()
    pc.sync.onNaiInfo({
      tier: 'opus',
      anlas: 4321,
      opusUsage: { percent: 42, isNegative: false, timeUntilNextPercent: 3600 }
    })
    expect(await pc.sync.syncOnce()).toBe(true)
    let state = await world.phone('GET', '/api/state')
    expect(state.json.library.naiInfo).toMatchObject({
      tier: 'opus',
      anlas: 4321,
      opusUsage: { percent: 42, isNegative: false },
      updatedAt: world.cloud.clock
    })
    expect(state.json.cloudGen.quota).toMatchObject({ state: 'available' })
    expect(pc.sync.status().cloudGen.quota).toBe('available')

    world.tick(1000)
    pc.sync.onNaiInfo({
      tier: 'opus',
      anlas: 4300,
      opusUsage: { percent: 0, isNegative: true, timeUntilNextPercent: 3600 }
    })
    expect(await pc.sync.syncOnce()).toBe(true)
    state = await world.phone('GET', '/api/state')
    expect(state.json.cloudGen.quota).toMatchObject({ state: 'exhausted' })
    expect(pc.sync.status().cloudGen.quota).toBe('exhausted')
    world.assertNoSecrets()
  })
})

describe('⑲ 최근 그림 올리기', () => {
  it('[최근 N장 올리기]로 예전 그림이 폰 갤러리에 오르고, 다시 눌러도 중복 업로드는 없다', async () => {
    const pc = await boot()
    for (const id of [1, 2, 3]) {
      world.db.images.push({
        id,
        filePath: `C:/fake/old/${id}.png`,
        sceneId: id === 3 ? null : 1,
        seed: 500 + id,
        kind: id === 3 ? 't2i' : 'scene',
        width: 832,
        height: 1216
      })
    }
    expect(pc.sync.uploadRecent(100)).toEqual({ queued: 3 })
    await world.drain(pc)
    const items = (await world.phone('GET', '/api/images')).json.items as Dict[]
    expect(items.map((i) => i.id).sort()).toEqual(['p1', 'p2', 'p3'])
    expect(items.find((i) => i.id === 'p3')).toMatchObject({ sceneId: null, presetId: null })
    expect(items.find((i) => i.id === 'p1')).toMatchObject({ sceneId: 1, presetId: 1 })
    expect(world.config.state.uploaded).toEqual([1, 2, 3])
    expect(pc.sync.uploadRecent(100)).toEqual({ queued: 0 })
    world.assertNoSecrets()
  })
})

describe('⑳ start() 로 시작하는 실제 순서', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('빈 클라우드에서 첫 동기화와 첫 poll 이 동시에 나가도 서로 어긋나지 않고 한 번 맞추면 더 올리지 않는다', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }) // 5초·30초 타이머는 돌지 않게
    const pc = world.startPc()
    await world.pairPhone(pc)
    pc.sync.start()
    await world.settle()

    const state = await world.phone('GET', '/api/state')
    expect(state.json.library.presets).toHaveLength(2)
    expect(state.json.pc.online).toBe(true)
    expect((await world.phone('GET', '/api/scenes?presetId=1')).json.items).toHaveLength(2)
    expect((await world.phone('GET', '/api/scenes?presetId=2')).json.items).toHaveLength(1)
    expect(world.cloud.bucket.files.has('meta/fragments.json')).toBe(true)
    expect(pc.sync.status()).toMatchObject({ connected: true, error: null, configured: true })
    expect(pc.renderer.errors).toEqual([])

    const puts = world.requests.filter((r) => r.method === 'PUT').length
    expect(await pc.sync.syncOnce()).toBe(true)
    expect(world.requests.filter((r) => r.method === 'PUT')).toHaveLength(puts)
    pc.sync.stop()
    world.assertNoSecrets()
  })
})

describe('㉑ PC 에서 지워진 씬', () => {
  it('아직 동기화 전에 PC 에서 지운 씬의 작업은 「씬이 PC에 없음」으로 실패하고, 동기화 뒤에는 폰에서 사라진다', async () => {
    const pc = await boot()
    world.db.scenes = world.db.scenes.filter((s) => s.id !== 2)
    const { id } = await world.createJob(sceneTarget(2), 2, 'pc')
    await pc.sync.pollOnce()
    await world.settle()
    expect(world.job(id)).toMatchObject({
      state: 'failed',
      done: 0,
      failed: 2,
      error: '씬이 PC에 없음'
    })
    expect(pc.enqueueCalls).toHaveLength(0) // 큐에는 아무것도 넣지 않았다

    expect(await pc.sync.syncOnce()).toBe(true)
    const scenes = await world.phone('GET', '/api/scenes?presetId=1')
    expect(scenes.json.items.map((s: Dict) => s.id)).toEqual([1])
    expect((await world.phone('GET', '/api/state')).json.library.presets[0].sceneCount).toBe(1)
    const gone = await world.createJob(sceneTarget(2), 1, 'pc')
    expect(gone.status).toBe(404)
    world.assertNoSecrets()
  })
})

describe('㉒ 동기화 끄기', () => {
  it('동기화를 끄면 PC 는 꺼진 것으로 보이고 작업을 받지 않으며, 켜면 기다리던 작업을 처리한다', async () => {
    const pc = await boot()
    await pc.sync.setEnabled(false)
    expect(pc.sync.status().enabled).toBe(false)
    world.tick(20_000)
    const polls = pollBodies().length

    const made = await world.createJob(sceneTarget(1), 1, 'pc')
    await pc.sync.pollOnce() // 꺼져 있으면 아무것도 보내지 않는다
    expect(pollBodies()).toHaveLength(polls)
    expect(world.job(made.id).state).toBe('queued')
    expect((await world.phone('GET', '/api/state')).json.pc.online).toBe(false)

    await pc.sync.setEnabled(true)
    await pc.sync.pollOnce()
    await world.waitFor(() =>
      expect(world.job(made.id)).toMatchObject({ state: 'done', done: 1, failed: 0 })
    )
    await world.drain(pc)
    expect((await world.phone('GET', '/api/state')).json.pc.online).toBe(true)
    world.assertNoSecrets()
  })
})

describe('㉓ 클라우드 생성 켜기 실패', () => {
  it('설정 저장이 실패하면 맡긴 NAI 토큰을 되돌려 지우고 꺼진 채로 남으며, 다시 시도하면 켜진다', async () => {
    const pc = await boot()
    world.inject(
      (m, p) => m === 'PUT' && p === '/api/pc/settings',
      () => Response.json({ ok: false, error: '일시 오류' }, { status: 500 })
    )
    await expect(pc.sync.setCloudGen(true)).rejects.toThrow('클라우드 요청 실패')
    expect(world.cloud.kv('secret:nai')).toBeNull() // 토큰만 맡긴 채 남지 않는다
    expect(world.config.state.gen).toBe(false)
    expect(pc.sync.status().cloudGen.enabled).toBe(false)
    expect((await world.cloud.pcJson('GET', '/api/pc/info')).json).toMatchObject({
      hasNaiToken: false,
      settings: { cloudGenEnabled: false }
    })

    await pc.sync.setCloudGen(true)
    await world.settle()
    expect(world.cloud.kv('secret:nai')).not.toBeNull()
    expect(world.config.state.gen).toBe(true)
    expect(pc.sync.status().cloudGen).toMatchObject({ enabled: true, hasToken: true })
    world.assertNoSecrets()
  })
})

describe('㉔ 무작위 사건 순서', () => {
  // 폰 작업·취소·poll·시간·렌더러 새로고침(처리 도중 포함)·PC 재시작·네트워크 끊김을 뒤섞은 뒤
  // 장애를 걷어 내면 모든 작업이 끝 상태로 수렴하고, 같은 PC 가 같은 작업을 두 번 큐에 넣지 않는다
  it.each([1, 5, 8, 13, 51, 111])(
    'PC 쪽 시드 %i',
    async (seed) => {
      const result = await runPcChaos(seed)
      expect(result.problems).toEqual([])
    },
    90_000
  )

  // 클라우드 생성이 켜진 채 PC 를 끄고 켜며 알람·NAI 오류·가져오기 끊김을 뒤섞은 뒤에도
  // 안 가져간 그림이 없고 장수가 넘치지 않는다
  it.each([2, 16, 48, 76])(
    '클라우드 쪽 시드 %i',
    async (seed) => {
      const result = await runCloudChaos(seed)
      expect(result.problems).toEqual([])
    },
    90_000
  )
})

describe('㉕ 「가져왔다」 알림 유실', () => {
  const failNotice = (): void =>
    world.inject(
      (m, p) => m === 'POST' && /\/api\/pc\/cloud-images\/[^/]+\/imported$/.test(p),
      () => Response.json({ ok: false, error: '일시 오류' }, { status: 503 })
    )

  async function oneCloudImage(): Promise<void> {
    const pc = await bootWithCloudGen()
    powerOff(pc)
    await world.createJob(sceneTarget(1), 1, 'cloud')
    await world.runAlarms()
    expect(world.cloud.imageRows()).toHaveLength(1)
  }

  it('알림이 못 가도 같은 그림을 다시 저장하지 않고 다음 차례에 알린다', async () => {
    await oneCloudImage()
    const pc2 = world.startPc()
    failNotice()
    await pc2.sync.syncNow()
    await world.drain(pc2)
    expect(world.saveGenerated).toHaveBeenCalledTimes(1)
    expect(world.cloud.imageRows()[0]).toMatchObject({ imported: 0 }) // 클라우드는 아직 모른다

    await pc2.sync.importOnce()
    expect(world.saveGenerated).toHaveBeenCalledTimes(1) // 다시 받지 않았다
    const saved = (await world.saveGenerated.mock.results[0].value) as { id: number }
    expect(world.cloud.imageRows()[0]).toMatchObject({ imported: 1, pc_image_id: saved.id })
    world.assertNoSecrets()
  })

  // 알림 대기표(pendingImported)를 설정에도 적어 두므로, 알림이 못 간 채 앱이 다시 켜져도
  // 같은 그림을 PC 에 한 번 더 저장하지 않고 먼저 알린다 (예전에는 메모리뿐이라 두 번 저장됐다)
  it('알림이 못 간 채 PC 앱이 다시 켜져도 같은 그림을 PC 에 또 저장하지 않고 새 프로세스가 먼저 알린다', async () => {
    await oneCloudImage()
    const pc2 = world.startPc()
    failNotice()
    await pc2.sync.syncNow()
    await world.drain(pc2)
    expect(world.saveGenerated).toHaveBeenCalledTimes(1)
    const saved = (await world.saveGenerated.mock.results[0].value) as { id: number }
    expect(world.cloud.imageRows()[0]).toMatchObject({ imported: 0 })
    // 설정에 적혀 있다 (앱이 다시 켜지면 여기서 읽는다)
    expect(world.config.state.pendingImported).toEqual({
      [world.cloud.imageRows()[0].id as string]: saved.id
    })

    pc2.kill()
    const pc3 = world.startPc()
    await pc3.sync.syncNow()
    await world.drain(pc3)
    expect(world.saveGenerated).toHaveBeenCalledTimes(1)
    expect(world.cloud.imageRows()[0]).toMatchObject({ imported: 1, pc_image_id: saved.id })
    expect(world.config.state.pendingImported).toEqual({}) // 알렸으니 비운다
    world.assertNoSecrets()
  })

  it('알림이 못 간 그림의 클라우드 사본이 지워졌으면(404) 대기표에서 빼고 다시 저장하지도 않는다', async () => {
    await oneCloudImage()
    const pc2 = world.startPc()
    failNotice()
    await pc2.sync.syncNow()
    await world.drain(pc2)
    expect(Object.keys(world.config.state.pendingImported)).toHaveLength(1)

    // 폰이 force 로 그 클라우드 사본을 지웠다 — 알릴 곳이 없다
    const id = world.cloud.imageRows()[0].id as string
    expect((await world.phone('DELETE', `/api/images/${id}?force=1`)).status).toBe(200)
    await pc2.sync.importOnce()
    expect(world.config.state.pendingImported).toEqual({})
    expect(world.saveGenerated).toHaveBeenCalledTimes(1)
  })
})

describe('㉖ 보관 장수', () => {
  it('보관 장수를 줄이면 오래된 PC 그림부터 지워지고, PC 가 아직 안 가져간 클라우드 생성분은 남는다', async () => {
    const pc = await bootWithCloudGen()
    expect((await pc.sync.setKeepImages(100)).keepImages).toBe(100)
    expect((await world.cloud.pcJson('GET', '/api/pc/info')).json.settings).toEqual({
      cloudGenEnabled: true,
      keepImages: 100
    })
    powerOff(pc)
    await world.createJob(sceneTarget(1), 2, 'cloud')
    await world.runAlarms()
    expect(world.cloud.imageRows()).toHaveLength(2)

    // 새로 켠 PC 가 예전 그림 105장을 올린다 (보관 100장)
    const pc2 = world.startPc()
    for (let id = 1; id <= 105; id++) {
      world.db.images.push({
        id,
        filePath: `C:/fake/old/${id}.png`,
        sceneId: 1,
        seed: id,
        kind: 'scene',
        width: 832,
        height: 1216
      })
    }
    expect(pc2.sync.uploadRecent(200)).toEqual({ queued: 105 })
    await world.drain(pc2)

    const rows = world.cloud.imageRows()
    const pcRows = rows.filter((r) => r.source === 'pc')
    const cloudRows = rows.filter((r) => r.source === 'cloud')
    expect(pcRows).toHaveLength(100)
    expect(pcRows.map((r) => r.id)).not.toContain('p5') // 가장 오래된 5장이 지워졌다
    expect(pcRows.map((r) => r.id)).toContain('p6')
    expect(cloudRows).toHaveLength(2) // 안 가져간 클라우드 그림은 세지도 지우지도 않는다
    expect(cloudRows.every((r) => r.imported === 0)).toBe(true)
    for (const row of cloudRows)
      expect(world.cloud.bucket.files.has(row.r2_key as string)).toBe(true)
    expect(world.cloud.bucket.files.has('img/p5.webp')).toBe(false)
    expect(world.cloud.bucket.files.has('thumb/p5.webp')).toBe(false)
    expect(world.cloud.bucket.files.has('img/p6.webp')).toBe(true)

    // 가져간 뒤에는 클라우드 사본도 보관 장수에 세어진다
    await pc2.sync.importOnce()
    await world.drain(pc2)
    expect(world.cloud.imageRows().filter((r) => r.imported === 1)).toHaveLength(2)
    world.assertNoSecrets()
  })
})

describe('고친 결함의 회귀 방지 (종단 시험이 처음 찾아낸 것들)', () => {
  const pushOldImages = (): void => {
    for (const id of [1, 2]) {
      world.db.images.push({
        id,
        filePath: `C:/fake/old/${id}.png`,
        sceneId: 1,
        seed: 500 + id,
        kind: 'scene',
        width: 832,
        height: 1216
      })
    }
  }

  /** 워커의 그림 저장소가 비었다 (새 워커·새 버킷으로 바뀌었거나 초기화됐다) */
  const wipeCloudImages = (): void => {
    world.cloud.sql.exec(`DELETE FROM images`)
    recountImages(world.cloud.sql)
    for (const key of world.cloud.bucket.keys('img/')) world.cloud.bucket.files.delete(key)
    for (const key of world.cloud.bucket.keys('thumb/')) world.cloud.bucket.files.delete(key)
  }

  // 「올린 그림 id」 기록이 클라우드 저장소와 무관하게 남아 있던 탓에, 저장소가 비어도 [최근 N장 올리기]가
  // 0장을 올렸다. 이제 클라우드가 전체 올리기를 요구하면 기록을 비운다
  it('클라우드 저장소가 초기화돼도 [최근 N장 올리기]로 PC 그림을 폰 갤러리에 다시 올릴 수 있다', async () => {
    const pc = await boot()
    pushOldImages()
    expect(pc.sync.uploadRecent(100)).toEqual({ queued: 2 })
    await world.drain(pc)
    expect((await world.phone('GET', '/api/images')).json.items).toHaveLength(2)

    // 워커 저장소가 비었다 → 다음 poll 이 needsFullSync
    wipeCloudImages()
    world.cloud.sql.exec(`DELETE FROM kv WHERE k IN ('library', 'hash:library', 'hash:fragments')`)
    world.cloud.sql.exec(`DELETE FROM scenes`)
    world.cloud.sql.exec(`DELETE FROM scene_hash`)
    await pc.sync.pollOnce()
    await world.settle()
    expect((await world.phone('GET', '/api/state')).json.library).not.toBeNull()
    expect((await world.phone('GET', '/api/images')).json.items).toEqual([])

    expect(pc.sync.uploadRecent(100)).toEqual({ queued: 2 })
    await world.drain(pc)
    expect((await world.phone('GET', '/api/images')).json.items).toHaveLength(2)
    world.assertNoSecrets()
  })

  it('새 연결 파일을 가져온 뒤에도 [최근 N장 올리기]가 이미 올린 그림을 다시 올린다', async () => {
    const pc = await boot()
    pushOldImages()
    pc.sync.uploadRecent(100)
    await world.drain(pc)
    expect(pc.sync.uploadRecent(100)).toEqual({ queued: 0 }) // 같은 저장소면 다시 올리지 않는다

    // 다른 워커로 연결을 바꿨다 (배포 스크립트가 새 연결 파일을 둠) — 새 저장소에는 그림이 없다
    wipeCloudImages()
    world.config.state.connect = 'imported'
    await pc.sync.pollOnce()
    world.config.state.connect = 'none'
    await world.settle()

    expect(pc.sync.uploadRecent(100)).toEqual({ queued: 2 })
    await world.drain(pc)
    expect((await world.phone('GET', '/api/images')).json.items).toHaveLength(2)
  })

  // 클라우드가 Anlas 안전망으로 스스로 끈 직후, PC 가 아직 모르는 사이에 [보관 장수]를 바꾸면
  // PC 의 옛 켜짐 값이 실려 꺼진 클라우드 생성이 되살아나던 결함
  it('Anlas 안전망으로 꺼진 클라우드 생성은 PC 의 보관 장수 변경으로 다시 켜지지 않는다', async () => {
    const pc = await bootWithCloudGen() // PC 는 켜져 있다
    world.cloud.nai.spendPerImage = 5
    await world.createJob(sceneTarget(1), 3, 'cloud') // PC 가 켜져 있어도 「클라우드」로 고른 작업
    await world.runAlarms()
    const settings = async (): Promise<Dict> =>
      (await world.cloud.pcJson('GET', '/api/pc/info')).json.settings
    expect((await settings()).cloudGenEnabled).toBe(false)
    expect(world.config.state.gen).toBe(true) // PC 는 아직 모른다

    await pc.sync.setKeepImages(500)
    expect(await settings()).toEqual({ cloudGenEnabled: false, keepImages: 500 })
    expect(world.config.state.gen).toBe(false)
    expect(pc.sync.status()).toMatchObject({ keepImages: 500, cloudGen: { enabled: false } })
  })
})

// ── ㉗ 폰이 PC 꺼짐 중에 고친 메인 프롬프트 ────────────────────────────

describe('㉗ 폰이 PC 꺼짐 중에 고친 메인 프롬프트', () => {
  const payloadOf = (index: number): Dict => JSON.parse(world.cloud.nai.generateCalls[index].body!)
  const preparedRequest = (key: string): Dict =>
    JSON.parse(
      world.cloud.sql
        .exec<{ request: string }>(`SELECT request FROM prepared WHERE key = ?`, key)
        .one().request
    )

  it('메인 작업·씬 작업 모두 NAI 로 나가는 요청에 고친 프롬프트가 들어가고, 캐릭터 편집은 안내만 하다가 PC 가 반영한 뒤부터 쓰인다', async () => {
    const pc = await bootWithCloudGen()
    powerOff(pc)

    // 메인 프롬프트를 두 번에 나눠 고쳐도 편집 줄은 하나로 합쳐진다
    expect((await world.phone('PATCH', '/api/main', { prompt: 'EDITED_MAIN, smile' })).status).toBe(
      200
    )
    expect((await world.phone('PATCH', '/api/main', { negativePrompt: 'EDITED_NEG' })).status).toBe(
      200
    )
    expect(world.unackedOps()).toBe(1)

    // 메인 작업: 고친 프롬프트·네거티브로 나간다 (PC 의 옛 값은 안 나간다)
    const main = await world.createJob({ type: 'main' }, 1, 'auto')
    expect(main.json.job).toMatchObject({ state: 'cloud' })
    expect(main.json.notice).toBeUndefined()
    await world.runAlarms()
    expect(world.job(main.id)).toMatchObject({ state: 'done', done: 1 })
    expect(payloadOf(0).input).toContain('EDITED_MAIN, smile')
    expect(payloadOf(0).input).not.toContain('1girl, solo')
    expect(payloadOf(0).parameters.negative_prompt).toContain('EDITED_NEG')
    expect(payloadOf(0).parameters.negative_prompt).not.toContain('lowres')

    // 씬 작업: 고친 메인 프롬프트 + 씬 프롬프트
    const scene = await world.createJob(sceneTarget(1), 1, 'cloud')
    await world.runAlarms()
    expect(world.job(scene.id)).toMatchObject({ state: 'done', done: 1 })
    expect(payloadOf(1).input).toContain('EDITED_MAIN, smile')
    expect(payloadOf(1).input).toContain('forest path, daylight')
    expect(payloadOf(1).input).not.toContain('1girl, solo')
    expect(payloadOf(1).parameters.negative_prompt).toContain('EDITED_NEG')

    // 캐릭터 편집은 완성 요청에 얹을 수 없다 — 안내를 주고, 그 작업에는 쓰이지 않는다
    expect((await world.phone('PATCH', '/api/characters/11', { enabled: true })).status).toBe(200)
    const withChar = await world.createJob(sceneTarget(2), 1, 'cloud')
    expect(withChar.json.notice).toBe(
      '캐릭터 편집은 PC가 켜져 반영된 뒤부터 클라우드 생성에 쓰입니다'
    )
    await world.runAlarms()
    expect(world.cloud.nai.generateCalls[2].body).toContain('hana, black hair')
    expect(world.cloud.nai.generateCalls[2].body).not.toContain('duri')

    // PC 가 켜져 편집을 반영하면 완성 요청도 새로 올라가서 이후 작업에 캐릭터까지 쓰인다
    const pc2 = world.startPc()
    await pc2.sync.syncNow()
    await world.drain(pc2)
    expect(world.unackedOps()).toBe(0)
    expect(world.db.main.prompt).toBe('EDITED_MAIN, smile')
    expect(world.db.characters[1].enabled).toBe(true)
    await world.waitFor(() => {
      expect(preparedRequest('main').prompt).toBe('EDITED_MAIN, smile')
      expect(preparedRequest('main').characterPrompts).toHaveLength(2)
    })
    powerOff(pc2)
    const after = await world.createJob({ type: 'main' }, 1, 'cloud')
    expect(after.json.notice).toBeUndefined()
    await world.runAlarms()
    const last = world.cloud.nai.generateCalls.length - 1
    expect(payloadOf(last).input).toContain('EDITED_MAIN, smile')
    expect(world.cloud.nai.generateCalls[last].body).toContain('duri, blonde hair')
    world.assertNoSecrets()
  })
})

// ── ㉘ V5 무료 사용량이 작업 도중 바닥날 때 ─────────────────────────────

describe('㉘ V5 무료 사용량이 작업 도중 바닥날 때', () => {
  it('바닥난 것을 확인한 다음 장부터 NAI 생성 호출은 0회이고 Anlas 는 그대로다', async () => {
    const pc = await bootWithCloudGen()
    world.db.main.model = 'nai-diffusion-5-full'
    pc.renderer.touch() // 생성 설정이 바뀌었다 → 완성 요청 다시 올림
    await world.settle()
    await world.waitFor(() => {
      const row = world.cloud.sql
        .exec<{ request: string }>(`SELECT request FROM prepared WHERE key = 'scene:1'`)
        .one()
      expect(JSON.parse(row.request).model).toBe('nai-diffusion-5-full')
    })
    powerOff(pc)

    // NAI 가 두 장을 만든 뒤부터 무료 사용량이 바닥났다고 답한다 (구독 확인을 부를 때마다 그 시점 값을 본다)
    const nai = world.cloud.nai
    Object.defineProperty(nai, 'usage', {
      configurable: true,
      get: () =>
        nai.generateCalls.length >= 2
          ? { percent: 0, isNegative: true, timeUntilNextPercent: 3600 }
          : { percent: 12, isNegative: false, timeUntilNextPercent: 3600 }
    })

    const { id } = await world.createJob(sceneTarget(1), 5, 'cloud')
    await world.runAlarms()
    expect(nai.generateCalls).toHaveLength(2) // 바닥난 다음 장부터는 한 번도 부르지 않았다
    expect(world.job(id)).toMatchObject({ state: 'failed', done: 2, failed: 0 })
    expect(String(world.job(id).error)).toContain('무료 사용량')
    expect(nai.fixed).toBe(1000) // Anlas 가 한 번도 나가지 않았다
    // V5 는 매 장 생성 직전에 구독을 확인한다 — 모든 생성 호출 바로 앞이 구독 확인이었다
    nai.calls.forEach((call, index) => {
      if (call.path === '/ai/generate-image')
        expect(nai.calls[index - 1].path).toBe('/user/subscription')
    })

    // 폰에는 바닥난 것이 이유와 함께 보인다
    const state = await world.phone('GET', '/api/state')
    expect(state.json.cloudGen).toMatchObject({ ready: false, quota: { state: 'exhausted' } })
    expect(state.json.cloudGen.reason).toContain('무료 사용량')

    // 그래도 새 작업을 요청하면 구독 확인에서 멈춘다 (생성 호출 0회)
    const again = await world.createJob(sceneTarget(1), 2, 'cloud')
    await world.runAlarms()
    expect(nai.generateCalls).toHaveLength(2)
    expect(world.job(again.id)).toMatchObject({ state: 'failed', done: 0 })
    expect(nai.fixed).toBe(1000)

    // 이미 만든 2장은 PC 가 켜지면 가져간다
    const pc2 = world.startPc()
    await pc2.sync.syncNow()
    await world.drain(pc2)
    expect(world.saveGenerated).toHaveBeenCalledTimes(2)
    world.assertNoSecrets()
  })
})

// ── ㉙ PC 「모두 취소」 ──────────────────────────────────────────────

describe('㉙ PC 「모두 취소」', () => {
  it('폰 작업 항목은 취소만 되고 씬 예약 수로 돌아가지 않는다 (PC 가 직접 예약한 항목만 돌아간다)', async () => {
    const pc = await boot()
    pc.hold()
    const phoneJob = await world.createJob(sceneTarget(1), 3, 'pc')
    await pc.sync.pollOnce()
    await world.settle()
    // PC 사용자가 씬 2 를 예약 생성했다 (예약 2장이 큐로 옮겨져 예약 수는 0)
    world.db.updateScene(2, { reserveCount: 0 })
    const scene2 = world.db.scene(2)!
    pc.queue.enqueueMany([0, 1].map((i) => ({ ...sceneRequest(world.db, scene2), seed: 7000 + i })))

    // 메인이 렌더러로 보내는 요약에는 폰 작업 항목에만 작업 id 가 실려 있다
    const lite = pc.queue.statusLite().items
    expect(lite.map((i) => i.state)).toEqual([
      'generating',
      'pending',
      'pending',
      'pending',
      'pending'
    ])
    expect(lite.filter((i) => i.cloudJobId === phoneJob.id).map((i) => i.sceneId)).toEqual([
      1, 1, 1
    ])
    expect(lite.filter((i) => i.cloudJobId === undefined).map((i) => i.sceneId)).toEqual([2, 2])

    // 실제 렌더러 스토어의 「모두 취소」
    const calls = await pressCancelAll(pc)
    expect(calls.find((c) => c.channel === 'queue:cancel')!.req).toEqual({
      ids: lite.map((i) => i.id)
    }) // 취소는 폰 항목까지 모두
    expect(world.db.scene(1)!.reserveCount).toBe(0) // 폰 작업의 씬은 그대로
    expect(world.db.scene(2)!.reserveCount).toBe(2) // PC 가 예약한 2장만 돌아온다
    expect(
      calls.filter((c) => c.channel === 'scenes:update').map((c) => (c.req as { id: number }).id)
    ).toEqual([2])

    pc.release()
    await world.queueIdle(pc)
    await world.drain(pc)
    expect(pc.queue.statusLite().items.every((i) => i.state === 'cancelled')).toBe(true)
    expect(pc.generated).toHaveLength(0)
    // PC 사용자가 취소한 것이라 폰 작업은 실패로 끝난다 — 씬 예약에 남지 않으니 다시 만들어지지도 않는다
    expect(world.job(phoneJob.id)).toMatchObject({
      state: 'failed',
      done: 0,
      failed: 3,
      error: '취소됨'
    })
    expect(world.db.scene(1)!.reserveCount).toBe(0)
    world.assertNoSecrets()
  })
})

// ── ㉚ 쓰기 한도 ────────────────────────────────────────────────────

describe('㉚ 워커 쓰기 한도 (무료 요금제 하루 10만 행)', () => {
  it('씬 300개 프리셋에서 씬 1개만 바뀐 동기화는 워커가 10행 이하만 쓰고, 바뀐 게 없으면 한 행도 안 쓴다', async () => {
    for (let id = 100; id < 400; id++) {
      world.db.scenes.push(makeScene(id, 1, { name: `대량 ${id}`, prompt: `bulk ${id}` }))
    }
    const pc = await boot()
    expect((await world.phone('GET', '/api/scenes?presetId=1')).json.items).toHaveLength(302)
    const sql = world.cloud.sql
    const sceneBodies = (): number => world.requestsOf('PUT', '/api/pc/scenes').length

    // 씬 1개만 고쳤다
    world.db.updateScene(250, { prompt: 'changed prompt' })
    const before = sceneBodies()
    sql.resetStats()
    expect(await pc.sync.syncOnce()).toBe(true)
    expect(sceneBodies()).toBe(before + 1)
    expect(world.requestsOf('PUT', '/api/pc/scenes').at(-1)!.json!.scenes).toHaveLength(302) // PC 는 프리셋 통째로 보낸다
    expect(sql.stats().written).toBeLessThanOrEqual(10) // 워커는 바뀐 씬 1행 + 해시 1행만 쓴다
    const scenes = (await world.phone('GET', '/api/scenes?presetId=1')).json.items as Dict[]
    expect(scenes.find((s) => s.id === 250)!.prompt).toBe('changed prompt')
    expect(scenes.find((s) => s.id === 251)!.prompt).toBe('bulk 251')

    // 마지막 씬 1개를 지웠다 (라이브러리의 씬 개수도 바뀐다).
    // 가운데 씬을 지우면 뒤 씬들의 순서값(목록 위치)이 하나씩 당겨져 그 행들을 한 번 다시 쓴다 — 여기서는 재지 않는다
    world.db.trashed.add(399)
    sql.resetStats()
    expect(await pc.sync.syncOnce()).toBe(true)
    expect(sql.stats().written).toBeLessThanOrEqual(10)
    expect((await world.phone('GET', '/api/scenes?presetId=1')).json.items).toHaveLength(301)

    // 아무것도 안 바뀌었다
    sql.resetStats()
    expect(await pc.sync.syncOnce()).toBe(true)
    expect(sql.stats().written).toBe(0)
    world.assertNoSecrets()
  })

  it('PC 켜짐 1분(5초 poll 12번)에 워커가 쓰는 행은 몇 줄뿐이다', async () => {
    const pc = await boot()
    world.cloud.sql.resetStats()
    for (let i = 0; i < 12; i++) {
      world.tick(5_000)
      await pc.sync.pollOnce()
    }
    expect(pollBodies().length).toBeGreaterThanOrEqual(12)
    expect(world.cloud.sql.stats().written).toBeLessThanOrEqual(6) // 예전에는 poll 마다 4행 = 48행
    expect((await world.phone('GET', '/api/state')).json.pc.online).toBe(true)
    world.assertNoSecrets()
  })
})

// ── ㉛ 그림 저장과 씬 그림 수 ────────────────────────────────────────

describe('㉛ 그림 저장은 씬 업로드를 일으키지 않는다', () => {
  it('씬 그림을 만들어도 씬 본문은 올리지 않고, 씬별 그림 수는 60초가 지난 뒤 다음 동기화에 한 번만 올린다', async () => {
    const pc = await boot()
    const scenePuts = (): number => world.requestsOf('PUT', '/api/pc/scenes').length
    const countPuts = (): ReturnType<typeof world.requestsOf> =>
      world.requestsOf('PUT', '/api/pc/scene-counts')
    const baseScenes = scenePuts()
    expect(countPuts()).toHaveLength(1) // 첫 동기화 때 한 번

    // 씬 1 의 그림 3장
    const job = await world.createJob(sceneTarget(1), 3, 'pc')
    await pc.sync.pollOnce()
    await world.waitFor(() => expect(world.job(job.id)).toMatchObject({ state: 'done', done: 3 }))
    await world.drain(pc)
    expect(world.db.scene(1)!.imageCount).toBe(3)

    // 30초 주기 동기화를 두 번 돌려도(60초 안) 씬 본문도 그림 수도 올리지 않는다
    world.tick(10_000)
    expect(await pc.sync.syncOnce()).toBe(true)
    world.tick(10_000)
    expect(await pc.sync.syncOnce()).toBe(true)
    expect(scenePuts()).toBe(baseScenes)
    expect(countPuts()).toHaveLength(1)
    expect((await world.phone('GET', '/api/scenes?presetId=1')).json.items[0].imageCount).toBe(0)

    // 60초가 지난 뒤 첫 동기화에 그림 수만 한 번
    world.tick(60_000)
    expect(await pc.sync.syncOnce()).toBe(true)
    expect(scenePuts()).toBe(baseScenes)
    expect(countPuts()).toHaveLength(2)
    expect(countPuts().at(-1)!.json).toEqual({ counts: { '1': 3, '2': 0, '3': 0 } })
    expect((await world.phone('GET', '/api/scenes?presetId=1')).json.items[0].imageCount).toBe(3)
    expect(await pc.sync.syncOnce()).toBe(true)
    expect(countPuts()).toHaveLength(2) // 같은 값이면 다시 보내지 않는다

    // 한 장 더 — 방금 올렸으니 60초가 찰 때까지는 기다린다
    const more = await world.createJob(sceneTarget(1), 1, 'pc')
    await pc.sync.pollOnce()
    await world.waitFor(() => expect(world.job(more.id)).toMatchObject({ state: 'done' }))
    await world.drain(pc)
    expect(await pc.sync.syncOnce()).toBe(true)
    expect(countPuts()).toHaveLength(2)
    world.tick(60_000)
    expect(await pc.sync.syncOnce()).toBe(true)
    expect(countPuts()).toHaveLength(3)
    expect(countPuts().at(-1)!.json).toEqual({ counts: { '1': 4, '2': 0, '3': 0 } })

    // 메인 탭 그림(씬 없음)은 어느 씬의 그림 수도 바꾸지 않는다 — 아무것도 올리지 않는다
    const main = await world.createJob({ type: 'main' }, 2, 'pc')
    await pc.sync.pollOnce()
    await world.waitFor(() => expect(world.job(main.id)).toMatchObject({ state: 'done', done: 2 }))
    await world.drain(pc)
    world.tick(61_000)
    expect(await pc.sync.syncOnce()).toBe(true)
    expect(countPuts()).toHaveLength(3)
    expect(scenePuts()).toBe(baseScenes)
    world.assertNoSecrets()
  })

  it('PC 가 클라우드 그림을 가져와도 씬 그림 수가 같은 길로 반영된다', async () => {
    const pc = await bootWithCloudGen()
    powerOff(pc)
    await world.createJob(sceneTarget(2), 2, 'cloud')
    await world.runAlarms()

    const pc2 = world.startPc()
    await pc2.sync.syncNow()
    await world.drain(pc2)
    expect(world.db.scene(2)!.imageCount).toBe(2)
    world.tick(61_000)
    expect(await pc2.sync.syncOnce()).toBe(true)
    const scenes = (await world.phone('GET', '/api/scenes?presetId=1')).json.items as Dict[]
    expect(scenes.find((s) => s.id === 2)!.imageCount).toBe(2)
    world.assertNoSecrets()
  })
})

// ── ㉜ 안 가져간 클라우드 그림 지우기 ─────────────────────────────────

describe('㉜ PC 가 아직 안 가져간 클라우드 그림 지우기', () => {
  /** PC 가 꺼진 사이 클라우드가 씬 1 그림 2장을 만들었다 */
  async function twoCloudImages(): Promise<string[]> {
    const pc = await bootWithCloudGen()
    powerOff(pc)
    await world.createJob(sceneTarget(1), 2, 'cloud')
    await world.runAlarms()
    const items = (await world.phone('GET', '/api/images')).json.items as Dict[]
    expect(items).toHaveLength(2)
    return items.map((i) => i.id as string)
  }

  it('폰 갤러리에는 pcPending 으로 보이고 지우기는 force 없이는 409 — 가져간 뒤에는 그냥 지워진다', async () => {
    const ids = await twoCloudImages()
    const items = (await world.phone('GET', '/api/images')).json.items as Dict[]
    expect(items.every((i) => i.source === 'cloud' && i.pcPending === true)).toBe(true)

    // 유일한 사본이라 그냥은 못 지운다 (R2 파일도 행도 그대로)
    const refused = await world.phone('DELETE', `/api/images/${ids[0]}`)
    expect(refused.status).toBe(409)
    expect(refused.json.error).toContain('PC로 아직 옮기지 않은 그림')
    expect(world.cloud.imageRows()).toHaveLength(2)
    for (const row of world.cloud.imageRows()) {
      expect(world.cloud.bucket.files.has(row.r2_key as string)).toBe(true)
    }
    expect((await world.cloud.pcJson('GET', '/api/pc/cloud-images')).json.items).toHaveLength(2)

    // 폰이 다른 확인 문구로 다시 물은 뒤 force 를 붙이면 지워진다
    expect((await world.phone('DELETE', `/api/images/${ids[1]}?force=1`)).status).toBe(200)
    expect(world.cloud.imageRows().map((r) => r.id)).toEqual([ids[0]])
    expect(world.cloud.bucket.files.has(`img/${ids[1]}.zip`)).toBe(false)

    // PC 가 켜지면 남은 한 장만 가져간다
    const pc2 = world.startPc()
    await pc2.sync.syncNow()
    await world.drain(pc2)
    expect(world.saveGenerated).toHaveBeenCalledTimes(1)

    // 가져간 뒤에는 pcPending 이 아니라서 그냥 지워진다 (PC 쪽 그림은 그대로)
    const after = (await world.phone('GET', '/api/images')).json.items as Dict[]
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ id: ids[0], pcPending: false })
    expect((await world.phone('DELETE', `/api/images/${ids[0]}`)).status).toBe(200)
    expect(world.cloud.imageRows()).toEqual([])
    expect(world.db.images.filter((i) => i.filePath.includes('/saved/'))).toHaveLength(1)
    world.assertNoSecrets()
  })

  it('PC 가 올린 그림은 처음부터 pcPending 이 아니라 바로 지워지고, PC 의 원본은 그대로다', async () => {
    const pc = await boot()
    const { id } = await world.createJob(sceneTarget(1), 1, 'pc')
    await pc.sync.pollOnce()
    await world.waitFor(() => expect(world.job(id)).toMatchObject({ state: 'done' }))
    await world.drain(pc)

    const items = (await world.phone('GET', '/api/images')).json.items as Dict[]
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ source: 'pc', pcPending: false })
    expect((await world.phone('DELETE', `/api/images/${items[0].id}`)).status).toBe(200)
    expect((await world.phone('GET', '/api/images')).json.items).toEqual([])
    expect(world.db.images).toHaveLength(1)
    world.assertNoSecrets()
  })

  it('iOS 사파리처럼 썸네일을 JPEG 로 올려도 받고 그 형식 그대로 돌려준다 (한 번만 올릴 수 있다)', async () => {
    const ids = await twoCloudImages()
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
    const upload = (): Promise<Response> =>
      world.cloud.call('PUT', `/api/images/${ids[0]}/thumb`, {
        auth: world.phoneToken,
        raw: jpeg as unknown as BodyInit,
        headers: { 'content-type': 'image/jpeg' }
      })
    expect((await upload()).status).toBe(200)
    const thumb = await world.phoneBytes(`/api/images/${ids[0]}/thumb`)
    expect(thumb.type).toBe('image/jpeg')
    expect([...thumb.bytes]).toEqual([...jpeg])

    const items = (await world.phone('GET', '/api/images')).json.items as Dict[]
    expect(items.find((i) => i.id === ids[0])!.hasThumb).toBe(true)
    expect(items.find((i) => i.id === ids[1])!.hasThumb).toBe(false)
    expect((await upload()).status).toBe(409)
    world.assertNoSecrets()
  })
})

// ── ㉝ 응답 유실 재시도 ──────────────────────────────────────────────

describe('㉝ 생성 요청 응답이 유실돼 폰이 다시 보냈을 때', () => {
  it('같은 requestId 는 작업 하나로 합쳐지고 PC 큐에도 한 번만 들어가며, 10분이 지나면 새 작업이다', async () => {
    const pc = await boot()
    const body = { target: sceneTarget(1), count: 2, place: 'pc', requestId: 'req-lost-1' }
    const first = await world.phone('POST', '/api/jobs', body)
    const retry = await world.phone('POST', '/api/jobs', body) // 응답이 유실돼 폰이 다시 보냈다
    expect(retry.status).toBe(200)
    expect(retry.json.job.id).toBe(first.json.job.id)
    expect((await world.phone('GET', '/api/state')).json.jobs).toHaveLength(1)

    // 번호가 다르거나 없으면 다른 요청이다
    const other = await world.phone('POST', '/api/jobs', { ...body, requestId: 'req-lost-2' })
    expect(other.json.job.id).not.toBe(first.json.job.id)
    const bare = await world.phone('POST', '/api/jobs', { ...body, requestId: undefined })
    expect(bare.json.job.id).not.toBe(first.json.job.id)
    expect((await world.phone('GET', '/api/state')).json.jobs).toHaveLength(3)
    // 번호가 이상하면 거절한다
    const tooLong = await world.phone('POST', '/api/jobs', { ...body, requestId: 'x'.repeat(101) })
    expect(tooLong.status).toBe(400)

    // PC 는 첫 작업을 한 번만 받아 2장만 만든다 (나머지 두 작업도 같은 길로 간다)
    await pc.sync.pollOnce()
    await world.waitFor(() =>
      expect(world.job(first.json.job.id)).toMatchObject({ state: 'done', done: 2, failed: 0 })
    )
    await world.waitFor(() =>
      expect(world.job(bare.json.job.id)).toMatchObject({ state: 'done', done: 2, failed: 0 })
    )
    await world.drain(pc)
    const withFirstId = pc.enqueueCalls.filter((call) =>
      call.some((r) => r.cloudJobId === first.json.job.id)
    )
    expect(withFirstId).toHaveLength(1)
    expect(withFirstId[0]).toHaveLength(2)

    // 끝난 뒤에 같은 번호로 와도 끝난 그 작업을 돌려준다
    const late = await world.phone('POST', '/api/jobs', body)
    expect(late.json.job).toMatchObject({ id: first.json.job.id, state: 'done', done: 2 })

    // 10분이 지나면 같은 번호라도 새 작업
    world.tick(10 * 60 * 1000 + 1)
    const fresh = await world.phone('POST', '/api/jobs', body)
    expect(fresh.json.job.id).not.toBe(first.json.job.id)
    world.assertNoSecrets()
  })
})

// ── ㉞ 휴지통에 든 씬 ───────────────────────────────────────────────

describe('㉞ 휴지통에 든 씬 (scenes:isLive)', () => {
  it('PC 에서 휴지통으로 보낸 씬의 폰 작업은 큐에 넣지 않고 「씬이 PC에 없음」으로 끝난다', async () => {
    const pc = await boot()
    world.db.trashed.add(2) // 아직 동기화 전이라 폰에는 보인다
    expect((await world.phone('GET', '/api/scenes?presetId=1')).json.items).toHaveLength(2)

    const { id } = await world.createJob(sceneTarget(2), 2, 'pc')
    await pc.sync.pollOnce()
    await world.settle()
    expect(world.job(id)).toMatchObject({
      state: 'failed',
      done: 0,
      failed: 2,
      error: '씬이 PC에 없음'
    })
    expect(pc.enqueueCalls).toHaveLength(0)
    expect(pc.generated).toHaveLength(0)

    // 동기화 뒤에는 폰에서도 사라진다
    expect(await pc.sync.syncOnce()).toBe(true)
    expect((await world.phone('GET', '/api/scenes?presetId=1')).json.items).toHaveLength(1)
    expect((await world.createJob(sceneTarget(2), 1, 'pc')).status).toBe(404)
    world.assertNoSecrets()
  })

  it('클라우드 생성: 휴지통 씬의 완성 요청도 클라우드에서 지워져 PC 가 꺼져도 만들지 않는다', async () => {
    const pc = await bootWithCloudGen()
    world.db.trashed.add(2)
    pc.renderer.touch() // 씬 목록이 바뀌었다 → 완성 요청 다시 올림 (남는 키만)
    await world.settle()
    await world.waitFor(() => expect(preparedKeys()).toEqual(['main', 'scene:1', 'scene:3']))
    expect(await pc.sync.syncOnce()).toBe(true)
    powerOff(pc)

    expect((await world.createJob(sceneTarget(2), 1, 'cloud')).status).toBe(404)
    const alive = await world.createJob(sceneTarget(1), 1, 'cloud')
    await world.runAlarms()
    expect(world.job(alive.id)).toMatchObject({ state: 'done', done: 1 })
    expect(world.cloud.nai.generateCalls).toHaveLength(1)
    world.assertNoSecrets()
  })
})
