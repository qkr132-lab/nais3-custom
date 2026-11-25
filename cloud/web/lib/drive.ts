/**
 * PC 폴더 색인 읽기 — DOM 없이 쓰는 순수 함수.
 * PC가 올리는 색인은 폴더마다 { path, dirs, imgs } 뿐이다 (src/shared/cloud-contract.ts 의 CloudDriveIndex).
 * 화면이 쓰는 이름·윗 폴더·개수는 전부 여기서 계산한다. 수정 시각은 PC가 보내지 않으므로 없다.
 */
import type { CloudDriveIndex, CloudImageItem } from '@shared/cloud-contract'

/** 화면에 보이는 폴더 한 개 */
export interface DriveFolder {
  /** 루트 기준 상대 경로 (루트는 '', 구분자는 '/') */
  path: string
  /** 경로의 마지막 조각. 루트는 색인의 rootName */
  name: string
  /** 윗 폴더 경로 (루트와 루트 바로 아래 폴더는 '') */
  parentPath: string
  /** 하위 폴더 이름 */
  childDirs: string[]
  /** 이 폴더 바로 안의 그림 파일 이름 */
  files: string[]
  /** 이 폴더 바로 안의 그림 수 */
  imageCount: number
}

export interface DriveTree {
  rootName: string
  /** 루트를 뺀 폴더 수 */
  totalFolders: number
  /** 모든 폴더의 그림 수 합 */
  totalImages: number
  /** 색인에 실린 순서 그대로 (루트 포함) */
  folders: DriveFolder[]
  byPath: Map<string, DriveFolder>
}

/** 폴더 경로에 이름을 잇는다 (루트 바로 아래면 이름만) */
export function joinDrivePath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

/** 윗 폴더 경로 — 마지막 조각을 뗀다. 루트 바로 아래와 루트는 '' */
export function driveParentPath(path: string): string {
  const at = path.lastIndexOf('/')
  return at < 0 ? '' : path.slice(0, at)
}

/** 경로의 마지막 조각 */
export function driveBaseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** 워커는 색인 속 모양을 검사하지 않고 그대로 돌려준다 — 문자열 목록이 아니면 빈 목록으로 본다 */
function names(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function makeFolder(path: string, rootName: string, dirs: unknown, imgs: unknown): DriveFolder {
  const files = names(imgs)
  return {
    path,
    name: path === '' ? rootName : driveBaseName(path),
    parentPath: driveParentPath(path),
    childDirs: names(dirs),
    files,
    imageCount: files.length
  }
}

/** 색인을 화면이 쓰는 폴더 목록·경로 표·합계로 바꾼다 */
export function buildDriveTree(index: CloudDriveIndex): DriveTree {
  const rootName = typeof index.rootName === 'string' ? index.rootName : ''
  const folders: DriveFolder[] = []
  const byPath = new Map<string, DriveFolder>()
  let totalImages = 0
  for (const entry of Array.isArray(index.folders) ? index.folders : []) {
    if (!entry || typeof entry.path !== 'string' || byPath.has(entry.path)) continue
    const folder = makeFolder(entry.path, rootName, entry.dirs, entry.imgs)
    folders.push(folder)
    byPath.set(folder.path, folder)
    totalImages += folder.imageCount
  }
  return {
    rootName,
    totalFolders: folders.length - (byPath.has('') ? 1 : 0),
    totalImages,
    folders,
    byPath
  }
}

/** 경로의 폴더. 색인에 없으면 null */
export function driveFolder(tree: DriveTree, path: string): DriveFolder | null {
  return tree.byPath.get(path) ?? null
}

/**
 * 폴더의 하위 폴더들 (윗 폴더가 적어 둔 순서).
 * 색인에 본문이 없는 하위 폴더(PC가 깊이 제한·읽기 실패로 훑지 못함)는 빈 폴더로 보인다
 */
export function driveSubFolders(tree: DriveTree, path: string): DriveFolder[] {
  const parent = tree.byPath.get(path)
  if (!parent) return []
  return parent.childDirs.map((name) => {
    const subPath = joinDrivePath(path, name)
    return tree.byPath.get(subPath) ?? makeFolder(subPath, tree.rootName, [], [])
  })
}

/** 경로에 검색어가 든 폴더 (루트 제외, 대소문자 무시). 검색어가 비면 빈 목록 */
export function searchDriveFolders(tree: DriveTree, query: string, limit: number): DriveFolder[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const out: DriveFolder[] = []
  for (const folder of tree.folders) {
    if (out.length >= limit) break
    if (folder.path !== '' && folder.path.toLowerCase().includes(q)) out.push(folder)
  }
  return out
}

/** 폴더 안 그림 중 클라우드에 미리보기가 아직 없는 것이 있는가 (cachedFiles 의 키는 루트 기준 파일 경로) */
export function hasUncachedDriveFiles(
  folder: DriveFolder | null,
  cachedFiles: Record<string, number>
): boolean {
  if (!folder) return false
  return folder.files.some((name) => !cachedFiles[joinDrivePath(folder.path, name)])
}

/**
 * 폴더 안 그림들을 전체 화면 보기가 받는 항목으로 바꾼다. id 는 `d:` + 루트 기준 파일 경로.
 * PC 색인에는 그림 크기·시각이 없어 0 으로 둔다 — 보기 화면은 PC 폴더 그림에 크기·시각을 보이지 않는다
 */
export function driveImageItems(folder: DriveFolder | null): CloudImageItem[] {
  if (!folder) return []
  return folder.files.map((name) => ({
    id: `d:${joinDrivePath(folder.path, name)}`,
    source: 'pc',
    sceneId: null,
    presetId: null,
    jobId: null,
    seed: null,
    width: 0,
    height: 0,
    createdAt: 0,
    hasThumb: true,
    format: 'webp',
    pcPending: false
  }))
}
