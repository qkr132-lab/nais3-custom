/** 썸네일 만들기·내보내기 — 브라우저(canvas)가 있어야 하는 부분 */

const THUMB_SHORT_EDGE = 360
const THUMB_MAX_BYTES = 256 * 1024
const THUMB_QUALITIES = [0.82, 0.62, 0.42]

export type ThumbType = 'image/webp' | 'image/jpeg'

/** 한 형식·품질로 인코딩. 그 형식을 못 만드는 브라우저는 다른 형식(PNG)이나 null 을 돌려준다 */
export type ThumbEncoder = (type: ThumbType, quality: number) => Promise<Blob | null>

/**
 * WebP 로 먼저 시도하고, 브라우저가 WebP 를 못 만들면(iOS Safari 는 canvas 가 PNG 를 돌려준다) JPEG 로 넘어간다.
 * 256KB 안에 들어가는 첫 결과를 돌려주고, 어떤 형식으로도 못 맞추면 null
 */
export async function encodeThumb(
  encode: ThumbEncoder,
  maxBytes: number = THUMB_MAX_BYTES
): Promise<Blob | null> {
  for (const type of ['image/webp', 'image/jpeg'] as const) {
    for (const quality of THUMB_QUALITIES) {
      const out = await encode(type, quality)
      if (!out || out.type !== type) break // 이 형식은 못 만든다 — 다음 형식으로
      if (out.size <= maxBytes) return out
    }
  }
  return null
}

/**
 * 그림을 짧은 변 360px 의 WebP(안 되면 JPEG)로 줄인다 (키우지는 않는다).
 * 256KB 를 못 맞추거나 디코드가 안 되면 null — 올리지 않고 넘어간다.
 */
export async function makeThumb(source: Blob): Promise<Blob | null> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(source)
  } catch {
    return null
  }
  try {
    const scale = Math.min(1, THUMB_SHORT_EDGE / Math.min(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0, width, height)
    return await encodeThumb(
      (type, quality) =>
        new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality))
    )
  } finally {
    bitmap.close()
  }
}

/** 파일 이름에 쓸 확장자 */
export function extensionFor(blob: Blob): string {
  if (blob.type === 'image/png') return 'png'
  if (blob.type === 'image/jpeg') return 'jpg'
  return 'webp'
}

/**
 * 그림 저장 — 파일 공유가 되는 기기(대부분의 폰)는 공유 시트, 아니면 내려받기.
 * 돌려주는 값: 'shared' | 'downloaded' | 'cancelled'
 */
export async function saveImage(
  blob: Blob,
  baseName: string
): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const fileName = `${baseName}.${extensionFor(blob)}`
  try {
    const file = new File([blob], fileName, { type: blob.type || 'image/png' })
    if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] })
      return 'shared'
    }
  } catch (err) {
    // 공유 시트를 닫은 것은 오류가 아니다
    if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled'
    // 그 밖의 공유 실패는 내려받기로 넘어간다
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
  return 'downloaded'
}
