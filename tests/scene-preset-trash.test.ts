import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations, reconcileSchema } from '../src/main/db/migrations'
import {
  createPreset,
  createScene,
  deletePreset,
  deleteScene,
  listPresets,
  listScenes,
  listTrashedPresets,
  listTrashedScenes,
  purgeOldTrash,
  purgePreset,
  restorePreset,
  restoreScenes
} from '../src/main/scenes/repo'
import { trashFile } from '../src/main/trash'

/**
 * 프리셋 휴지통 (커스텀).
 * 프리셋을 지우면 안의 씬까지 통째로 사라져 되돌릴 길이 없었다 — 이제 휴지통으로 간다.
 * 임시 메모리 DB에 실제 마이그레이션을 돌려 합성 데이터로만 확인한다.
 */

let db: DatabaseSync
const settings = new Map<string, string>()

vi.mock('electron', () => ({ app: {}, BrowserWindow: {}, dialog: {}, shell: {} }))
vi.mock('sharp', () => ({ default: vi.fn() }))
vi.mock('../src/main/trash', () => ({ trashFile: vi.fn(async () => {}) }))
vi.mock('../src/main/db/settings', () => ({
  getSetting: (key: string) => settings.get(key) ?? null
}))
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
function openDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:')
  for (const migrate of migrations) migrate(d as never)
  return d
}

const hasColumn = (table: string, col: string): boolean =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
    (c) => c.name === col
  )

const sceneRow = (id: number): { preset_id: number; deleted_at: string | null } | undefined =>
  db.prepare('SELECT preset_id, deleted_at FROM gen_scenes WHERE id = ?').get(id) as
    { preset_id: number; deleted_at: string | null } | undefined

const addImage = (sceneId: number, filePath: string, favorite = 0): void => {
  db.prepare(
    "INSERT INTO images (file_path, payload_json, scene_id, favorite) VALUES (?, '{}', ?, ?)"
  ).run(filePath, sceneId, favorite)
}

const imageRows = (): { file_path: string; scene_id: number | null; favorite: number }[] =>
  db.prepare('SELECT file_path, scene_id, favorite FROM images ORDER BY id').all() as {
    file_path: string
    scene_id: number | null
    favorite: number
  }[]

const presetDeletedAt = (id: number): string | null | undefined =>
  (
    db.prepare('SELECT deleted_at FROM scene_presets WHERE id = ?').get(id) as
      { deleted_at: string | null } | undefined
  )?.deleted_at

/** 기본 씬 프리셋 id (v8이 만든 것) */
const basePresetId = (): number =>
  (
    db
      .prepare("SELECT id FROM scene_presets WHERE kind = 'scene' ORDER BY sort_order, id LIMIT 1")
      .get() as { id: number }
  ).id

beforeEach(() => {
  db = openDb()
  reconcileSchema(db as never)
  settings.clear()
  vi.mocked(trashFile).mockClear()
})
afterEach(() => db.close())

