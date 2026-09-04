import { BrowserWindow, dialog } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import type {
  BackupCharacter,
  BackupQueueEntry,
  BackupSceneLink,
  CharacterBackup,
  ImportMode
} from '../../shared/character-backup'
import { isFullBackup, planImport, remapUidMap, remapUids } from '../../shared/character-backup'
import { getDb } from '../db'
import { getSetting, setSetting } from '../db/settings'
import { createCharacter, createFolder, deleteCharacter, updateCharacter } from './repo'

/**
 * 캐릭터 완전 백업 (커스텀).
 *
 * 카드 내용뿐 아니라 "이 캐릭터가 어디에 어떻게 물려 있었는지"까지 담는다:
 * 폴더(중첩 포함) · 행위 역할 · 배치 좌표 · 캐릭터 레퍼런스 연결 ·
 * 씬별 캐릭터 추가(위치/역할/좌표 사용) · 큐 반복 항목.
 *
 * 연결 정보는 캐릭터 id 대신 파일 안 uid로 적는다 — 가져오면 id가 새로 매겨지기 때문이다.
 * 씬·프리셋은 이름으로 찾는다. 같은 이름이 없으면 그 연결만 버리고 나머지는 살린다.
 *
 * 판정·매핑 로직은 shared/character-backup.ts (테스트 있음), 여기는 DB·파일 입출력만.
 */

const EXTRAS_KEY = 'scene_extras'

interface SceneAddition {
  characterIds: number[]
  charRefIds: number[]
  vibeIds: number[]
  useCoords?: boolean
  positions?: Record<number, { x: number; y: number }>
  roles?: Record<number, 'source' | 'target' | null>
}

interface SequenceEntry {
  id: string
  name: string
  characterIds: number[]
  charRefIds: number[]
  vibeIds: number[]
  enabled: boolean
  useCoords?: boolean
  positions?: Record<number, { x: number; y: number }>
  roles?: Record<number, 'source' | 'target' | null>
}

interface SceneExtras {
  sequenceEnabled?: boolean
  entries?: SequenceEntry[]
  additionsEnabled?: boolean
  additions?: Record<number, Record<number, SceneAddition>>
}

function readExtras(): SceneExtras {
  try {
    return JSON.parse(getSetting(EXTRAS_KEY) ?? '{}') as SceneExtras
  } catch {
    return {}
  }
}

// ── 내보내기 ────────────────────────────────────────────────────────────

