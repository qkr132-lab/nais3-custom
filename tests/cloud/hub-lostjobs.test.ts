import { describe, expect, it } from 'vitest'
import { PC_LOST_GRACE_MS, PC_LOST_JOB_ERROR } from '../../cloud/src/core/jobs'
import { SCHEMA_VERSION, ensureSchema } from '../../cloud/src/core/schema'
import { Harness, T0, enableCloudGen, seedPc, type Dict } from './helpers/harness'
import { createTestSql } from './helpers/sql'

const MIN = 60_000
const LOST = 'PC가 작업을 잃었습니다 (앱을 다시 켰거나 큐를 비움)'

/** 연결된 폰 + 라이브러리가 올라간 허브, PC 켜짐 */
async function setup(): Promise<{ h: Harness; token: string }> {
  const h = new Harness()
  await seedPc(h)
  const token = await h.pair()
  await h.pcPoll()
  return { h, token }
}

/** PC 에 넘길 작업을 만든다 (place pc → queued · runner pc) */
async function makeJob(h: Harness, token: string, place = 'pc', count = 2): Promise<string> {
  const made = await h.phoneJson(token, 'POST', '/api/jobs', {
    target: { type: 'scene', sceneId: 1 },
    count,
    place
  })
  expect(made.status, JSON.stringify(made.json)).toBe(200)
  return made.json.job.id
}

/** PC 가 작업을 큐에 받았다고 알린다 */
async function accept(h: Harness, ...ids: string[]): Promise<void> {
  await h.pcJson('POST', '/api/pc/ack', {
    opIds: [],
    jobs: ids.map((id) => ({ id, state: 'accepted' }))
  })
}

const states = (h: Harness, ...ids: string[]): unknown[] => ids.map((id) => h.jobRow(id).state)

