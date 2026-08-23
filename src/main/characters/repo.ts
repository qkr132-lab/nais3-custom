import { BrowserWindow, dialog } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import sharp from 'sharp'
import type {
  CharacterCard,
  CharacterCardPatch,
  CharacterFolder,
  CharacterOrderEntry,
  TrashedCharacter
} from '../../shared/types'
import { getDb } from '../db'

interface CharRow {
  id: number
  name: string
  prompt: string
  negative_prompt: string
  thumbnail: Buffer | null
  enabled: number
  center_x: number
  center_y: number
  folder_id: number | null
  char_ref_id: number | null
  role: string | null
}

export function listCharacters(): { folders: CharacterFolder[]; items: CharacterCard[] } {
  const db = getDb()
  const folders = (
    db
      .prepare(
        'SELECT id, name, collapsed, color, parent_id FROM character_folders ORDER BY sort_order'
      )
      .all() as {
      id: number
      name: string
      collapsed: number
      color: string | null
      parent_id: number | null
    }[]
  ).map((f) => ({
    id: f.id,
    name: f.name,
    collapsed: f.collapsed === 1,
    color: f.color,
    parentId: f.parent_id
  }))

  const items = (
    db
      .prepare(
        `SELECT id, name, prompt, negative_prompt, thumbnail, enabled, center_x, center_y, folder_id, char_ref_id, role
         FROM character_prompts WHERE deleted_at IS NULL ORDER BY sort_order, id`
      )
      .all() as CharRow[]
  ).map((r) => ({
    id: r.id,
    name: r.name,
    prompt: r.prompt,
    negativePrompt: r.negative_prompt,
    thumbnail: r.thumbnail ? r.thumbnail.toString('base64') : '',
    enabled: r.enabled === 1,
    center: { x: r.center_x, y: r.center_y },
    folderId: r.folder_id,
    charRefId: r.char_ref_id,
    role: (r.role === 'source' || r.role === 'target' ? r.role : null) as CharacterCard['role']
  }))

  return { folders, items }
}

export function createCharacter(name: string, folderId: number | null): number {
  const db = getDb()
  const max = db
    .prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM character_prompts')
    .get() as {
    m: number
  }
  return Number(
    db
      .prepare('INSERT INTO character_prompts (name, folder_id, sort_order) VALUES (?, ?, ?)')
      .run(name, folderId, max.m + 1).lastInsertRowid
  )
}

export function updateCharacter(id: number, patch: CharacterCardPatch): void {
  const sets: string[] = []
  const values: unknown[] = []
  if (patch.name !== undefined) {
    sets.push('name = ?')
    values.push(patch.name)
  }
  if (patch.prompt !== undefined) {
    sets.push('prompt = ?')
    values.push(patch.prompt)
  }
  if (patch.negativePrompt !== undefined) {
    sets.push('negative_prompt = ?')
    values.push(patch.negativePrompt)
  }
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?')
    values.push(patch.enabled ? 1 : 0)
  }
  if (patch.center !== undefined) {
    sets.push('center_x = ?', 'center_y = ?')
    values.push(patch.center.x, patch.center.y)
  }
  if (patch.charRefId !== undefined) {
    sets.push('char_ref_id = ?')
    values.push(patch.charRefId)
  }
  if (patch.role !== undefined) {
    sets.push('role = ?')
    values.push(patch.role)
  }
  if (sets.length === 0) return
  sets.push(`updated_at = datetime('now')`)
  getDb()
    .prepare(`UPDATE character_prompts SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values, id)
}

/**
 * 캐릭터 삭제 — 실제로 지우지 않고 유예시간 동안 휴지통에 둔다 (커스텀).
 * 폴더를 통째로 지울 때 안의 카드가 함께 사라지므로 되돌릴 길이 반드시 필요하다.
 */
export function deleteCharacter(id: number): void {
  const db = getDb()
  const folderName = db
    .prepare(
      `SELECT f.name AS name FROM character_prompts c
       LEFT JOIN character_folders f ON f.id = c.folder_id WHERE c.id = ?`
    )
    .get(id) as { name: string | null } | undefined
  db.prepare(
    "UPDATE character_prompts SET deleted_at = datetime('now'), deleted_folder = ?, enabled = 0 WHERE id = ?"
  ).run(folderName?.name ?? null, id)
}

/** 휴지통 목록 — 최근에 지운 것부터 */
export function listTrashedCharacters(): TrashedCharacter[] {
  return (
    getDb()
      .prepare(
        `SELECT id, name, prompt, deleted_at, deleted_folder
         FROM character_prompts WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC`
      )
      .all() as {
      id: number
      name: string
      prompt: string
      deleted_at: string
      deleted_folder: string | null
    }[]
  ).map((r) => ({
    id: r.id,
    name: r.name,
    prompt: r.prompt,
    deletedAt: r.deleted_at,
    folderName: r.deleted_folder
  }))
}

/** 되살리기. 원래 폴더가 이미 없으면 미분류로 돌아온다 (folder_id는 그대로 두되 참조가 끊긴 상태) */
export function restoreCharacters(ids: number[]): void {
  if (!ids.length) return
  const db = getDb()
  const placeholders = ids.map(() => '?').join(',')
  db.transaction(() => {
    // 없어진 폴더를 가리키는 카드는 미분류로
    db.prepare(
      `UPDATE character_prompts SET folder_id = NULL
       WHERE id IN (${placeholders})
         AND folder_id IS NOT NULL
         AND folder_id NOT IN (SELECT id FROM character_folders)`
    ).run(...ids)
    db.prepare(
      `UPDATE character_prompts SET deleted_at = NULL, deleted_folder = NULL WHERE id IN (${placeholders})`
    ).run(...ids)
  })()
}

/** 휴지통에서 영구 삭제 */
export function purgeCharacters(ids: number[]): void {
  if (!ids.length) return
  const placeholders = ids.map(() => '?').join(',')
  getDb()
    .prepare(
      `DELETE FROM character_prompts WHERE id IN (${placeholders}) AND deleted_at IS NOT NULL`
    )
    .run(...ids)
}

/** 보관 기간이 지난 휴지통 카드 정리. 0이면 무제한 보관 */
export function purgeOldTrashedCharacters(days: number): number {
  if (!days || days <= 0) return 0
  const result = getDb()
    .prepare(
      `DELETE FROM character_prompts
       WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now', ?)`
    )
    .run(`-${Math.floor(days)} days`)
  return result.changes
}

