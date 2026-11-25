import { describe, expect, it, vi } from 'vitest'
import { handleRequest } from '../../cloud/src/core/router'
import { runDailyCleanup } from '../../cloud/src/core/maintenance'
import { SCHEMA_VERSION, ensureSchema } from '../../cloud/src/core/schema'
import {
  Harness,
  ORIGIN,
  T0,
  enableCloudGen,
  insertImageRows,
  preparedItem,
  sampleLibrary,
  sampleScene,
  sampleSceneRequest,
  seedPc,
  uploadPcImage,
  type Dict
} from './helpers/harness'
import { createTestSql } from './helpers/sql'

// 무료 요금제 한도(DO 하루 쓰기 10만 행 · 읽기 500만 행)를 지키는 장치들의 시험 — 설계 7-2

const MIN = 60_000
const DAY = 24 * 60 * MIN

/** 표 전체를 훑으면 안 되는 표 (주기 요청이 매번 훑으면 하루 읽기 한도를 넘는다) */
const BIG_TABLES = ['images', 'jobs', 'ops', 'prepared', 'scenes']

/** 쿼리 계획 한 줄로 (node:sqlite 를 직접 — EXPLAIN 은 허브의 exec 가 읽기로 치지 않는다) */
function planOf(h: Harness, query: string): string {
  return h.sql.db
    .prepare(`EXPLAIN QUERY PLAN ${query}`)
    .all()
    .map((r) => String((r as { detail?: unknown }).detail))
    .join(' | ')
}

function bigScenes(count: number, presetId = 1, base = 1000): ReturnType<typeof sampleScene>[] {
  return Array.from({ length: count }, (_, i) => sampleScene(base + i, presetId))
}

async function putScenes(
  h: Harness,
  scenes: unknown[],
  hash: string,
  presetId = 1
): Promise<Response> {
  return h.pc('PUT', '/api/pc/scenes', { presetId, scenes, hash })
}

describe('씬 업로드 — 차분 반영 (쓰기 행 줄이기)', () => {
  it('씬 1000개 프리셋에서 1개만 바뀐 업로드는 그 씬 한 행과 해시 한 줄만 쓴다', async () => {
    const h = new Harness()
    await seedPc(h)
    const scenes = bigScenes(1000)
    h.sql.resetStats()
    expect((await putScenes(h, scenes, 'big-1')).status).toBe(200)
    const first = h.sql.stats()
    // 처음 올릴 때는 새 행 1000개 + 옛 씬 2개 삭제 + 해시 — 전체를 쓰는 건 이때뿐
    expect(first.written).toBe(1000 + 2 + 1)
    expect(h.sql.exec(`SELECT COUNT(*) AS n FROM scenes WHERE preset_id = 1`).one().n).toBe(1000)

    // 같은 내용을 다시 올리면 아무 행도 쓰지 않는다
    h.sql.resetStats()
    expect((await putScenes(h, scenes, 'big-1')).status).toBe(200)
    expect(h.sql.stats().written).toBe(0)

    // 씬 하나만 바뀜 → 그 씬 한 행 + 해시 한 줄
    const changed = scenes.map((s, i) => (i === 500 ? { ...s, prompt: 'CHANGED' } : s))
    h.sql.resetStats()
    expect((await putScenes(h, changed, 'big-2')).status).toBe(200)
    const second = h.sql.stats()
    expect(second.written).toBe(2)
    expect(second.fullScans).not.toHaveProperty('scenes')
    const row = h.sql.exec<Dict>(`SELECT data FROM scenes WHERE id = 1500`).one()
    expect(JSON.parse(row.data).prompt).toBe('CHANGED')
    expect(h.sql.exec(`SELECT hash FROM scene_hash WHERE preset_id = 1`).one().hash).toBe('big-2')
  })

  it('업로드에 없는 씬만 지우고, 순서가 바뀐 씬만 다시 쓴다', async () => {
    const h = new Harness()
    await seedPc(h)
    const scenes = bigScenes(50)
    await putScenes(h, scenes, 'a')

    // 씬 하나가 사라짐 → 그 행 삭제 + 해시
    h.sql.resetStats()
    await putScenes(
      h,
      scenes.filter((s) => s.id !== 1010),
      'b'
    )
    expect(h.sql.stats().written).toBe(2)
    expect(h.sql.exec(`SELECT COUNT(*) AS n FROM scenes WHERE preset_id = 1`).one().n).toBe(49)

    // 순서(sortOrder)만 바뀐 씬 하나 → 그 행 + 해시
    h.sql.resetStats()
    const moved = scenes
      .filter((s) => s.id !== 1010)
      .map((s) => (s.id === 1020 ? { ...s, sortOrder: 99999 } : s))
    await putScenes(h, moved, 'c')
    expect(h.sql.stats().written).toBe(2)
    const order = h.sql
      .exec<Dict>(`SELECT id FROM scenes WHERE preset_id = 1 ORDER BY sort_order DESC LIMIT 1`)
      .one()
    expect(order.id).toBe(1020)
  })

  it('다른 프리셋에서 옮겨 온 씬은 프리셋 번호가 바뀌고, 옛 프리셋을 올려도 지워지지 않는다', async () => {
    const h = new Harness()
    await seedPc(h)
    await putScenes(h, [sampleScene(7, 1), sampleScene(8, 1)], 'p1-a', 1)
    // 씬 8 이 프리셋 2 로 옮겨 감 — 프리셋 2 를 먼저 올리고 프리셋 1 을 나중에 올린다
    await putScenes(h, [sampleScene(8, 2, { kind: 'background' })], 'p2-a', 2)
    await putScenes(h, [sampleScene(7, 1)], 'p1-b', 1)
    expect(
      h.sql.exec<Dict>(`SELECT id, preset_id FROM scenes WHERE id IN (7, 8) ORDER BY id`).toArray()
    ).toEqual([
      { id: 7, preset_id: 1 },
      { id: 8, preset_id: 2 }
    ])
  })

  it('씬 본문에 옛 PC 가 실어 보낸 imageCount 는 저장하지 않는다 (그림 수는 scene-counts 로만)', async () => {
    const h = new Harness()
    await seedPc(h)
    await putScenes(h, [{ ...sampleScene(7, 1), imageCount: 12 }], 'x')
    const stored = JSON.parse(h.sql.exec<Dict>(`SELECT data FROM scenes WHERE id = 7`).one().data)
    expect(stored).not.toHaveProperty('imageCount')
    // 같은 씬을 imageCount 만 바꿔 다시 올려도 쓸 것이 없다
    h.sql.resetStats()
    await putScenes(h, [{ ...sampleScene(7, 1), imageCount: 13 }], 'x')
    expect(h.sql.stats().written).toBe(0)
  })

  it('PC 가 반영하기 전의 폰 편집이 얹힌 채로도 같은 값이면 쓰지 않는다', async () => {
    const h = new Harness()
    await seedPc(h)
    const token = await h.pair()
    await h.phoneJson(token, 'PATCH', '/api/scenes/1', { name: '폰에서 고친 이름' })
    h.sql.resetStats()
    // PC 는 아직 옛 이름으로 올린다 (같은 해시) — 덧입힌 값이 이미 저장된 값과 같으므로 쓸 것이 없다
    await putScenes(h, [sampleScene(1, 1), sampleScene(2, 1)], 'scenes-1')
    expect(h.sql.stats().written).toBe(0)
    expect(
      JSON.parse(h.sql.exec<Dict>(`SELECT data FROM scenes WHERE id = 1`).one().data).name
    ).toBe('폰에서 고친 이름')
  })

  it('잘못된 씬이 하나라도 있으면 아무것도 바꾸지 않는다', async () => {
    const h = new Harness()
    await seedPc(h)
    h.sql.resetStats()
    const res = await putScenes(h, [sampleScene(7, 1), { name: 'id 없음' }], 'bad')
    expect(res.status).toBe(400)
    expect(h.sql.stats().written).toBe(0)
    expect(
      h.sql.exec<Dict>(`SELECT id FROM scenes WHERE preset_id = 1 ORDER BY id`).toArray()
    ).toEqual([{ id: 1 }, { id: 2 }])
  })
})

