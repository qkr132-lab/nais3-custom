import { dialog } from 'electron'
import { copyFileSync, existsSync, mkdirSync } from 'fs'
import { basename, extname, join } from 'path'
import sharp from 'sharp'
import type { LibraryImage } from '../../shared/types'
import { getDb } from '../db'
import { libraryRoot } from '../images/storage'
import { trashFile } from '../trash'

/**
 * 이미지 라이브러리 (NAIS2 Library 이식) — 참고 이미지 모음.
 * 원본은 userData/library/refs로 복사 (원본 이동/삭제돼도 라이브러리는 유지,
 * nais-image 프로토콜 허용 경로 안이라 렌더러에서 바로 표시 가능).
 */

function refsDir(): string {
  const dir = join(libraryRoot(), 'refs')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function listLibraryImages(): { items: LibraryImage[] } {
  const rows = getDb()
    .prepare(
      `SELECT id, name, file_path, thumbnail, width, height, created_at
       FROM library_images ORDER BY sort_order, id`
    )
    .all() as {
    id: number
    name: string
    file_path: string
    thumbnail: Buffer | null
    width: number
    height: number
    created_at: string
  }[]
  return {
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      filePath: r.file_path,
      thumbnail: r.thumbnail ? r.thumbnail.toString('base64') : '',
      width: r.width,
      height: r.height,
      createdAt: r.created_at
    }))
  }
}

/** 파일 선택 다이얼로그로 이미지 추가 — 복사 + 썸네일 생성 */
export async function addLibraryImages(): Promise<{ count: number }> {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '라이브러리에 이미지 추가',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
  })
  if (canceled || filePaths.length === 0) return { count: 0 }
  return { count: await importFiles(filePaths) }
}

/** 경로 목록으로 추가 (드래그 앤 드롭) */
export async function addLibraryImagesFromPaths(paths: string[]): Promise<{ count: number }> {
  return { count: await importFiles(paths) }
}

async function importFiles(filePaths: string[]): Promise<number> {
  const db = getDb()
  const dir = refsDir()
  let count = 0
  for (const src of filePaths) {
    try {
      const meta = await sharp(src).metadata()
      const width = meta.width ?? 0
      const height = meta.height ?? 0

      // 파일명 충돌 방지 — 이름-2, 이름-3 …
      const ext = extname(src)
      const base = basename(src, ext)
      let dest = join(dir, `${base}${ext}`)
      for (let n = 2; existsSync(dest); n++) dest = join(dir, `${base}-${n}${ext}`)
      copyFileSync(src, dest)

      const thumbnail = await sharp(src)
        .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 88 })
        .toBuffer()

      const max = (
        db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM library_images').get() as {
          m: number
        }
      ).m
      db.prepare(
        'INSERT INTO library_images (name, file_path, thumbnail, width, height, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(base, dest, thumbnail, width, height, max + 1)
      count++
    } catch {
      // 이미지가 아니거나 읽기 실패 — 건너뜀
    }
  }
  return count
}

export function renameLibraryImage(id: number, name: string): void {
  getDb().prepare('UPDATE library_images SET name = ? WHERE id = ?').run(name, id)
}

/** 삭제 — 복사해둔 파일은 OS 휴지통으로 (복원 가능) */
export function deleteLibraryImages(ids: number[]): void {
  const db = getDb()
  for (const id of ids) {
    const row = db.prepare('SELECT file_path FROM library_images WHERE id = ?').get(id) as
      | { file_path: string }
      | undefined
    if (row) {
      void trashFile(row.file_path)
      db.prepare('DELETE FROM library_images WHERE id = ?').run(id)
    }
  }
}

export function reorderLibraryImages(ids: number[]): void {
  const db = getDb()
  const tx = db.transaction(() => {
    ids.forEach((id, i) => {
      db.prepare('UPDATE library_images SET sort_order = ? WHERE id = ?').run(i, id)
    })
  })
  tx()
}