describe('잃어버린 PC 작업 정리 (poll 의 activeJobIds)', () => {
  it('상수: 유예 60초, 오류 문구는 설계 그대로', () => {
    expect(PC_LOST_GRACE_MS).toBe(60_000)
    expect(PC_LOST_JOB_ERROR).toBe(LOST)
  })

  it('받은 지 60초가 지났는데 activeJobIds 에 없으면 실패로 정리한다 (있는 작업은 그대로)', async () => {
    const { h, token } = await setup()
    const a = await makeJob(h, token)
    const b = await makeJob(h, token)
    await accept(h, a, b)
    expect(h.jobRow(a)).toMatchObject({ state: 'pc', accepted_at: T0 })

    // 59.999초 — 아직 유예 안
    h.tick(PC_LOST_GRACE_MS - 1)
    await h.pcPoll(true, [])
    expect(states(h, a, b)).toEqual(['pc', 'pc'])

    // 60초 — b 는 큐에 있다고 하고 a 만 빠졌다
    h.tick(1)
    await h.pcPoll(true, [b])
    expect(h.jobRow(a)).toMatchObject({
      state: 'failed',
      error: LOST,
      done: 0,
      failed: 0,
      updated_at: T0 + PC_LOST_GRACE_MS
    })
    expect(h.jobRow(b).state).toBe('pc')

    // 폰에도 이유가 보인다
    const jobs = (await h.phoneJson(token, 'GET', '/api/state')).json.jobs as Dict[]
    expect(jobs.find((j) => j.id === a)).toMatchObject({ state: 'failed', error: LOST })
    expect(jobs.find((j) => j.id === b)).toMatchObject({ state: 'pc', error: null })

    // 이미 정리된 작업은 다음 poll 에서 또 건드리지 않는다
    h.tick(MIN)
    await h.pcPoll(true, [b])
    expect(h.jobRow(a).updated_at).toBe(T0 + PC_LOST_GRACE_MS)
  })

  it('앱을 다시 켜 큐를 잃으면 빈 목록이 와서 받아 둔 작업이 모두 정리된다', async () => {
    const { h, token } = await setup()
    const ids = [await makeJob(h, token), await makeJob(h, token), await makeJob(h, token)]
    await accept(h, ...ids)
    h.tick(2 * MIN)
    await h.pcPoll(true, [])
    expect(states(h, ...ids)).toEqual(['failed', 'failed', 'failed'])
  })

  it('받은 시각(accepted)부터 센다 — 큐에서 오래 기다렸다 받은 작업도 받은 뒤 60초는 기다린다', async () => {
    const { h, token } = await setup()
    const id = await makeJob(h, token)
    h.tick(10 * MIN) // 만든 지 오래됐지만 아직 안 받았다
    await h.pcPoll(true, [])
    expect(h.jobRow(id).state).toBe('queued') // queued 는 정리 대상이 아니다
    await accept(h, id)
    expect(h.jobRow(id).accepted_at).toBe(T0 + 10 * MIN)
    await h.pcPoll(true, [])
    expect(h.jobRow(id).state).toBe('pc')
    h.tick(PC_LOST_GRACE_MS)
    await h.pcPoll(true, [])
    expect(h.jobRow(id)).toMatchObject({ state: 'failed', error: LOST })
  })

  it('accepted ack 를 또 받아도 받은 시각은 처음 값이다', async () => {
    const { h, token } = await setup()
    const id = await makeJob(h, token)
    await accept(h, id)
    h.tick(30_000)
    await accept(h, id)
    expect(h.jobRow(id).accepted_at).toBe(T0)
  })

  it('목록 필드가 없는 옛 poll · 모양이 틀린 목록은 아무것도 정리하지 않는다', async () => {
    const { h, token } = await setup()
    const id = await makeJob(h, token)
    await accept(h, id)
    h.tick(10 * MIN)
    await h.pcPoll(true) // 필드 없음
    expect(h.jobRow(id).state).toBe('pc')
    for (const activeJobIds of ['abc', null, {}, 7, [1, 2], ['a', 3], [null]]) {
      await h.pcJson('POST', '/api/pc/poll', {
        protocol: 1,
        appVersion: 'test',
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
        activeJobIds
      })
      expect(h.jobRow(id).state, JSON.stringify(activeJobIds)).toBe('pc')
    }
  })

  it('pc 상태가 아닌 작업은 건드리지 않는다 (queued · cloud · 끝남 · 취소)', async () => {
    const { h, token } = await setup()
    await enableCloudGen(h)
    const queued = await makeJob(h, token)
    const cloud = await makeJob(h, token, 'cloud')
    const done = await makeJob(h, token)
    const failed = await makeJob(h, token)
    const cancelled = await makeJob(h, token)
    await accept(h, done, failed, cancelled)
    await h.pcJson('POST', '/api/pc/ack', {
      opIds: [],
      jobs: [
        { id: done, state: 'done', done: 2, failed: 0 },
        { id: failed, state: 'failed', done: 0, failed: 2, error: '생성 실패' }
      ]
    })
    await h.phoneJson(token, 'POST', `/api/jobs/${cancelled}/cancel`)
    const before = [queued, cloud, done, failed, cancelled].map((id) => ({ ...h.jobRow(id) }))
    h.tick(30 * MIN)
    await h.pcPoll(true, [])
    expect([queued, cloud, done, failed, cancelled].map((id) => ({ ...h.jobRow(id) }))).toEqual(
      before
    )
    expect(states(h, queued, cloud, done, failed, cancelled)).toEqual([
      'queued',
      'cloud',
      'done',
      'failed',
      'cancelled'
    ])
    expect(h.jobRow(failed).error).toBe('생성 실패')
  })

  it('받은 시각이 비어 있는 옛 행은 updated_at 으로 갈음한다', async () => {
    const { h, token } = await setup()
    const id = await makeJob(h, token)
    await accept(h, id)
    h.sql.exec(`UPDATE jobs SET accepted_at = NULL WHERE id = ?`, id) // 열이 생기기 전에 받은 작업
    h.tick(PC_LOST_GRACE_MS - 1)
    await h.pcPoll(true, [])
    expect(h.jobRow(id).state).toBe('pc')
    h.tick(1)
    await h.pcPoll(true, [])
    expect(h.jobRow(id)).toMatchObject({ state: 'failed', error: LOST })
  })

  it('정리하면서 그 작업의 임시 kv 도 치운다', async () => {
    const { h, token } = await setup()
    const id = await makeJob(h, token)
    await accept(h, id)
    h.sql.exec(
      `INSERT INTO kv (k, v) VALUES (?, '1'), (?, '1'), (?, '1')`,
      `anlas:${id}`,
      `verify:${id}`,
      `rl:${id}`
    )
    h.tick(PC_LOST_GRACE_MS)
    await h.pcPoll(true, [])
    expect(h.sql.exec(`SELECT k FROM kv WHERE k LIKE '%:${id}'`).toArray()).toEqual([])
  })

  it('잃었다고 정리된 뒤에 PC 의 최종 결과(done · failed)가 늦게 도착하면 그 결과를 따른다', async () => {
    const { h, token } = await setup()
    const a = await makeJob(h, token, 'pc', 3)
    const b = await makeJob(h, token, 'pc', 2)
    const c = await makeJob(h, token, 'pc', 1)
    await accept(h, a, b, c)
    h.tick(PC_LOST_GRACE_MS)
    await h.pcPoll(true, []) // 마침 큐에서 빠진 순간의 poll
    expect(states(h, a, b, c)).toEqual(['failed', 'failed', 'failed'])

    await h.pcJson('POST', '/api/pc/ack', {
      opIds: [],
      jobs: [
        { id: a, state: 'done', done: 3, failed: 0 },
        { id: b, state: 'failed', done: 1, failed: 1, error: '생성 중 오류' },
        { id: c, state: 'accepted' } // 늦은 accepted 는 되살리지 않는다
      ]
    })
    expect(h.jobRow(a)).toMatchObject({ state: 'done', done: 3, failed: 0, error: null })
    expect(h.jobRow(b)).toMatchObject({
      state: 'failed',
      done: 1,
      failed: 1,
      error: '생성 중 오류'
    })
    expect(h.jobRow(c)).toMatchObject({ state: 'failed', error: LOST })

    // 이렇게 바로잡힌 작업은 그다음 poll 에서 다시 정리되지 않는다
    h.tick(MIN)
    await h.pcPoll(true, [])
    expect(states(h, a, b)).toEqual(['done', 'failed'])
    expect(h.jobRow(a).error).toBeNull()
  })

  it('다른 이유로 실패한 작업은 늦은 ack 로 되살아나지 않는다', async () => {
    const { h, token } = await setup()
    const id = await makeJob(h, token)
    await accept(h, id)
    await h.pcJson('POST', '/api/pc/ack', {
      opIds: [],
      jobs: [{ id, state: 'failed', done: 0, failed: 2, error: '진짜 실패' }]
    })
    await h.pcJson('POST', '/api/pc/ack', {
      opIds: [],
      jobs: [{ id, state: 'done', done: 2, failed: 0 }]
    })
    expect(h.jobRow(id)).toMatchObject({ state: 'failed', error: '진짜 실패', done: 0, failed: 2 })
  })

  it('취소된 작업은 정리 대상이 아니다 (취소 상태 그대로)', async () => {
    const { h, token } = await setup()
    const id = await makeJob(h, token)
    await accept(h, id)
    await h.phoneJson(token, 'POST', `/api/jobs/${id}/cancel`)
    h.tick(5 * MIN)
    await h.pcPoll(true, [])
    expect(h.jobRow(id).state).toBe('cancelled')
  })
})

