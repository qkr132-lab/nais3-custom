import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations, reconcileSchema } from '../src/main/db/migrations'
import { buildFragmentsByPath, buildSnapshot } from '../src/main/cloud/snapshot'
import { readSnapshotSource } from '../src/main/cloud/source'
import {
  findLiveScene,
  listRecent,
  presetIdOfScene,
  presetName,
  sqliteUtcToMs
} from '../src/main/cloud/images'
import { fragmentSource, listFragments } from '../src/main/fragments/repo'
import {
  isSceneLive,
  listAllScenesLite,
  listSceneImageCounts,
  listScenes
} from '../src/main/scenes/repo'

/**
 * 모바일 클라우드 — DB 에서 스냅샷 원재료를 읽는 쪽 (커스텀).
 * 임시 메모리 DB 와 합성 데이터로만 확인한다.
 */

let db: DatabaseSync
const settings = vi.hoisted(() => ({ map: {} as Record<string, string> }))

vi.mock('electron', () => ({
  app: {},
  shell: {},
  safeStorage: {},
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  dialog: {}
}))
vi.mock('sharp', () => ({ default: vi.fn() }))
vi.mock('../src/main/trash', () => ({ trashFile: vi.fn(async () => {}) }))
vi.mock('../src/main/db/settings', () => ({
  getSetting: (key: string) => settings.map[key] ?? null,
  setSetting: (key: string, value: string) => {
    settings.map[key] = value
  }
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

const run = (sql: string, ...args: (string | number | null)[]): number =>
  Number(db.prepare(sql).run(...args).lastInsertRowid)

const preset = (
  name: string,
  sort: number,
  kind = 'scene',
  deleted: string | null = null
): number =>
  run(
    'INSERT INTO scene_presets (name, sort_order, kind, deleted_at) VALUES (?, ?, ?, ?)',
    name,
    sort,
    kind,
    deleted
  )

const scene = (
  presetId: number,
  name: string,
  sort: number,
  deleted: string | null = null
): number =>
  run(
    `INSERT INTO gen_scenes (preset_id, name, prompt, negative_prompt, width, height, sort_order, deleted_at)
     VALUES (?, ?, 'forest', 'lowres', 832, 1216, ?, ?)`,
    presetId,
    name,
    sort,
    deleted
  )

const image = (
  sceneId: number | null,
  deleted: string | null = null,
  thumb: Buffer | null = null
): number =>
  run(
    `INSERT INTO images (file_path, thumbnail, kind, seed, payload_json, scene_id, deleted_at)
     VALUES ('/x.png', ?, 'scene', 7, '{}', ?, ?)`,
    thumb as never,
    sceneId,
    deleted
  )

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  for (const migrate of migrations) migrate(db as never)
  reconcileSchema(db as never)
  db.exec('DELETE FROM gen_scenes; DELETE FROM scene_presets;')
  settings.map = {}
})

afterEach(() => db.close())

describe('listAllScenesLite', () => {
  it('휴지통 씬·휴지통 프리셋의 씬은 빼고, 프리셋 순서 → 씬 순서로 준다', () => {
    const second = preset('둘째', 2)
    const first = preset('첫째', 1)
    const trashed = preset('버림', 3, 'scene', '2026-01-01 00:00:00')
    const bg = preset('배경', 0, 'background')
    scene(second, 's2-b', 2)
    scene(second, 's2-a', 1)
    scene(first, 'f1', 1)
    scene(first, 'gone', 2, '2026-01-01 00:00:00')
    scene(trashed, 't1', 1)
    scene(bg, 'bg1', 1)

    const names = listAllScenesLite().map((s) => s.name)
    expect(names).toEqual(['bg1', 'f1', 's2-a', 's2-b'])
  })

  it('썸네일은 비우고, 그림 수는 세지 않는다(늘 0). 프리셋 종류가 씬 종류가 된다', () => {
    const p = preset('p', 1)
    const bg = preset('배경', 2, 'background')
    const a = scene(p, 'a', 1)
    const b = scene(bg, 'b', 1)
    image(a)
    image(a, null, Buffer.from('thumb'))
    image(a, '2026-01-01 00:00:00')
    const [first, second] = listAllScenesLite()
    expect(first).toMatchObject({
      id: a,
      imageCount: 0,
      thumbnail: '',
      thumbnailPath: '',
      kind: 'scene'
    })
    expect(second).toMatchObject({ id: b, imageCount: 0, kind: 'background' })
    // 기존 함수는 그대로 — 썸네일과 그림 수를 계속 싣는다
    expect(listScenes(p)[0].thumbnail).not.toBe('')
    expect(listScenes(p)[0].imageCount).toBe(2)
  })

  it('sortOrder = DB 의 sort_order 그대로 (목록 위치가 아니다) — 가운데 씬을 지워도 뒤 씬 값은 그대로', () => {
    const p = preset('p', 1)
    const a = scene(p, 'a', 1)
    const b = scene(p, 'b', 2)
    const c = scene(p, 'c', 3)
    const d = scene(p, 'd', 7) // 간격이 있어도 그대로
    expect(listAllScenesLite().map((s) => [s.id, s.sortOrder])).toEqual([
      [a, 1],
      [b, 2],
      [c, 3],
      [d, 7]
    ])
    db.prepare("UPDATE gen_scenes SET deleted_at = datetime('now') WHERE id = ?").run(b)
    expect(listAllScenesLite().map((s) => [s.id, s.sortOrder])).toEqual([
      [a, 1],
      [c, 3],
      [d, 7]
    ])
  })

  it('스냅샷에는 그 sort_order 가 씬의 sortOrder 로 실리고, 지운 씬 뒤의 씬들은 한 글자도 달라지지 않는다', () => {
    const p = preset('p', 1)
    scene(p, 'a', 1)
    const b = scene(p, 'b', 2)
    const c = scene(p, 'c', 3)
    const d = scene(p, 'd', 4)
    const lite = (snap: ReturnType<typeof buildSnapshot>): string[] =>
      snap.scenes[0].scenes.map((s) => JSON.stringify(s))
    const before = buildSnapshot(readSnapshotSource())
    db.prepare("UPDATE gen_scenes SET deleted_at = datetime('now') WHERE id = ?").run(b)
    const after = buildSnapshot(readSnapshotSource())
    expect(after.scenes[0].scenes.map((s) => [s.id, s.sortOrder])).toEqual([
      [expect.any(Number), 1],
      [c, 3],
      [d, 4]
    ])
    // 지운 씬(b) 하나만 빠지고 나머지 항목은 그대로 — 클라우드가 다시 쓰는 행이 없다
    const keep = (snap: ReturnType<typeof buildSnapshot>): string[] =>
      lite(snap).filter((_, i) => snap.scenes[0].scenes[i].id !== b)
    expect(keep(after)).toEqual(keep(before))
  })
})

describe('listSceneImageCounts', () => {
  it('살아 있는 씬마다 지우지 않은 그림 수 (그림이 없는 씬은 0, 휴지통 씬·프리셋은 뺀다)', () => {
    const p = preset('p', 1)
    const trashed = preset('버림', 2, 'scene', '2026-01-01 00:00:00')
    const a = scene(p, 'a', 1)
    const empty = scene(p, 'empty', 2)
    const gone = scene(p, 'gone', 3, '2026-01-01 00:00:00')
    const inTrashedPreset = scene(trashed, 't', 1)
    image(a)
    image(a, null, Buffer.from('thumb'))
    image(a, '2026-01-01 00:00:00') // 지운 그림은 세지 않는다
    image(gone)
    image(inTrashedPreset)
    image(null) // 씬이 없는 그림
    expect(listSceneImageCounts()).toEqual({ [String(a)]: 2, [String(empty)]: 0 })
  })

  it('씬이 하나도 없으면 빈 표', () => {
    expect(listSceneImageCounts()).toEqual({})
  })
})

describe('isSceneLive', () => {
  it('씬도 프리셋도 휴지통 밖일 때만 참 (없는 씬은 거짓)', () => {
    const p = preset('p', 1)
    const trashed = preset('버림', 2, 'scene', '2026-01-01 00:00:00')
    const live = scene(p, 'live', 1)
    const gone = scene(p, 'gone', 2, '2026-01-01 00:00:00')
    const inTrashedPreset = scene(trashed, 't', 1)
    expect(isSceneLive(live)).toBe(true)
    expect(isSceneLive(gone)).toBe(false)
    expect(isSceneLive(inTrashedPreset)).toBe(false)
    expect(isSceneLive(99999)).toBe(false)
  })
})

describe('readSnapshotSource', () => {
  it('캐릭터·폴더·복장·조각·프리셋·설정을 읽는다 (휴지통 캐릭터는 뺀다)', () => {
    const p = preset('기본', 1)
    scene(p, '씬', 1)
    const folder = run("INSERT INTO character_folders (name, sort_order) VALUES ('폴더', 1)")
    run(
      `INSERT INTO character_prompts (name, prompt, negative_prompt, enabled, folder_id, role, sort_order, thumbnail)
       VALUES ('가', '1girl', 'x', 1, ?, 'source', 1, X'0102')`,
      folder
    )
    run(
      `INSERT INTO character_prompts (name, prompt, enabled, sort_order, deleted_at)
       VALUES ('버림', 'y', 1, 2, '2026-01-01 00:00:00')`
    )
    run("INSERT INTO outfits (name, pieces, sort_order) VALUES ('교복', '[]', 1)")
    settings.map = { main_params: '{"prompt":"m"}', prompt_split_enabled: '1', nai_tier: 'opus' }

    const src = readSnapshotSource()
    expect(src.presets.map((x) => x.name)).toEqual(['기본'])
    expect(src.scenes.map((s) => s.name)).toEqual(['씬'])
    expect(src.characters).toEqual([
      {
        id: expect.any(Number),
        name: '가',
        prompt: '1girl',
        negativePrompt: 'x',
        enabled: true,
        folderId: folder,
        role: 'source',
        outfitId: null
      }
    ])
    // 썸네일 BLOB 은 읽지도 싣지도 않는다
    expect(JSON.stringify(src.characters)).not.toContain('thumbnail')
    expect(src.charFolders).toEqual([{ id: folder, name: '폴더', parentId: null }])
    expect(src.outfits.map((o) => o.name)).toContain('교복') // 기본 복장은 마이그레이션이 넣어 둔다
    expect(src.mainParamsRaw).toBe('{"prompt":"m"}')
    expect(src.promptSplit).toBe(true)
    expect(src.naiTier).toBe('opus')

    const snap = buildSnapshot(src)
    expect(snap.library.main.promptSplit).toBe(true)
    expect(snap.library.characters).toHaveLength(1)
  })

  it('분할 설정이 없으면 꺼짐, 등급이 없으면 null', () => {
    const src = readSnapshotSource()
    expect(src.promptSplit).toBe(false)
    expect(src.naiTier).toBeNull()
    expect(src.mainParamsRaw).toBeNull()
  })
})

describe('조각 표 — fragmentSource 와 같은 규칙', () => {
  it('buildFragmentsByPath 의 모든 키가 fragmentSource.getLines 와 같은 줄 목록을 준다', () => {
    const folder = run("INSERT INTO fragment_folders (name, sort_order) VALUES ('의상', 1)")
    run(
      "INSERT INTO fragments (name, content, folder_id, sort_order) VALUES ('Casual', 't-shirt\n# 주석\n\nhoodie # 꼬리', ?, 1)",
      folder
    )
    run(
      "INSERT INTO fragments (name, content, folder_id, sort_order) VALUES ('Hair', 'long', NULL, 2)"
    )
    run(
      "INSERT INTO fragments (name, content, folder_id, sort_order) VALUES ('빈 조각', '# 전부 주석', NULL, 3)"
    )

    const { folders, items } = listFragments()
    const byPath = buildFragmentsByPath(folders, items)
    const source = fragmentSource()
    expect(Object.keys(byPath).sort()).toEqual(['casual', 'hair', '빈 조각', '의상/casual'].sort())
    for (const [path, lines] of Object.entries(byPath)) {
      expect(source.getLines(path)).toEqual(lines)
    }
    expect(source.getLines('없는조각')).toBeNull()
    expect(byPath['없는조각']).toBeUndefined()
  })
})

describe('그림 DB 도우미 (images.ts)', () => {
  it('listRecent: 지운 그림 제외·최신순·UTC 시각을 ms 로', () => {
    const p = preset('p', 1)
    const s = scene(p, 's', 1)
    run(
      "INSERT INTO images (file_path, kind, seed, payload_json, scene_id, created_at) VALUES ('/a.png', 'scene', 1, '{}', ?, '2026-10-23 03:00:00')",
      s
    )
    run(
      "INSERT INTO images (file_path, kind, seed, payload_json, created_at, deleted_at) VALUES ('/gone.png', 't2i', 2, '{}', '2026-10-23 04:00:00', '2026-10-23 05:00:00')"
    )
    run(
      "INSERT INTO images (file_path, kind, seed, payload_json, created_at) VALUES ('/c.png', 't2i', 3, '{}', '2026-10-23 06:30:00')"
    )
    const rows = listRecent(10)
    expect(rows.map((r) => r.filePath)).toEqual(['/c.png', '/a.png'])
    expect(rows[1]).toMatchObject({ sceneId: s, seed: 1, kind: 'scene' })
    expect(rows[1].createdAt).toBe(Date.UTC(2026, 9, 23, 3, 0, 0))
    expect(listRecent(1)).toHaveLength(1)
    expect(sqliteUtcToMs('2026-01-01 00:00:00')).toBe(Date.UTC(2026, 0, 1))
  })

  it('findLiveScene: 휴지통 씬·휴지통 프리셋의 씬·없는 씬은 null', () => {
    const live = preset('살아있음', 1)
    const dead = preset('죽음', 2, 'scene', '2026-01-01 00:00:00')
    const a = scene(live, '씬A', 1)
    const b = scene(live, '씬B', 2, '2026-01-01 00:00:00')
    const c = scene(dead, '씬C', 1)
    expect(findLiveScene(a)).toEqual({ id: a, name: '씬A', presetId: live })
    expect(findLiveScene(b)).toBeNull()
    expect(findLiveScene(c)).toBeNull()
    expect(findLiveScene(99999)).toBeNull()
    expect(presetIdOfScene(a)).toBe(live)
    expect(presetIdOfScene(99999)).toBeNull()
    expect(presetName(live)).toBe('살아있음')
    expect(presetName(99999)).toBeNull()
  })
})
