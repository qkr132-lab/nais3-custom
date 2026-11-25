import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getDriveRoot,
  mkdirDriveFolder,
  normalizeRelPath,
  resolveSafeDrivePath,
  scanDriveIndex,
  setDriveRoot
} from '../src/main/cloud/drive'

/**
 * 모바일 클라우드 — 폰과 나누는 PC 폴더 (커스텀). 임시 폴더만 쓴다.
 * 폴더는 설정에서 고른 것만 쓰고(기본값 없음), 폰이 보낸 경로로 그 폴더 밖에 닿을 수 없어야 한다.
 */

const state = vi.hoisted(() => ({ settings: {} as Record<string, string> }))

vi.mock('../src/main/db/settings', () => ({
  getSetting: (key: string) => state.settings[key] ?? null,
  setSetting: (key: string, value: string) => {
    state.settings[key] = value
  }
}))
// drive.ts 가 끌어오는 무거운 모듈 — 이 시험이 보는 함수는 쓰지 않는다
vi.mock('../src/main/scenes/repo', () => ({ exportToFolder: vi.fn(), listScenes: vi.fn(() => []) }))
vi.mock('sharp', () => ({ default: vi.fn() }))

let dir = ''
beforeEach(() => {
  state.settings = {}
  dir = mkdtempSync(join(tmpdir(), 'nais-cloud-drive-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('폴더를 고르지 않았을 때', () => {
  it('기본 폴더가 없다 — 공유가 꺼진 것으로 본다', () => {
    expect(getDriveRoot()).toBe('')
    expect(scanDriveIndex()).toBeNull()
    expect(resolveSafeDrivePath('')).toBeNull()
    expect(resolveSafeDrivePath('a/b')).toBeNull()
    expect(mkdirDriveFolder('새 폴더')).toBe(false)
  })

  it('고른 폴더를 지우면 다시 꺼진다', () => {
    setDriveRoot(dir)
    expect(getDriveRoot()).toBe(dir)
    setDriveRoot('')
    expect(getDriveRoot()).toBe('')
    expect(resolveSafeDrivePath('a')).toBeNull()
  })
})

describe('고른 폴더 안에서만', () => {
  beforeEach(() => setDriveRoot(dir))

  it('빈 경로는 폴더 자신, 하위 경로는 그 안', () => {
    expect(resolveSafeDrivePath('')).toBe(resolve(dir))
    expect(resolveSafeDrivePath('a/b')).toBe(resolve(dir, 'a', 'b'))
    expect(resolveSafeDrivePath('a\\b')).toBe(resolve(dir, 'a', 'b'))
  })

  it('.. 조각은 버려져 밖으로 나가지 못한다', () => {
    expect(normalizeRelPath('../../x/./y/..')).toBe('x/y')
    expect(resolveSafeDrivePath('../../secret')).toBe(resolve(dir, 'secret'))
  })

  it('드라이브 글자가 든 경로는 받지 않는다 (다른 드라이브로 새지 않게)', () => {
    expect(resolveSafeDrivePath('C:/Windows/win.ini')).toBeNull()
    expect(resolveSafeDrivePath('sub/E:/x.png')).toBeNull()
    expect(resolveSafeDrivePath('E:')).toBeNull()
    expect(mkdirDriveFolder('Z:/어딘가')).toBe(false)
  })

  it('색인은 그림과 폴더만 싣고 node_modules·점 폴더는 건너뛴다', () => {
    mkdirSync(join(dir, '캐릭터'))
    mkdirSync(join(dir, 'node_modules'))
    mkdirSync(join(dir, '.git'))
    writeFileSync(join(dir, '캐릭터', '01.png'), 'x')
    writeFileSync(join(dir, '캐릭터', '메모.txt'), 'x')
    writeFileSync(join(dir, 'node_modules', 'a.png'), 'x')
    const scanned = scanDriveIndex()
    expect(scanned).not.toBeNull()
    const folders = scanned!.index.folders
    expect(folders.map((f) => f.path).sort()).toEqual(['', '캐릭터'])
    expect(folders.find((f) => f.path === '')?.dirs).toEqual(['캐릭터'])
    expect(folders.find((f) => f.path === '캐릭터')?.imgs).toEqual(['01.png'])
    expect(scanned!.latestFolder).toBe('캐릭터')
  })

  it('하위 폴더를 만든다', () => {
    expect(mkdirDriveFolder('새 폴더/안쪽')).toBe(true)
    expect(scanDriveIndex()!.index.folders.map((f) => f.path)).toContain('새 폴더/안쪽')
  })
})
