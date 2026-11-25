import { readFileSync } from 'fs'
import sharp from 'sharp'
import { getDb } from '../db'
import { saveGeneratedImage } from '../images/storage'
import { uploadBytes } from '../r2/upload-image'
import type { CloudImageDeps, RecentImage, UploadBytes } from './types'

/**
 * 클라우드로 올리고 내려받는 그림의 DB·파일 접근 (커스텀).
 * sync.ts 는 이 구현을 직접 부르지 않고 CloudImageDeps 로 주입받는다.
 */

/** 올릴 바이트 — 메타데이터를 뺀 WebP(r2/upload-image 와 같은 처리) + DB 썸네일 + 크기 */
export async function readForUpload(id: number, filePath: string): Promise<UploadBytes> {
  const webp = await uploadBytes(filePath, readFileSync(filePath))
  const meta = await sharp(webp).metadata()
  const row = getDb().prepare('SELECT thumbnail FROM images WHERE id = ?').get(id) as
    { thumbnail: Buffer | null } | undefined
  return { webp, thumb: row?.thumbnail ?? null, width: meta.width ?? 0, height: meta.height ?? 0 }
}

/** SQLite datetime('now') 는 UTC 'YYYY-MM-DD HH:MM:SS' */
export function sqliteUtcToMs(text: string): number {
  const ms = Date.parse(`${text.replace(' ', 'T')}Z`)
  return Number.isFinite(ms) ? ms : Date.now()
}

/** 최근 그림 (지운 것 제외) — 최신순 */
export function listRecent(limit: number): RecentImage[] {
  const rows = getDb()
    .prepare(
      `SELECT id, file_path, scene_id, seed, kind, created_at
       FROM images WHERE deleted_at IS NULL ORDER BY id DESC LIMIT ?`
    )
    .all(Math.max(1, Math.floor(limit))) as {
    id: number
    file_path: string
    scene_id: number | null
    seed: number | null
    kind: string
    created_at: string
  }[]
  return rows.map((r) => ({
    id: r.id,
    filePath: r.file_path,
    sceneId: r.scene_id,
    seed: r.seed,
    kind: r.kind,
    createdAt: sqliteUtcToMs(r.created_at)
  }))
}

export function presetIdOfScene(sceneId: number): number | null {
  const r = getDb().prepare('SELECT preset_id FROM gen_scenes WHERE id = ?').get(sceneId) as
    { preset_id: number } | undefined
  return r?.preset_id ?? null
}

/** 살아 있는 씬만 — 씬이나 프리셋이 휴지통에 있으면 지워진 것으로 본다 */
export function findLiveScene(
  sceneId: number
): { id: number; name: string; presetId: number } | null {
  const r = getDb()
    .prepare(
      `SELECT s.id, s.name, s.preset_id FROM gen_scenes s
       JOIN scene_presets p ON p.id = s.preset_id
       WHERE s.id = ? AND s.deleted_at IS NULL AND p.deleted_at IS NULL`
    )
    .get(sceneId) as { id: number; name: string; preset_id: number } | undefined
  return r ? { id: r.id, name: r.name, presetId: r.preset_id } : null
}

export function presetName(presetId: number): string | null {
  const r = getDb().prepare('SELECT name FROM scene_presets WHERE id = ?').get(presetId) as
    { name: string } | undefined
  return r?.name ?? null
}

export const cloudImageDeps: CloudImageDeps = {
  readForUpload,
  listRecent,
  presetIdOfScene,
  findScene: findLiveScene,
  presetName,
  saveGenerated: (input) => saveGeneratedImage(input)
}
