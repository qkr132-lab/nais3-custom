import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations, reconcileSchema } from '../src/main/db/migrations'
import { saveGeneratedImage } from '../src/main/images/storage'
import { createPreset, createScene } from '../src/main/scenes/repo'
import { naiPng } from './helpers/synthetic-images'

/**
 * 고속 모드 — 두 작업자가 거의 동시에 저장해도 파일 이름이 겹쳐 서로 덮어쓰지 않는다.
 * 임시 폴더 + 메모리 DB + 합성 이미지로만 확인한다 (NAI 호출 없음).
 */

let db: DatabaseSync
let root = ''
let sceneId = 0
const settings = new Map<string, string>()

vi.mock('electron', () => ({
  app: { getPath: (name: string) => join(root, name) },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  dialog: { showSaveDialog: vi.fn() },
  shell: { openPath: vi.fn(async () => '') }
}))
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

const SENT = JSON.stringify({
  input: '1girl, solo',
  model: 'nai-diffusion-5-full',
  parameters: { seed: 42, steps: 28, negative_prompt: 'lowres' }
})

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  for (const migrate of migrations) migrate(db as never)
  reconcileSchema(db as never)
  root = mkdtempSync(join(tmpdir(), 'nais3-turbo-save-'))
  settings.clear()
  settings.set('save_dir', join(root, 'out'))
  settings.set('scene_save_dir', join(root, 'scene'))
  settings.set('date_folders', '0')
  sceneId = createScene(createPreset('기본'), '교실')
})
afterEach(() => {
  vi.useRealTimers()
  db.close()
  rmSync(root, { recursive: true, force: true })
})

describe('동시에 저장해도 이름이 겹치지 않는다', () => {
  it('같은 씬에 네 장을 한꺼번에 저장하면 씬 이름_1 ~ 씬 이름_4 로 나뉜다', async () => {
    const png = await naiPng()
    const saved = await Promise.all(
      [1, 2, 3, 4].map((seed) =>
        saveGeneratedImage({
          png,
          sentPayload: SENT,
          seed,
          kind: 'scene',
          sceneId,
          sceneName: '교실',
          scenePresetName: '기본'
        })
      )
    )
    const names = saved.map((s) => basename(s.filePath)).sort()
    expect(names).toEqual(['교실_1.png', '교실_2.png', '교실_3.png', '교실_4.png'])
    expect(saved.every((s) => existsSync(s.filePath))).toBe(true)
    expect(new Set(saved.map((s) => s.id)).size).toBe(4)
  })

  it('메타데이터 저장을 꺼 파일 처리에 대기가 끼어도 씬 번호는 겹치지 않는다', async () => {
    settings.set('save_metadata', '0')
    const png = await naiPng()
    const saved = await Promise.all(
      [1, 2, 3].map((seed) =>
        saveGeneratedImage({
          png,
          sentPayload: SENT,
          seed,
          kind: 'scene',
          sceneId,
          sceneName: '교실',
          scenePresetName: '기본'
        })
      )
    )
    expect(new Set(saved.map((s) => s.filePath)).size).toBe(3)
  })

  it('메인 탭: 같은 초에 같은 시드로 두 장이 끝나도 서로 덮어쓰지 않는다', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-29T03:00:00Z'))
    const png = await naiPng()
    const saved = await Promise.all(
      [0, 1].map(() => saveGeneratedImage({ png, sentPayload: SENT, seed: 42, kind: 't2i' }))
    )
    const names = saved.map((s) => basename(s.filePath)).sort()
    expect(names).toEqual([
      'NAIS3_2026-10-29T03-00-00_42.png',
      'NAIS3_2026-10-29T03-00-00_42_2.png'
    ])
    expect(saved.every((s) => existsSync(s.filePath))).toBe(true)
  })

  it('시드가 다르면 예전과 같은 이름이다 (겹칠 때만 번호가 붙는다)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-29T03:00:00Z'))
    const png = await naiPng()
    const saved = await Promise.all(
      [1, 2].map((seed) => saveGeneratedImage({ png, sentPayload: SENT, seed, kind: 't2i' }))
    )
    expect(saved.map((s) => basename(s.filePath)).sort()).toEqual([
      'NAIS3_2026-10-29T03-00-00_1.png',
      'NAIS3_2026-10-29T03-00-00_2.png'
    ])
  })
})
