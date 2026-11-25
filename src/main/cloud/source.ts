import { getDb } from '../db'
import { getSetting } from '../db/settings'
import { listFragments } from '../fragments/repo'
import { listAllScenesLite, listPresets, listSceneImageCounts } from '../scenes/repo'
import type { CharFolderInput, CharacterInput, SnapshotSource } from './snapshot'

/**
 * 클라우드 스냅샷의 원재료를 DB 에서 읽는다 (커스텀).
 * 캐릭터·복장은 썸네일 BLOB·조각 JSON 을 읽지 않으려고 필요한 열만 직접 고른다(30초마다 도는 일이라 가볍게).
 */

function readCharacters(): CharacterInput[] {
  const rows = getDb()
    .prepare(
      `SELECT id, name, prompt, negative_prompt, enabled, folder_id, role, outfit_id
       FROM character_prompts WHERE deleted_at IS NULL ORDER BY sort_order, id`
    )
    .all() as {
    id: number
    name: string
    prompt: string
    negative_prompt: string
    enabled: number
    folder_id: number | null
    role: string | null
    outfit_id: number | null
  }[]
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prompt: r.prompt,
    negativePrompt: r.negative_prompt,
    enabled: r.enabled === 1,
    folderId: r.folder_id,
    role: r.role === 'source' || r.role === 'target' ? r.role : null,
    outfitId: r.outfit_id ?? null
  }))
}

function readCharFolders(): CharFolderInput[] {
  const rows = getDb()
    .prepare(
      'SELECT id, name, parent_id FROM character_folders WHERE deleted_at IS NULL ORDER BY sort_order'
    )
    .all() as { id: number; name: string; parent_id: number | null }[]
  return rows.map((r) => ({ id: r.id, name: r.name, parentId: r.parent_id }))
}

function readOutfits(): { id: number; name: string }[] {
  return getDb().prepare('SELECT id, name FROM outfits ORDER BY sort_order, id').all() as {
    id: number
    name: string
  }[]
}

/** 씬마다 그림 수 — 씬 본문과 따로, 씬을 읽지 않고 한 번에 센다 */
export function readSceneCounts(): Record<string, number> {
  return listSceneImageCounts()
}

export function readSnapshotSource(): SnapshotSource {
  const fragments = listFragments()
  return {
    presets: [...listPresets('scene'), ...listPresets('background')],
    scenes: listAllScenesLite(),
    characters: readCharacters(),
    charFolders: readCharFolders(),
    outfits: readOutfits(),
    fragmentFolders: fragments.folders,
    fragments: fragments.items,
    mainParamsRaw: getSetting('main_params'),
    promptSplit: getSetting('prompt_split_enabled') === '1',
    naiTier: getSetting('nai_tier')
  }
}
