import sharp from 'sharp'
import { charRefBucket } from '../../shared/char-refs'

/**
 * 캐릭레퍼 이미지 전처리 — 보낼 PNG 를 만든다.
 * - canvas (V4.5) — OpenAPI 명세: 1024×1536 / 1536×1024 / 1472×1472
 *   캔버스에 검정 패딩으로 맞춰 전송. 종횡비에 따라 캔버스 선택.
 * - bucket (V5) — 웹과 같게 비율이 가장 가까운 버킷 크기를 덮도록 줄인 뒤 가운데를 잘라 전송.
 */
export async function processCharRefImage(buf: Buffer, mode: 'canvas' | 'bucket'): Promise<Buffer> {
  const meta = await sharp(buf).metadata()
  const w = meta.width ?? 1
  const h = meta.height ?? 1
  if (mode === 'bucket') {
    const b = charRefBucket(w, h)
    const fitted = b.unchanged
      ? sharp(buf)
      : sharp(buf)
          .resize(b.resizeWidth, b.resizeHeight, { fit: 'fill' })
          .extract({ left: b.left, top: b.top, width: b.width, height: b.height })
    return fitted.png().toBuffer()
  }
  const ratio = w / h
  const canvas =
    ratio > 1.2
      ? { w: 1536, h: 1024 }
      : ratio < 1 / 1.2
        ? { w: 1024, h: 1536 }
        : { w: 1472, h: 1472 }

  return sharp(buf)
    .resize(canvas.w, canvas.h, { fit: 'contain', background: { r: 0, g: 0, b: 0 } })
    .png()
    .toBuffer()
}
