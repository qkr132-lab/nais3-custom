/**
 * 폰 화면의 PC 폴더 색인 읽기 시험 — cloud/web/lib/drive.ts
 *
 * PC가 올리는 색인은 폴더마다 { path, dirs, imgs } 뿐이다 (src/shared/cloud-contract.ts 의 CloudDriveIndex).
 * 화면이 쓰는 이름·윗 폴더·하위 폴더·개수는 폰이 여기서 계산한다. 수정 시각은 PC가 보내지 않으므로 없다.
 * 마지막 묶음은 PC의 실제 색인 만들기(scanDriveIndex)가 낸 결과를 그대로 읽혀 양쪽 모양이 어긋나면 깨지게 한다.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudDriveIndex } from '@shared/cloud-contract'
import { handleRequest } from '../../cloud/src/core/router'
import { createApi } from '../../cloud/web/lib/api'
import {
  buildDriveTree,
  driveBaseName,
  driveFolder,
  driveImageItems,
  driveParentPath,
  driveSubFolders,
  hasUncachedDriveFiles,
  joinDrivePath,
  searchDriveFolders
} from '../../cloud/web/lib/drive'
import { scanDriveIndex, setDriveRoot } from '../../src/main/cloud/drive'
import { Harness, ORIGIN } from './helpers/harness'

const state = vi.hoisted(() => ({ settings: {} as Record<string, string> }))

vi.mock('../../src/main/db/settings', () => ({
  getSetting: (key: string) => state.settings[key] ?? null,
  setSetting: (key: string, value: string) => {
    state.settings[key] = value
  }
}))
// drive.ts 가 끌어오는 무거운 모듈 — 이 시험이 보는 함수는 쓰지 않는다
vi.mock('../../src/main/scenes/repo', () => ({
  exportToFolder: vi.fn(),
  listScenes: vi.fn(() => [])
}))
vi.mock('sharp', () => ({ default: vi.fn() }))

/** PC가 올리는 모양 그대로의 예시 색인 */
function sampleIndex(): CloudDriveIndex {
  return {
    rootName: '공유 그림',
    rootPath: 'D:/예시/공유 그림',
    updatedAt: 1_800_000_000_000,
    folders: [
      { path: '', dirs: ['그림', '빈 폴더'], imgs: ['표지.png'] },
      { path: '그림', dirs: ['캐릭터', '배경 모음'], imgs: [] },
      { path: '그림/캐릭터', dirs: [], imgs: ['01.png', '02.webp'] },
      { path: '그림/배경 모음', dirs: [], imgs: ['밤 하늘 01.png'] },
      { path: '빈 폴더', dirs: [], imgs: [] }
    ]
  }
}

describe('경로 도우미', () => {
  it('폴더 경로에 이름을 잇는다 — 루트 바로 아래는 이름만', () => {
    expect(joinDrivePath('', '그림')).toBe('그림')
    expect(joinDrivePath('그림', '캐릭터')).toBe('그림/캐릭터')
    expect(joinDrivePath('그림/배경 모음', '밤 하늘 01.png')).toBe('그림/배경 모음/밤 하늘 01.png')
  })

  it('윗 폴더 경로는 마지막 조각을 뗀 것', () => {
    expect(driveParentPath('')).toBe('')
    expect(driveParentPath('그림')).toBe('')
    expect(driveParentPath('그림/배경 모음')).toBe('그림')
    expect(driveParentPath('a/b/c')).toBe('a/b')
  })

  it('이름은 경로의 마지막 조각', () => {
    expect(driveBaseName('그림')).toBe('그림')
    expect(driveBaseName('그림/배경 모음')).toBe('배경 모음')
    expect(driveBaseName('')).toBe('')
  })
})

