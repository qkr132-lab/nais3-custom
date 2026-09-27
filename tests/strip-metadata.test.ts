import sharp from 'sharp'
import { deflateSync, inflateSync } from 'zlib'
import { describe, expect, it } from 'vitest'
import { metadataFromPng, metadataFromWebp } from '../src/main/images/metadata'
import { stripImageMetadata } from '../src/main/images/strip-metadata'
import {
  NAI_COMMENT,
  RAW,
  SH,
  SW,
  XMP,
  alphaMagic,
  encodeRgbaPng,
  naiPng,
  naiWebp,
  pngChunk,
  pngChunks,
  rawInput,
  rawPixels,
  stealthPng,
  stealthWebp,
  webpChunks
} from './helpers/synthetic-images'

/**
 * 메타데이터 빼기 (커스텀) — 저장·내보내기에서 생성 정보를 무손실로 걷어낸다.
 * 합성 이미지로만 확인: 청크만 빠지고 픽셀 데이터는 한 바이트도 다시 인코딩하지 않는다.
 */

describe('PNG — 텍스트·EXIF 청크만 뺀다', () => {
  it('tEXt·zTXt·iTXt·eXIf를 빼고 색·픽셀 청크는 그대로 둔다', async () => {
    const base = await sharp(RAW, rawInput)
      .png()
      .withIccProfile('srgb')
      .withMetadata({ density: 144 })
      .withExif({ IFD0: { ImageDescription: '1girl, solo' } })
      .withXmp(XMP)
      .toBuffer()
    // NAI가 넣는 tEXt와 압축·국제 텍스트를 IHDR 바로 뒤에 끼운다
    const inserted = Buffer.concat([
      pngChunk('tEXt', Buffer.from(`Comment\0${NAI_COMMENT}`, 'latin1')),
      pngChunk('tEXt', Buffer.from('Software\0NovelAI', 'latin1')),
      pngChunk(
        'zTXt',
        Buffer.concat([Buffer.from('Description\0\0', 'latin1'), deflateSync('1girl, solo')])
      ),
      pngChunk('iTXt', Buffer.from('parameters\0\0\0\0\x001girl, solo', 'latin1'))
    ])
    const png = Buffer.concat([base.subarray(0, 33), inserted, base.subarray(33)])
    const before = pngChunks(png).map((c) => c.type)
    expect(before).toEqual(expect.arrayContaining(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'iCCP', 'pHYs']))
    expect((await metadataFromPng(png))?.seed).toBe(42)

    const out = await stripImageMetadata(png)
    const drop = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf'])
    expect(pngChunks(out).map((c) => c.type)).toEqual(before.filter((t) => !drop.has(t)))
    // 남은 청크는 바이트 그대로 (IDAT 재인코딩 없음)
    const kept = pngChunks(png).filter((c) => !drop.has(c.type))
    expect(Buffer.concat(kept.map((c) => c.bytes))).toEqual(out.subarray(8))
    expect(out.subarray(0, 8)).toEqual(png.subarray(0, 8))

    expect(await rawPixels(out)).toEqual(await rawPixels(png))
    expect(await metadataFromPng(out)).toBeNull()
    const info = await sharp(out).metadata()
    expect(info.exif).toBeUndefined()
    expect(info.xmp).toBeUndefined()
    expect(info.icc).toBeDefined()
    expect(info.density).toBe(144)
  })

  it('뺄 게 없으면 같은 버퍼를 그대로 돌려준다', async () => {
    const png = await sharp(RAW, rawInput).png().toBuffer()
    expect(await stripImageMetadata(png)).toBe(png)
  })

  it('잘린 PNG는 건드리지 않는다', async () => {
    const png = await naiPng()
    const cut = png.subarray(0, png.length - 20)
    expect(await stripImageMetadata(cut)).toBe(cut)
  })
})