export async function exportCharacterBackup(includeThumbnails: boolean): Promise<{
  saved: boolean
  count: number
}> {
  const db = getDb()

  const folderRows = db
    .prepare('SELECT id, name, color, parent_id FROM character_folders ORDER BY sort_order')
    .all() as { id: number; name: string; color: string | null; parent_id: number | null }[]
  const folderName = new Map(folderRows.map((f) => [f.id, f.name]))

  const cardRows = db
    .prepare(
      `SELECT id, name, prompt, negative_prompt, center_x, center_y, role, enabled, folder_id,
              char_ref_id, thumbnail
       FROM character_prompts WHERE deleted_at IS NULL ORDER BY sort_order, id`
    )
    .all() as {
    id: number
    name: string
    prompt: string
    negative_prompt: string
    center_x: number
    center_y: number
    role: string | null
    enabled: number
    folder_id: number | null
    char_ref_id: number | null
    thumbnail: Buffer | null
  }[]

  const refName = new Map(
    (db.prepare('SELECT id, name FROM charref_images').all() as { id: number; name: string }[]).map(
      (r) => [r.id, r.name]
    )
  )

  // uid는 파일 안에서만 통하면 되므로 카드 id로 짓는다 (읽기 쉬워 디버깅에도 유리)
  const uidOf = (id: number): string => `c${id}`

  const characters: BackupCharacter[] = cardRows.map((r) => ({
    uid: uidOf(r.id),
    name: r.name,
    prompt: r.prompt,
    negativePrompt: r.negative_prompt,
    center: { x: r.center_x, y: r.center_y },
    role: r.role === 'source' || r.role === 'target' ? r.role : null,
    enabled: r.enabled === 1,
    folder: r.folder_id != null ? (folderName.get(r.folder_id) ?? null) : null,
    charRefName: r.char_ref_id != null ? (refName.get(r.char_ref_id) ?? null) : null,
    ...(includeThumbnails && r.thumbnail ? { thumbnail: r.thumbnail.toString('base64') } : {})
  }))

  const known = new Set(cardRows.map((r) => r.id))
  const keepUids = (ids: number[] | undefined): string[] =>
    (ids ?? []).filter((id) => known.has(id)).map(uidOf)
  const keepMap = <V>(map: Record<number, V> | undefined): Record<string, V> => {
    const out: Record<string, V> = {}
    for (const [id, value] of Object.entries(map ?? {})) {
      if (known.has(Number(id))) out[uidOf(Number(id))] = value
    }
    return out
  }

  // 씬별 캐릭터 추가 — presetId/sceneId를 이름으로 바꿔 적는다
  const presetName = new Map(
    (db.prepare('SELECT id, name FROM scene_presets').all() as { id: number; name: string }[]).map(
      (p) => [p.id, p.name]
    )
  )
  const sceneName = new Map(
    (
      db.prepare('SELECT id, name FROM gen_scenes WHERE deleted_at IS NULL').all() as {
        id: number
        name: string
      }[]
    ).map((s) => [s.id, s.name])
  )

  const extras = readExtras()
  const sceneLinks: BackupSceneLink[] = []
  for (const [presetId, scenes] of Object.entries(extras.additions ?? {})) {
    const preset = presetName.get(Number(presetId))
    if (!preset) continue
    for (const [sceneId, addition] of Object.entries(scenes)) {
      const scene = sceneName.get(Number(sceneId))
      if (!scene) continue
      const characterUids = keepUids(addition.characterIds)
      if (!characterUids.length) continue
      sceneLinks.push({
        preset,
        scene,
        characterUids,
        useCoords: addition.useCoords,
        positions: keepMap(addition.positions),
        roles: keepMap(addition.roles)
      })
    }
  }

  const queueEntries: BackupQueueEntry[] = (extras.entries ?? [])
    .map((e) => ({
      name: e.name,
      enabled: e.enabled,
      characterUids: keepUids(e.characterIds),
      useCoords: e.useCoords,
      positions: keepMap(e.positions),
      roles: keepMap(e.roles)
    }))
    .filter((e) => e.characterUids.length > 0)

  const backup: CharacterBackup = {
    version: 3,
    folders: folderRows.map((f) => ({
      name: f.name,
      parent: f.parent_id != null ? (folderName.get(f.parent_id) ?? null) : null,
      color: f.color
    })),
    characters,
    sceneLinks,
    queueEntries
  }

  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const result = await dialog.showSaveDialog(win, {
    title: '캐릭터 완전 백업',
    defaultPath: 'nais3-characters-full.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (result.canceled || !result.filePath) return { saved: false, count: 0 }
  writeFileSync(result.filePath, JSON.stringify(backup, null, 2), 'utf-8')
  return { saved: true, count: characters.length }
}

// ── 미리보기 (무엇이 들어오는지 먼저 보여주기) ──────────────────────────

export interface BackupPreview {
  ok: boolean
  filePath?: string
  characters: number
  folders: number
  sceneLinks: number
  queueEntries: number
  /** 기존과 완전히 같아 건너뛸 카드 수 (skip-identical 기준) */
  identical: number
  hasThumbnails: boolean
}

export async function pickCharacterBackup(): Promise<BackupPreview> {
  const empty: BackupPreview = {
    ok: false,
    characters: 0,
    folders: 0,
    sceneLinks: 0,
    queueEntries: 0,
    identical: 0,
    hasThumbnails: false
  }
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const result = await dialog.showOpenDialog(win, {
    title: '캐릭터 백업 열기',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  })
  if (result.canceled || !result.filePaths[0]) return empty

  const backup = readBackup(result.filePaths[0])
  if (!backup) return empty

  const existing = getDb()
    .prepare(
      'SELECT id, name, prompt, negative_prompt, center_x, center_y, role FROM character_prompts WHERE deleted_at IS NULL'
    )
    .all() as {
    id: number
    name: string
    prompt: string
    negative_prompt: string
    center_x: number
    center_y: number
    role: string | null
  }[]
  const plan = planImport(
    existing.map((c) => ({
      id: c.id,
      name: c.name,
      prompt: c.prompt,
      negativePrompt: c.negative_prompt,
      center: { x: c.center_x, y: c.center_y },
      role: (c.role === 'source' || c.role === 'target' ? c.role : null) as
        | 'source'
        | 'target'
        | null
    })),
    backup.characters,
    'skip-identical'
  )

  return {
    ok: true,
    filePath: result.filePaths[0],
    characters: backup.characters.length,
    folders: backup.folders.length,
    sceneLinks: backup.sceneLinks.length,
    queueEntries: backup.queueEntries.length,
    identical: plan.skipped.length,
    hasThumbnails: backup.characters.some((c) => c.thumbnail)
  }
}

function readBackup(filePath: string): CharacterBackup | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown
    return isFullBackup(parsed) ? parsed : null
  } catch {
    return null
  }
}

