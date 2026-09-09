import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFolder } from '../src/main/characters/repo'

let db: DatabaseSync
vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {} }))
vi.mock('sharp', () => ({ default: vi.fn() }))
vi.mock('../src/main/db', () => ({
  getDb: () => ({
    prepare: (sql: string) => db.prepare(sql),
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

describe('character folder creation persists its parent atomically', () => {
  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE character_folders (
      id INTEGER PRIMARY KEY, name TEXT, sort_order INTEGER DEFAULT 0,
      parent_id INTEGER, collapsed INTEGER DEFAULT 0, deleted_at TEXT
    )`)
  })
  afterEach(() => db.close())

  it('keeps existing callers creating root folders', () => {
    const id = createFolder('Root')
    expect(
      db.prepare('SELECT parent_id FROM character_folders WHERE id = ?').get(id)?.parent_id
    ).toBeNull()
  })
  it('creates a child in a collapsed parent and persists its expanded state', () => {
    const parentId = createFolder('Root')
    db.prepare('UPDATE character_folders SET collapsed = 1 WHERE id = ?').run(parentId)
    const childId = createFolder('Child', parentId)
    expect(
      db.prepare('SELECT parent_id FROM character_folders WHERE id = ?').get(childId)?.parent_id
    ).toBe(parentId)
    expect(
      db.prepare('SELECT collapsed FROM character_folders WHERE id = ?').get(parentId)?.collapsed
    ).toBe(0)
  })
  it.each(['missing', 'deleted'])('does not leave a root folder when the parent is %s', (state) => {
    const parentId = state === 'missing' ? 999 : createFolder('Deleted')
    if (state === 'deleted')
      db.prepare('UPDATE character_folders SET deleted_at = ? WHERE id = ?').run(
        '2026-01-01',
        parentId
      )
    const before = db.prepare('SELECT COUNT(*) AS n FROM character_folders').get()?.n
    expect(() => createFolder('Child', parentId)).toThrow('상위 폴더')
    expect(db.prepare('SELECT COUNT(*) AS n FROM character_folders').get()?.n).toBe(before)
  })
  it('rejects a third level without creating a misplaced folder', () => {
    const childId = createFolder('Child', createFolder('Root'))
    expect(() => createFolder('Grandchild', childId)).toThrow('2단계')
    expect(db.prepare('SELECT COUNT(*) AS n FROM character_folders').get()?.n).toBe(2)
  })
})
