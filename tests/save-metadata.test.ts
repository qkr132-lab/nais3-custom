import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dialog } from 'electron'
import { migrations, reconcileSchema } from '../src/main/db/migrations'
import { metadataFromImage, metadataFromPayloadJson } from '../src/main/images/metadata'
import { copyImageForOutput, saveGeneratedImage } from '../src/main/images/storage'
import { createPreset, createScene, exportToFolder, exportZip } from '../src/main/scenes/repo'
import {
  alphaMagic,
  hasMetadataChunks,
  naiPng,
  naiWebp,
  rawPixels,
  stealthPng,
  stealthWebp
} from './helpers/synthetic-images'

/**
 * 「메타데이터 함께 저장」 설정 (커스텀) — 앱이 쓰는 이미지 파일마다 설정을 따르는지.
 * 임시 폴더 + 메모리 DB + 합성 이미지로만 확인한다.
 */

let db: DatabaseSync
let root = ''
const settings = new Map<string, string>()

function appPath(name: string): string {
  return join(root, name)
}

vi.mock('electron', () => ({
  app: { getPath: (name: string) => appPath(name) },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  dialog: { showSaveDialog: vi.fn() },
  shell: { openPath: vi.fn(async () => '') }
}))
vi.mock('../src/main/trash', () => ({ trashFile: vi.fn(async () => {}) }))
vi.mock('../src/main/db/settings', () => ({
  getSetting: (key: string) => settings.get(key) ?? null
}))
vi.mock('../src/main/db', () => ({
  getDb: () => ({
    prepare: (sql: string) => db.prepare(sql),
    exec: (sql: string) => db.exec(sql),
    transaction: (run: () => unknown) => () => {
      db.exec('BEGIN')
      try {
        const result = run()
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
  })
}))

const SENT = JSON.stringify({
  input: '1girl, solo',
  model: 'nai-diffusion-4-5-full',
  parameters: { seed: 42, steps: 28, negative_prompt: 'lowres' }
})
const LOCAL = {
  promptParts: { base: '1girl', additional: 'solo', detail: '', negative: 'lowres' }
}

const payloadOf = (filePath: string): string =>
  (
    db.prepare('SELECT payload_json FROM images WHERE file_path = ?').get(filePath) as {
      payload_json: string
    }
  ).payload_json

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  for (const migrate of migrations) migrate(db as never)
  reconcileSchema(db as never)
  root = mkdtempSync(join(tmpdir(), 'nais3-meta-'))
  settings.clear()
  settings.set('save_dir', join(root, 'out'))
  settings.set('scene_save_dir', join(root, 'scene'))
  settings.set('date_folders', '0')
})
afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

describe('생성 자동 저장', () => {
  it('기본(켬)이면 NAI 청크를 두고 NAIS3 청크를 더한다, WebP는 바이트 그대로', async () => {
    const png = await naiPng()
    const saved = await saveGeneratedImage({
      png,
      sentPayload: SENT,
      seed: 42,
      kind: 't2i',
      localMetadata: LOCAL
    })
    const file = readFileSync(saved.filePath)
    expect(file.includes(Buffer.from('nais3-params'))).toBe(true)
    const meta = await metadataFromImage(file)
    expect(meta?.seed).toBe(42)
    expect(meta?.promptParts?.base).toBe('1girl')

    const { webp } = await naiWebp()
    const savedWebp = await saveGeneratedImage({
      png: webp,
      sentPayload: SENT,
      seed: 43,
      kind: 't2i',
      format: 'webp'
    })
    expect(readFileSync(savedWebp.filePath)).toEqual(webp)
  })

  it('끄면 파일에서 생성 정보를 빼고 DB 기록은 그대로 둔다', async () => {
    settings.set('save_metadata', '0')
    const png = await naiPng()
    const saved = await saveGeneratedImage({
      png,
      sentPayload: SENT,
      seed: 42,
      kind: 't2i',
      localMetadata: LOCAL
    })
    expect(saved.filePath.startsWith(join(root, 'out'))).toBe(true)
    const file = readFileSync(saved.filePath)
    expect(hasMetadataChunks(file)).toBe(false)
    expect(file.includes(Buffer.from('nais3-params'))).toBe(false)
    expect(await metadataFromImage(file)).toBeNull()
    expect(await rawPixels(file)).toEqual(await rawPixels(png))
    // 메타데이터 보기는 파일에 없으면 DB payload_json으로 폴백한다
    const fromDb = metadataFromPayloadJson(payloadOf(saved.filePath))
    expect(fromDb?.seed).toBe(42)
    expect(fromDb?.prompt).toBe('1girl, solo')
    expect(fromDb?.promptParts?.base).toBe('1girl')

    const { webp } = await naiWebp()
    const savedWebp = await saveGeneratedImage({
      png: webp,
      sentPayload: SENT,
      seed: 43,
      kind: 't2i',
      format: 'webp'
    })
    const webpFile = readFileSync(savedWebp.filePath)
    expect(hasMetadataChunks(webpFile)).toBe(false)
    expect(await rawPixels(webpFile)).toEqual(await rawPixels(webp))
  })

  it('알파 LSB에 숨은 stealth 정보도 설정을 따른다', async () => {
    const { png } = stealthPng()
    const keep = await saveGeneratedImage({ png, sentPayload: SENT, seed: 42, kind: 't2i' })
    expect((await metadataFromImage(readFileSync(keep.filePath)))?.seed).toBe(42)

    // WebP는 ALPH 알파 LSB — 켜면 그대로
    const { webp } = await stealthWebp()
    const keepWebp = await saveGeneratedImage({
      png: webp,
      sentPayload: SENT,
      seed: 44,
      kind: 't2i',
      format: 'webp'
    })
    expect(readFileSync(keepWebp.filePath)).toEqual(webp)

    settings.set('save_metadata', '0')
    const saved = await saveGeneratedImage({ png, sentPayload: SENT, seed: 43, kind: 't2i' })
    expect(await metadataFromImage(readFileSync(saved.filePath))).toBeNull()
    expect(metadataFromPayloadJson(payloadOf(saved.filePath))?.seed).toBe(42)

    const savedWebp = await saveGeneratedImage({
      png: webp,
      sentPayload: SENT,
      seed: 45,
      kind: 't2i',
      format: 'webp'
    })
    const webpFile = readFileSync(savedWebp.filePath)
    expect(hasMetadataChunks(webpFile)).toBe(false)
    expect(await alphaMagic(webpFile)).not.toBe('stealth_pngcomp')
  })

  it('자동 저장을 꺼서 라이브러리에 보관할 때도 설정을 따른다', async () => {
    settings.set('auto_save', '0')
    settings.set('save_metadata', '0')
    const saved = await saveGeneratedImage({
      png: await naiPng(),
      sentPayload: SENT,
      seed: 42,
      kind: 't2i',
      localMetadata: LOCAL
    })
    expect(saved.filePath.startsWith(join(root, 'userData', 'library'))).toBe(true)
    expect(hasMetadataChunks(readFileSync(saved.filePath))).toBe(false)
  })
})

