import { createHash } from 'crypto'
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations, reconcileSchema } from '../src/main/db/migrations'
import {
  importBackupPresets,
  listBackupFiles,
  listBackupPresets
} from '../src/main/backup/preset-import'

/**
 * 백업에서 프리셋 가져오기 (커스텀).
 * 휴지통이 생기기 전에 지운 프리셋을 자동 백업 DB에서 되찾는다.
 * 지금 DB는 메모리, 백업은 임시 폴더의 파일 — 전부 합성 데이터.
 */

let db: DatabaseSync
let dir: string

// 백업은 better-sqlite3로 연다 — 테스트에선 Node 내장 SQLite로 같은 옵션을 흉내 낸다
vi.mock('better-sqlite3', async () => {
  const { DatabaseSync: Sync } = await import('node:sqlite')
  const fs = await import('fs')
  class ReadonlyFile extends Sync {
    constructor(path: string, opts: { readonly?: boolean; fileMustExist?: boolean } = {}) {
      if (opts.fileMustExist && !fs.existsSync(path)) throw new Error(`no such file: ${path}`)
      super(path, { readOnly: opts.readonly === true })
    }
  }
  return { default: ReadonlyFile }
})
vi.mock('../src/main/db', () => ({
  getDb: () => ({
    prepare: (sql: string) => db.prepare(sql),
    exec: (sql: string) => db.exec(sql),
    transaction: (run: () => unknown) => () => {
      db.exec('BEGIN')
      try {
        const result = run()
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
  })
}))

/** 앱과 같은 순서 — 버전드 마이그레이션 전부 → reconcileSchema */
function fullSchema(path: string): DatabaseSync {
  const d = new DatabaseSync(path)
  for (const migrate of migrations) migrate(d as never)
  reconcileSchema(d as never)
  return d
}

const setSetting = (d: DatabaseSync, key: string, value: unknown): void => {
  d.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
    key,
    typeof value === 'string' ? value : JSON.stringify(value)
  )
}
const getSetting = (key: string): string | null =>
  (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)
    ?.value ?? null
const extrasNow = (): Record<string, Record<string, Record<string, unknown>>> =>
  JSON.parse(getSetting('scene_extras') ?? '{}')

type SceneRow = Record<string, unknown> & { id: number; preset_id: number; name: string }
const scenesNamed = (name: string): SceneRow[] =>
  db.prepare('SELECT * FROM gen_scenes WHERE name = ? ORDER BY id').all(name) as SceneRow[]
const presetNamed = (name: string): Record<string, unknown> & { id: number } =>
  db.prepare('SELECT * FROM scene_presets WHERE name = ?').get(name) as Record<string, unknown> & {
    id: number
  }

const SETUP_1 = { characterIds: [3], charRefIds: [], vibeIds: [], roles: { 3: 'source' } }
const SETUP_2 = { characterIds: [4], charRefIds: [], vibeIds: [] }

/**
 * 지금 스키마 백업: 프리셋 A(id 5) = 씬 10·11 + 휴지통 씬 12,
 * 휴지통 프리셋(id 6) = 함께 지운 씬 13 + 먼저 따로 지운 씬 14.
 * 씬별 설정·R2 설정도 id 5 기준으로 들어 있다.
 */
function currentSchemaBackup(name = 'auto-current.db', wal = false): string {
  const path = join(dir, name)
  const b = fullSchema(path)
  if (wal) b.exec('PRAGMA journal_mode = WAL')
  b.exec(`
    INSERT INTO scene_presets (id, name, sort_order, kind, default_width, default_height)
      VALUES (5, '프리셋 A', 3, 'scene', 1024, 1024);
    INSERT INTO scene_presets (id, name, sort_order, kind, deleted_at)
      VALUES (6, '휴지통 프리셋', 4, 'scene', '2026-01-01 00:00:00.000');
    INSERT INTO gen_scenes (id, preset_id, name, prompt, sort_order, export_no, source_tags)
      VALUES (10, 5, '씬 1', 'p1', 0, 7, 'kiss');
    INSERT INTO gen_scenes (id, preset_id, name, prompt, sort_order) VALUES (11, 5, '씬 2', 'p2', 1);
    INSERT INTO gen_scenes (id, preset_id, name, sort_order, deleted_at)
      VALUES (12, 5, '지운 씬', 2, '2026-01-01 00:00:00');
    INSERT INTO gen_scenes (id, preset_id, name, deleted_at)
      VALUES (13, 6, '휴지통 프리셋 씬', '2026-01-01 00:00:00.000');
    INSERT INTO gen_scenes (id, preset_id, name, deleted_at)
      VALUES (14, 6, '따로 지운 씬', '2025-12-31 00:00:00');
  `)
  setSetting(b, 'scene_extras', {
    additions: { 5: { 10: SETUP_1, 11: SETUP_2, 12: SETUP_2 } },
    transparentBackgrounds: { 5: { 10: true } }
  })
  setSetting(b, 'r2_sync_cfg_5', { enabled: true, bucket: 'b', prefix: 'p/' })
  setSetting(b, 'r2_sync_state_5', { version: 2, targets: { x: { 99: 'p/01.png' } } })
  b.close()
  return path
}

/** 옛 스키마 백업 (v8 무렵): kind·deleted_at·배경·검열 열 없음, 지금은 없는 열 하나 */
function oldSchemaBackup(badRow = false): string {
  const path = join(dir, 'pre-migration-v9.db')
  const b = new DatabaseSync(path)
  b.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE scene_presets (id INTEGER PRIMARY KEY, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE gen_scenes (
      id INTEGER PRIMARY KEY, name TEXT, prompt TEXT NOT NULL DEFAULT '',
      negative_prompt TEXT NOT NULL DEFAULT '', width INTEGER NOT NULL DEFAULT 832,
      height INTEGER NOT NULL DEFAULT 1216, sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      preset_id INTEGER NOT NULL DEFAULT 1, reserve_count INTEGER NOT NULL DEFAULT 0, old_only TEXT
    );
    INSERT INTO scene_presets (id, name, sort_order) VALUES (1, '기본', 0), (7, '옛 프리셋', 1);
    INSERT INTO gen_scenes (id, preset_id, name, prompt, sort_order, old_only) VALUES (20, 7, '옛 씬 1', 'o1', 0, 'x');
  `)
  b.prepare(
    'INSERT INTO gen_scenes (id, preset_id, name, prompt, sort_order) VALUES (21, 7, ?, ?, 1)'
  ).run(badRow ? null : '옛 씬 2', 'o2')
  setSetting(b, 'scene_extras', { additions: { 7: { 20: SETUP_1 } } })
  b.close()
  return path
}

const fingerprint = (path: string): { hash: string; mtime: number; files: string[] } => ({
  hash: createHash('sha1').update(readFileSync(path)).digest('hex'),
  mtime: statSync(path).mtimeMs,
  files: readdirSync(dir).sort()
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nais3-preset-import-'))
  db = fullSchema(':memory:')
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('백업 파일 목록', () => {
  it('.db만, 최근 것부터', () => {
    for (const [name, t] of [
      ['auto-a.db', 1_000],
      ['auto-b.db', 3_000],
      ['pre-migration-v9.db', 2_000],
      ['notes.txt', 4_000]
    ] as const) {
      writeFileSync(join(dir, name), 'x'.repeat(t / 1000))
      utimesSync(join(dir, name), t, t)
    }
    expect(listBackupFiles(dir).map((f) => [f.name, f.size])).toEqual([
      ['auto-b.db', 3],
      ['pre-migration-v9.db', 2],
      ['auto-a.db', 1]
    ])
    expect(listBackupFiles(join(dir, 'missing'))).toEqual([])
  })
})

describe('백업 속 프리셋 목록', () => {
  it('휴지통 프리셋도 넣고, 가져올 씬 수와 지금 있는지를 붙인다', () => {
    const items = listBackupPresets(currentSchemaBackup())
    expect(items.map((p) => [p.name, p.kind, p.sceneCount, p.exists])).toEqual([
      ['배경', 'background', 0, true],
      ['기본', 'scene', 0, true],
      ['프리셋 A', 'scene', 2, false],
      // 함께 지운 씬 13만 센다 (따로 지운 씬 14는 빠짐)
      ['휴지통 프리셋', 'scene', 1, false]
    ])
  })

  it('옛 스키마 백업도 읽는다 (종류 열 없음 = 씬)', () => {
    const items = listBackupPresets(oldSchemaBackup())
    expect(items.map((p) => [p.id, p.kind, p.sceneCount, p.exists])).toEqual([
      [1, 'scene', 0, true],
      [7, 'scene', 2, false]
    ])
  })
})

describe('프리셋 가져오기', () => {
  it('id가 비어 있으면 그대로 — 휴지통 씬은 빼고, 같은 종류의 맨 끝에', () => {
    const path = currentSchemaBackup()
    expect(importBackupPresets(path, [5])).toEqual({ presets: 1, scenes: 2 })

    const preset = presetNamed('프리셋 A')
    expect(preset).toMatchObject({ id: 5, kind: 'scene', default_width: 1024, deleted_at: null })
    // 지금 씬 프리셋은 '기본'(순서 0) 하나 → 그 뒤
    expect(preset.sort_order).toBe(1)
    expect(scenesNamed('씬 1')[0]).toMatchObject({
      id: 10,
      preset_id: 5,
      prompt: 'p1',
      export_no: 7,
      source_tags: 'kiss',
      deleted_at: null
    })
    expect(scenesNamed('씬 2')[0]).toMatchObject({ id: 11, preset_id: 5, sort_order: 1 })
    expect(scenesNamed('지운 씬')).toEqual([])

    // 씬별 설정은 가져온 씬 것만 (휴지통 씬 12는 빠진다)
    const extras = extrasNow()
    expect(extras.additions).toEqual({ 5: { 10: SETUP_1, 11: SETUP_2 } })
    expect(extras.transparentBackgrounds).toEqual({ 5: { 10: true } })
  })

  it('id가 차 있으면 새 id를 받고, 씬별 설정도 새 id로 옮긴다', () => {
    db.exec(`
      INSERT INTO scene_presets (id, name, sort_order) VALUES (5, '다른 프리셋', 1);
      INSERT INTO gen_scenes (id, preset_id, name) VALUES (10, 1, '다른 씬');
    `)
    setSetting(db, 'scene_extras', { additions: { 5: { 10: SETUP_2 } } })

    expect(importBackupPresets(currentSchemaBackup(), [5])).toEqual({ presets: 1, scenes: 2 })

    const preset = presetNamed('프리셋 A')
    expect(preset.id).not.toBe(5)
    expect(preset.sort_order).toBe(2)
    const [s1] = scenesNamed('씬 1')
    const [s2] = scenesNamed('씬 2')
    expect(s1.id).not.toBe(10)
    expect(s1.preset_id).toBe(preset.id)
    expect(s2).toMatchObject({ id: 11, preset_id: preset.id })
    // 원래 있던 프리셋·씬은 그대로
    expect(presetNamed('다른 프리셋').id).toBe(5)
    expect(scenesNamed('다른 씬')[0]).toMatchObject({ id: 10, preset_id: 1 })

    const extras = extrasNow()
    expect(extras.additions[5]).toEqual({ 10: SETUP_2 })
    expect(extras.additions[preset.id]).toEqual({ [s1.id]: SETUP_1, 11: SETUP_2 })
    expect(extras.transparentBackgrounds[preset.id]).toEqual({ [s1.id]: true })
  })

  it('지금 있는 씬별 설정은 덮어쓰지 않고, 나머지 설정도 그대로 둔다', () => {
    const existing = { characterIds: [9], charRefIds: [], vibeIds: [] }
    setSetting(db, 'scene_extras', {
      sequenceEnabled: true,
      entries: [{ id: 'e1', name: '반복 1', enabled: true, characterIds: [9] }],
      additions: { 5: { 10: existing } },
      transparentBackgrounds: { 5: { 10: false } }
    })

    importBackupPresets(currentSchemaBackup(), [5])

    const extras = extrasNow() as Record<string, unknown> & {
      additions: Record<string, Record<string, unknown>>
      transparentBackgrounds: Record<string, Record<string, unknown>>
    }
    expect(extras.additions[5]).toEqual({ 10: existing, 11: SETUP_2 })
    expect(extras.transparentBackgrounds[5]).toEqual({ 10: false })
    expect(extras.sequenceEnabled).toBe(true)
    expect(extras.entries).toHaveLength(1)
  })

  it('옛 스키마 백업 — 없는 열은 지금 기본값, 지금 없는 열은 버린다', () => {
    expect(importBackupPresets(oldSchemaBackup(), [7])).toEqual({ presets: 1, scenes: 2 })

    const preset = presetNamed('옛 프리셋')
    expect(preset).toMatchObject({
      id: 7,
      kind: 'scene',
      default_width: null,
      deleted_at: null
    })
    expect(scenesNamed('옛 씬 1')[0]).toMatchObject({
      id: 20,
      preset_id: 7,
      prompt: 'o1',
      background: '{}',
      censor_kinds: '[]',
      variety_plus: 0,
      source_tags: '',
      deleted_at: null
    })
    expect(scenesNamed('옛 씬 2')[0]).toMatchObject({ id: 21, sort_order: 1 })
    expect(extrasNow().additions).toEqual({ 7: { 20: SETUP_1 } })
  })

  it('백업 때 휴지통에 있던 프리셋도 함께 지운 씬과 살아 있는 채로 가져온다', () => {
    expect(importBackupPresets(currentSchemaBackup(), [6, 404])).toEqual({
      presets: 1,
      scenes: 1
    })
    expect(presetNamed('휴지통 프리셋')).toMatchObject({ id: 6, deleted_at: null })
    expect(scenesNamed('휴지통 프리셋 씬')[0]).toMatchObject({
      id: 13,
      preset_id: 6,
      deleted_at: null
    })
    expect(scenesNamed('따로 지운 씬')).toEqual([])
  })

  it('중간에 실패하면 전부 되돌린다', () => {
    const before = getSetting('scene_extras')
    const presetCount = (
      db.prepare('SELECT COUNT(*) AS c FROM scene_presets').get() as { c: number }
    ).c
    // 씬 21의 이름이 비어 있다 — 프리셋과 씬 20을 넣은 뒤 여기서 NOT NULL로 실패
    expect(() => importBackupPresets(oldSchemaBackup(true), [7])).toThrow()

    expect(presetNamed('옛 프리셋')).toBeUndefined()
    expect(scenesNamed('옛 씬 1')).toEqual([])
    expect((db.prepare('SELECT COUNT(*) AS c FROM scene_presets').get() as { c: number }).c).toBe(
      presetCount
    )
    expect(getSetting('scene_extras')).toBe(before)
  })

  it('R2 동기화 설정은 따라오고 추적 기록은 안 따라온다', () => {
    importBackupPresets(currentSchemaBackup(), [5])
    expect(JSON.parse(getSetting('r2_sync_cfg_5') ?? 'null')).toMatchObject({ bucket: 'b' })
    expect(getSetting('r2_sync_state_5')).toBeNull()
  })

  it('지운 프리셋의 R2 추적 기록이 남은 id는 비어 있어도 쓰지 않는다', () => {
    setSetting(db, 'r2_sync_state_5', { version: 2, targets: {} })
    importBackupPresets(currentSchemaBackup(), [5])
    const preset = presetNamed('프리셋 A')
    expect(preset.id).not.toBe(5)
    expect(getSetting(`r2_sync_cfg_${preset.id}`)).not.toBeNull()
    expect(getSetting('r2_sync_cfg_5')).toBeNull()
  })
})

describe('백업 파일은 건드리지 않는다', () => {
  it('목록·가져오기 전후로 내용·수정 시각·폴더가 같다', () => {
    const path = currentSchemaBackup()
    const before = fingerprint(path)
    listBackupPresets(path)
    importBackupPresets(path, [5])
    expect(fingerprint(path)).toEqual(before)
  })

  it('WAL 표시가 된 사본도 — 열 때 생긴 -wal/-shm은 치운다', () => {
    const path = currentSchemaBackup('pre-migration-v31.db', true)
    expect(readFileSync(path)[18]).toBe(2) // WAL 표시
    const before = fingerprint(path)
    listBackupPresets(path)
    importBackupPresets(path, [5])
    expect(fingerprint(path)).toEqual(before)
    expect(presetNamed('프리셋 A').id).toBe(5)
  })
})
