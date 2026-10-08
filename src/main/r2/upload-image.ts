import { extname } from 'path'
import sharp from 'sharp'
import { stripImageMetadata } from '../images/strip-metadata'

/**
 * R2에 올리는 그림 (커스텀).
 * 메타데이터 저장 설정과 상관없이 생성 정보를 늘 빼고 WebP로 올린다 — 웹에 공개되는 파일이라서.
 * 그림이 아닌 파일(txt·json·zip·mp4 등)은 그대로 올린다.
 */

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

/** WebP로 바꿔 올릴 그림인지 */
export const isUploadImage = (path: string): boolean => IMAGE_EXTS.has(extname(path).toLowerCase())

/** 올릴 이름 — 그림이면 확장자를 .webp로 */
export function uploadName(path: string): string {
  if (!isUploadImage(path)) return path
  return `${path.slice(0, path.length - extname(path).length)}.webp`
}

/** 올릴 바이트 — 그림이면 메타데이터를 빼고 WebP로. 이미 WebP면 다시 압축하지 않고 메타데이터만 뺀다 */
export async function uploadBytes(path: string, buf: Buffer): Promise<Buffer> {
  if (!isUploadImage(path)) return buf
  const ext = extname(path).toLowerCase()
  // PNG·WebP는 알파 채널 맨 아래 비트에 숨은 NAI 정보까지 먼저 지운다
  const clean = ext === '.png' || ext === '.webp' ? await stripImageMetadata(buf) : buf
  if (ext === '.webp') return clean
  let img = sharp(clean)
  // 불투명한 그림이면 알파 채널을 버려 파일을 줄인다 (NAI 그림은 늘 불투명)
  if ((await img.stats()).isOpaque) img = sharp(clean).removeAlpha()
  // sharp는 withMetadata()를 부르지 않으면 EXIF·XMP를 싣지 않는다
  return img.webp({ quality: 90 }).toBuffer()
}
