import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations, reconcileSchema } from '../src/main/db/migrations'
import { createPreset, exportScenesJson, importScenesJson } from '../src/main/scenes/repo'

/**
 * 씬 JSON 내보내기에 실리는 것 (커스텀).
 * 지운 씬은 빼고, 캐릭터는 씬 캐릭터 목록·자리에 넣은 카드만 — 캐릭터 창에서 켜져 있기만 하거나
 * 목록 밖에 예전 위치·역할·태그 기록만 남은 카드는 싣지 않는다. 가져올 때는 캐릭터 탭에 똑같은 카드가 있으면 그걸 건다. 임시 메모리 DB와 합성 데이터로만 확인한다.
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
  it('지운 씬은 빼고, 씬에 넣은 캐릭터와 그 위치·역할·자리·태그를 싣는다 — 목록 밖 기록은 뺀다', async () => {
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
            roles: { [added]: 'source' },
            // 씬 캐릭터 목록엔 없는데 예전 태그·위치 기록만 남은 카드
            charTags: { [added]: 'blush', [tagged]: 'smile' },
            positions: { [added]: { x: 0.3, y: 0.4 }, [tagged]: { x: 0.9, y: 0.9 } },
            slots: [{ x: 0.5, y: 0.5 }],
            slotRoles: { 0: 'target' },
            slotTags: { 0: 'upper body' }
          }
        }
      }
    })
    const r = await exportScenesJson(presetId)
    expect(r).toEqual({ saved: true, scenes: 1, characters: 1 })
    const file = JSON.parse(readFileSync(state.save, 'utf-8'))
    expect(file.scenes.map((s: { name: string }) => s.name)).toEqual(['alive'])
    expect(file.characters.map((c: { name: string }) => c.name)).toEqual(['added'])
    expect(file.scenes[0].setup).toMatchObject({
      characters: [`c${added}`],
      useCoords: true,
      positions: { [`c${added}`]: { x: 0.3, y: 0.4 } },
      roles: { [`c${added}`]: 'source' },
      charTags: { [`c${added}`]: 'blush' },
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

  it('다른 씬에 실린 카드라도 이 씬 목록 밖이면 그 기록은 이 씬에 싣지 않는다', async () => {
    const presetId = createPreset('p')
    const a = scene(presetId, 'a')
    const b = scene(presetId, 'b')
    const man = card('man', false)
    state.extras = JSON.stringify({
      additions: {
        [presetId]: {
          [a]: { characterIds: [man], roles: { [man]: 'source' } },
          // b에는 man이 없는데 예전 역할·위치가 남아 있다
          [b]: { characterIds: [], useCoords: true, roles: { [man]: 'source' }, positions: { [man]: { x: 0.1, y: 0.1 } } }
        }
      }
    })
    await exportScenesJson(presetId)
    const file = JSON.parse(readFileSync(state.save, 'utf-8'))
    const [sa, sb] = file.scenes
    expect(sa.setup.roles).toEqual({ [`c${man}`]: 'source' })
    expect(sb.setup).toEqual({ characters: [], useCoords: true })
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