describe('색인 → 폴더', () => {
  const tree = buildDriveTree(sampleIndex())

  it('루트 — 이름은 색인의 rootName, 윗 폴더는 없다', () => {
    expect(driveFolder(tree, '')).toEqual({
      path: '',
      name: '공유 그림',
      parentPath: '',
      childDirs: ['그림', '빈 폴더'],
      files: ['표지.png'],
      imageCount: 1
    })
    expect(tree.rootName).toBe('공유 그림')
  })

  it('합계 — 폴더 수는 루트를 빼고, 그림 수는 모든 폴더의 합', () => {
    expect(tree.totalFolders).toBe(4)
    expect(tree.totalImages).toBe(4)
  })

  it('겹친 폴더 — 이름·윗 폴더·그림을 경로에서 얻는다', () => {
    expect(driveFolder(tree, '그림')).toEqual({
      path: '그림',
      name: '그림',
      parentPath: '',
      childDirs: ['캐릭터', '배경 모음'],
      files: [],
      imageCount: 0
    })
    expect(driveFolder(tree, '그림/캐릭터')).toEqual({
      path: '그림/캐릭터',
      name: '캐릭터',
      parentPath: '그림',
      childDirs: [],
      files: ['01.png', '02.webp'],
      imageCount: 2
    })
  })

  it('빈 폴더 — 하위 폴더도 그림도 없다', () => {
    const empty = driveFolder(tree, '빈 폴더')
    expect(empty).toEqual({
      path: '빈 폴더',
      name: '빈 폴더',
      parentPath: '',
      childDirs: [],
      files: [],
      imageCount: 0
    })
    expect(driveSubFolders(tree, '빈 폴더')).toEqual([])
    expect(driveImageItems(empty)).toEqual([])
  })

  it('공백·한글이 든 폴더 이름을 그대로 다룬다', () => {
    const folder = driveFolder(tree, '그림/배경 모음')
    expect(folder?.name).toBe('배경 모음')
    expect(folder?.parentPath).toBe('그림')
    expect(folder?.files).toEqual(['밤 하늘 01.png'])
    expect(driveImageItems(folder).map((it) => it.id)).toEqual(['d:그림/배경 모음/밤 하늘 01.png'])
  })

  it('색인에 없는 경로는 null', () => {
    expect(driveFolder(tree, '없는 폴더')).toBeNull()
    expect(driveSubFolders(tree, '없는 폴더')).toEqual([])
  })

  it('수정 시각은 없다 — PC가 보내지 않는 값을 만들지 않는다', () => {
    for (const folder of tree.folders) {
      expect(Object.keys(folder).sort()).toEqual([
        'childDirs',
        'files',
        'imageCount',
        'name',
        'parentPath',
        'path'
      ])
    }
  })

  it('루트 본문이 없는 색인도 읽는다', () => {
    const noRoot = buildDriveTree({
      rootName: '공유 그림',
      rootPath: '',
      updatedAt: 0,
      folders: [{ path: '그림', dirs: [], imgs: ['01.png'] }]
    })
    expect(driveFolder(noRoot, '')).toBeNull()
    expect(noRoot.totalFolders).toBe(1)
    expect(noRoot.totalImages).toBe(1)
  })

  it('모양이 어긋난 줄은 빈 목록으로 보고, 같은 경로는 첫 줄만 쓴다', () => {
    const odd = buildDriveTree({
      rootName: '공유 그림',
      rootPath: '',
      updatedAt: 0,
      folders: [
        { path: '', dirs: ['그림'], imgs: ['a.png'] },
        { path: '그림' },
        { path: '그림', dirs: [], imgs: ['b.png', 'c.png'] },
        { dirs: [], imgs: ['d.png'] },
        null
      ]
    } as unknown as CloudDriveIndex)
    expect(driveFolder(odd, '그림')).toEqual({
      path: '그림',
      name: '그림',
      parentPath: '',
      childDirs: [],
      files: [],
      imageCount: 0
    })
    expect(odd.totalFolders).toBe(1)
    expect(odd.totalImages).toBe(1)
  })
})

describe('하위 폴더', () => {
  const tree = buildDriveTree(sampleIndex())

  it('윗 폴더가 적어 둔 순서대로, 폴더마다 하위 폴더 수·그림 수가 붙는다', () => {
    const subs = driveSubFolders(tree, '그림')
    expect(subs.map((f) => f.path)).toEqual(['그림/캐릭터', '그림/배경 모음'])
    expect(subs.map((f) => f.name)).toEqual(['캐릭터', '배경 모음'])
    expect(subs.map((f) => f.imageCount)).toEqual([2, 1])
    expect(driveSubFolders(tree, '').map((f) => [f.name, f.childDirs.length])).toEqual([
      ['그림', 2],
      ['빈 폴더', 0]
    ])
  })

  it('색인에 본문이 없는 하위 폴더는 빈 폴더로 보인다', () => {
    const shallow = buildDriveTree({
      rootName: '공유 그림',
      rootPath: '',
      updatedAt: 0,
      folders: [{ path: '', dirs: ['깊은 곳'], imgs: [] }]
    })
    expect(driveSubFolders(shallow, '')).toEqual([
      { path: '깊은 곳', name: '깊은 곳', parentPath: '', childDirs: [], files: [], imageCount: 0 }
    ])
  })
})

