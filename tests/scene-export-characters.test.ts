import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations, reconcileSchema } from '../src/main/db/migrations'
import { createPreset, exportScenesJson } from '../src/main/scenes/repo'

/**
 * 씬 JSON 내보내기에 실리는 것 (커스텀).
 * 지운 씬은 빼고, 캐릭터는 씬에 넣었거나 씬 설정(위치·역할·태그)이 걸린 카드만 —
 * 캐릭터 창에서 켜져 있기만 한 카드는 싣지 않는다. 임시 메모리 DB와 합성 데이터로만 확인한다.
 */

let db: DatabaseSync
let dir: string
const state = vi.hoisted(() => ({ save: '', extras: '{}' }))

vi.mock('electron', () => ({
  app: {},
  shell: {},
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
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
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('씬 JSON 내보내기', () => {
  it('지운 씬은 빼고, 씬에 넣은 캐릭터와 그 위치·역할·자리·태그를 싣는다', async () => {
    const presetId = createPreset('p')
    const alive = scene(presetId, 'alive')
    scene(presetId, 'gone', true)
    const added = card('added', false)
    const tagged = card('tagged', false)
    state.extras = JSON.stringify({
      additions: {
        [presetId]: {
          [alive]: {
            characterIds: [added],
            useCoords: true,
            positions: { [added]: { x: 0.3, y: 0.4 } },
            roles: { [added]: 'source' },
            // 씬 캐릭터 목록엔 없지만 이 씬 태그가 걸린 카드
            charTags: { [tagged]: 'smile' },
            slots: [{ x: 0.5, y: 0.5 }],
            slotRoles: { 0: 'target' },
            slotTags: { 0: 'upper body' }
          }
        }
      }
    })
    const r = await exportScenesJson(presetId)
    expect(r).toEqual({ saved: true, scenes: 1, characters: 2 })
    const file = JSON.parse(readFileSync(state.save, 'utf-8'))
    expect(file.scenes.map((s: { name: string }) => s.name)).toEqual(['alive'])
    expect(file.characters.map((c: { name: string }) => c.name).sort()).toEqual(['added', 'tagged'])
    expect(file.scenes[0].setup).toMatchObject({
      characters: [`c${added}`],
      useCoords: true,
      positions: { [`c${added}`]: { x: 0.3, y: 0.4 } },
      roles: { [`c${added}`]: 'source' },
      charTags: { [`c${tagged}`]: 'smile' },
      slots: [{ x: 0.5, y: 0.5 }],
      slotRoles: { 0: 'target' },
      slotTags: { 0: 'upper body' }
    })
  })

  it('캐릭터 창에서 켜져 있기만 한 카드는 싣지 않는다', async () => {
    const presetId = createPreset('p')
    const alive = scene(presetId, 'alive')
    const added = card('added', false)
    card('enabled only', true)
    state.extras = JSON.stringify({
      additions: { [presetId]: { [alive]: { characterIds: [added] } } }
    })
    await exportScenesJson(presetId)
    const file = JSON.parse(readFileSync(state.save, 'utf-8'))
    expect(file.characters.map((c: { name: string }) => c.name)).toEqual(['added'])
    expect(file).not.toHaveProperty('shared')
    expect(JSON.stringify(file)).not.toContain('enabled only')
  })

  it('켜져 있는 카드라도 씬에 넣었으면 싣는다', async () => {
    const presetId = createPreset('p')
    const alive = scene(presetId, 'alive')
    const both = card('enabled and added', true)
    state.extras = JSON.stringify({
      additions: { [presetId]: { [alive]: { characterIds: [both] } } }
    })
    await exportScenesJson(presetId)
    const file = JSON.parse(readFileSync(state.save, 'utf-8'))
    expect(file.characters.map((c: { name: string }) => c.name)).toEqual(['enabled and added'])
    expect(file).not.toHaveProperty('shared')
  })
})