/** 카드 복제 — 썸네일 포함, enabled는 꺼서 (실수로 6명 초과 방지) */
export function duplicateCharacter(id: number): number {
  const db = getDb()
  const max = (
    db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM character_prompts').get() as {
      m: number
    }
  ).m
  const info = db
    .prepare(
      `INSERT INTO character_prompts
         (name, prompt, negative_prompt, folder, thumbnail, settings_json, enabled, center_x, center_y, folder_id, role, sort_order)
       SELECT name || ' 복사', prompt, negative_prompt, folder, thumbnail, settings_json, 0, center_x, center_y, folder_id, role, ?
       FROM character_prompts WHERE id = ?`
    )
    .run(max + 1, id)
  return Number(info.lastInsertRowid)
}

/**
 * 리스트 전체 순서 반영. 카드의 폴더 소속은 "직전에 나온 폴더 행"으로 파생된다
 * (첫 폴더 행보다 위의 카드 = 미분류). 트랜잭션으로 원자 적용.
 */
export function reorderCharacters(order: CharacterOrderEntry[]): void {
  const db = getDb()
  const setFolder = db.prepare('UPDATE character_folders SET sort_order = ? WHERE id = ?')
  const setChar = db.prepare(
    'UPDATE character_prompts SET sort_order = ?, folder_id = ? WHERE id = ?'
  )
  db.transaction(() => {
    let currentFolder: number | null = null
    order.forEach((entry, i) => {
      if (entry.type === 'folder') {
        currentFolder = entry.id
        setFolder.run(i, entry.id)
      } else {
        setChar.run(i, currentFolder, entry.id)
      }
    })
  })()
}

export function createFolder(name: string): number {
  const db = getDb()
  const max = db
    .prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM character_folders')
    .get() as {
    m: number
  }
  return Number(
    db
      .prepare('INSERT INTO character_folders (name, sort_order) VALUES (?, ?)')
      .run(name, max.m + 1).lastInsertRowid
  )
}

export function renameFolder(id: number, name: string): void {
  getDb().prepare('UPDATE character_folders SET name = ? WHERE id = ?').run(name, id)
}

export function setFolderCollapsed(id: number, collapsed: boolean): void {
  getDb()
    .prepare('UPDATE character_folders SET collapsed = ? WHERE id = ?')
    .run(collapsed ? 1 : 0, id)
}

export function setFolderColor(id: number, color: string | null): void {
  getDb().prepare('UPDATE character_folders SET color = ? WHERE id = ?').run(color, id)
}

/**
 * 폴더를 다른 폴더 안으로 넣거나(parentId) 밖으로 뺀다(null). 커스텀.
 *
 * 깊이는 2단계까지만 허용한다 — 하위 폴더가 다시 하위를 갖기 시작하면 순서·드래그
 * 규칙이 급격히 복잡해지고, 실사용(분류 한 겹)에 그 이상은 필요하지 않았다.
 * 막는 경우: 자기 자신 / 이미 하위를 가진 폴더를 남의 밑으로 / 하위 폴더 밑으로.
 */
