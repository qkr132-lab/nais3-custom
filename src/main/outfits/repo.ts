import { getDb } from '../db'
import type { Outfit, OutfitPiece } from '../../shared/outfit'

/**
 * 복장 저장소 (커스텀). 조각 목록은 JSON 한 칸에 둔다 — 조각은 복장과 늘 같이 읽고 쓴다.
 */

interface Row {
  id: number
  name: string
  pieces: string
}

/** 저장된 조각을 검사해서 읽는다 — 손상된 조각은 버린다 */
export function normalizePieces(raw: unknown): OutfitPiece[] {
  let v = raw
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return []
    }
  }
  if (!Array.isArray(v)) return []
  const seen = new Set<string>()
  const out: OutfitPiece[] = []
  for (const p of v as Partial<OutfitPiece>[]) {
    if (!p || typeof p.id !== 'string' || !p.id || seen.has(p.id)) continue
    seen.add(p.id)
    out.push({
      id: p.id,
      name: typeof p.name === 'string' ? p.name : '',
      tags: typeof p.tags === 'string' ? p.tags : '',
      on: p.on !== false
    })
  }
  return out
}

const toOutfit = (r: Row): Outfit => ({ id: r.id, name: r.name, pieces: normalizePieces(r.pieces) })

export function listOutfits(): Outfit[] {
  return (
    getDb().prepare('SELECT id, name, pieces FROM outfits ORDER BY sort_order, id').all() as Row[]
  ).map(toOutfit)
}

export function getOutfit(id: number): Outfit | null {
  const r = getDb().prepare('SELECT id, name, pieces FROM outfits WHERE id = ?').get(id) as
    | Row
    | undefined
  return r ? toOutfit(r) : null
}

export function createOutfit(name: string, pieces: OutfitPiece[] = []): number {
  const db = getDb()
  const max = (db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM outfits').get() as { m: number }).m
  return Number(
    db
      .prepare('INSERT INTO outfits (name, pieces, sort_order) VALUES (?, ?, ?)')
      .run(name.trim() || '새 복장', JSON.stringify(normalizePieces(pieces)), max + 1).lastInsertRowid
  )
}

export function updateOutfit(id: number, patch: { name?: string; pieces?: OutfitPiece[] }): void {
  const sets: string[] = []
  const values: unknown[] = []
  if (patch.name !== undefined) {
    sets.push('name = ?')
    values.push(patch.name.trim() || '새 복장')
  }
  if (patch.pieces !== undefined) {
    sets.push('pieces = ?')
    values.push(JSON.stringify(normalizePieces(patch.pieces)))
  }
  if (!sets.length) return
  sets.push("updated_at = datetime('now')")
  getDb()
    .prepare(`UPDATE outfits SET ${sets.join(', ')} WHERE id = ?`)
    .run(...(values as never[]), id)
}

/**
 * 복장을 지운다. 이 복장을 기본으로 입던 카드는 기본 복장이 없어진다 —
 * 그 카드는 이제 옷 없이 카드 태그만으로 나가므로, 지우기 전에 확인은 화면이 받는다.
 */
export function deleteOutfit(id: number): void {
  const db = getDb()
  db.transaction(() => {
    db.prepare('UPDATE character_prompts SET outfit_id = NULL WHERE outfit_id = ?').run(id)
    db.prepare('DELETE FROM outfits WHERE id = ?').run(id)
  })()
}

/**
 * 가져오기용 — 이름과 조각이 똑같은 복장이 있으면 그걸 쓰고, 없으면 새로 만든다.
 * 같은 파일을 두 번 가져와도 복장이 불어나지 않게.
 */
export function findOrCreateOutfit(name: string, pieces: unknown): number {
  const clean = normalizePieces(pieces)
  const label = name.trim() || '새 복장'
  const same = getDb()
    .prepare('SELECT id FROM outfits WHERE name = ? AND pieces = ?')
    .get(label, JSON.stringify(clean)) as { id: number } | undefined
  return same?.id ?? createOutfit(label, clean)
}

/** 여러 복장을 한 번에 — 파일 안 uid → 이 PC의 복장 id */
export function importOutfits(list: unknown): Map<string, number> {
  const map = new Map<string, number>()
  if (!Array.isArray(list)) return map
  for (const o of list as { uid?: unknown; name?: unknown; pieces?: unknown }[]) {
    if (!o || typeof o.uid !== 'string') continue
    map.set(o.uid, findOrCreateOutfit(typeof o.name === 'string' ? o.name : '', o.pieces))
  }
  return map
}

/** 파일에 실을 복장 목록 — 실제로 있는 것만 */
export function exportOutfits(ids: Iterable<number>): { uid: string; name: string; pieces: OutfitPiece[] }[] {
  const out: { uid: string; name: string; pieces: OutfitPiece[] }[] = []
  for (const id of new Set(ids)) {
    const o = getOutfit(id)
    if (o) out.push({ uid: `o${o.id}`, name: o.name, pieces: o.pieces })
  }
  return out
}

export function duplicateOutfit(id: number): number | null {
  const o = getOutfit(id)
  return o ? createOutfit(`${o.name} 복사`, o.pieces) : null
}

/** 이 복장을 기본으로 입는 카드 수 — 지우기 전 경고용 */
export function outfitUsage(id: number): number {
  return (
    getDb()
      .prepare(
        'SELECT COUNT(*) AS n FROM character_prompts WHERE outfit_id = ? AND deleted_at IS NULL'
      )
      .get(id) as { n: number }
  ).n
}