describe('씬 그림 수 (PUT /api/pc/scene-counts)', () => {
  it('저장하면 폰의 씬 목록과 편집 응답에 imageCount 로 나온다. 같은 값을 또 보내면 쓰지 않는다', async () => {
    const h = new Harness()
    await seedPc(h)
    const token = await h.pair()
    const before = await h.phoneJson(token, 'GET', '/api/scenes?presetId=1')
    expect(before.json.items.map((s: Dict) => s.imageCount)).toEqual([0, 0])

    expect(
      (await h.pc('PUT', '/api/pc/scene-counts', { counts: { '1': 3, '2': 0, '99': 5 } })).status
    ).toBe(200)
    const after = await h.phoneJson(token, 'GET', '/api/scenes?presetId=1')
    expect(after.json.items.map((s: Dict) => [s.id, s.imageCount])).toEqual([
      [1, 3],
      [2, 0]
    ])
    const patched = await h.phoneJson(token, 'PATCH', '/api/scenes/1', { name: '새 이름' })
    expect(patched.json.scene.imageCount).toBe(3)

    // 0 은 저장하지 않는다 (없으면 0)
    expect(JSON.parse(h.kv('scene:counts')!)).toEqual({ '1': 3, '99': 5 })

    h.sql.resetStats()
    await h.pc('PUT', '/api/pc/scene-counts', { counts: { '1': 3, '99': 5, '2': 0 } })
    expect(h.sql.stats().written).toBe(0)

    // 통째로 바꾼다 — 보내지 않은 씬은 0 이 된다
    await h.pc('PUT', '/api/pc/scene-counts', { counts: { '2': 4 } })
    const replaced = await h.phoneJson(token, 'GET', '/api/scenes?presetId=1')
    expect(replaced.json.items.map((s: Dict) => s.imageCount)).toEqual([0, 4])
  })

  it('인스턴스가 다시 떠도 저장된 그림 수를 읽는다', async () => {
    const h = new Harness()
    await seedPc(h)
    const token = await h.pair()
    await h.pc('PUT', '/api/pc/scene-counts', { counts: { '2': 7 } })
    h.restartInstance()
    const res = await h.phoneJson(token, 'GET', '/api/scenes?presetId=1')
    expect(res.json.items.map((s: Dict) => s.imageCount)).toEqual([0, 7])
  })

  it('모양이 틀리면 400, PC 인증이 없으면 401', async () => {
    const h = new Harness()
    for (const counts of [null, [], { abc: 1 }, { '1': -1 }, { '1': 1.5 }, { '1': '3' }]) {
      const res = await h.pcJson('PUT', '/api/pc/scene-counts', { counts })
      expect(res.status, JSON.stringify(counts)).toBe(400)
    }
    expect((await h.pcJson('PUT', '/api/pc/scene-counts', {})).status).toBe(400)
    expect((await h.call('PUT', '/api/pc/scene-counts', { body: { counts: {} } })).status).toBe(401)
  })
})

describe('인덱스 · 카운터 · 해시 캐시 — 보관함 2000장에서도 주기 요청이 표를 훑지 않는다', () => {
  /** 씬 500개 프리셋, 그림 2000장(그중 PC 가 안 가져간 클라우드 생성분 3장), 완성 요청 301개, 끝난 작업 60개 */
  async function bigStore(): Promise<{ h: Harness; token: string }> {
    const h = new Harness()
    await seedPc(h)
    await putScenes(h, bigScenes(500), 'big')
    const token = await h.pair()
    await h.pcPoll(true)
    insertImageRows(h, 2000, (i) => ({
      source: i < 3 ? 'cloud' : 'pc',
      imported: 0,
      sceneId: 1000 + (i % 500),
      presetId: i % 2 === 0 ? 1 : 2,
      createdAt: T0 - 10_000 + i
    }))
    for (let start = 0; start < 300; start += 100) {
      await h.pcJson('PUT', '/api/pc/prepared', {
        items: Array.from({ length: 100 }, (_, i) =>
          preparedItem(`scene:${1000 + start + i}`, sampleSceneRequest(1000 + start + i))
        )
      })
    }
    for (let i = 0; i < 60; i++) {
      h.sql.exec(
        `INSERT INTO jobs (id, target, label, count, done, failed, state, place, runner, error, created_at, updated_at, in_flight, attempts)
         VALUES (?, '{"type":"main"}', '메인 생성', 1, 1, 0, 'done', 'pc', 'pc', NULL, ?, ?, 0, 0)`,
        `jold${i}`,
        T0 - i * 1000,
        T0 - i * 1000
      )
    }
    return { h, token }
  }

  function expectNoBigScan(h: Harness, label: string): void {
    const stats = h.sql.stats()
    const scanned = BIG_TABLES.filter((t) => stats.fullScans[t])
    expect(scanned, `${label}: 표 전체를 훑음 ${JSON.stringify(stats.fullScans)}`).toEqual([])
  }

  it('GET /api/pc/info — 그림 수는 카운터, 진행 중 작업은 인덱스', async () => {
    const { h } = await bigStore()
    h.sql.resetStats()
    const res = await h.pcJson('GET', '/api/pc/info')
    expect(res.json.imagesStored).toBe(2000)
    expect(res.json.cloudJobsActive).toBe(0)
    expectNoBigScan(h, 'info')
    expect(h.sql.stats().returned).toBeLessThan(20)
  })

  it('GET /api/pc/hashes — 완성 요청 해시는 kv 캐시 한 덩어리', async () => {
    const { h } = await bigStore()
    h.sql.resetStats()
    const res = await h.pcJson('GET', '/api/pc/hashes')
    expect(Object.keys(res.json.prepared)).toHaveLength(303) // seedPc 3개 + 300개
    expectNoBigScan(h, 'hashes')
    expect(h.sql.stats().returned).toBeLessThan(10)
  })

  it('GET /api/pc/cloud-images — 부분 인덱스로 안 가져간 클라우드 생성분만', async () => {
    const { h } = await bigStore()
    h.sql.resetStats()
    const res = await h.pcJson('GET', '/api/pc/cloud-images')
    expect(res.json.items).toHaveLength(3)
    expectNoBigScan(h, 'cloud-images')
    expect(h.sql.stats().returned).toBe(3)
    const plan = planOf(
      h,
      `SELECT id FROM images WHERE source = 'cloud' AND imported = 0 ORDER BY created_at ASC, id ASC LIMIT 50`
    )
    expect(plan).toContain('images_cloud_pending')
  })

  it('POST /api/pc/poll — 5초마다 오는 요청은 작업·편집·그림 표를 훑지 않는다', async () => {
    const { h } = await bigStore()
    await h.pcPoll(true)
    h.tick(5000)
    h.sql.resetStats()
    await h.pcPoll(true, [])
    expectNoBigScan(h, 'poll')
    const stats = h.sql.stats()
    expect(stats.returned).toBeLessThan(15)
    expect(stats.written).toBe(0) // 값이 그대로면 디스크에 아무것도 쓰지 않는다
  })

  it('폰 GET /api/state · /api/images (전체·프리셋·씬 필터) — 인덱스를 탄다', async () => {
    const { h, token } = await bigStore()
    for (const [label, path, limit] of [
      ['state', '/api/state', 40],
      ['images', '/api/images?limit=40', 100],
      ['images?presetId', '/api/images?presetId=2&limit=40', 100],
      ['images?sceneId', '/api/images?sceneId=1010&limit=40', 100],
      ['images?before', `/api/images?before=${T0 - 10_000 + 1000}:p101000&limit=40`, 100]
    ] as const) {
      h.sql.resetStats()
      const res = await h.phone(token, 'GET', path)
      expect(res.status, label).toBe(200)
      expectNoBigScan(h, label)
      expect(h.sql.stats().returned, label).toBeLessThan(limit)
    }
    const plan = planOf(
      h,
      `SELECT id FROM images WHERE preset_id = 2 ORDER BY created_at DESC, id DESC LIMIT 41`
    )
    expect(plan).toContain('images_preset')
    expect(plan).not.toContain('TEMP B-TREE')
    const scenePlan = planOf(
      h,
      `SELECT i.id FROM images i WHERE i.scene_id = 1010 ORDER BY i.created_at DESC, i.id DESC LIMIT 41`
    )
    expect(scenePlan).toContain('images_scene2')
    expect(scenePlan).not.toContain('TEMP B-TREE')
  })

  it('작업·편집 인덱스: 대기 작업 · 잃어버린 작업 · 클라우드 작업 · 최근 작업 30개 · 미반영 편집', async () => {
    const h = new Harness()
    const plans: Record<string, string> = {}
    const explain = (name: string, query: string): void => {
      plans[name] = planOf(h, query)
    }
    explain(
      'queued',
      `SELECT id FROM jobs WHERE state = 'queued' AND runner = 'pc' ORDER BY created_at ASC LIMIT 50`
    )
    explain(
      'lost',
      `SELECT id FROM jobs WHERE state = 'pc' AND runner = 'pc' AND COALESCE(accepted_at, updated_at) <= 1`
    )
    explain(
      'cloud',
      `SELECT id FROM jobs WHERE state = 'cloud' ORDER BY created_at ASC, id ASC LIMIT 1`
    )
    explain('recent', `SELECT id FROM jobs ORDER BY updated_at DESC, created_at DESC LIMIT 30`)
    explain('ops', `SELECT id FROM ops WHERE acked = 0 ORDER BY id ASC LIMIT 200`)
    expect(plans.queued).toContain('jobs_active')
    expect(plans.lost).toContain('jobs_active')
    expect(plans.cloud).toContain('jobs_active')
    expect(plans.recent).toContain('jobs_updated')
    expect(plans.ops).toContain('ops_pending')
    for (const [name, plan] of Object.entries(plans)) {
      expect(plan, name).not.toMatch(/SCAN (jobs|ops)\b(?! USING)/)
    }
  })

  it('그림 수 카운터: 올림 · 덮어쓰기 · 가져감 · 삭제 · 보관 정리가 info.imagesStored 와 늘 맞는다', async () => {
    const h = new Harness()
    await seedPc(h)
    await enableCloudGen(h)
    const token = await h.pair()
    const stored = async (): Promise<number> =>
      (await h.pcJson('GET', '/api/pc/info')).json.imagesStored
    const rows = (): number => Number(h.sql.exec(`SELECT COUNT(*) AS n FROM images`).one().n)

    await uploadPcImage(h, 1)
    await uploadPcImage(h, 2)
    await uploadPcImage(h, 2) // 같은 id 덮어쓰기 — 늘지 않는다
    expect(await stored()).toBe(2)

    // 클라우드 생성 2장
    const made = await h.phoneJson(token, 'POST', '/api/jobs', {
      target: { type: 'main' },
      count: 2,
      place: 'cloud'
    })
    expect(made.status).toBe(200)
    await h.runAlarms()
    expect(await stored()).toBe(4)
    expect(h.kv('n:images')).toBe('4,2')

    // 한 장 가져감 → 안 가져간 수만 줄고 전체는 그대로
    const pending = (await h.pcJson('GET', '/api/pc/cloud-images')).json.items
    await h.pcJson('POST', `/api/pc/cloud-images/${pending[0].id}/imported`, { pcImageId: 50 })
    await h.pcJson('POST', `/api/pc/cloud-images/${pending[0].id}/imported`, { pcImageId: 50 }) // 또 알려도 한 번만
    expect(h.kv('n:images')).toBe('4,1')

    // 폰이 지움: 가져간 것은 그냥, 안 가져간 것은 force
    await h.phoneJson(token, 'DELETE', '/api/images/p1')
    await h.phoneJson(token, 'DELETE', `/api/images/${pending[0].id}`)
    expect(h.kv('n:images')).toBe('2,1')
    expect(
      (await h.phoneJson(token, 'DELETE', `/api/images/${pending[1].id}?force=1`)).status
    ).toBe(200)
    expect(h.kv('n:images')).toBe('1,0')
    expect(await stored()).toBe(rows())

    // 보관 정리: keepImages 100 에 맞춰 오래된 PC 그림부터
    insertImageRows(h, 150)
    expect(h.kv('n:images')).toBe('151,0')
    await h.pcJson('PUT', '/api/pc/settings', { cloudGenEnabled: true, keepImages: 100 })
    await uploadPcImage(h, 9000)
    expect(await stored()).toBe(100)
    expect(rows()).toBe(100)
  })

  it('카운터가 없거나 어긋나도 처음 읽을 때 세어 채우고, 하루 한 번 정리가 바로잡는다', async () => {
    const h = new Harness()
    await seedPc(h)
    await uploadPcImage(h, 1)
    h.sql.exec(`DELETE FROM kv WHERE k = 'n:images'`)
    expect((await h.pcJson('GET', '/api/pc/info')).json.imagesStored).toBe(1)
    expect(h.kv('n:images')).toBe('1,0')

    h.sql.exec(`UPDATE kv SET v = '999,5' WHERE k = 'n:images'`) // 어긋남
    await h.pcPoll() // 첫 poll 에서 하루 한 번 정리가 돈다
    h.tick(DAY + 1)
    await h.pcPoll()
    expect(h.kv('n:images')).toBe('1,0')

    h.sql.exec(`UPDATE kv SET v = 'broken' WHERE k = 'n:images'`)
    expect((await h.pcJson('GET', '/api/pc/info')).json.imagesStored).toBe(1)
  })

  it('완성 요청 해시 캐시: 올리면 갱신, allKeys 로 지우면 빠짐, 캐시가 없으면 표에서 다시 만든다', async () => {
    const h = new Harness()
    await seedPc(h)
    expect((await h.pcJson('GET', '/api/pc/hashes')).json.prepared).toEqual({
      main: 'h-main',
      'scene:1': 'h-scene:1',
      'scene:2': 'h-scene:2'
    })
    await h.pcJson('PUT', '/api/pc/prepared', {
      items: [
        preparedItem('scene:2', sampleSceneRequest(2), 'new-2'),
        preparedItem('scene:3', sampleSceneRequest(3))
      ],
      allKeys: ['main', 'scene:2', 'scene:3']
    })
    const hashes = (await h.pcJson('GET', '/api/pc/hashes')).json.prepared
    expect(hashes).toEqual({ main: 'h-main', 'scene:2': 'new-2', 'scene:3': 'h-scene:3' })
    expect(h.sql.exec(`SELECT COUNT(*) AS n FROM prepared`).one().n).toBe(3)

    // 같은 내용을 다시 보내면 쓰기 행이 없다
    h.sql.resetStats()
    await h.pcJson('PUT', '/api/pc/prepared', {
      items: [preparedItem('scene:3', sampleSceneRequest(3))]
    })
    expect(h.sql.stats().written).toBe(0)

    // 캐시를 잃어도(옛 저장소) 표에서 다시 만든다
    h.sql.exec(`DELETE FROM kv WHERE k = 'hash:prepared'`)
    expect((await h.pcJson('GET', '/api/pc/hashes')).json.prepared).toEqual(hashes)
    expect(h.kv('hash:prepared')).not.toBeNull()

    // 표와 어긋난 캐시는 하루 한 번 정리가 바로잡는다
    h.sql.exec(`DELETE FROM prepared WHERE key = 'scene:3'`)
    runDailyCleanup(h.deps)
    expect((await h.pcJson('GET', '/api/pc/hashes')).json.prepared).toEqual({
      main: 'h-main',
      'scene:2': 'new-2'
    })
  })

  it('판 2 저장소를 올리면(3판 내용) 열과 인덱스가 생기고 옛 images_scene 은 images_scene2 로 바뀌며 그림 수가 세어진다', () => {
    const sql = createTestSql()
    ensureSchema(sql)
    const NEW_INDEXES = [
      'images_cloud_pending',
      'images_preset',
      'images_scene2',
      'jobs_active',
      'jobs_updated',
      'ops_pending',
      'jobs_request'
    ]
    // 판 2 모양으로 되돌린다: 3판 인덱스·열·카운터를 없애고 옛 images_scene 을 되살린다
    for (const name of NEW_INDEXES) sql.exec(`DROP INDEX ${name}`)
    sql.exec(`CREATE INDEX images_scene ON images(scene_id, created_at DESC)`)
    sql.exec(`ALTER TABLE jobs DROP COLUMN request_id`)
    sql.exec(`UPDATE kv SET v = '2' WHERE k = 'schema:version'`)
    sql.exec(
      `INSERT INTO images (id, source, scene_id, preset_id, job_id, seed, width, height, created_at, has_thumb, format, r2_key, sent_payload, imported, pc_image_id)
       VALUES ('p1', 'pc', 1, 1, NULL, 1, 1, 1, 1, 0, 'webp', 'img/p1.webp', NULL, 0, 1)`
    )
    sql.exec(`INSERT INTO kv (k, v) VALUES ('n:images', '77,77')`) // 옛 값이 남아 있어도 3판 올리기가 지운다

    ensureSchema(sql)
    expect(SCHEMA_VERSION).toBe(4)
    const names = sql
      .exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index'`)
      .toArray()
      .map((r) => r.name)
    for (const name of NEW_INDEXES) expect(names).toContain(name)
    expect(names).not.toContain('images_scene')
    expect(
      sql
        .exec<{ name: string }>(`PRAGMA table_info(jobs)`)
        .toArray()
        .map((r) => r.name)
    ).toContain('request_id')
    expect(sql.exec(`SELECT v FROM kv WHERE k = 'n:images'`).toArray()).toEqual([])
    // 새 저장소도 같은 인덱스 집합이다
    const fresh = createTestSql()
    ensureSchema(fresh)
    const freshNames = fresh
      .exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index'`)
      .toArray()
      .map((r) => r.name)
    expect(freshNames.sort()).toEqual([...names].sort())
  })
})