export function setFolderParent(id: number, parentId: number | null): boolean {
  const db = getDb()
  if (parentId === null) {
    db.prepare('UPDATE character_folders SET parent_id = NULL WHERE id = ?').run(id)
    return true
  }
  if (parentId === id) return false

  const parent = db.prepare('SELECT parent_id FROM character_folders WHERE id = ?').get(parentId) as
    | { parent_id: number | null }
    | undefined
  if (!parent) return false
  // 부모가 이미 남의 하위면 3단계가 된다
  if (parent.parent_id !== null) return false
  // 자기 밑에 하위가 있으면 옮길 수 없다 (옮기는 순간 3단계)
  const childCount = (
    db.prepare('SELECT COUNT(*) AS n FROM character_folders WHERE parent_id = ?').get(id) as {
      n: number
    }
  ).n
  if (childCount > 0) return false

  db.prepare('UPDATE character_folders SET parent_id = ? WHERE id = ?').run(parentId, id)
  return true
}

export function deleteFolder(id: number): void {
  const db = getDb()
  db.transaction(() => {
    db.prepare('UPDATE character_prompts SET folder_id = NULL WHERE folder_id = ?').run(id)
    // 하위 폴더는 같이 지우지 않고 최상위로 올린다 (항목 보존이 이 함수의 취지)
    db.prepare('UPDATE character_folders SET parent_id = NULL WHERE parent_id = ?').run(id)
    db.prepare('DELETE FROM character_folders WHERE id = ?').run(id)
  })()
}

/**
 * 폴더와 그 안의 카드를 함께 삭제 (커스텀). 카드는 소프트삭제라 휴지통에서 되살릴 수 있다.
 * 되살린 카드는 폴더가 이미 없으므로 미분류로 돌아온다 — 삭제 당시 폴더 이름은 휴지통에 남는다.
 */
export function deleteFolderWithCharacters(id: number): number[] {
  const db = getDb()
  // 하위 폴더까지 통째로 (2단계라 한 겹만 보면 된다)
  const childIds = (
    db.prepare('SELECT id FROM character_folders WHERE parent_id = ?').all(id) as { id: number }[]
  ).map((r) => r.id)
  const folderIds = [id, ...childIds]
  const placeholders = folderIds.map(() => '?').join(',')
  const ids = (
    db
      .prepare(
        `SELECT id FROM character_prompts WHERE folder_id IN (${placeholders}) AND deleted_at IS NULL`
      )
      .all(...folderIds) as { id: number }[]
  ).map((r) => r.id)
  db.transaction(() => {
    for (const cardId of ids) deleteCharacter(cardId)
    db.prepare(`DELETE FROM character_folders WHERE id IN (${placeholders})`).run(...folderIds)
  })()
  return ids
}