describe('PNG — 알파 LSB에 숨은 stealth 정보', () => {
  it('stealth_pngcomp를 지우고 RGB와 다른 청크는 그대로 둔다', async () => {
    const phys = pngChunk('pHYs', Buffer.from([0, 0, 0x16, 0x25, 0, 0, 0x16, 0x25, 1]))
    const text = pngChunk('tEXt', Buffer.from(`Comment\0${NAI_COMMENT}`, 'latin1'))
    const { png, pixels } = stealthPng('stealth_pngcomp', [phys, text])
    expect(await rawPixels(png)).toEqual(pixels)
    // 텍스트 청크를 빼도 알파 쪽에서 읽히는 상태 (NAI PNG와 같은 이중 저장)
    const onlyStealth = stealthPng().png
    expect((await metadataFromPng(onlyStealth))?.seed).toBe(42)

    for (const src of [png, onlyStealth]) {
      const out = await stripImageMetadata(src)
      expect(await metadataFromPng(out)).toBeNull()
      expect(await alphaMagic(out)).not.toBe('stealth_pngcomp')
      // RGB는 그대로, 알파는 최하위 비트만 1로 (254/255 → 255)
      const expected = Buffer.from(pixels)
      for (let i = 3; i < expected.length; i += 4) expected[i] |= 1
      expect(await rawPixels(out)).toEqual(expected)
    }

    const out = await stripImageMetadata(png)
    const chunks = pngChunks(out)
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'pHYs', 'IDAT', 'IEND'])
    const keep = pngChunks(png).filter((c) => c.type !== 'IDAT' && c.type !== 'tEXt')
    expect(chunks.filter((c) => c.type !== 'IDAT').map((c) => c.bytes)).toEqual(
      keep.map((c) => c.bytes)
    )
    const idat = chunks[2].bytes
    expect(idat).toEqual(pngChunk('IDAT', idat.subarray(8, idat.length - 4))) // CRC 맞음
    // 행마다 원래 필터 종류를 그대로 쓴다
    const rows = inflateSync(idat.subarray(8, idat.length - 4))
    for (let y = 0; y < SH; y++) expect(rows[y * (SW * 4 + 1)]).toBe(y % 5)
    // 원본 버퍼는 바꾸지 않는다
    expect(await rawPixels(png)).toEqual(pixels)
  })

  it('비압축 변형(stealth_pnginfo)도 지운다', async () => {
    const { png } = stealthPng('stealth_pnginfo')
    expect(await alphaMagic(png)).toBe('stealth_pnginfo')
    expect(await alphaMagic(await stripImageMetadata(png))).not.toBe('stealth_pnginfo')
  })

  it('매직이 없는 RGBA PNG는 같은 버퍼를 그대로 돌려준다', async () => {
    const pixels = Buffer.from(Array.from({ length: SW * SH * 4 }, (_, i) => (i * 53 + 7) % 256))
    const png = encodeRgbaPng(SW, SH, pixels)
    expect(await stripImageMetadata(png)).toBe(png)
  })
})

describe('WebP — EXIF·XMP 청크를 빼고 VP8X 플래그를 끈다', () => {
  it('NAI 모양 EXIF(홀수 크기)+XMP를 빼고 RIFF 크기를 고친다', async () => {
    const { webp, vp8l } = await naiWebp()
    expect(webpChunks(webp).find((c) => c.type === 'EXIF')!.bytes.length % 2).toBe(1)
    expect(metadataFromWebp(webp)?.seed).toBe(42)
    expect((await sharp(webp).metadata()).exif).toBeDefined()

    const out = await stripImageMetadata(webp)
    const chunks = webpChunks(out)
    expect(chunks.map((c) => c.type)).toEqual(['VP8X', 'VP8L'])
    expect(out[20]).toBe(0x10) // VP8X 페이로드 첫 바이트 = 플래그, 알파만 남음
    expect(out.readUInt32LE(4)).toBe(out.length - 8)
    expect(chunks[1].bytes).toEqual(vp8l)
    // 원본 버퍼는 바꾸지 않는다
    expect(webp[20]).toBe(0x1c)

    expect(await rawPixels(out)).toEqual(await rawPixels(webp))
    expect(metadataFromWebp(out)).toBeNull()
    const info = await sharp(out).metadata()
    expect(info.exif).toBeUndefined()
    expect(info.xmp).toBeUndefined()
  })

  it('인코더가 만든 손실 WebP(ALPH+VP8)에서도 픽셀이 같다', async () => {
    const webp = await sharp(RAW, rawInput)
      .webp({ quality: 90 })
      .withExif({ IFD0: { ImageDescription: '1girl, solo' } })
      .withXmp(XMP)
      .toBuffer()
    const before = webpChunks(webp).map((c) => c.type)
    expect(before).toEqual(expect.arrayContaining(['VP8X', 'EXIF', 'XMP ']))

    const out = await stripImageMetadata(webp)
    expect(webpChunks(out).map((c) => c.type)).toEqual(
      before.filter((t) => t !== 'EXIF' && t !== 'XMP ')
    )
    expect(out[20] & 0x0c).toBe(0)
    expect(out[20] & ~0x0c).toBe(webp[20] & ~0x0c)
    expect(out.readUInt32LE(4)).toBe(out.length - 8)
    expect(await rawPixels(out)).toEqual(await rawPixels(webp))
    const info = await sharp(out).metadata()
    expect(info.exif).toBeUndefined()
    expect(info.xmp).toBeUndefined()
  })

  it('뺄 게 없으면 같은 버퍼를 그대로 돌려준다', async () => {
    const webp = await sharp(RAW, rawInput).webp({ lossless: true }).toBuffer()
    expect(await stripImageMetadata(webp)).toBe(webp)
  })
})