describe('씬 내보내기', () => {
  async function sceneImage(): Promise<{ sceneId: number; src: string; bytes: Buffer }> {
    const presetId = createPreset('프리셋')
    const sceneId = createScene(presetId, '감동')
    const saved = await saveGeneratedImage({
      png: await naiPng(),
      sentPayload: SENT,
      seed: 42,
      kind: 'scene',
      sceneId,
      sceneName: '감동',
      scenePresetName: '프리셋',
      localMetadata: LOCAL
    })
    return { sceneId, src: saved.filePath, bytes: readFileSync(saved.filePath) }
  }

  it('폴더로 내보내기 — 끄면 뺀 사본, 켜면 원본 그대로', async () => {
    const { sceneId, src, bytes } = await sceneImage()
    expect(hasMetadataChunks(bytes)).toBe(true)

    settings.set('save_metadata', '0')
    const off = join(root, 'export-off')
    mkdirSync(off)
    expect((await exportToFolder({ ids: [sceneId] }, { dir: off, policy: 'rename' })).copied).toBe(
      1
    )
    const stripped = readFileSync(join(off, '감동.png'))
    expect(hasMetadataChunks(stripped)).toBe(false)
    expect(await rawPixels(stripped)).toEqual(await rawPixels(bytes))
    // 원본 파일은 건드리지 않는다
    expect(readFileSync(src)).toEqual(bytes)

    settings.set('save_metadata', '1')
    const on = join(root, 'export-on')
    mkdirSync(on)
    await exportToFolder({ ids: [sceneId] }, { dir: on, policy: 'rename' })
    expect(readFileSync(join(on, '감동.png'))).toEqual(bytes)
  })

  it('ZIP 내보내기 — 끄면 뺀 사본, 켜면 원본 그대로', async () => {
    const { bytes } = await sceneImage()
    const zipPath = join(root, 'scenes.zip')
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: zipPath })
    const entry = async (): Promise<Buffer> => {
      const zip = await JSZip.loadAsync(readFileSync(zipPath))
      return zip.file('감동.png')!.async('nodebuffer')
    }

    settings.set('save_metadata', '0')
    expect(await exportZip('sceneTop')).toBe(1)
    const stripped = await entry()
    expect(hasMetadataChunks(stripped)).toBe(false)
    expect(await rawPixels(stripped)).toEqual(await rawPixels(bytes))

    settings.delete('save_metadata')
    expect(await exportZip('sceneTop')).toBe(1)
    expect(await entry()).toEqual(bytes)
  })
})

describe('다른 이름으로 저장·드래그 사본', () => {
  it('설정에 따라 원본 복사 또는 뺀 사본', async () => {
    const src = join(root, 'src.png')
    const saved = await saveGeneratedImage({
      png: await naiPng(),
      sentPayload: SENT,
      seed: 42,
      kind: 't2i'
    })
    const bytes = readFileSync(saved.filePath)
    await copyImageForOutput(saved.filePath, src)
    expect(readFileSync(src)).toEqual(bytes)

    settings.set('save_metadata', '0')
    const dest = join(root, 'dest.png')
    await copyImageForOutput(saved.filePath, dest)
    const stripped = readFileSync(dest)
    expect(hasMetadataChunks(stripped)).toBe(false)
    expect(await rawPixels(stripped)).toEqual(await rawPixels(bytes))
    expect(readFileSync(saved.filePath)).toEqual(bytes)
  })
})