describe('poll — 켜짐 표시는 메모리에, 디스크에는 60초에 한 번 · 바뀔 때만', () => {
  it('값이 그대로인 poll 은 디스크에 쓰지 않고, 60초가 지나면 lastSeen 한 줄만 쓴다', async () => {
    const h = new Harness()
    await h.pcPoll(true) // 처음엔 네 줄(lastSeen · acceptsJobs · appVersion · queue)
    h.sql.resetStats()
    for (let i = 0; i < 11; i++) {
      h.tick(5000)
      await h.pcPoll(true) // queue.updatedAt 만 매번 다르다
    }
    expect(h.sql.stats().written).toBe(0)

    h.tick(5000) // 마지막 기록에서 60초
    h.sql.resetStats()
    await h.pcPoll(true)
    expect(h.sql.stats().written).toBe(1)
    expect(h.kv('pc:lastSeen')).toBe(String(h.clock))
  })

  it('acceptsJobs · queue · appVersion 이 바뀌면 그때 쓴다 (queue 비교는 updatedAt 제외)', async () => {
    const h = new Harness()
    await h.pcPoll(true)
    h.tick(5000)
    h.sql.resetStats()
    await h.pcPoll(false) // acceptsJobs 바뀜
    expect(h.kv('pc:acceptsJobs')).toBe('0')
    expect(h.sql.stats().written).toBe(2) // lastSeen + acceptsJobs

    h.tick(5000)
    h.sql.resetStats()
    await h.pcPoll(false, undefined, {
      queue: {
        running: true,
        pending: 2,
        generating: 1,
        done: 0,
        failed: 0,
        generatingSceneId: 1,
        updatedAt: h.clock
      }
    })
    expect(JSON.parse(h.kv('pc:queue')!)).toMatchObject({ pending: 2, generating: 1 })
    expect(h.sql.stats().written).toBe(2) // lastSeen + queue

    h.tick(5000)
    h.sql.resetStats()
    await h.pcPoll(false, undefined, {
      appVersion: '9.9.9',
      queue: {
        running: true,
        pending: 2,
        generating: 1,
        done: 0,
        failed: 0,
        generatingSceneId: 1,
        updatedAt: h.clock
      }
    })
    expect(h.kv('pc:appVersion')).toBe('9.9.9')
    expect(h.sql.stats().written).toBe(2) // lastSeen + appVersion (queue 는 updatedAt 만 달랐다)
  })

  it('하루 동안 켜 둔 PC(5초 poll 17280번)의 poll 쓰기는 몇 천 행이 아니라 수천 행 미만 — 60초당 1행', async () => {
    const h = new Harness()
    await h.pcPoll(true)
    h.sql.resetStats()
    for (let i = 0; i < 720; i++) {
      // 한 시간치(5초 간격)
      h.tick(5000)
      await h.pcPoll(true)
    }
    const perHour = h.sql.stats().written
    expect(perHour).toBeLessThanOrEqual(61) // 60초에 한 줄
    expect(perHour * 24).toBeLessThan(1500) // 하루 환산 — 예전엔 4줄 × 17280 = 69120
  })

  it('폰과 작업 배정은 메모리의 최신 값을 본다. 인스턴스가 다시 뜨면 디스크 값으로 물러난다', async () => {
    const h = new Harness()
    await seedPc(h)
    const token = await h.pair()
    await h.pcPoll(true)
    h.tick(10_000)
    await h.pcPoll(true) // 디스크의 lastSeen 은 10초 전 값
    const state = await h.phoneJson(token, 'GET', '/api/state')
    expect(state.json.pc.online).toBe(true)
    expect(state.json.pc.lastSeen).toBe(h.clock) // 메모리의 최신 값

    h.tick(10_000) // 마지막 poll 에서 10초 — 15초 안
    h.restartInstance()
    const after = await h.phoneJson(token, 'GET', '/api/state')
    expect(after.json.pc.lastSeen).toBe(T0) // 디스크에는 처음 poll 시각만 있다
    expect(after.json.pc.online).toBe(false)
    await h.pcPoll(true) // 다음 poll 이 메모리를 다시 채운다
    expect((await h.phoneJson(token, 'GET', '/api/state')).json.pc.online).toBe(true)
  })
})