/** 파일 선택 → 192px webp 썸네일로 저장. 취소하면 null */
export async function pickCharacterThumbnail(id: number): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const result = await dialog.showOpenDialog(win, {
    title: '캐릭터 이미지 선택',
    properties: ['openFile'],
    filters: [{ name: '이미지', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
  })
  if (result.canceled || result.filePaths.length === 0) return null

  const thumbnail = await sharp(readFileSync(result.filePaths[0]))
    .resize(192, 192, { fit: 'cover' })
    .webp({ quality: 82 })
    .toBuffer()

  getDb()
    .prepare(
      `UPDATE character_prompts SET thumbnail = ?, updated_at = datetime('now') WHERE id = ?`
    )
    .run(thumbnail, id)
  return thumbnail.toString('base64')
}

/** 캐릭터 썸네일 제거 (F12) */
export function clearCharacterThumbnail(id: number): void {
  getDb()
    .prepare(
      `UPDATE character_prompts SET thumbnail = NULL, updated_at = datetime('now') WHERE id = ?`
    )
    .run(id)
}

/**
 * 캐릭터 JSON 내보내기 (커스텀). folderId를 주면 그 폴더만, null이면 미분류, 생략하면 전체.
 * 씬 JSON(scenes/repo.ts)과 같은 결의 단순 포맷 — 썸네일은 용량이 커서 싣지 않는다.
 */
export async function exportCharactersJson(folderId?: number | null): Promise<{
  saved: boolean
  count: number
}> {
  const db = getDb()
  const where =
    folderId === undefined
      ? 'c.deleted_at IS NULL'
      : folderId === null
        ? 'c.deleted_at IS NULL AND c.folder_id IS NULL'
        : 'c.deleted_at IS NULL AND c.folder_id = ?'
  const params = folderId === undefined || folderId === null ? [] : [folderId]
  // 폴더 이름을 함께 싣는다 — 가져올 때 폴더 구조를 그대로 되살리기 위해서다
  const rows = db
    .prepare(
      `SELECT c.name, c.prompt, c.negative_prompt, c.center_x, c.center_y, c.role,
              f.name AS folder_name
       FROM character_prompts c
       LEFT JOIN character_folders f ON f.id = c.folder_id
       WHERE ${where}
       ORDER BY c.sort_order, c.id`
    )
    .all(...params) as {
    name: string
    prompt: string
    negative_prompt: string
    center_x: number
    center_y: number
    role: string | null
    folder_name: string | null
  }[]

  const folderName =
    typeof folderId === 'number'
      ? (
          db.prepare('SELECT name FROM character_folders WHERE id = ?').get(folderId) as
            { name: string } | undefined
        )?.name
      : undefined

  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const result = await dialog.showSaveDialog(win, {
    title: '캐릭터 내보내기',
    defaultPath: `nais3-characters${folderName ? `-${folderName}` : ''}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (result.canceled || !result.filePath) return { saved: false, count: 0 }

  const characters = rows.map((r) => ({
    name: r.name,
    prompt: r.prompt,
    negativePrompt: r.negative_prompt,
    center: { x: r.center_x, y: r.center_y },
    ...(r.role ? { role: r.role } : {}),
    // 카드가 속했던 폴더 (미분류면 null) — 가져오기에서 이 이름으로 폴더를 되살린다
    folder: r.folder_name
  }))
  // 빈 폴더까지 포함해 폴더 목록도 남긴다 (전체 내보내기일 때만 의미 있음)
  const folders =
    folderId === undefined
      ? (
          db.prepare('SELECT name FROM character_folders ORDER BY sort_order').all() as {
            name: string
          }[]
        ).map((f) => f.name)
      : folderName
        ? [folderName]
        : []
  writeFileSync(
    result.filePath,
    JSON.stringify({ version: 2, folder: folderName ?? null, folders, characters }, null, 2),
    'utf-8'
  )
  return { saved: true, count: characters.length }
}

interface ImportedCharacter {
  name?: string
  prompt?: string
  negativePrompt?: string
  center?: { x?: number; y?: number }
  role?: string
  /** v2부터: 이 카드가 속했던 폴더 이름 */
  folder?: string | null
}

/** 캐릭터 JSON 가져오기 — folderId를 주면 그 폴더로 들어간다. 켜진 상태로 들어오지 않는다 */
export async function importCharactersJson(
  folderId?: number | null
): Promise<{ imported: number }> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const result = await dialog.showOpenDialog(win, {
    title: '캐릭터 가져오기',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  })
  if (result.canceled || !result.filePaths[0]) return { imported: 0 }

  let parsed: { characters?: ImportedCharacter[]; folders?: string[] } | ImportedCharacter[]
  try {
    parsed = JSON.parse(readFileSync(result.filePaths[0], 'utf-8'))
  } catch {
    return { imported: 0 }
  }
  const list = Array.isArray(parsed) ? parsed : (parsed.characters ?? [])
  const db = getDb()
  let imported = 0

  /**
   * 폴더 이름 → id. 이름이 같은 폴더가 이미 있으면 그리로 합치고, 없으면 새로 만든다.
   * 특정 폴더로 가져오는 경우(폴더 우클릭)는 사용자가 위치를 정한 것이므로 무시한다.
   */
  const folderIds = new Map<string, number>()
  const resolveFolder = (name?: string | null): number | null => {
    if (folderId !== undefined) return folderId // 지정 폴더로 몰아넣기
    const trimmed = name?.trim()
    if (!trimmed) return null // 미분류
    const cached = folderIds.get(trimmed)
    if (cached !== undefined) return cached
    const existing = db
      .prepare('SELECT id FROM character_folders WHERE name = ? LIMIT 1')
      .get(trimmed) as { id: number } | undefined
    const id = existing?.id ?? createFolder(trimmed)
    folderIds.set(trimmed, id)
    return id
  }

  // 빈 폴더도 되살린다 (v2 파일에만 folders가 있다)
  const folderNames = Array.isArray(parsed) ? [] : (parsed.folders ?? [])

  db.transaction(() => {
    if (folderId === undefined) for (const name of folderNames) resolveFolder(name)
    for (const c of list) {
      if (!c || typeof c.prompt !== 'string' || !c.prompt.trim()) continue
      const id = createCharacter(c.name?.trim() || '', resolveFolder(c.folder))
      updateCharacter(id, {
        prompt: c.prompt,
        negativePrompt: typeof c.negativePrompt === 'string' ? c.negativePrompt : '',
        // 가져오자마자 생성에 끼어들지 않게 꺼서 들여온다
        enabled: false,
        center: {
          x: typeof c.center?.x === 'number' ? c.center.x : 0.5,
          y: typeof c.center?.y === 'number' ? c.center.y : 0.5
        },
        role: c.role === 'source' || c.role === 'target' ? c.role : null
      })
      imported++
    }
  })()
  return { imported }
}
