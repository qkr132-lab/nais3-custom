import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations, reconcileSchema } from '../src/main/db/migrations'
import { createPreset, exportScenesJson, importScenesJson } from '../src/main/scenes/repo'

/**
 * 씬 JSON 내보내기에 실리는 것 (커스텀).
 * 지운 씬은 빼고, 자리(위치·역할·자리 태그)와 하는쪽/당하는쪽 위치·행위 태그만 싣는다 — 캐릭터 카드는 싣지 않는다.
 * 예전 파일을 가져올 때는 캐릭터 탭에 똑같은 카드가 있으면 그걸 건다. 임시 메모리 DB와 합성 데이터로만 확인한다.
 */

let db: DatabaseSync
let dir: string
const state = vi.hoisted(() => ({ save: '', open: '', extras: '{}' }))

vi.mock('electron', () => ({
  app: {},
  shell: {},
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  dialog: {
    showOpenDialog: async () => ({ canceled: !state.open, filePaths: [state.open] }),
    showSaveDialog: async () => ({ canceled: false, filePath: state.save })
  }
}))
vi.mock('sharp', () => ({ default: vi.fn() }))
vi.mock('../src/main/trash', () => ({ trashFile: vi.fn(async () => {}) }))
vi.mock('../src/main/db/settings', () => ({
  getSetting: (key: string) => (key === 'scene_extras' ? state.extras : null)
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

const scene = (presetId: number, name: string, deleted = false): number =>
  Number(
    db
      .prepare(
        `INSERT INTO gen_scenes (preset_id, name, prompt, width, height, sort_order, deleted_at)
         VALUES (?, ?, 'forest', 832, 1216, 1, ?)`
      )
      .run(presetId, name, deleted ? '2026-01-01 00:00:00' : null).lastInsertRowid
  )

const card = (name: string, enabled: boolean): number =>
  Number(
    db
      .prepare('INSERT INTO character_prompts (name, prompt, enabled) VALUES (?, ?, ?)')
      .run(name, `${name} tags`, enabled ? 1 : 0).lastInsertRowid
  )

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  for (const migrate of migrations) migrate(db as never)
  reconcileSchema(db as never)
  dir = mkdtempSync(join(tmpdir(), 'nais-scene-export-'))
  state.save = join(dir, 'out.json')
  state.extras = '{}'
  state.open = ''
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('씬 JSON 내보내기', () => {
  it('지운 씬은 빼고, 자리(위치·역할·자리 태그)와 하는쪽/당하는쪽 위치·태그만 싣는다', async () => {
    const presetId = createPreset('p')
    const alive = scene(presetId, 'alive')
    scene(presetId, 'gone', true)
    db.prepare(
      `UPDATE gen_scenes SET source_tags = 'grabbing', target_tags = 'crying',
       source_pos = '{"x":0.2,"y":0.5}', target_pos = '{"x":0.8,"y":0.5}' WHERE id = ?`
    ).run(alive)
    const added = card('added', false)
    const tagged = card('tagged', true)
    state.extras = JSON.stringify({
      additions: {
        [presetId]: {
          [alive]: {
            characterIds: [added],
            useCoords: true,
            positions: { [added]: { x: 0.3, y: 0.4 } },
            roles: { [added]: 'source' },
            charTags: { [added]: 'blush', [tagged]: 'smile' },
            partnerTags: { [added]: 'tears' },
            slots: [{ x: 0.5, y: 0.5 }, { x: 0.1, y: 0.9 }],
            slotChars: { 0: added },
            slotRoles: { 0: 'target', 1: 'source' },
            slotTags: { 0: 'upper body', 1: 'standing' }
          }
        }
      }
    })
    const r = await exportScenesJson(presetId)
    expect(r).toEqual({ saved: true, scenes: 1 })
    const file = JSON.parse(readFileSync(state.save, 'utf-8'))
    expect(file.characters).toEqual([])
    expect(file).not.toHaveProperty('outfits')
    expect(file.scenes.map((s: { name: string }) => s.name)).toEqual(['alive'])
    const [s] = file.scenes
    expect(s).toMatchObject({
      sourceTags: 'grabbing',
      targetTags: 'crying',
      sourcePos: { x: 0.2, y: 0.5 },
      targetPos: { x: 0.8, y: 0.5 }
    })
    expect(s.setup).toEqual({
      characters: [],
      useCoords: true,
      slots: [{ x: 0.5, y: 0.5 }, { x: 0.1, y: 0.9 }],
      slotRoles: { 0: 'target', 1: 'source' },
      slotTags: { 0: 'upper body', 1: 'standing' }
    })
    expect(JSON.stringify(file)).not.toMatch(/added|tagged|blush|smile|tears/)
  })

  it('자리도 위치 적용도 없는 씬은 구성을 싣지 않는다', async () => {
    const presetId = createPreset('p')
    const alive = scene(presetId, 'alive')
    const added = card('added', true)
    state.extras = JSON.stringify({
      additions: { [presetId]: { [alive]: { characterIds: [added], charTags: { [added]: 'x' } } } }
    })
    await exportScenesJson(presetId)
    const file = JSON.parse(readFileSync(state.save, 'utf-8'))
    expect(file.scenes[0]).not.toHaveProperty('setup')
    expect(file.characters).toEqual([])
  })
})

describe('씬 JSON 가져오기 — 캐릭터 탭에 있는 카드', () => {
  const bundle = (characters: object[], use: string[]): string =>
    JSON.stringify({
      version: 2,
      characterFolder: '가져온 폴더',
      characters,
      scenes: [{ name: 's', prompt: 'x', setup: { characters: use } }]
    })
  const cardCount = (): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM character_prompts').get() as { n: number }).n
  const folders = (): string[] =>
    (db.prepare('SELECT name FROM character_folders').all() as { name: string }[]).map((f) => f.name)

  it('이름·태그가 똑같은 카드가 다른 폴더에 있으면 새로 만들지 않고 그 카드를 씬에 건다', async () => {
    const presetId = createPreset('p')
    const mine = card('알몸남자', false)
    db.prepare('UPDATE character_prompts SET prompt = ? WHERE id = ?').run('1boy, nude', mine)
    state.open = join(dir, 'in.json')
    writeFileSync(
      state.open,
      bundle([{ uid: 'c9', name: '알몸남자', prompt: ' 1boy, nude ', negativePrompt: '' }], ['c9'])
    )
    const before = cardCount()
    const r = await importScenesJson(presetId)
    expect(cardCount()).toBe(before)
    expect(r.additions[0].setup.characterIds).toEqual([mine])
    // 새 카드가 없으면 빈 폴더도 만들지 않는다
    expect(folders()).not.toContain('가져온 폴더')
  })

  it('이름이나 태그가 다르면 새로 만든다', async () => {
    const presetId = createPreset('p')
    const mine = card('알몸남자', false)
    db.prepare('UPDATE character_prompts SET prompt = ? WHERE id = ?').run('1boy, nude', mine)
    state.open = join(dir, 'in.json')
    writeFileSync(
      state.open,
      bundle([{ uid: 'c9', name: '알몸남자', prompt: '1boy, nude, muscular', negativePrompt: '' }], ['c9'])
    )
    const before = cardCount()
    const r = await importScenesJson(presetId)
    expect(cardCount()).toBe(before + 1)
    expect(r.additions[0].setup.characterIds).not.toEqual([mine])
    expect(folders()).toContain('가져온 폴더')
  })
})