describe('하루 한 번 정리 — 끝난 작업은 7일 보관', () => {
  function insertJob(h: Harness, id: string, state: string, updatedAt: number): void {
    h.sql.exec(
      `INSERT INTO jobs (id, target, label, count, done, failed, state, place, runner, error, created_at, updated_at, in_flight, attempts)
       VALUES (?, '{"type":"main"}', '메인 생성', 1, 0, 0, ?, 'pc', 'pc', NULL, ?, ?, 0, 0)`,
      id,
      state,
      updatedAt,
      updatedAt
    )
  }

  it('poll 이 하루 한 번 7일 지난 끝난 작업만 지운다 (진행 중인 작업은 오래돼도 남는다)', async () => {
    const h = new Harness()
    insertJob(h, 'old-done', 'done', T0 - 8 * DAY)
    insertJob(h, 'old-failed', 'failed', T0 - 7 * DAY - 1)
    insertJob(h, 'old-cancelled', 'cancelled', T0 - 30 * DAY)
    insertJob(h, 'fresh-done', 'done', T0 - 6 * DAY)
    insertJob(h, 'old-queued', 'queued', T0 - 30 * DAY)
    insertJob(h, 'old-cloud', 'cloud', T0 - 30 * DAY)

    await h.pcPoll()
    const ids = (): string[] =>
      h.sql
        .exec<{ id: string }>(`SELECT id FROM jobs ORDER BY id`)
        .toArray()
        .map((r) => r.id)
    expect(ids()).toEqual(['fresh-done', 'old-cloud', 'old-queued'])
    expect(h.kv('cleanup:at')).toBe(String(T0))

    // 같은 날 다시 poll 해도 정리는 돌지 않는다 (표를 또 훑지 않는다)
    insertJob(h, 'old-done-2', 'done', T0 - 20 * DAY)
    h.tick(DAY - 1)
    await h.pcPoll()
    expect(ids()).toContain('old-done-2')
    expect(h.kv('cleanup:at')).toBe(String(T0))

    // 하루가 지나면 다시
    h.tick(2)
    await h.pcPoll()
    expect(ids()).not.toContain('old-done-2')
    expect(ids()).not.toContain('fresh-done') // 이제 7일이 지났다
    expect(h.kv('cleanup:at')).toBe(String(h.clock))
  })

  it('알람이 울려도 정리가 돈다. 반영 끝난 편집 줄 · 만료된 연결 코드 · 시도 기록도 함께', async () => {
    const h = new Harness()
    await seedPc(h)
    await enableCloudGen(h)
    const token = await h.pair()
    await h.phoneJson(token, 'PATCH', '/api/main', { prompt: 'a' })
    const poll = await h.pcPoll()
    await h.pcJson('POST', '/api/pc/ack', { opIds: poll.ops.map((o) => o.id), jobs: [] })
    h.sql.exec(`INSERT INTO ratelimit (k, n, reset_at) VALUES ('old', 3, ?)`, T0 - 1)
    h.sql.exec(`INSERT INTO pairing (code, expires_at, attempts) VALUES ('OLDOLDOL', ?, 0)`, T0 - 1)
    insertJob(h, 'old-done', 'done', T0 - 10 * DAY)

    h.tick(DAY + 1)
    await h.phoneJson(token, 'POST', '/api/jobs', {
      target: { type: 'main' },
      count: 1,
      place: 'cloud'
    })
    await h.runAlarms()
    expect(h.kv('cleanup:at')).not.toBeNull()
    expect(Number(h.kv('cleanup:at'))).toBeGreaterThan(T0)
    expect(h.sql.exec(`SELECT * FROM ops WHERE acked = 1`).toArray()).toHaveLength(0)
    expect(h.sql.exec(`SELECT * FROM ratelimit WHERE k = 'old'`).toArray()).toHaveLength(0)
    expect(h.sql.exec(`SELECT * FROM pairing WHERE code = 'OLDOLDOL'`).toArray()).toHaveLength(0)
    expect(h.sql.exec(`SELECT * FROM jobs WHERE id = 'old-done'`).toArray()).toHaveLength(0)
  })

  it('작업을 만들 때는 더 이상 정리하지 않는다 (예전엔 만들 때마다 표를 훑었다)', async () => {
    const h = new Harness()
    await seedPc(h)
    const token = await h.pair()
    await h.pcPoll()
    insertJob(h, 'old-done', 'done', T0 - 10 * DAY)
    h.tick(MIN)
    const res = await h.phoneJson(token, 'POST', '/api/jobs', {
      target: { type: 'main' },
      count: 1,
      place: 'pc'
    })
    expect(res.status).toBe(200)
    expect(h.sql.exec(`SELECT * FROM jobs WHERE id = 'old-done'`).toArray()).toHaveLength(1)
  })
})

// ── 미반영 편집 줄: 병합 · 상한 · 429 ────────────────────────────────

