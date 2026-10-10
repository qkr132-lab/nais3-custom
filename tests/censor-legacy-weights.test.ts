import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations, reconcileSchema } from '../src/main/db/migrations'
import {
  bulkCopyScenes,
  createPreset,
  duplicatePreset,
  duplicateScene,
  exportScenesJson,
  getScene,
  importScenesJson,
  listScenes,
  setSceneCensors,
  updateScene
} from '../src/main/scenes/repo'

/**
 * 예전 검열 가중치(censor_weights) 데이터 (커스텀).
 * 가중치 기능은 없어졌지만 열과 옛 파일은 남아 있다 — 읽어도 깨지지 않고, 쓰이지도 않아야 한다.
 * 임시 메모리 DB에 실제 마이그레이션을 돌려 합성 데이터로만 확인한다.
 */

let db: DatabaseSync
let dir: string
const files = vi.hoisted(() => ({ open: '', save: '' }))

vi.mock('electron', () => ({
  app: {},
  shell: {},
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  dialog: {
    showOpenDialog: async () => ({ canceled: false, filePaths: [files.open] }),
    showSaveDialog: async () => ({ canceled: false, filePath: files.save })
  }
}))
vi.mock('sharp', () => ({ default: vi.fn() }))
vi.mock('../src/main/trash', () => ({ trashFile: vi.fn(async () => {}) }))
vi.mock('../src/main/db/settings', () => ({ getSetting: () => null }))
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

const LEGACY_WEIGHTS = '{"penis":1.2,"vulva":0.7,"suppress":0.4}'
const weightsOf = (id: number): string =>
  (
    db.prepare('SELECT censor_weights FROM gen_scenes WHERE id = ?').get(id) as {
      censor_weights: string
    }
  ).censor_weights

/** 가중치를 저장하던 버전이 남긴 씬 한 줄 */
function legacyScene(presetId: number, name: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO gen_scenes (preset_id, name, prompt, width, height, sort_order, censor_kinds, censor_weights, suppress_anal)
         VALUES (?, ?, 'forest', 832, 1216, 1, '["penis","vulva"]', ?, 1)`
      )
      .run(presetId, name, LEGACY_WEIGHTS).lastInsertRowid
  )
}

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  for (const migrate of migrations) migrate(db as never)
  reconcileSchema(db as never)
  dir = mkdtempSync(join(tmpdir(), 'nais-censor-legacy-'))
  files.open = join(dir, 'in.json')
  files.save = join(dir, 'out.json')
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('예전 검열 가중치 데이터', () => {
  it('저장된 가중치가 있어도 씬은 그대로 읽히고 가중치는 노출되지 않는다', () => {
    const presetId = createPreset('legacy')
    const id = legacyScene(presetId, 'old')
    const scene = getScene(id)!
    expect(scene.censorKinds).toEqual(['penis', 'vulva'])
    expect(scene.suppressAnal).toBe(true)
    expect(scene).not.toHaveProperty('censorWeights')
    expect(listScenes(presetId)[0]).not.toHaveProperty('censorWeights')
  })

  it('검열 설정을 바꾸거나 복제·복사해도 옛 가중치는 읽지도 쓰지도 않는다', () => {
    const presetId = createPreset('legacy')
    const id = legacyScene(presetId, 'old')
    expect(setSceneCensors([id], { anal: true, suppressAnal: false })).toEqual([
      { id, censorKinds: ['penis', 'vulva', 'anal'], censorTagWeights: {}, suppressAnal: false }
    ])
    expect(weightsOf(id)).toBe(LEGACY_WEIGHTS)
    // 옛 화면이 보내던 필드는 무시
    updateScene(id, { censorWeights: { penis: 3 }, name: 'renamed' })
    expect(weightsOf(id)).toBe(LEGACY_WEIGHTS)
    expect(getScene(id)?.name).toBe('renamed')

    const copy = getScene(duplicateScene(id))!
    expect(copy.censorKinds).toEqual(['penis', 'vulva', 'anal'])
    expect(weightsOf(copy.id)).toBe('{}')
    const otherPreset = createPreset('other')
    const [pair] = bulkCopyScenes([id], otherPreset)
    expect(getScene(pair.to)?.censorKinds).toEqual(['penis', 'vulva', 'anal'])
    const { id: presetCopy } = duplicatePreset(presetId)
    expect(listScenes(presetCopy).map((s) => s.censorKinds)).toEqual([
      ['penis', 'vulva', 'anal'],
      ['penis', 'vulva', 'anal']
    ])
  })

  it('내보내기에는 가중치를 싣지 않는다', async () => {
    const presetId = createPreset('legacy')
    legacyScene(presetId, 'old')
    expect((await exportScenesJson(presetId)).saved).toBe(true)
    const [scene] = JSON.parse(readFileSync(files.save, 'utf-8')).scenes
    expect(scene.censorKinds).toEqual(['penis', 'vulva'])
    expect(scene.suppressAnal).toBe(true)
    expect(scene).not.toHaveProperty('censorWeights')
  })

  it('가중치가 든 옛 씬 파일(v1·v2)도 그대로 가져온다', async () => {
    const presetId = createPreset('import')
    const censorWeights = { penis: 1.2, suppress: 0.4 }
    writeFileSync(
      files.open,
      JSON.stringify({
        scenes: [{ name: 'v1', prompt: 'sky', censorKinds: ['anal'], censorWeights }]
      })
    )
    expect((await importScenesJson(presetId)).count).toBe(1)
    writeFileSync(
      files.open,
      JSON.stringify({
        version: 2,
        characters: [],
        scenes: [
          {
            name: 'v2',
            prompt: 'sea',
            censorKinds: ['testicles'],
            censorWeights,
            suppressAnal: true
          }
        ]
      })
    )
    await importScenesJson(presetId)
    const scenes = listScenes(presetId)
    expect(scenes.map((s) => [s.name, s.censorKinds, s.suppressAnal])).toEqual([
      ['v1', ['anal'], false],
      ['v2', ['testicles'], true]
    ])
    for (const s of scenes) expect(weightsOf(s.id)).toBe('{}')
  })
})
