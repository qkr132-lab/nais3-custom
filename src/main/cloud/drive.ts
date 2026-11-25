import { existsSync, mkdirSync, readdirSync, statSync } from 'fs'
import { basename, join, resolve, sep } from 'path'
import sharp from 'sharp'
import type { CloudDriveFolderEntry, CloudDriveIndex } from '../../shared/cloud-contract'
import { getSetting, setSetting } from '../db/settings'
import { isInsideDir } from '../r2/local-path'
import { exportToFolder, listScenes } from '../scenes/repo'

const DRIVE_ROOT_KEY = 'cloud_drive_root'

/** 색인에서 건너뛰는 폴더 (점으로 시작하는 폴더는 따로 건너뛴다) */
const SKIP_DIRS = new Set(['node_modules'])

const IMG_EXT = /\.(png|webp|jpg|jpeg)$/i

/** 폰과 나눌 PC 폴더 — 설정 → 모바일에서 고른다. 고르지 않았으면 '' 이고 폴더 공유는 꺼져 있다 */
export function getDriveRoot(): string {
  return getSetting(DRIVE_ROOT_KEY)?.trim() ?? ''
}

export function setDriveRoot(dirPath: string): void {
  setSetting(DRIVE_ROOT_KEY, dirPath.trim())
}

export function normalizeRelPath(relPath: string): string {
  return relPath
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/')
}

/**
 * 루트 폴더 안의 안전한 절대 경로로 바꾼다. 폴더를 고르지 않았거나 밖으로 벗어나면 null.
 * `C:` 같은 드라이브 조각은 resolve 가 다른 드라이브로 보내므로 조각에 `:` 가 있으면 받지 않는다.
 */
export function resolveSafeDrivePath(relPath: string): string | null {
  const base = getDriveRoot()
  if (!base) return null
  const root = resolve(base)
  const clean = normalizeRelPath(relPath)
  if (!clean) return root
  if (clean.includes(':')) return null
  const target = resolve(root, clean.split('/').join(sep))
  return isInsideDir(root, target) ? target : null
}

export interface DriveIndexScanResult {
  index: CloudDriveIndex
  /** 가장 최근에 이미지가 수정된 폴더 상대 경로 (자동 클라우드 미리보기 동기화용) */
  latestFolder: string | null
}

/**
 * 고른 PC 폴더의 폴더·그림 트리 색인을 만든다. 폴더를 고르지 않았거나 없으면 null.
 */
export function scanDriveIndex(): DriveIndexScanResult | null {
  const root = getDriveRoot()
  if (!root || !existsSync(root)) return null

  const folders: CloudDriveFolderEntry[] = []
  let latestFolder: string | null = null
  let latestMtime = 0

  function walk(absDir: string, relDir: string, depth: number): void {
    if (depth > 8) return
    let entries
    try {
      entries = readdirSync(absDir, { withFileTypes: true })
    } catch {
      return
    }
    const dirs: string[] = []
    const imgs: string[] = []
    let folderMaxMtime = 0

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        dirs.push(entry.name)
      } else if (entry.isFile() && IMG_EXT.test(entry.name)) {
        imgs.push(entry.name)
        try {
          const st = statSync(join(absDir, entry.name))
          if (st.mtimeMs > folderMaxMtime) folderMaxMtime = st.mtimeMs
        } catch {
          // ignore stat errors
        }
      }
    }

    dirs.sort((a, b) => a.localeCompare(b, 'ko'))
    imgs.sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }))

    folders.push({
      path: relDir,
      dirs,
      imgs
    })

    if (imgs.length > 0 && folderMaxMtime > latestMtime) {
      latestMtime = folderMaxMtime
      latestFolder = relDir
    }

    for (const d of dirs) {
      const nextRel = relDir ? `${relDir}/${d}` : d
      walk(join(absDir, d), nextRel, depth + 1)
    }
  }

  walk(root, '', 0)

  return {
    index: {
      rootName: basename(root) || root,
      rootPath: root,
      updatedAt: Date.now(),
      folders
    },
    latestFolder
  }
}

/** 연결된 폴더 아래 새 하위 폴더를 만든다 */
export function mkdirDriveFolder(relPath: string): boolean {
  const target = resolveSafeDrivePath(relPath)
  if (!target) return false
  try {
    mkdirSync(target, { recursive: true })
    return true
  } catch {
    return false
  }
}

/** 선택한 프리셋의 씬 그림들을 연결된 폴더의 하위 경로로 바로 분류·저장한다 */
export async function exportPresetToDriveFolder(
  presetId: number,
  relPath: string,
  favoritesOnly = false
): Promise<{ copied: number; dir: string | null }> {
  const targetDir = resolveSafeDrivePath(relPath)
  if (!targetDir) return { copied: 0, dir: null }
  mkdirSync(targetDir, { recursive: true })
  const scenes = listScenes(presetId)
  const ids = scenes.map((s) => s.id)
  if (ids.length === 0) return { copied: 0, dir: targetDir }
  const res = await exportToFolder({ ids, favoritesOnly }, { dir: targetDir, policy: 'overwrite' })
  return { copied: res.copied ?? 0, dir: targetDir }
}

/** 폴더 안 그림 파일을 클라우드 미리보기용 WebP + 썸네일로 변환한다 */
export async function readDriveImageForCloud(relFilePath: string): Promise<{
  webp: Uint8Array
  thumb: Uint8Array
  width: number
  height: number
} | null> {
  const absPath = resolveSafeDrivePath(relFilePath)
  if (!absPath || !existsSync(absPath)) return null
  try {
    const img = sharp(absPath)
    const meta = await img.metadata()
    const width = meta.width ?? 832
    const height = meta.height ?? 1216
    const [webpBuf, thumbBuf] = await Promise.all([
      sharp(absPath).webp({ quality: 86 }).toBuffer(),
      sharp(absPath)
        .resize(360, 360, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 76 })
        .toBuffer()
    ])
    return {
      webp: new Uint8Array(webpBuf),
      thumb: new Uint8Array(thumbBuf),
      width,
      height
    }
  } catch {
    return null
  }
}