describe('미반영 편집 줄(ops) — 같은 대상은 합치고, 개수·크기에 상한', () => {
  const pendingOps = (h: Harness): Dict[] =>
    h.sql.exec<Dict>(`SELECT id, type, payload FROM ops WHERE acked = 0 ORDER BY id`).toArray()
  const FULL = '편집이 너무 많이 쌓였습니다. PC를 켜서 반영한 뒤 다시 시도하세요'

  it('같은 씬을 여러 번 고쳐도 줄은 하나 — 새 값이 이기고 새 번호로 다시 선다', async () => {
    const h = new Harness()
    await seedPc(h)
    const token = await h.pair()
    await h.phoneJson(token, 'PATCH', '/api/scenes/1', { name: 'A', prompt: 'p1' })
    const first = pendingOps(h)
    expect(first).toHaveLength(1)
    await h.phoneJson(token, 'PATCH', '/api/scenes/1', { prompt: 'p2', width: 640 })
    await h.phoneJson(token, 'PATCH', '/api/scenes/2', { name: 'B' }) // 다른 씬은 따로
    const rows = pendingOps(h)
    expect(rows).toHaveLength(2)
    const merged = rows.find((r) => JSON.parse(r.payload).sceneId === 1)!
    expect(JSON.parse(merged.payload)).toEqual({
      sceneId: 1,
      patch: { name: 'A', prompt: 'p2', width: 640 }
    })
    expect(merged.id).toBeGreaterThan(first[0].id)
    // 폰이 보는 씬 사본도 최신
    const scene = (await h.phoneJson(token, 'GET', '/api/scenes?presetId=1')).json.items[0]
    expect(scene).toMatchObject({ name: 'A', prompt: 'p2', width: 640, pendingEdit: true })
  })

  it('PC 가 옛 줄을 받아 반영하는 사이 또 고쳐도, 그 확인(ack)이 새 편집을 덮지 않는다', async () => {
    const h = new Harness()
    await seedPc(h)
    const token = await h.pair()
    await h.phoneJson(token, 'PATCH', '/api/scenes/1', { prompt: 'first' })
    const polled = await h.pcPoll() // PC 가 옛 줄을 가져감
    expect(polled.ops).toHaveLength(1)
    await h.phoneJson(token, 'PATCH', '/api/scenes/1', { negativePrompt: 'second' })
    await h.pcJson('POST', '/api/pc/ack', { opIds: polled.ops.map((o) => o.id), jobs: [] }) // 옛 줄의 ack
    const left = pendingOps(h)
    expect(left).toHaveLength(1)
    expect(JSON.parse(left[0].payload).patch).toEqual({ prompt: 'first', negativePrompt: 'second' })
    // 다음 poll 은 합친 줄을 준다 — 앞의 prompt 도 함께(다시 적용돼도 같은 값)
    const next = await h.pcPoll()
    expect(next.ops).toHaveLength(1)
  })

  it('캐릭터는 대상별로, 메인은 한 줄로 합친다 (분할 프롬프트와 통짜 프롬프트는 새 쪽만 남김)', async () => {
    const h = new Harness()
    await seedPc(h)
    const token = await h.pair()
    await h.phoneJson(token, 'PATCH', '/api/characters/10', { enabled: false })
    await h.phoneJson(token, 'PATCH', '/api/characters/10', { prompt: 'new hana' })
    await h.phoneJson(token, 'PATCH', '/api/characters/11', { enabled: true })
    expect(pendingOps(h).filter((r) => r.type === 'char:update')).toHaveLength(2)
    const hana = pendingOps(h).find((r) => JSON.parse(r.payload).charId === 10)!
    expect(JSON.parse(hana.payload).patch).toEqual({ enabled: false, prompt: 'new hana' })

    await h.phoneJson(token, 'PATCH', '/api/main', { prompt: 'm1', negativePrompt: 'n1' })
    await h.phoneJson(token, 'PATCH', '/api/main', {
      promptParts: { base: 'b', additional: 'a', detail: 'd' }
    })
    let main = pendingOps(h).filter((r) => r.type === 'main:update')
    expect(main).toHaveLength(1)
    expect(JSON.parse(main[0].payload).patch).toEqual({
      negativePrompt: 'n1',
      promptParts: { base: 'b', additional: 'a', detail: 'd' }
    })
    await h.phoneJson(token, 'PATCH', '/api/main', { prompt: 'm2' })
    main = pendingOps(h).filter((r) => r.type === 'main:update')
    expect(JSON.parse(main[0].payload).patch).toEqual({ negativePrompt: 'n1', prompt: 'm2' })
  })

  it('미반영 줄이 300개면 새 대상의 편집은 429 — 이미 있는 대상은 합쳐지므로 계속 된다. ack 되면 다시 받는다', async () => {
    const h = new Harness()
    await seedPc(h)
    await putScenes(h, bigScenes(400), 'many')
    const token = await h.pair()
    for (let i = 0; i < 300; i++) {
      const res = await h.phone(token, 'PATCH', `/api/scenes/${1000 + i}`, { name: `n${i}` })
      expect(res.status, String(i)).toBe(200)
    }
    expect(pendingOps(h)).toHaveLength(300)

    const refused = await h.phoneJson(token, 'PATCH', '/api/scenes/1300', { name: '301번째' })
    expect(refused.status).toBe(429)
    expect(refused.json.error).toBe(FULL)
    // 거절된 편집은 씬 사본도 바꾸지 않는다
    expect(
      JSON.parse(h.sql.exec<Dict>(`SELECT data FROM scenes WHERE id = 1300`).one().data).name
    ).toBe('씬 1300')
    // 이미 줄에 있는 씬은 합쳐서 계속 고칠 수 있다
    expect((await h.phone(token, 'PATCH', '/api/scenes/1000', { prompt: '또' })).status).toBe(200)
    expect(pendingOps(h)).toHaveLength(300)
    // 캐릭터·메인 같은 새 대상도 막힌다
    expect((await h.phone(token, 'PATCH', '/api/main', { prompt: 'x' })).status).toBe(429)
    expect((await h.phone(token, 'PATCH', '/api/characters/10', { enabled: false })).status).toBe(
      429
    )

    const polled = await h.pcPoll()
    expect(polled.ops).toHaveLength(200) // 한 번에 200줄
    await h.pcJson('POST', '/api/pc/ack', { opIds: polled.ops.map((o) => o.id), jobs: [] })
    expect((await h.phone(token, 'PATCH', '/api/scenes/1300', { name: '이제 된다' })).status).toBe(
      200
    )
  })

  it('한 줄이 200KB 를 넘는 편집은 429 — 처음부터 큰 편집도, 합쳐서 커진 편집도', async () => {
    const h = new Harness()
    await seedPc(h)
    const token = await h.pair()
    const korean = (n: number): string => '가'.repeat(n) // 글자당 3바이트
    // 단일 편집: 칸당 5만 자 제한 안이지만 합계가 200KB(≈ 6.8만 글자)를 넘는다
    const tooBig = await h.phoneJson(token, 'PATCH', '/api/scenes/1', {
      prompt: korean(40_000),
      negativePrompt: korean(40_000)
    })
    expect(tooBig.status).toBe(429)
    expect(tooBig.json.error).toBe(FULL)
    expect(pendingOps(h)).toHaveLength(0)
    // 거절된 편집은 씬 사본도 바꾸지 않는다
    expect(
      JSON.parse(h.sql.exec<Dict>(`SELECT data FROM scenes WHERE id = 1`).one().data).prompt
    ).toBe('scene prompt 1')

    // 한 칸씩은 들어가지만(120KB) 같은 씬에 합치면 넘는다
    expect(
      (await h.phone(token, 'PATCH', '/api/scenes/1', { prompt: korean(40_000) })).status
    ).toBe(200)
    const merged = await h.phoneJson(token, 'PATCH', '/api/scenes/1', {
      negativePrompt: korean(40_000)
    })
    expect(merged.status).toBe(429)
    expect(merged.json.error).toBe(FULL)
    // 합치기가 거절되면 옛 줄이 그대로 남는다
    const left = pendingOps(h)
    expect(left).toHaveLength(1)
    expect(JSON.parse(left[0].payload).patch).toEqual({ prompt: korean(40_000) })
  })

  it('미반영 줄 전체가 2MB(poll 응답 한 번의 합계)를 넘는 편집은 429 — 반영(ack)해 줄이 비면 다시 받는다', async () => {
    const h = new Harness()
    await seedPc(h)
    await putScenes(h, bigScenes(40), 'few')
    const token = await h.pair()
    const korean = '가'.repeat(50_000) // 칸 한도 5만 자 = 150KB
    let accepted = 0
    for (let i = 0; i < 20; i++) {
      const res = await h.phoneJson(token, 'PATCH', `/api/scenes/${1000 + i}`, { prompt: korean })
      if (res.status === 200) {
        accepted++
        continue
      }
      expect(res.status).toBe(429)
      expect(res.json.error).toBe(FULL)
      break
    }
    expect(accepted).toBe(13) // 150KB × 13 ≈ 1.95MB — 14번째부터 막힌다
    const total = h.sql
      .exec<{ n: number }>(
        `SELECT SUM(length(CAST(payload AS BLOB))) AS n FROM ops WHERE acked = 0`
      )
      .one().n
    expect(total).toBeLessThanOrEqual(2 * 1024 * 1024)

    // 한도 안이니 poll 한 번에 전부 실려 간다
    const polled = await h.pcJson('POST', '/api/pc/poll', { acceptsJobs: true, queue: null })
    expect(polled.json.ops).toHaveLength(13)
    // 같은 대상(이미 줄에 있는 씬)은 합쳐지므로 크기가 늘지 않는 한 계속 고칠 수 있다
    expect((await h.phone(token, 'PATCH', '/api/scenes/1000', { prompt: korean })).status).toBe(200)

    await h.pcJson('POST', '/api/pc/ack', {
      opIds: polled.json.ops.map((o: Dict) => o.id),
      jobs: []
    })
    expect((await h.phone(token, 'PATCH', '/api/scenes/1013', { prompt: korean })).status).toBe(200)
  })

  it('한도 도입 전에 쌓인 줄이 2MB 를 넘어도 poll 응답은 2MB 안에서 — 나머지는 ack 뒤 다음 poll 에', async () => {
    const h = new Harness()
    await seedPc(h)
    const big = JSON.stringify({ sceneId: 1, patch: { prompt: '가'.repeat(50_000) } })
    for (let i = 0; i < 20; i++) {
      h.sql.exec(
        `INSERT INTO ops (type, payload, at, acked) VALUES ('scene:update', ?, ?, 0)`,
        big.replace('"sceneId":1', `"sceneId":${i + 1}`),
        T0
      )
    }
    const sizeOf = (ops: Dict[]): number =>
      ops.reduce((n, op) => n + new TextEncoder().encode(JSON.stringify(op.patch)).length, 0)
    const first = await h.pcJson('POST', '/api/pc/poll', { acceptsJobs: true, queue: null })
    expect(first.json.ops.length).toBeGreaterThanOrEqual(12)
    expect(first.json.ops.length).toBeLessThan(20)
    expect(sizeOf(first.json.ops)).toBeLessThanOrEqual(2 * 1024 * 1024)

    await h.pcJson('POST', '/api/pc/ack', {
      opIds: first.json.ops.map((o: Dict) => o.id),
      jobs: []
    })
    const second = await h.pcJson('POST', '/api/pc/poll', { acceptsJobs: true, queue: null })
    expect(first.json.ops.length + second.json.ops.length).toBe(20)
  })
})

// ── 본문 크기 선검사 ────────────────────────────────────────────────