describe('저장소 판 올리기 (jobs.accepted_at · jobs.request_id · prepared.updated_at · 인덱스)', () => {
  /** 판 1 의 jobs 표 — accepted_at 이 없다 */
  const V1_JOBS = `CREATE TABLE jobs (id TEXT PRIMARY KEY, target TEXT NOT NULL, label TEXT NOT NULL, count INTEGER NOT NULL,
    done INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, place TEXT NOT NULL,
    runner TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    in_flight INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0)`

  const columns = (sql: ReturnType<typeof createTestSql>): string[] =>
    sql
      .exec<{ name: string }>(`PRAGMA table_info(jobs)`)
      .toArray()
      .map((r) => r.name)

  const preparedColumns = (sql: ReturnType<typeof createTestSql>): string[] =>
    sql
      .exec<{ name: string }>(`PRAGMA table_info(prepared)`)
      .toArray()
      .map((r) => r.name)

  const version = (sql: ReturnType<typeof createTestSql>): string =>
    sql.exec<{ v: string }>(`SELECT v FROM kv WHERE k = 'schema:version'`).one().v

  it('판은 4 이고, 새 저장소에는 처음부터 jobs.accepted_at · jobs.request_id · prepared.updated_at 이 있다', () => {
    expect(SCHEMA_VERSION).toBe(4)
    const sql = createTestSql()
    ensureSchema(sql)
    expect(columns(sql)).toContain('accepted_at')
    expect(columns(sql)).toContain('request_id')
    expect(preparedColumns(sql)).toContain('updated_at')
    expect(version(sql)).toBe('4')
  })

  it('판 1 저장소는 열을 더하고 판을 올린다. 기존 행은 그대로이고 두 번 불러도 탈이 없다', () => {
    const sql = createTestSql()
    sql.exec(`CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`)
    sql.exec(V1_JOBS)
    sql.exec(`INSERT INTO kv (k, v) VALUES ('schema:version', '1')`)
    sql.exec(
      `INSERT INTO jobs (id, target, label, count, state, place, runner, created_at, updated_at)
       VALUES ('jold', '{"type":"main"}', '메인 생성', 2, 'pc', 'pc', 'pc', 100, 200)`
    )
    expect(columns(sql)).not.toContain('accepted_at')

    ensureSchema(sql)
    expect(columns(sql)).toContain('accepted_at')
    expect(columns(sql)).toContain('request_id')
    expect(version(sql)).toBe('4')
    expect(sql.exec<Dict>(`SELECT id, state, updated_at, accepted_at FROM jobs`).toArray()).toEqual(
      [{ id: 'jold', state: 'pc', updated_at: 200, accepted_at: null }]
    )

    ensureSchema(sql) // 이미 최신 — 아무 일도 없다
    expect(version(sql)).toBe('4')
    expect(columns(sql).filter((c) => c === 'accepted_at')).toHaveLength(1)
    expect(columns(sql).filter((c) => c === 'request_id')).toHaveLength(1)
  })

  it('판 번호는 1 인데 열이 이미 있어도(중간에 끊긴 올리기) 오류 없이 판만 올린다', () => {
    const sql = createTestSql()
    ensureSchema(sql)
    sql.exec(`UPDATE kv SET v = '1' WHERE k = 'schema:version'`)
    expect(() => ensureSchema(sql)).not.toThrow()
    expect(version(sql)).toBe('4')
  })

  it('판 3 저장소는 prepared.updated_at 을 더하고 기존 행은 그대로 둔다 (시각은 비어 있음)', () => {
    const sql = createTestSql()
    ensureSchema(sql)
    // 판 3 모양으로 되돌린다: updated_at 열을 없애고 행을 하나 넣는다
    sql.exec(`ALTER TABLE prepared DROP COLUMN updated_at`)
    sql.exec(`INSERT INTO prepared (key, hash, request) VALUES ('main', 'h1', '{"prompt":"p"}')`)
    sql.exec(`UPDATE kv SET v = '3' WHERE k = 'schema:version'`)
    expect(preparedColumns(sql)).not.toContain('updated_at')

    ensureSchema(sql)
    expect(preparedColumns(sql)).toContain('updated_at')
    expect(version(sql)).toBe('4')
    expect(sql.exec<Dict>(`SELECT key, hash, request, updated_at FROM prepared`).toArray()).toEqual(
      [{ key: 'main', hash: 'h1', request: '{"prompt":"p"}', updated_at: null }]
    )
    ensureSchema(sql) // 두 번 불러도 탈이 없다
    expect(preparedColumns(sql).filter((c) => c === 'updated_at')).toHaveLength(1)
  })

  it('열을 더하는 일 말고 다른 오류는 삼키지 않는다', () => {
    const sql = createTestSql()
    ensureSchema(sql)
    sql.exec(`UPDATE kv SET v = '1' WHERE k = 'schema:version'`)
    // ALTER 가 「duplicate column」이 아닌 이유로 실패하면 판을 올린 척하지 않고 그대로 던진다
    const broken = {
      exec: (query: string, ...bindings: unknown[]) => {
        if (/^\s*ALTER TABLE/i.test(query)) throw new Error('disk I/O error')
        return sql.exec(query, ...bindings)
      }
    }
    expect(() => ensureSchema(broken as never)).toThrow('disk I/O error')
  })
})