/** 디코딩한 RGBA를 RGB와 알파로 나눈다 */
async function rgbAlpha(buf: Buffer): Promise<{ rgb: Buffer; alpha: Buffer }> {
  const px = await rawPixels(buf)
  const rgb = Buffer.alloc((px.length / 4) * 3)
  const alpha = Buffer.alloc(px.length / 4)
  for (let p = 0; p < alpha.length; p++) {
    px.copy(rgb, p * 3, p * 4, p * 4 + 3)
    alpha[p] = px[p * 4 + 3]
  }
  return { rgb, alpha }
}

/** 문서화한 알파 정리 규칙 — 2 이상은 LSB를 1로, 0·1은 0으로 */
const clearedAlpha = (alpha: Buffer): Buffer => alpha.map((a) => (a >= 2 ? a | 1 : 0))

const chunkOf = (buf: Buffer, type: string): Buffer =>
  webpChunks(buf).find((c) => c.type === type)!.bytes

describe('WebP — ALPH 알파 LSB에 숨은 stealth 정보', () => {
  it('NAI 모양(254/255 알파 + EXIF): 둘 다 지우고 VP8 색 청크는 바이트 그대로', async () => {
    const { webp, pixels } = await stealthWebp()
    const original = Buffer.from(webp)
    expect(webpChunks(webp).map((c) => c.type)).toEqual(['VP8X', 'ALPH', 'VP8 ', 'EXIF'])
    expect(metadataFromWebp(webp)?.seed).toBe(42)
    expect(await alphaMagic(webp)).toBe('stealth_pngcomp')
    const before = await rgbAlpha(webp)
    // 알파는 무손실 — 심은 값 그대로 디코딩된다
    expect(before.alpha).toEqual(Buffer.from(pixels.filter((_, i) => i % 4 === 3)))

    const out = await stripImageMetadata(webp)
    expect(webpChunks(out).map((c) => c.type)).toEqual(['VP8X', 'ALPH', 'VP8 '])
    expect(out.readUInt32LE(4)).toBe(out.length - 8)
    // VP8X는 EXIF 플래그만 꺼지고, 색 청크는 한 바이트도 안 바뀐다
    const vp8x = Buffer.from(chunkOf(webp, 'VP8X'))
    vp8x[8] &= ~0x08
    expect(chunkOf(out, 'VP8X')).toEqual(vp8x)
    expect(chunkOf(out, 'VP8 ')).toEqual(chunkOf(webp, 'VP8 '))
    // 새 ALPH = 압축 1(VP8L) · 필터 없음 · 전처리 없음
    expect(chunkOf(out, 'ALPH')[8]).toBe(0x01)

    const after = await rgbAlpha(out)
    expect(after.rgb).toEqual(before.rgb)
    expect(after.alpha).toEqual(clearedAlpha(before.alpha))
    expect(after.alpha.every((a) => a === 255)).toBe(true) // 254/255 → 모두 255
    expect(await alphaMagic(out)).not.toBe('stealth_pngcomp')
    expect(metadataFromWebp(out)).toBeNull()
    expect((await sharp(out).metadata()).exif).toBeUndefined()
    // 원본 버퍼는 바꾸지 않고, 다시 빼도 더 뺄 게 없다
    expect(webp).toEqual(original)
    expect(await stripImageMetadata(out)).toBe(out)
  })

  it('실제 투명도가 있어도 알파는 최하위 비트만 바뀐다 (0·1은 0)', async () => {
    const { webp } = await stealthWebp({ transparent: true, exif: false })
    expect(webpChunks(webp).map((c) => c.type)).toEqual(['VP8X', 'ALPH', 'VP8 '])
    expect(await alphaMagic(webp)).toBe('stealth_pngcomp')
    const before = await rgbAlpha(webp)
    expect(new Set(before.alpha)).toEqual(new Set([0, 1, 96, 97, 172, 173, 254, 255]))

    const out = await stripImageMetadata(webp)
    const kept = (buf: Buffer): Buffer[] =>
      webpChunks(buf)
        .filter((c) => c.type !== 'ALPH')
        .map((c) => c.bytes)
    expect(kept(out)).toEqual(kept(webp))
    expect(out.readUInt32LE(4)).toBe(out.length - 8)

    const after = await rgbAlpha(out)
    expect(after.rgb).toEqual(before.rgb)
    expect(after.alpha).toEqual(clearedAlpha(before.alpha))
    for (let p = 0; p < after.alpha.length; p++) {
      expect(Math.abs(after.alpha[p] - before.alpha[p])).toBeLessThanOrEqual(1)
      if (before.alpha[p] === 0) expect(after.alpha[p]).toBe(0) // 투명은 그대로 투명
    }
    expect(await alphaMagic(out)).not.toBe('stealth_pngcomp')
  })

  it('비압축 변형(stealth_pnginfo)도 지운다', async () => {
    const { webp } = await stealthWebp({ magic: 'stealth_pnginfo' })
    expect(await alphaMagic(webp)).toBe('stealth_pnginfo')
    const out = await stripImageMetadata(webp)
    expect(await alphaMagic(out)).not.toBe('stealth_pnginfo')
    expect(chunkOf(out, 'VP8 ')).toEqual(chunkOf(webp, 'VP8 '))
  })

  it('매직이 없는 ALPH는 바이트 그대로 둔다', async () => {
    const pixels = Buffer.from(Array.from({ length: SW * SH * 4 }, (_, i) => (i * 53 + 7) % 256))
    const clean = await sharp(pixels, { raw: { width: SW, height: SH, channels: 4 } })
      .webp({ quality: 90, alphaQuality: 100 })
      .toBuffer()
    expect(webpChunks(clean).map((c) => c.type)).toEqual(['VP8X', 'ALPH', 'VP8 '])
    expect(await stripImageMetadata(clean)).toBe(clean)

    // EXIF만 있으면 EXIF만 빠지고 ALPH는 원본 바이트
    const withExif = await sharp(clean)
      .withExif({ IFD0: { ImageDescription: '1girl, solo' } })
      .webp({ quality: 90, alphaQuality: 100 })
      .toBuffer()
    const out = await stripImageMetadata(withExif)
    expect(webpChunks(out).map((c) => c.type)).not.toContain('EXIF')
    expect(chunkOf(out, 'ALPH')).toEqual(chunkOf(withExif, 'ALPH'))
  })
})

describe('그 밖의 포맷', () => {
  it('모르는 포맷은 그대로 둔다', async () => {
    const jpeg = await sharp(RAW, rawInput)
      .jpeg()
      .withExif({ IFD0: { ImageDescription: 'x' } })
      .toBuffer()
    expect(await stripImageMetadata(jpeg)).toBe(jpeg)
    const junk = Buffer.from('not an image')
    expect(await stripImageMetadata(junk)).toBe(junk)
  })
})