describe('본문 크기는 읽기 전에 막는다', () => {
  /** 청크를 pull 될 때마다 하나씩 내보내는 스트림 — 몇 번 읽혔는지 센다 */
  function streamOf(
    chunkBytes: number,
    chunks: number
  ): { stream: ReadableStream<Uint8Array>; pulled: () => number; cancelled: () => boolean } {
    let pulled = 0
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= chunks) {
          controller.close()
          return
        }
        pulled++
        controller.enqueue(new Uint8Array(chunkBytes).fill(97))
      },
      cancel() {
        cancelled = true
      }
    })
    return { stream, pulled: () => pulled, cancelled: () => cancelled }
  }

  async function send(
    h: Harness,
    method: string,
    path: string,
    body: ReadableStream<Uint8Array>,
    headers: Record<string, string> = {}
  ): Promise<Response> {
    const request = new Request(`${ORIGIN}${path}`, {
      method,
      headers,
      body,
      // @ts-expect-error Node(undici) 는 스트림 본문에 duplex 가 필요하다
      duplex: 'half'
    })
    return handleRequest(h.deps, request)
  }

  it('/api/pair: Content-Length 가 2KB 를 넘으면 본문을 모으지 않고 413 (버리는 읽기는 64KB 까지만)', async () => {
    const h = new Harness()
    const body = streamOf(1024 * 1024, 100)
    const res = await send(h, 'POST', '/api/pair', body.stream, {
      'content-length': '104857600',
      'content-type': 'application/json'
    })
    expect(res.status).toBe(413)
    expect(body.pulled()).toBeLessThanOrEqual(2) // 첫 조각(1MB)이 버리기 예산(64KB)을 넘자 취소
    expect(body.cancelled()).toBe(true)
  })

  it('/api/pair: Content-Length 만 보고 413 — 본문 스트림이 오류를 내도 거기까지 가지 않는다', async () => {
    const h = new Harness()
    const exploding = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('본문을 읽으면 안 된다')
      }
    })
    const res = await send(h, 'POST', '/api/pair', exploding, { 'content-length': '5000' })
    expect(res.status).toBe(413)
  })

  it('/api/pair: Content-Length 가 없는(chunked) 100MB 본문도 한도(2KB)를 넘는 즉시 읽기를 멈춘다', async () => {
    const h = new Harness()
    const body = streamOf(1024 * 1024, 100)
    const res = await send(h, 'POST', '/api/pair', body.stream, {
      'content-type': 'application/json'
    })
    expect(res.status).toBe(413)
    expect(body.pulled()).toBeLessThanOrEqual(2)
    expect(body.cancelled()).toBe(true)
  })

  it('/api/pair: 거짓 Content-Length(작게 적고 크게 보냄)도 실제 크기로 막는다', async () => {
    const h = new Harness()
    const body = streamOf(1024 * 1024, 100)
    const res = await send(h, 'POST', '/api/pair', body.stream, { 'content-length': '10' })
    expect(res.status).toBe(413)
    expect(body.pulled()).toBeLessThanOrEqual(2)
  })

  it('/api/pair: 시도 제한은 본문을 읽기 전에 건다 — 큰 본문만 보내도 30번 뒤엔 429', async () => {
    const h = new Harness()
    for (let i = 0; i < 30; i++) {
      const res = await send(h, 'POST', '/api/pair', streamOf(4096, 1).stream, {
        'content-length': '4096'
      })
      expect(res.status, String(i)).toBe(413)
    }
    // 31번째는 429 — 본문 크기 검사(413)보다도, 코드 검사보다도 먼저 제한이 걸린다
    const oversize = await send(h, 'POST', '/api/pair', streamOf(4096, 1).stream, {
      'content-length': '4096'
    })
    expect(oversize.status).toBe(429)
    const small = await send(h, 'POST', '/api/pair', streamOf(100, 1).stream, {
      'content-type': 'application/json'
    })
    expect(small.status).toBe(429)
  })

  it('/api/pair: 정상 연결은 그대로 되고, 깨진 JSON 은 틀린 코드와 같게 400', async () => {
    const h = new Harness()
    const made = await h.pcJson('POST', '/api/pc/pairing')
    const broken = await h.call('POST', '/api/pair', { raw: '{ not json' })
    expect(broken.status).toBe(400)
    expect(((await broken.json()) as Dict).error).toContain('연결 코드')
    // 깨진 요청이 코드 하나를 한 번 실패로 센다 — 아직 살아 있다
    const done = await h.call('POST', '/api/pair', {
      body: { code: made.json.code, name: '내 폰' }
    })
    expect(done.status).toBe(200)
  })

  it('인증된 쪽도 같다: 썸네일 PUT · 일반 JSON 본문은 Content-Length 로 먼저, 없으면 읽다가 멈춘다', async () => {
    const h = new Harness()
    await seedPc(h)
    const token = await h.pair()
    await uploadPcImage(h, 1)

    // PC 썸네일 한도 512KB
    const lengthy = streamOf(1024 * 1024, 50)
    const res1 = await send(h, 'PUT', '/api/pc/images/p1/thumb', lengthy.stream, {
      'x-nais-pc': 'test-pc-secret-0123456789abcdef',
      'content-length': String(50 * 1024 * 1024),
      'content-type': 'image/webp'
    })
    expect(res1.status).toBe(413)
    expect(lengthy.pulled()).toBeLessThanOrEqual(2)
    expect(lengthy.cancelled()).toBe(true)

    const chunked = streamOf(1024 * 1024, 50)
    const res2 = await send(h, 'PUT', '/api/pc/images/p1/thumb', chunked.stream, {
      'x-nais-pc': 'test-pc-secret-0123456789abcdef',
      'content-type': 'image/webp'
    })
    expect(res2.status).toBe(413)
    expect(chunked.pulled()).toBeLessThanOrEqual(2)

    // 폰 편집 본문(400K 글자 한도 → 받는 바이트 한도 1.2MB)
    const json = streamOf(1024 * 1024, 50)
    const res3 = await send(h, 'PATCH', '/api/main', json.stream, {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    })
    expect(res3.status).toBe(413)
    expect(json.pulled()).toBeLessThanOrEqual(3)
  })

  it('한도 안의 본문은 그대로 읽는다 (여러 조각으로 나뉘어 와도)', async () => {
    const h = new Harness()
    await seedPc(h)
    const token = await h.pair()
    const text = JSON.stringify({ prompt: '한글 프롬프트 '.repeat(2000) })
    const bytes = new TextEncoder().encode(text)
    const parts = [bytes.slice(0, 7), bytes.slice(7, 20_000), bytes.slice(20_000)] // 글자 중간에서 끊긴다
    let i = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < parts.length) controller.enqueue(parts[i++])
        else controller.close()
      }
    })
    const res = await send(h, 'PATCH', '/api/main', stream, {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    })
    expect(res.status).toBe(200)
    expect(JSON.parse(h.sql.exec<Dict>(`SELECT payload FROM ops`).one().payload).patch.prompt).toBe(
      '한글 프롬프트 '.repeat(2000)
    )
  })
})

describe('읽지 않고 돌려보내는 요청 본문은 응답 전에 비운다', () => {
  /** 청크를 pull 될 때마다 하나씩 — 끝까지 읽혔는지(closed) 취소됐는지 센다 */
  function chunked(
    chunkBytes: number,
    chunks: number
  ): {
    stream: ReadableStream<Uint8Array>
    state: () => { pulled: number; closed: boolean; cancelled: boolean }
  } {
    const state = { pulled: 0, closed: false, cancelled: false }
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (state.pulled >= chunks) {
          state.closed = true
          controller.close()
          return
        }
        state.pulled++
        controller.enqueue(new Uint8Array(chunkBytes).fill(98))
      },
      cancel() {
        state.cancelled = true
      }
    })
    return { stream, state: () => ({ ...state }) }
  }

  function post(
    h: Harness,
    path: string,
    body: ReadableStream<Uint8Array>,
    headers: Record<string, string>
  ): Promise<Response> {
    return handleRequest(
      h.deps,
      new Request(`${ORIGIN}${path}`, {
        method: 'PUT',
        headers,
        body,
        // @ts-expect-error Node(undici) 는 스트림 본문에 duplex 가 필요하다
        duplex: 'half'
      })
    )
  }

  it('인증 실패(401)한 요청의 작은 본문은 끝까지 읽어 버린다 — 런타임이 응답 뒤에 본문을 읽으려다 내는 오류를 막는다', async () => {
    const h = new Harness()
    const body = chunked(1024, 5)
    const res = await post(h, '/api/pc/images/p1', body.stream, { 'x-nais-pc': 'wrong' })
    expect(res.status).toBe(401)
    expect(body.state()).toMatchObject({ pulled: 5, closed: true, cancelled: false })
  })

  it('큰 본문은 64KB 까지만 읽고 취소한다 (메모리를 쓰지 않는다)', async () => {
    const h = new Harness()
    const body = chunked(1024, 100_000)
    const res = await post(h, '/api/pc/images/p1', body.stream, { 'x-nais-pc': 'wrong' })
    expect(res.status).toBe(401)
    const state = body.state()
    expect(state.cancelled).toBe(true)
    expect(state.pulled).toBeGreaterThanOrEqual(64)
    expect(state.pulled).toBeLessThanOrEqual(70)
  })

  it('조금씩만 보내며 버티는 본문에 응답을 붙들리지 않는다 — 2초 기다리고 취소한다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const h = new Harness()
      let cancelled = false
      const stalled = new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>(() => undefined) // 영영 안 온다
        },
        cancel() {
          cancelled = true
        }
      })
      const pending = post(h, '/api/pc/images/p1', stalled, { 'x-nais-pc': 'wrong' })
      // 인증(비동기 해시)을 지나 본문 비우기가 시계를 맞출 때까지 기다린다
      while (vi.getTimerCount() === 0) await new Promise((resolve) => setImmediate(resolve))
      await vi.advanceTimersByTimeAsync(1900)
      expect(cancelled).toBe(false)
      await vi.advanceTimersByTimeAsync(200)
      const res = await pending
      expect(res.status).toBe(401)
      expect(cancelled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('검사에서 거절한 썸네일(415)의 본문도 비운다. 정상 처리한 요청은 그대로 200', async () => {
    const h = new Harness()
    await seedPc(h)
    await uploadPcImage(h, 1)
    const png = chunked(512, 3)
    const refused = await post(h, '/api/pc/images/p1/thumb', png.stream, {
      'x-nais-pc': 'test-pc-secret-0123456789abcdef',
      'content-type': 'image/png'
    })
    expect(refused.status).toBe(415)
    expect(png.state()).toMatchObject({ pulled: 3, closed: true })

    const webp = chunked(512, 3)
    const accepted = await post(h, '/api/pc/images/p1/thumb', webp.stream, {
      'x-nais-pc': 'test-pc-secret-0123456789abcdef',
      'content-type': 'image/webp'
    })
    expect(accepted.status).toBe(200)
    expect(webp.state()).toMatchObject({ pulled: 3, closed: true })
  })
})

