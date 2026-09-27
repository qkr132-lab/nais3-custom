import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createOutfit,
  duplicateOutfit,
  exportOutfits,
  getOutfit,
  importOutfits,
  normalizePieces,
  updateOutfit
} from '../src/main/outfits/repo'
import type { OutfitPiece } from '../src/shared/outfit'

let db: DatabaseSync
vi.mock('../src/main/db', () => ({
  getDb: () => ({ prepare: (sql: string) => db.prepare(sql) })
}))

const pieces: OutfitPiece[] = [
  { id: 'skirt', name: '치마', tags: 'pleated skirt', on: true },
  { id: 'lift', name: '젖히기', tags: 'skirt lift, panties aside', on: false, when: 'nsfw-lower' },
  { id: 'open', name: '풀기', tags: 'open jacket, bra lift', on: false, when: 'nsfw-chest' },
  { id: 'zip', name: '지퍼', tags: 'unzipped', on: false }
]

describe('nsfw 조각 조건이 저장·복제·내보내기를 거쳐도 남는다', () => {
  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE outfits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      pieces TEXT NOT NULL DEFAULT '[]',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      negative TEXT NOT NULL DEFAULT ''
    )`)
  })
  afterEach(() => db.close())

  it('저장하고 고쳐도 조건이 그대로', () => {
    const id = createOutfit('치마 교복', pieces)
    expect(getOutfit(id)?.pieces).toEqual(pieces)
    updateOutfit(id, { pieces: [...pieces].reverse() })
    expect(getOutfit(id)?.pieces).toEqual([...pieces].reverse())
  })

  it('복제한 복장도 같은 조건', () => {
    const id = createOutfit('치마 교복', pieces)
    const copy = duplicateOutfit(id)
    expect(copy).not.toBeNull()
    expect(getOutfit(copy!)?.pieces).toEqual(pieces)
  })

  it('파일로 내보내고 다시 가져와도 조건이 남고, 같은 파일을 두 번 가져와도 늘지 않는다', () => {
    const id = createOutfit('치마 교복', pieces, 'pants')
    const file = JSON.parse(JSON.stringify(exportOutfits([id])))
    expect(file[0].pieces).toEqual(pieces)
    db.exec('DELETE FROM outfits')
    const first = importOutfits(file).get(`o${id}`)
    expect(getOutfit(first!)?.pieces).toEqual(pieces)
    expect(importOutfits(file).get(`o${id}`)).toBe(first)
  })

  it('조건이 없는 옛 조각은 전과 같고, 켜진 조각·모르는 값의 조건은 버린다', () => {
    expect(
      normalizePieces([
        { id: 'a', name: '옛 상태', tags: 'unzipped', on: false },
        { id: 'b', name: '기본', tags: 'blazer', on: true, when: 'nsfw-lower' },
        { id: 'c', name: '이상한 값', tags: 'x', on: false, when: 'nsfw-feet' }
      ])
    ).toStrictEqual([
      { id: 'a', name: '옛 상태', tags: 'unzipped', on: false },
      { id: 'b', name: '기본', tags: 'blazer', on: true },
      { id: 'c', name: '이상한 값', tags: 'x', on: false }
    ])
  })
})
