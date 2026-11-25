/** API 연결 하나 + 그림 캐시·불러오기 도우미 */
import { ApiError, createApi } from './lib/api'
import { ImageCache } from './lib/image-cache'
import { readToken } from './lib/storage'
import { makeThumb } from './lib/thumb'
import { extractFirstPng, isZipBytes } from './lib/zip'

let unauthorizedHandler: () => void = () => {}

/** 401 을 받았을 때 할 일 (actions.ts 가 등록) */
export function setUnauthorizedHandler(fn: () => void): void {
  unauthorizedHandler = fn
}

export const api = createApi({
  // window 에 묶어서 부른다 (그냥 넘기면 Illegal invocation)
  fetch: (input, init) => window.fetch(input, init),
  getToken: readToken,
  onUnauthorized: () => unauthorizedHandler()
})

export const imageCache = new ImageCache()

function toBlob(bytes: Uint8Array, type: string): Blob {
  return new Blob([bytes as BlobPart], { type })
}

/** 전체 크기 그림 — zip(클라우드 생성분)이면 풀어서 첫 PNG 를 꺼낸다 */
export async function loadFullBlob(id: string): Promise<Blob> {
  if (id.startsWith('d:')) {
    const relPath = id.slice(2)
    const { bytes, contentType } = await api.driveFileBytes(relPath, false)
    return toBlob(bytes, contentType || 'image/webp')
  }
  const { bytes, contentType } = await api.imageBytes(id, 'full')
  if (isZipBytes(bytes) || /zip/i.test(contentType)) {
    return toBlob(extractFirstPng(bytes), 'image/png')
  }
  return toBlob(bytes, contentType || 'image/webp')
}

/** 클라우드 생성분의 id 는 c 로 시작한다 (PC 가 올린 그림은 p + 숫자) */
export function isCloudId(id: string): boolean {
  return id.startsWith('c')
}

/**
 * 목록용 그림. 썸네일이 있으면 그것을, 없으면 전체 크기를 가져온다.
 * hasThumb 를 모르면(undefined) 썸네일부터 시도하고 404 일 때 전체 크기로 넘어간다.
 * 클라우드 생성분인데 썸네일이 없었다면, 풀어 둔 PNG 로 썸네일을 만들어 한 번 올려 둔다.
 */
export function thumbLoader(id: string, hasThumb?: boolean): () => Promise<Blob> {
  if (id.startsWith('d:')) {
    const relPath = id.slice(2)
    return async () => {
      try {
        const { bytes, contentType } = await api.driveFileBytes(relPath, true)
        return toBlob(bytes, contentType || 'image/webp')
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 404) throw err
        const { bytes, contentType } = await api.driveFileBytes(relPath, false)
        return toBlob(bytes, contentType || 'image/webp')
      }
    }
  }
  return async () => {
    if (hasThumb !== false) {
      try {
        const { bytes, contentType } = await api.imageBytes(id, 'thumb')
        return toBlob(bytes, contentType || 'image/webp')
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 404) throw err
      }
    }
    const full = await loadFullBlob(id)
    if (isCloudId(id)) uploadThumb(id, full)
    return full
  }
}

// ── 썸네일 올리기 (한 번에 하나씩, 같은 그림은 한 번만) ───────────────

const thumbSeen = new Set<string>()
let thumbChain: Promise<void> = Promise.resolve()
const thumbListeners = new Set<(id: string) => void>()

/** 썸네일 올리기가 끝났을 때 알림을 받는다 */
export function onThumbUploaded(fn: (id: string) => void): () => void {
  thumbListeners.add(fn)
  return () => {
    thumbListeners.delete(fn)
  }
}

export function uploadThumb(id: string, full: Blob): void {
  if (thumbSeen.has(id)) return
  thumbSeen.add(id)
  thumbChain = thumbChain.then(async () => {
    try {
      const thumb = await makeThumb(full)
      if (!thumb) return // 썸네일을 못 만든다(디코드 실패·용량 초과) — 다시 시도하지 않음
      await api.putThumb(id, thumb) // WebP, WebP 를 못 만드는 기기(iOS Safari)는 JPEG
      for (const fn of thumbListeners) fn(id)
    } catch {
      thumbSeen.delete(id) // 다음에 다시 보일 때 한 번 더
    }
  })
}