describe('프리셋 삭제는 휴지통으로 간다', () => {
  it('프리셋과 안의 씬이 같은 시각으로 표시되고 목록에서 빠진다', () => {
    const presetId = createPreset('프리셋 B')
    const a = createScene(presetId, '씬 1')
    const b = createScene(presetId, '씬 2')

    deletePreset(presetId)

    const at = presetDeletedAt(presetId)
    expect(at).toBeTruthy()
    expect(sceneRow(a)?.deleted_at).toBe(at)
    expect(sceneRow(b)?.deleted_at).toBe(at)
    expect(listPresets('scene').map((p) => p.id)).not.toContain(presetId)
    expect(listScenes(presetId)).toEqual([])
    // 프리셋째 지운 씬은 씬 휴지통에 따로 나오지 않는다
    expect(listTrashedScenes('scene').map((s) => s.id)).not.toContain(a)
    const trashed = listTrashedPresets('scene')
    expect(trashed.map((p) => [p.id, p.sceneCount])).toEqual([[presetId, 2]])
    expect(trashed[0].deletedAt).toBe(at)
    expect(listTrashedPresets('background')).toEqual([])
  })

  it('마지막 프리셋 판정은 휴지통 프리셋을 세지 않는다', () => {
    const base = basePresetId()
    const other = createPreset('프리셋 B')
    deletePreset(other)
    // 살아 있는 씬 프리셋은 하나뿐 — 휴지통 것이 있어도 못 지운다
    deletePreset(base)
    expect(presetDeletedAt(base)).toBeNull()
    expect(listPresets('scene').map((p) => p.id)).toEqual([base])
    // 배경 프리셋은 따로 센다 — 하나뿐이면 못 지운다
    const bg = listPresets('background')
    expect(bg).toHaveLength(1)
    deletePreset(bg[0].id)
    expect(presetDeletedAt(bg[0].id)).toBeNull()
  })

  it('이미 휴지통에 있는 프리셋을 다시 지워도 시각이 바뀌지 않는다', () => {
    const presetId = createPreset('프리셋 B')
    createScene(presetId, '씬 1')
    deletePreset(presetId)
    const at = presetDeletedAt(presetId)
    db.prepare('UPDATE scene_presets SET deleted_at = ? WHERE id = ?').run(
      '2026-01-01 00:00:00.000',
      presetId
    )
    deletePreset(presetId)
    expect(presetDeletedAt(presetId)).toBe('2026-01-01 00:00:00.000')
    expect(at).not.toBe('2026-01-01 00:00:00.000')
  })
})

describe('프리셋 복원', () => {
  it('함께 지운 씬만 돌아오고, 먼저 따로 지운 씬은 씬 휴지통에 남는다', () => {
    const presetId = createPreset('프리셋 B')
    const earlier = createScene(presetId, '먼저 지운 씬')
    const a = createScene(presetId, '씬 1')
    const b = createScene(presetId, '씬 2')
    deleteScene(earlier)
    const earlierAt = sceneRow(earlier)?.deleted_at

    deletePreset(presetId)
    // 따로 지운 씬의 시각은 그대로
    expect(sceneRow(earlier)?.deleted_at).toBe(earlierAt)
    expect(listTrashedScenes('scene').map((s) => s.id)).not.toContain(earlier)
    expect(listTrashedPresets('scene')[0].sceneCount).toBe(2)

    restorePreset(presetId)

    expect(presetDeletedAt(presetId)).toBeNull()
    expect(listPresets('scene').map((p) => p.id)).toContain(presetId)
    expect(listScenes(presetId).map((s) => s.id)).toEqual([a, b])
    expect(sceneRow(earlier)?.deleted_at).toBe(earlierAt)
    expect(listTrashedScenes('scene').map((s) => s.id)).toEqual([earlier])
    expect(listTrashedPresets('scene')).toEqual([])
  })

  it('휴지통 프리셋의 씬을 따로 되살리면 같은 종류의 살아 있는 첫 프리셋으로 간다', () => {
    const presetId = createPreset('프리셋 B')
    const earlier = createScene(presetId, '먼저 지운 씬')
    deleteScene(earlier)
    deletePreset(presetId)

    restoreScenes([earlier])

    expect(sceneRow(earlier)).toEqual({ preset_id: basePresetId(), deleted_at: null })
  })
})