// ── 작업 중복 방지 · 캐릭터 편집 안내 ───────────────────────────────

describe('POST /api/jobs — requestId · 캐릭터 편집 안내', () => {
  const sceneJob = (extra: Dict = {}): Dict => ({
    target: { type: 'scene', sceneId: 1 },
    count: 2,
    place: 'pc',
    ...extra
  })

  it('같은 requestId 로 10분 안에 다시 오면 새로 만들지 않고 앞서 만든 작업을 돌려준다', async () => {
    const h = new Harness()
    await seedPc(h)
    const token = await h.pair()
    const a = await h.phoneJson(token, 'POST', '/api/jobs', sceneJob({ requestId: 'req-1' }))
    expect(a.status).toBe(200)
    h.tick(9 * MIN)
    const b = await h.phoneJson(token, 'POST', '/api/jobs', sceneJob({ requestId: 'req-1' }))
    expect(b.status).toBe(200)
    expect(b.json.job.id).toBe(a.json.job.id)
    expect(h.sql.exec(`SELECT * FROM jobs`).toArray()).toHaveLength(1)

    // 앞 작업이 진행되어도 그 작업의 지금 상태를 돌려준다
    await h.pcJson('POST', '/api/pc/ack', {
      opIds: [],
      jobs: [{ id: a.json.job.id, state: 'accepted' }]
    })
    const c = await h.phoneJson(token, 'POST', '/api/jobs', sceneJob({ requestId: 'req-1' }))
    expect(c.json.job).toMatchObject({ id: a.json.job.id, state: 'pc' })

    // 10분이 지나면 새 작업
    h.tick(2 * MIN)
    const d = await h.phoneJson(token, 'POST', '/api/jobs', sceneJob({ requestId: 'req-1' }))
    expect(d.json.job.id).not.toBe(a.json.job.id)
    expect(h.sql.exec(`SELECT * FROM jobs`).toArray()).toHaveLength(2)
  })

  it('다른 requestId · requestId 없음은 매번 새 작업. 모양이 틀린 requestId 는 400', async () => {
    const h = new Harness()
    await seedPc(h)
    const token = await h.pair()
    const ids = new Set<string>()
    for (const extra of [{ requestId: 'r-a' }, { requestId: 'r-b' }, {}, {}]) {
      ids.add((await h.phoneJson(token, 'POST', '/api/jobs', sceneJob(extra))).json.job.id)
    }
    expect(ids.size).toBe(4)
    for (const requestId of ['', '   ', 'x'.repeat(101), 123, {}]) {
      expect((await h.phoneJson(token, 'POST', '/api/jobs', sceneJob({ requestId }))).status).toBe(
        400
      )
    }
    expect(
      (await h.phoneJson(token, 'POST', '/api/jobs', sceneJob({ requestId: null }))).status
    ).toBe(200)
  })

  it('클라우드 작업도 같다: 알람이 한 번만 걸리고 생성도 한 번만 된다', async () => {
    const h = new Harness()
    await seedPc(h)
    await enableCloudGen(h)
    const token = await h.pair()
    const body = { target: { type: 'main' }, count: 1, place: 'cloud', requestId: 'cloud-1' }
    const a = await h.phoneJson(token, 'POST', '/api/jobs', body)
    const b = await h.phoneJson(token, 'POST', '/api/jobs', body)
    expect(b.json.job.id).toBe(a.json.job.id)
    await h.runAlarms()
    expect(h.nai.generateCalls).toHaveLength(1)
    expect(h.sql.exec(`SELECT * FROM jobs`).toArray()).toHaveLength(1)
  })

  it('PC 반영 전의 캐릭터 편집이 있으면 클라우드 작업 응답에 안내가 붙는다 (PC 작업이나 다른 편집에는 없다)', async () => {
    const h = new Harness()
    await seedPc(h)
    await enableCloudGen(h)
    const token = await h.pair()
    const NOTICE = '캐릭터 편집은 PC가 켜져 반영된 뒤부터 클라우드 생성에 쓰입니다'
    const cloud = { target: { type: 'main' }, count: 1, place: 'cloud' }

    // 씬·메인 편집은 완성 요청에 얹히므로 안내가 없다
    await h.phoneJson(token, 'PATCH', '/api/main', { prompt: 'edited' })
    await h.phoneJson(token, 'PATCH', '/api/scenes/1', { prompt: 'edited' })
    expect((await h.phoneJson(token, 'POST', '/api/jobs', cloud)).json.notice).toBeUndefined()

    await h.phoneJson(token, 'PATCH', '/api/characters/10', { enabled: false })
    const withNotice = await h.phoneJson(token, 'POST', '/api/jobs', cloud)
    expect(withNotice.status).toBe(200)
    expect(withNotice.json.notice).toBe(NOTICE)
    expect(withNotice.json.job.runner).toBe('cloud')

    // PC 작업(place pc)에는 붙지 않는다 — PC 가 켜지면 편집이 먼저 반영된다
    expect(
      (await h.phoneJson(token, 'POST', '/api/jobs', { ...cloud, place: 'pc' })).json.notice
    ).not.toBe(NOTICE)

    // PC 가 반영(ack)하고 나면 안내도 사라진다
    const polled = await h.pcPoll()
    await h.pcJson('POST', '/api/pc/ack', { opIds: polled.ops.map((o) => o.id), jobs: [] })
    expect((await h.phoneJson(token, 'POST', '/api/jobs', cloud)).json.notice).toBeUndefined()
  })
})

// ── pcPending · 삭제 확인 · 썸네일 형식 ─────────────────────────────

describe('클라우드 생성분 삭제 — pcPending 과 409 / force', () => {
  async function withCloudImages(): Promise<{ h: Harness; token: string; ids: string[] }> {
    const h = new Harness()
    await seedPc(h)
    await enableCloudGen(h)
    const token = await h.pair()
    await uploadPcImage(h, 1)
    await h.phoneJson(token, 'POST', '/api/jobs', {
      target: { type: 'main' },
      count: 2,
      place: 'cloud'
    })
    await h.runAlarms()
    const ids = (await h.pcJson('GET', '/api/pc/cloud-images')).json.items.map((i: Dict) => i.id)
    expect(ids).toHaveLength(2)
    return { h, token, ids }
  }

  it('목록의 pcPending: PC 가 안 가져간 클라우드 생성분만 true', async () => {
    const { h, token, ids } = await withCloudImages()
    const list = await h.phoneJson(token, 'GET', '/api/images')
    const byId = Object.fromEntries(list.json.items.map((i: Dict) => [i.id, i.pcPending]))
    expect(byId).toEqual({ p1: false, [ids[0]]: true, [ids[1]]: true })

    await h.pcJson('POST', `/api/pc/cloud-images/${ids[0]}/imported`, { pcImageId: 7 })
    const after = await h.phoneJson(token, 'GET', '/api/images')
    const afterById = Object.fromEntries(after.json.items.map((i: Dict) => [i.id, i.pcPending]))
    expect(afterById).toEqual({ p1: false, [ids[0]]: false, [ids[1]]: true })
  })

  it('안 가져간 그림은 force 없이 지우면 409 로 막고 아무것도 지우지 않는다', async () => {
    const { h, token, ids } = await withCloudImages()
    const refused = await h.phoneJson(token, 'DELETE', `/api/images/${ids[0]}`)
    expect(refused.status).toBe(409)
    expect(refused.json.error).toBe(
      'PC로 아직 옮기지 않은 그림입니다. 지우면 다시 받을 수 없습니다'
    )
    for (const bad of ['?force=0', '?force=true', '?force=']) {
      expect((await h.phone(token, 'DELETE', `/api/images/${ids[0]}${bad}`)).status, bad).toBe(409)
    }
    expect(h.sql.exec(`SELECT * FROM images WHERE id = ?`, ids[0]).toArray()).toHaveLength(1)
    expect(h.bucket.files.has(`img/${ids[0]}.zip`)).toBe(true)
    expect((await h.pcJson('GET', '/api/pc/cloud-images')).json.items).toHaveLength(2)
  })

  it('force=1 이면 지운다. 가져간 그림 · PC 그림은 force 없이도 지운다', async () => {
    const { h, token, ids } = await withCloudImages()
    expect((await h.phone(token, 'DELETE', `/api/images/${ids[0]}?force=1`)).status).toBe(200)
    expect(h.sql.exec(`SELECT * FROM images WHERE id = ?`, ids[0]).toArray()).toHaveLength(0)
    expect(h.bucket.files.has(`img/${ids[0]}.zip`)).toBe(false)

    await h.pcJson('POST', `/api/pc/cloud-images/${ids[1]}/imported`, { pcImageId: 8 })
    expect((await h.phone(token, 'DELETE', `/api/images/${ids[1]}`)).status).toBe(200)
    expect((await h.phone(token, 'DELETE', '/api/images/p1')).status).toBe(200)
    expect(h.sql.exec(`SELECT * FROM images`).toArray()).toHaveLength(0)
    expect((await h.phone(token, 'DELETE', '/api/images/p1')).status).toBe(404)
  })
})

