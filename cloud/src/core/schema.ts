import type { SqlLike } from './deps'

/**
 * 저장소 판 — 올리면 ensureSchema 에서 옛 판을 고친다.
 * 1 = 최초 / 2 = jobs.accepted_at 추가 (PC 가 작업을 받은 시각 — 잃어버린 작업 정리용)
 * 3 = 읽기·쓰기 줄이기: 인덱스 7개(부분 인덱스 포함, images_scene 은 images_scene2 로 교체) + jobs.request_id(작업 중복 방지) + 그림 수 카운터
 * 4 = prepared.updated_at 추가 (완성 요청 내용이 마지막으로 바뀐 시각 — ack 된 메인 편집을 prepared 가 새로 올라올 때까지 덧입히는 판단용)
 */
export const SCHEMA_VERSION = 4

/** 설계 명세 4절 스키마. 문장마다 따로 실행한다 (DO SQL 은 문장 하나씩이 가장 안전) */
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS scenes (id INTEGER PRIMARY KEY, preset_id INTEGER NOT NULL, sort_order INTEGER NOT NULL, data TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS scenes_preset ON scenes(preset_id, sort_order)`,
  `CREATE TABLE IF NOT EXISTS scene_hash (preset_id INTEGER PRIMARY KEY, hash TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS prepared (key TEXT PRIMARY KEY, hash TEXT NOT NULL, request TEXT NOT NULL, updated_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS ops (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL, acked INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, target TEXT NOT NULL, label TEXT NOT NULL, count INTEGER NOT NULL,
    done INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, place TEXT NOT NULL,
    runner TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    in_flight INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, accepted_at INTEGER, request_id TEXT)`,
  `CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, source TEXT NOT NULL, scene_id INTEGER, preset_id INTEGER, job_id TEXT,
    seed INTEGER, width INTEGER NOT NULL, height INTEGER NOT NULL, created_at INTEGER NOT NULL, has_thumb INTEGER NOT NULL DEFAULT 0,
    format TEXT NOT NULL, r2_key TEXT NOT NULL, sent_payload TEXT, imported INTEGER NOT NULL DEFAULT 0, pc_image_id INTEGER)`,
  `CREATE INDEX IF NOT EXISTS images_created ON images(created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_seen INTEGER)`,
  `CREATE TABLE IF NOT EXISTS pairing (code TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS ratelimit (k TEXT PRIMARY KEY, n INTEGER NOT NULL, reset_at INTEGER NOT NULL)`
]

/**
 * 3판에서 더한 인덱스. 5초 poll·30초 주기 요청이 표 전체를 훑지 않게 하는 것이 목적이다
 * (DO 무료 요금제는 하루 읽기 500만 행·쓰기 10만 행). 옛 저장소는 3판 열(jobs.request_id)이
 * 생긴 뒤에야 만들 수 있으므로 마이그레이션 다음에 돌린다 — 문장은 몇 번 돌아도 탈이 없다.
 */
const INDEX_STATEMENTS = [
  // 씬별 최신 그림과 씬 필터 갤러리 — id 까지 담아 표를 다시 읽지 않는 커버링 인덱스 (예전 images_scene 을 대신한다)
  `CREATE INDEX IF NOT EXISTS images_scene2 ON images(scene_id, created_at DESC, id DESC)`,
  // PC 가 아직 안 가져간 클라우드 생성분 목록(GET /api/pc/cloud-images)
  `CREATE INDEX IF NOT EXISTS images_cloud_pending ON images(created_at, id) WHERE source = 'cloud' AND imported = 0`,
  // 폰 갤러리의 프리셋 필터 (끝의 id DESC 는 ORDER BY created_at DESC, id DESC 를 그대로 받으려는 것)
  `CREATE INDEX IF NOT EXISTS images_preset ON images(preset_id, created_at DESC, id DESC)`,
  // poll 의 대기 작업·잃어버린 작업 정리, 알람의 클라우드 작업 고르기, 정보의 진행 중 작업 수
  `CREATE INDEX IF NOT EXISTS jobs_active ON jobs(state, runner, created_at)`,
  // 폰 상태의 최근 작업 30개, 끝난 작업 정리
  `CREATE INDEX IF NOT EXISTS jobs_updated ON jobs(updated_at DESC)`,
  // poll 이 5초마다 부르는 미반영 편집 줄 (반영 끝난 줄은 인덱스에 없다)
  `CREATE INDEX IF NOT EXISTS ops_pending ON ops(id) WHERE acked = 0`,
  // 같은 요청 id 로 다시 온 작업 만들기 (대부분의 행은 NULL 이라 인덱스에 안 들어간다)
  `CREATE INDEX IF NOT EXISTS jobs_request ON jobs(request_id) WHERE request_id IS NOT NULL`
]

/** Hub 생성자에서 한 번 (blockConcurrencyWhile 안) — 이미 있으면 아무 일도 안 한다 */
export function ensureSchema(sql: SqlLike): void {
  for (const statement of STATEMENTS) sql.exec(statement)
  const row = sql.exec<{ v: string }>(`SELECT v FROM kv WHERE k = 'schema:version'`).toArray()[0]
  if (!row) {
    sql.exec(`INSERT INTO kv (k, v) VALUES ('schema:version', ?)`, String(SCHEMA_VERSION))
  } else {
    const current = Number(row.v)
    if (current < SCHEMA_VERSION) {
      // 판마다 한 단계씩 순서대로 고친다 (각 단계는 두 번 실행돼도 탈이 없게 쓴다)
      for (let version = Math.max(current, 1) + 1; version <= SCHEMA_VERSION; version++) {
        MIGRATIONS[version]?.(sql)
      }
      sql.exec(`UPDATE kv SET v = ? WHERE k = 'schema:version'`, String(SCHEMA_VERSION))
    }
  }
  for (const statement of INDEX_STATEMENTS) sql.exec(statement)
}

/** 이미 있는 열을 또 더하려 하면 DO·node:sqlite 모두 "duplicate column name" 으로 거절한다 — 그건 통과 */
function addColumn(sql: SqlLike, table: string, definition: string): void {
  try {
    sql.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`)
  } catch (error) {
    if (!/duplicate column/i.test(error instanceof Error ? error.message : String(error)))
      throw error
  }
}

/** 판 번호 → 그 판으로 올리는 단계. 새로 만든 저장소는 STATEMENTS 가 이미 최신 모양이라 건너뛴다 */
const MIGRATIONS: Record<number, (sql: SqlLike) => void> = {
  // 2: PC 가 작업을 받은(accepted) 시각 — poll 의 activeJobIds 로 잃어버린 작업을 정리할 때 유예 계산에 쓴다
  2: (sql) => addColumn(sql, 'jobs', 'accepted_at INTEGER'),
  // 3: 작업 중복 방지 열. 인덱스는 위 INDEX_STATEMENTS 가 이어서 만들고, 그림 수 카운터(kv n:images · n:pending)는
  //    지워 두면 처음 읽을 때 세어 채운다
  3: (sql) => {
    addColumn(sql, 'jobs', 'request_id TEXT')
    sql.exec(`DROP INDEX IF EXISTS images_scene`)
    sql.exec(`DELETE FROM kv WHERE k IN ('n:images', 'n:pending')`)
  },
  // 4: 완성 요청의 마지막 변경 시각. 이미 있는 행은 비워 두면(NULL = 0) 어떤 ack 시각보다도 오래된 것으로 본다
  4: (sql) => addColumn(sql, 'prepared', 'updated_at INTEGER')
}