describe('프리셋 영구 삭제', () => {
  it('함께 지운 씬의 이미지는 기록에 남고, 먼저 따로 지운 씬은 이미지까지 지운다', async () => {
    const presetId = createPreset('프리셋 B')
    const earlier = createScene(presetId, '먼저 지운 씬')
    const a = createScene(presetId, '씬 1')
    addImage(earlier, 'img-earlier.png')
    addImage(a, 'img-a.png', 1)
    deleteScene(earlier)
    deletePreset(presetId)

    await purgePreset(presetId)

    expect(presetDeletedAt(presetId)).toBeUndefined()
    expect(sceneRow(earlier)).toBeUndefined()
    expect(sceneRow(a)).toBeUndefined()
    // 예전 프리셋 삭제처럼 scene_id만 끊긴다 (즐겨찾기 그대로)
    expect(imageRows()).toEqual([{ file_path: 'img-a.png', scene_id: null, favorite: 1 }])
    expect(vi.mocked(trashFile).mock.calls.map((c) => c[0])).toEqual(['img-earlier.png'])
    expect(listTrashedPresets('scene')).toEqual([])
  })

  it('살아 있는 프리셋은 영구 삭제하지 않는다', async () => {
    const presetId = createPreset('프리셋 B')
    const a = createScene(presetId, '씬 1')
    await purgePreset(presetId)
    expect(presetDeletedAt(presetId)).toBeNull()
    expect(sceneRow(a)?.deleted_at).toBeNull()
  })
})

describe('보관 기간', () => {
  const trashDaysAgo = (presetId: number, days: number): void => {
    deletePreset(presetId)
    const at = (
      db.prepare("SELECT strftime('%Y-%m-%d %H:%M:%f', 'now', ?) AS t").get(`-${days} days`) as {
        t: string
      }
    ).t
    db.prepare('UPDATE gen_scenes SET deleted_at = ? WHERE preset_id = ?').run(at, presetId)
    db.prepare('UPDATE scene_presets SET deleted_at = ? WHERE id = ?').run(at, presetId)
  }

  it('기간이 지난 휴지통 프리셋만 앱 시작 때 영구 삭제된다', async () => {
    settings.set('trash_retention_days', '30')
    const old = createPreset('오래된 프리셋')
    const oldScene = createScene(old, '씬')
    const recent = createPreset('최근 프리셋')
    const recentScene = createScene(recent, '씬')
    addImage(oldScene, 'img-old.png', 1)
    trashDaysAgo(old, 40)
    trashDaysAgo(recent, 5)

    await purgeOldTrash()

    expect(presetDeletedAt(old)).toBeUndefined()
    expect(sceneRow(oldScene)).toBeUndefined()
    // 자동 영구 삭제도 이미지는 기록에 남긴다
    expect(imageRows()).toEqual([{ file_path: 'img-old.png', scene_id: null, favorite: 1 }])
    expect(trashFile).not.toHaveBeenCalled()
    expect(presetDeletedAt(recent)).toBeTruthy()
    expect(sceneRow(recentScene)?.deleted_at).toBeTruthy()
  })

  it('0이면 기간과 상관없이 계속 보관한다', async () => {
    settings.set('trash_retention_days', '0')
    const old = createPreset('오래된 프리셋')
    trashDaysAgo(old, 400)
    await purgeOldTrash()
    expect(presetDeletedAt(old)).toBeTruthy()
  })
})

describe('스키마', () => {
  it('프리셋 삭제 표시 칸은 버전드 마이그레이션이 아니라 reconcileSchema가 붙이고, 여러 번 돌려도 된다', () => {
    db.close()
    db = openDb()
    const before = db.prepare('PRAGMA user_version').get()
    expect(hasColumn('scene_presets', 'deleted_at')).toBe(false)
    db.prepare("INSERT INTO scene_presets (name, sort_order) VALUES ('프리셋 B', 5)").run()

    reconcileSchema(db as never)
    reconcileSchema(db as never)

    expect(hasColumn('scene_presets', 'deleted_at')).toBe(true)
    expect(
      (db.prepare('PRAGMA table_info(scene_presets)').all() as { name: string }[]).filter(
        (c) => c.name === 'deleted_at'
      )
    ).toHaveLength(1)
    // 기존 프리셋은 살아 있는 채로
    expect(
      db.prepare('SELECT COUNT(*) AS c FROM scene_presets WHERE deleted_at IS NOT NULL').get()
    ).toEqual({ c: 0 })
    expect(db.prepare('PRAGMA user_version').get()).toEqual(before)
  })
})