describe('폴더 검색', () => {
  const tree = buildDriveTree({
    rootName: 'Share',
    rootPath: '',
    updatedAt: 0,
    folders: [
      { path: '', dirs: ['Backup', '그림'], imgs: [] },
      { path: 'Backup', dirs: ['Old Set'], imgs: [] },
      { path: 'Backup/Old Set', dirs: [], imgs: ['01.png'] },
      { path: '그림', dirs: ['배경 모음'], imgs: [] },
      { path: '그림/배경 모음', dirs: [], imgs: [] }
    ]
  })

  it('경로에 검색어가 든 폴더 — 대소문자를 가리지 않고 루트는 뺀다', () => {
    expect(searchDriveFolders(tree, 'backup', 80).map((f) => f.path)).toEqual([
      'Backup',
      'Backup/Old Set'
    ])
    expect(searchDriveFolders(tree, ' 배경 모음 ', 80).map((f) => f.path)).toEqual([
      '그림/배경 모음'
    ])
    expect(searchDriveFolders(tree, 'share', 80)).toEqual([])
  })

  it('개수 한도를 지키고, 검색어가 비면 빈 목록', () => {
    expect(searchDriveFolders(tree, 'a', 1)).toHaveLength(1)
    expect(searchDriveFolders(tree, '   ', 80)).toEqual([])
  })
})

describe('미리보기가 없는 그림', () => {
  const tree = buildDriveTree(sampleIndex())

  it('폴더 안 그림 중 하나라도 클라우드에 없으면 true', () => {
    const folder = driveFolder(tree, '그림/캐릭터')
    expect(hasUncachedDriveFiles(folder, {})).toBe(true)
    expect(hasUncachedDriveFiles(folder, { '그림/캐릭터/01.png': 1 })).toBe(true)
    expect(
      hasUncachedDriveFiles(folder, { '그림/캐릭터/01.png': 1, '그림/캐릭터/02.webp': 2 })
    ).toBe(false)
  })

  it('루트 그림은 파일 이름만으로 찾는다', () => {
    expect(hasUncachedDriveFiles(driveFolder(tree, ''), { '표지.png': 1 })).toBe(false)
  })

  it('빈 폴더·없는 폴더는 false', () => {
    expect(hasUncachedDriveFiles(driveFolder(tree, '빈 폴더'), {})).toBe(false)
    expect(hasUncachedDriveFiles(null, {})).toBe(false)
  })
})

describe('전체 화면 보기 항목', () => {
  const tree = buildDriveTree(sampleIndex())

  it('id 는 d: + 루트 기준 파일 경로', () => {
    expect(driveImageItems(driveFolder(tree, '')).map((it) => it.id)).toEqual(['d:표지.png'])
    expect(driveImageItems(driveFolder(tree, '그림/캐릭터'))).toEqual([
      {
        id: 'd:그림/캐릭터/01.png',
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
      },
      {
        id: 'd:그림/캐릭터/02.webp',
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
      }
    ])
  })

  it('폴더가 없으면 빈 목록', () => {
    expect(driveImageItems(null)).toEqual([])
  })
})