// ── 가져오기 ────────────────────────────────────────────────────────────

export interface ImportResult {
  created: number
  skipped: number
  removed: number
  sceneLinks: number
  queueEntries: number
  /** 이름이 맞는 씬을 못 찾아 버린 연결 */
  droppedLinks: number
}

export function importCharacterBackup(filePath: string, mode: ImportMode): ImportResult {
  const backup = readBackup(filePath)
  const nothing: ImportResult = {
    created: 0,
    skipped: 0,
    removed: 0,
    sceneLinks: 0,
    queueEntries: 0,
    droppedLinks: 0
  }
  if (!backup) return nothing

  const db = getDb()
  const existing = db
    .prepare(
      'SELECT id, name, prompt, negative_prompt, center_x, center_y, role FROM character_prompts WHERE deleted_at IS NULL'
    )
    .all() as {
    id: number
    name: string
    prompt: string
    negative_prompt: string
    center_x: number
    center_y: number
    role: string | null
  }[]

  const plan = planImport(
    existing.map((c) => ({
      id: c.id,
      name: c.name,
      prompt: c.prompt,
      negativePrompt: c.negative_prompt,
      center: { x: c.center_x, y: c.center_y },
      role: (c.role === 'source' || c.role === 'target' ? c.role : null) as
        | 'source'
        | 'target'
        | null
    })),
    backup.characters,
    mode
  )

  const uidToId = new Map<string, number>()
  const folderIds = new Map<string, number>()
  const refIds = new Map(
    (db.prepare('SELECT id, name FROM charref_images').all() as { id: number; name: string }[]).map(
      (r) => [r.name, r.id]
    )
  )

  const resolveFolder = (name: string | null): number | null => {
    if (!name?.trim()) return null
    const cached = folderIds.get(name)
    if (cached !== undefined) return cached
    const found = db.prepare('SELECT id FROM character_folders WHERE name = ? LIMIT 1').get(name) as
      | { id: number }
      | undefined
    const id = found?.id ?? createFolder(name)
    folderIds.set(name, id)
    return id
  }

  db.transaction(() => {
    // 전체 교체: 기존 카드를 휴지통으로 (되살릴 수 있게 — 영구 삭제하지 않는다)
    for (const id of plan.removeIds) deleteCharacter(id)

    // 폴더 먼저 (빈 폴더·중첩 포함)
    for (const f of backup.folders) resolveFolder(f.name)
    for (const f of backup.folders) {
      const id = folderIds.get(f.name)
      const parentId = f.parent ? folderIds.get(f.parent) : null
      if (id == null) continue
      if (f.color) db.prepare('UPDATE character_folders SET color = ? WHERE id = ?').run(f.color, id)
      if (parentId != null && parentId !== id) {
        db.prepare('UPDATE character_folders SET parent_id = ? WHERE id = ?').run(parentId, id)
      }
    }

    for (const c of plan.create) {
      const id = createCharacter(c.name, resolveFolder(c.folder))
      updateCharacter(id, {
        prompt: c.prompt,
        negativePrompt: c.negativePrompt,
        // 가져오자마자 생성에 끼어들지 않게 꺼서 들여온다 (원래 켜져 있었어도)
        enabled: false,
        center: c.center,
        role: c.role,
        ...(c.charRefName && refIds.has(c.charRefName)
          ? { charRefId: refIds.get(c.charRefName) }
          : {})
      })
      if (c.thumbnail) {
        db.prepare('UPDATE character_prompts SET thumbnail = ? WHERE id = ?').run(
          Buffer.from(c.thumbnail, 'base64'),
          id
        )
      }
      uidToId.set(c.uid, id)
    }

    // 건너뛴 카드도 연결 복원 대상이 되도록 기존 카드에 물려준다
    for (const c of plan.skipped) {
      const match = existing.find(
        (e) => e.name === c.name && e.prompt === c.prompt && e.negative_prompt === c.negativePrompt
      )
      if (match) uidToId.set(c.uid, match.id)
    }
  })()

  // ── 연결 복원 ──
  const presetIds = new Map(
    (db.prepare('SELECT id, name FROM scene_presets').all() as { id: number; name: string }[]).map(
      (p) => [p.name, p.id]
    )
  )
  const extras = readExtras()
  const additions = extras.additions ?? {}
  let restoredLinks = 0
  let dropped = 0

  for (const link of backup.sceneLinks) {
    const presetId = presetIds.get(link.preset)
    if (presetId == null) {
      dropped++
      continue
    }
    const scene = db
      .prepare(
        'SELECT id FROM gen_scenes WHERE preset_id = ? AND name = ? AND deleted_at IS NULL LIMIT 1'
      )
      .get(presetId, link.scene) as { id: number } | undefined
    if (!scene) {
      dropped++
      continue
    }
    const characterIds = remapUids(link.characterUids, uidToId)
    if (!characterIds.length) {
      dropped++
      continue
    }
    const bucket = (additions[presetId] ??= {})
    const prev = bucket[scene.id]
    bucket[scene.id] = {
      // 이미 있던 선택은 지우지 않고 합친다 — 복원이 기존 작업을 덮어쓰면 곤란하다.
      // 통째로 먼저 펼쳐야 백업이 모르는 설정(자리·자리 태그·씬 태그 등)이 살아남는다 —
      // 아래에서 하나씩 적어 넣는 필드만 남기면 나머지가 조용히 지워진다.
      ...prev,
      characterIds: [...new Set([...(prev?.characterIds ?? []), ...characterIds])],
      charRefIds: prev?.charRefIds ?? [],
      vibeIds: prev?.vibeIds ?? [],
      useCoords: link.useCoords ?? prev?.useCoords,
      positions: { ...(prev?.positions ?? {}), ...remapUidMap(link.positions, uidToId) },
      roles: { ...(prev?.roles ?? {}), ...remapUidMap(link.roles, uidToId) }
    }
    restoredLinks++
  }

  const entries = extras.entries ?? []
  let restoredEntries = 0
  for (const e of backup.queueEntries) {
    const characterIds = remapUids(e.characterUids, uidToId)
    if (!characterIds.length) continue
    entries.push({
      id: `imported_${Date.now().toString(36)}_${restoredEntries}`,
      name: e.name,
      characterIds,
      charRefIds: [],
      vibeIds: [],
      enabled: e.enabled,
      useCoords: e.useCoords,
      positions: remapUidMap(e.positions, uidToId),
      roles: remapUidMap(e.roles, uidToId)
    })
    restoredEntries++
  }

  setSetting(
    EXTRAS_KEY,
    JSON.stringify({ ...extras, additions, entries } satisfies SceneExtras)
  )

  return {
    created: plan.create.length,
    skipped: plan.skipped.length,
    removed: plan.removeIds.length,
    sceneLinks: restoredLinks,
    queueEntries: restoredEntries,
    droppedLinks: dropped
  }
}