describe('썸네일 — WebP · JPEG 모두 받고 받은 형식 그대로 돌려준다', () => {
  const WEBP = new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80])
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])

  async function cloudImage(): Promise<{ h: Harness; token: string; id: string }> {
    const h = new Harness()
    await seedPc(h)
    await enableCloudGen(h)
    const token = await h.pair()
    await h.phoneJson(token, 'POST', '/api/jobs', {
      target: { type: 'main' },
      count: 1,
      place: 'cloud'
    })
    await h.runAlarms()
    const id = (await h.pcJson('GET', '/api/pc/cloud-images')).json.items[0].id as string
    return { h, token, id }
  }

  const put = (
    h: Harness,
    token: string,
    id: string,
    bytes: Uint8Array,
    type?: string
  ): Promise<Response> =>
    h.call('PUT', `/api/images/${id}/thumb`, {
      auth: token,
      raw: bytes as unknown as BodyInit,
      headers: type ? { 'content-type': type } : {}
    })

  it('image/jpeg 로 올리면 image/jpeg 로 돌려준다 (R2 에는 .jpg)', async () => {
    const { h, token, id } = await cloudImage()
    expect((await put(h, token, id, JPEG, 'image/jpeg')).status).toBe(200)
    const got = await h.phone(token, 'GET', `/api/images/${id}/thumb`)
    expect(got.status).toBe(200)
    expect(got.headers.get('content-type')).toBe('image/jpeg')
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(JPEG)
    expect(h.bucket.files.get(`thumb/${id}.jpg`)?.contentType).toBe('image/jpeg')
    expect(h.bucket.files.has(`thumb/${id}.webp`)).toBe(false)
    expect(h.sql.exec<Dict>(`SELECT has_thumb FROM images WHERE id = ?`, id).one().has_thumb).toBe(
      2
    )
    const list = await h.phoneJson(token, 'GET', '/api/images')
    expect(list.json.items[0].hasThumb).toBe(true)
  })

  it('image/webp 와 헤더 없음은 WebP. 허용하지 않는 형식은 415, 한 번 올린 뒤엔 409', async () => {
    const { h, token, id } = await cloudImage()
    expect((await put(h, token, id, WEBP, 'image/png')).status).toBe(415)
    expect((await put(h, token, id, WEBP, 'text/html')).status).toBe(415)
    expect(h.sql.exec<Dict>(`SELECT has_thumb FROM images WHERE id = ?`, id).one().has_thumb).toBe(
      0
    )
    expect((await put(h, token, id, WEBP, 'image/webp; charset=binary')).status).toBe(200)
    const got = await h.phone(token, 'GET', `/api/images/${id}/thumb`)
    expect(got.headers.get('content-type')).toBe('image/webp')
    expect(h.bucket.files.has(`thumb/${id}.webp`)).toBe(true)
    expect((await put(h, token, id, JPEG, 'image/jpeg')).status).toBe(409)
    expect(h.bucket.files.has(`thumb/${id}.jpg`)).toBe(false)

    const second = await cloudImage()
    expect((await put(second.h, second.token, second.id, WEBP)).status).toBe(200) // 헤더 없음 = 예전처럼 WebP
    expect(
      second.h.sql.exec<Dict>(`SELECT has_thumb FROM images WHERE id = ?`, second.id).one()
        .has_thumb
    ).toBe(1)
  })

  it('JPEG 썸네일이 있는 그림을 지우면 .jpg 도 함께 지운다', async () => {
    const { h, token, id } = await cloudImage()
    await put(h, token, id, JPEG, 'image/jpeg')
    expect((await h.phone(token, 'DELETE', `/api/images/${id}?force=1`)).status).toBe(200)
    expect(h.bucket.keys()).toEqual([])
  })

  it('PC 썸네일 올리기도 JPEG 를 받고, 형식이 바뀌면 옛 파일을 지운다', async () => {
    const h = new Harness()
    await seedPc(h)
    const token = await h.pair()
    await uploadPcImage(h, 1)
    const pcPut = (bytes: Uint8Array, type: string): Promise<Response> =>
      h.call('PUT', '/api/pc/images/p1/thumb', {
        auth: 'pc',
        raw: bytes as unknown as BodyInit,
        headers: { 'content-type': type }
      })
    expect((await pcPut(WEBP, 'image/webp')).status).toBe(200)
    expect(h.bucket.files.has('thumb/p1.webp')).toBe(true)
    expect((await pcPut(JPEG, 'image/jpeg')).status).toBe(200)
    expect(h.bucket.files.has('thumb/p1.webp')).toBe(false)
    expect(h.bucket.files.get('thumb/p1.jpg')?.contentType).toBe('image/jpeg')
    const got = await h.phone(token, 'GET', '/api/images/p1/thumb')
    expect(got.headers.get('content-type')).toBe('image/jpeg')
    expect((await pcPut(WEBP, 'application/octet-stream')).status).toBe(415)
  })

  it('보관 정리로 지워지는 그림의 JPEG 썸네일도 R2 에 남지 않는다', async () => {
    const h = new Harness()
    await seedPc(h)
    await uploadPcImage(h, 1, { createdAt: T0 })
    await h.call('PUT', '/api/pc/images/p1/thumb', {
      auth: 'pc',
      raw: JPEG as unknown as BodyInit,
      headers: { 'content-type': 'image/jpeg' }
    })
    await h.pcJson('PUT', '/api/pc/settings', { cloudGenEnabled: false, keepImages: 100 })
    insertImageRows(h, 100, () => ({ createdAt: T0 + 10 }))
    await uploadPcImage(h, 2, { createdAt: T0 + 20 })
    expect(h.sql.exec(`SELECT * FROM images WHERE id = 'p1'`).toArray()).toHaveLength(0)
    expect(h.bucket.files.has('thumb/p1.jpg')).toBe(false)
    expect(h.bucket.files.has('img/p1.webp')).toBe(false)
  })
})

describe('라이브러리 올리기는 씬 표를 훑지 않는다', () => {
  it('프리셋 해시 표로 사라진 프리셋을 찾는다', async () => {
    const h = new Harness()
    await seedPc(h)
    await putScenes(h, bigScenes(300), 'big')
    h.sql.resetStats()
    const lib = sampleLibrary()
    lib.presets = lib.presets.filter((p) => p.id === 1) // 프리셋 2 가 사라짐
    const res = await h.pcJson('PUT', '/api/pc/library', { library: lib, hash: 'lib-2' })
    expect(res.status).toBe(200)
    expect(h.sql.stats().fullScans).not.toHaveProperty('scenes')
    expect(h.sql.exec(`SELECT * FROM scenes WHERE preset_id = 2`).toArray()).toHaveLength(0)
    expect(h.sql.exec(`SELECT * FROM scene_hash WHERE preset_id = 2`).toArray()).toHaveLength(0)
    expect(h.sql.exec(`SELECT * FROM scenes WHERE preset_id = 1`).toArray()).toHaveLength(300)
  })
})

describe('알람이 끊겨도 폰·PC 의 요청이 되살린다', () => {
  it('클라우드 작업이 남았는데 알람이 사라졌으면 poll 이 다시 건다 — 점검은 1분에 한 번만', async () => {
    const h = new Harness()
    await seedPc(h)
    await enableCloudGen(h)
    const token = await h.pair()
    await h.phoneJson(token, 'POST', '/api/jobs', {
      target: { type: 'main' },
      count: 1,
      place: 'cloud'
    })
    expect(h.pendingAlarm).toBe(T0)
    // 알람이 사라졌다 (저장소 오류가 길게 이어져 알람 처리가 포기한 경우와 같은 모양)
    const lose = (): void => {
      h.sql.exec(`DELETE FROM kv WHERE k = 'alarm:at'`)
      h.pendingAlarm = null
      h.alarmLog.length = 0
    }
    lose()
    await h.pcPoll() // 첫 점검 — 바로 다시 건다
    expect(h.alarmLog).toEqual([T0 + 1000])

    lose()
    h.tick(30_000)
    await h.pcPoll()
    expect(h.alarmLog).toEqual([]) // 방금 점검했다
    h.tick(31_000)
    await h.pcPoll()
    expect(h.alarmLog).toHaveLength(1)
    await h.runAlarms()
    expect(h.jobRow((await h.phoneJson(token, 'GET', '/api/state')).json.jobs[0].id).state).toBe(
      'done'
    )
  })

  it('알람이 방금 걸렸거나 클라우드 작업이 없으면 건드리지 않는다', async () => {
    const h = new Harness()
    await seedPc(h)
    await enableCloudGen(h)
    const token = await h.pair()
    h.tick(2 * MIN)
    await h.pcPoll()
    await h.phoneJson(token, 'GET', '/api/state')
    expect(h.alarmLog).toEqual([]) // 작업이 없다

    await h.phoneJson(token, 'POST', '/api/jobs', {
      target: { type: 'main' },
      count: 1,
      place: 'cloud'
    })
    expect(h.alarmLog).toHaveLength(1)
    h.tick(30_000)
    await h.pcPoll()
    await h.phoneJson(token, 'GET', '/api/state')
    expect(h.alarmLog).toHaveLength(1) // 걸린 지 한 분이 안 됐다

    // 알람 처리 중에는(메모리 표시) 알람이 없어 보여도 또 걸지 않는다
    h.sql.exec(`DELETE FROM kv WHERE k = 'alarm:at'`)
    h.tick(2 * MIN)
    await h.pcPoll()
    expect(h.alarmLog).toHaveLength(2) // 끊긴 것으로 보고 한 번 다시 건다
    await h.runAlarms()
    h.tick(2 * MIN)
    await h.pcPoll() // 작업이 끝났으면 걸 일이 없다
    expect(h.pendingAlarm).toBeNull()
  })
})
