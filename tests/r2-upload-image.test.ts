import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { metadataFromPng, metadataFromWebp } from '../src/main/images/metadata'
import { isUploadImage, uploadBytes, uploadName } from '../src/main/r2/upload-image'
import {
  alphaMagic,
  hasMetadataChunks,
  naiPng,
  naiWebp,
  stealthPng,
  stealthWebp,
  stealthWebpLossless
} from './helpers/synthetic-images'

/**
 * R2 업로드 그림 (커스텀) — 설정과 상관없이 메타데이터를 빼고 WebP로 올린다.
 * 합성 이미지로만 확인한다.
 */

const isWebp = (buf: Buffer): boolean =>
  buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
  buf.subarray(8, 12).toString('latin1') === 'WEBP'

describe('R2 업로드 이름', () => {
  it('그림은 확장자를 .webp로, 나머지는 그대로', () => {
    expect(uploadName('sub/a/01.png')).toBe('sub/a/01.webp')
    expect(uploadName('sub/a/사진.JPG')).toBe('sub/a/사진.webp')
    expect(uploadName('sub/a/b.jpeg')).toBe('sub/a/b.webp')
    expect(uploadName('sub/a/c.webp')).toBe('sub/a/c.webp')
    expect(uploadName('sub/a/notes.txt')).toBe('sub/a/notes.txt')
    expect(uploadName('sub/a/clip.mp4')).toBe('sub/a/clip.mp4')
    expect(isUploadImage('x.gif')).toBe(false)
  })
})

describe('R2 업로드 바이트', () => {
  it('NAI PNG(텍스트 청크) → 메타데이터 없는 WebP', async () => {
    const out = await uploadBytes('a.png', await naiPng())
    expect(isWebp(out)).toBe(true)
    expect(hasMetadataChunks(out)).toBe(false)
    expect(await metadataFromWebp(out)).toBeNull()
  })

  it('알파에 숨은 stealth 정보가 든 PNG → 알파를 버린 WebP', async () => {
    const { png } = stealthPng()
    expect((await metadataFromPng(png))?.seed).toBe(42)
    const out = await uploadBytes('a.png', png)
    expect(isWebp(out)).toBe(true)
    expect(await metadataFromWebp(out)).toBeNull()
    expect((await sharp(out).metadata()).hasAlpha).toBe(false)
  })

  it('WebP는 다시 압축하지 않고 메타데이터만 뺀다 (손실·무손실 모두)', async () => {
    const { webp } = await naiWebp()
    const lossy = (await stealthWebp()).webp
    const lossless = (await stealthWebpLossless()).webp
    for (const src of [webp, lossy, lossless]) {
      const out = await uploadBytes('a.webp', src)
      expect(isWebp(out)).toBe(true)
      expect(hasMetadataChunks(out)).toBe(false)
      expect(await metadataFromWebp(out)).toBeNull()
      expect(await alphaMagic(out)).not.toBe('stealth_pngcomp')
    }
  })

  it('JPEG의 EXIF도 빠진다', async () => {
    const jpg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } })
      .jpeg()
      .withExif({ IFD0: { ImageDescription: 'prompt here' } })
      .toBuffer()
    expect((await sharp(jpg).metadata()).exif).toBeTruthy()
    const out = await uploadBytes('a.jpg', jpg)
    expect(isWebp(out)).toBe(true)
    expect((await sharp(out).metadata()).exif).toBeUndefined()
  })

  it('그림이 아닌 파일은 그대로', async () => {
    const txt = Buffer.from('hello')
    expect(await uploadBytes('a.txt', txt)).toBe(txt)
  })
})