describe('PC가 만든 색인을 그대로 읽는다', () => {
  let dir = ''
  beforeEach(() => {
    state.settings = {}
    dir = mkdtempSync(join(tmpdir(), 'nais-cloud-web-drive-'))
    setDriveRoot(dir)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('scanDriveIndex 결과(워커를 거치며 JSON 이 된 것)에서 폴더·그림·합계를 얻는다', () => {
    mkdirSync(join(dir, '그림', '캐릭터'), { recursive: true })
    mkdirSync(join(dir, '새 폴더'))
    writeFileSync(join(dir, '표지 그림.png'), 'x')
    writeFileSync(join(dir, '그림', '캐릭터', '01.png'), 'x')
    writeFileSync(join(dir, '그림', '캐릭터', '02.webp'), 'x')
    writeFileSync(join(dir, '그림', '캐릭터', '메모.txt'), 'x')

    const scanned = scanDriveIndex()
    expect(scanned).not.toBeNull()
    // 워커는 색인을 JSON 으로 보관했다가 폰에 그대로 돌려준다
    const index = JSON.parse(JSON.stringify(scanned!.index)) as CloudDriveIndex
    const tree = buildDriveTree(index)

    expect(tree.rootName).toBe(basename(dir))
    expect(tree.totalFolders).toBe(3)
    expect(tree.totalImages).toBe(3)

    const root = driveFolder(tree, '')
    expect(root?.name).toBe(basename(dir))
    expect(root?.files).toEqual(['표지 그림.png'])
    expect(driveSubFolders(tree, '').map((f) => f.name)).toEqual(['그림', '새 폴더'])

    const nested = driveFolder(tree, '그림/캐릭터')
    expect(nested?.parentPath).toBe('그림')
    expect(nested?.files).toEqual(['01.png', '02.webp'])
    expect(driveFolder(tree, '새 폴더')?.imageCount).toBe(0)
    expect(driveImageItems(nested).map((it) => it.id)).toEqual([
      'd:그림/캐릭터/01.png',
      'd:그림/캐릭터/02.webp'
    ])
  })

  it('PC가 올린 색인·미리보기를 실제 워커를 거쳐 폰 API 로 받아 읽는다', async () => {
    mkdirSync(join(dir, '그림', '배경 모음'), { recursive: true })
    writeFileSync(join(dir, '그림', '배경 모음', '밤 하늘 01.png'), 'x')
    writeFileSync(join(dir, '그림', '배경 모음', '밤 하늘 02.png'), 'x')
    const scanned = scanDriveIndex()

    const hub = new Harness()
    const token = await hub.pair()
    // 폰 API(cloud/web/lib/api.ts)의 요청을 워커 handleRequest 로 바로 잇는다
    const api = createApi({
      fetch: ((input: string, init?: RequestInit) =>
        handleRequest(
          hub.deps,
          new Request(`${ORIGIN}${input}`, {
            method: init?.method,
            headers: init?.headers,
            body: init?.body
          })
        )) as typeof fetch,
      getToken: () => token,
      onUnauthorized: () => undefined
    })

    // 색인을 올리기 전 — 폰은 「아직 없음」(null)을 받는다
    expect((await api.driveIndex()).index).toBeNull()

    // PC: 색인 올리기 (src/main/cloud/index.ts 의 syncDriveIndexToCloud 와 같은 요청)
    const put = await hub.pcJson('PUT', '/api/pc/drive-index', { index: scanned!.index })
    expect(put.status).toBe(200)

    const before = await api.driveIndex()
    const folder = driveFolder(buildDriveTree(before.index!), '그림/배경 모음')
    expect(folder?.name).toBe('배경 모음')
    expect(folder?.files).toEqual(['밤 하늘 01.png', '밤 하늘 02.png'])
    expect(hasUncachedDriveFiles(folder, before.cachedFiles)).toBe(true)

    // PC: 폴더 안 그림 미리보기 올리기 (syncDriveFolderImagesToCloud 와 같은 경로 표기)
    const bytes = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4, 87, 69, 66, 80])
    for (const name of folder!.files) {
      const q = encodeURIComponent(joinDrivePath(folder!.path, name))
      const res = await hub.call('PUT', `/api/pc/drive-image?path=${q}`, {
        auth: 'pc',
        raw: bytes as unknown as BodyInit,
        headers: { 'content-type': 'image/webp' }
      })
      expect(res.status).toBe(200)
    }

    // 폰: 올라온 미리보기를 같은 경로로 찾고, 그림 바이트도 같은 경로로 받는다
    const after = await api.driveIndex()
    expect(Object.keys(after.cachedFiles).sort()).toEqual([
      '그림/배경 모음/밤 하늘 01.png',
      '그림/배경 모음/밤 하늘 02.png'
    ])
    expect(hasUncachedDriveFiles(folder, after.cachedFiles)).toBe(false)
    const item = driveImageItems(folder)[0]
    const got = await api.driveFileBytes(item.id.slice(2), true)
    expect([...got.bytes]).toEqual([...bytes])
    expect(got.contentType).toBe('image/webp')
  })
})
