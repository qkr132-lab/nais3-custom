/**
 * 폰 API 호출 — 응답 모양은 src/shared/cloud-contract.ts 를 따른다.
 * 성공은 `{ ok: true, ...필드 }`, 실패는 `{ ok: false, error: '한국어 문장' }`.
 *
 * 모든 요청에 시간 제한이 있다 (상태·목록 15초, 그림 바이트 60초). 응답도 오류도 없이 멈춘 요청이
 * 폴링을 붙잡지 않도록, 시간이 지나면 끊고 「네트워크에 닿지 못함」(status 0)으로 다룬다.
 */
import type {
  CloudCharPatch,
  CloudControlAction,
  CloudCreateJob,
  CloudCreateJobResponse,
  CloudDriveIndex,
  CloudImageItem,
  CloudJob,
  CloudMainPatch,
  CloudPhoneScene,
  CloudPhoneState,
  CloudScenePatch
} from '@shared/cloud-contract'

/** 상태·목록·편집 요청의 시간 제한 (ms) */
export const JSON_TIMEOUT_MS = 15_000
/** 그림 바이트를 받거나 올리는 요청의 시간 제한 (ms) */
export const BYTES_TIMEOUT_MS = 60_000

const NETWORK_MESSAGE = '네트워크에 연결할 수 없습니다'
const TIMEOUT_MESSAGE = '서버 응답이 없습니다. 잠시 뒤 다시 시도하세요'

export class ApiError extends Error {
  /** HTTP 상태. 0 이면 네트워크에 닿지 못함(시간 초과 포함) */
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
  get isNetwork(): boolean {
    return this.status === 0
  }
}

export interface ApiDeps {
  fetch: typeof fetch
  getToken: () => string | null
  /** 401 을 받았을 때 (토큰이 틀렸거나 기기가 해제됨) */
  onUnauthorized: () => void
  /** 시간 제한을 바꾼다 (시험용) */
  timeoutMs?: { json?: number; bytes?: number }
}

export interface ListImagesQuery {
  sceneId?: number | null
  presetId?: number | null
  before?: string | null
  limit?: number
}

function fallbackMessage(status: number): string {
  if (status === 401) return '연결이 해제되었습니다'
  if (status === 404) return '찾을 수 없습니다'
  if (status === 413) return '파일이 너무 큽니다'
  if (status === 429) return '요청이 너무 많습니다. 잠시 뒤 다시 시도하세요'
  if (status >= 500) return '서버에 문제가 생겼습니다'
  return '요청을 처리하지 못했습니다'
}

export function createApi(deps: ApiDeps) {
  const jsonTimeout = deps.timeoutMs?.json ?? JSON_TIMEOUT_MS
  const bytesTimeout = deps.timeoutMs?.bytes ?? BYTES_TIMEOUT_MS

  /**
   * 요청 하나. 헤더가 오기까지와 본문을 읽는 동안 모두 timeoutMs 안에 끝나야 한다.
   * read 가 응답 본문을 읽어 돌려준다.
   */
  async function call<T>(
    method: string,
    path: string,
    init: {
      body?: BodyInit
      headers?: Record<string, string>
      auth?: boolean
      timeoutMs: number
    },
    read: (res: Response) => Promise<T>
  ): Promise<T> {
    const headers: Record<string, string> = { ...init.headers }
    if (init.auth !== false) {
      const token = deps.getToken()
      if (token) headers.authorization = `Bearer ${token}`
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), init.timeoutMs)
    const unreachable = (): ApiError =>
      new ApiError(0, controller.signal.aborted ? TIMEOUT_MESSAGE : NETWORK_MESSAGE)
    try {
      let res: Response
      try {
        res = await deps.fetch(path, {
          method,
          headers,
          body: init.body,
          cache: 'no-store',
          signal: controller.signal
        })
      } catch {
        throw unreachable()
      }
      if (!res.ok) {
        if (res.status === 401 && init.auth !== false) deps.onUnauthorized()
        throw new ApiError(res.status, await errorText(res))
      }
      try {
        return await read(res)
      } catch (err) {
        if (controller.signal.aborted) throw unreachable() // 본문을 읽다가 시간이 다 됨
        throw err instanceof ApiError
          ? err
          : new ApiError(res.status, '서버 응답을 읽을 수 없습니다')
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async function errorText(res: Response): Promise<string> {
    try {
      const data = (await res.json()) as { error?: unknown }
      if (typeof data?.error === 'string' && data.error) return data.error
    } catch {
      /* 본문이 JSON 이 아님 */
    }
    return fallbackMessage(res.status)
  }

  function json<T extends object>(
    method: string,
    path: string,
    body?: unknown,
    auth = true
  ): Promise<T> {
    return call(
      method,
      path,
      {
        auth,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        timeoutMs: jsonTimeout
      },
      async (res) => {
        let data: unknown
        try {
          data = await res.json()
        } catch {
          throw new ApiError(res.status, '서버 응답을 읽을 수 없습니다')
        }
        const obj = data as { ok?: boolean; error?: string }
        if (!obj || obj.ok === false) {
          throw new ApiError(res.status, obj?.error || '요청을 처리하지 못했습니다')
        }
        return obj as T
      }
    )
  }

  function query(params: Record<string, string | number | null | undefined>): string {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') q.set(k, String(v))
    const s = q.toString()
    return s ? `?${s}` : ''
  }

  return {
    pair: (code: string, name: string) =>
      json<{ token: string; deviceId: string }>('POST', '/api/pair', { code, name }, false),
    me: () => json<{ deviceId: string; name: string }>('GET', '/api/me'),
    state: () => json<{ ok: true } & CloudPhoneState>('GET', '/api/state'),
    scenes: (presetId: number) =>
      json<{ items: CloudPhoneScene[] }>('GET', `/api/scenes${query({ presetId })}`),
    patchScene: (id: number, patch: CloudScenePatch) =>
      json<{ scene: CloudPhoneScene }>('PATCH', `/api/scenes/${id}`, patch),
    patchCharacter: (id: number, patch: CloudCharPatch) =>
      json<object>('PATCH', `/api/characters/${id}`, patch),
    patchMain: (patch: CloudMainPatch) => json<object>('PATCH', '/api/main', patch),
    createJob: (body: CloudCreateJob) => json<CloudCreateJobResponse>('POST', '/api/jobs', body),
    cancelJob: (id: string) => json<{ job: CloudJob }>('POST', `/api/jobs/${id}/cancel`),
    images: (q: ListImagesQuery = {}) =>
      json<{ items: CloudImageItem[]; next: string | null }>(
        'GET',
        `/api/images${query({ sceneId: q.sceneId, presetId: q.presetId, before: q.before, limit: q.limit })}`
      ),
    /** force: PC로 아직 옮기지 않은 그림(pcPending)도 지운다. 없으면 서버가 409 로 막는다 */
    deleteImage: (id: string, opts: { force?: boolean } = {}) =>
      json<object>('DELETE', `/api/images/${id}${opts.force ? '?force=1' : ''}`),
    logout: () => json<object>('POST', '/api/logout'),
    control: (action: CloudControlAction) =>
      json<{ opId: number }>('POST', '/api/control', { action }),
    driveIndex: () =>
      json<{ index: CloudDriveIndex | null; cachedFiles: Record<string, number> }>(
        'GET',
        '/api/drive/index'
      ),

    /** PC 폴더 그림 바이트 */
    driveFileBytes(
      relPath: string,
      thumb: boolean
    ): Promise<{ bytes: Uint8Array; contentType: string }> {
      return call(
        'GET',
        `/api/drive/file${query({ path: relPath, thumb: thumb ? 1 : null })}`,
        { timeoutMs: bytesTimeout },
        async (res) => ({
          bytes: new Uint8Array(await res.arrayBuffer()),
          contentType: res.headers.get('content-type') ?? ''
        })
      )
    },

    /** 그림 바이트 (full = webp 또는 zip, thumb = webp 또는 jpeg) */
    imageBytes(
      id: string,
      kind: 'full' | 'thumb'
    ): Promise<{ bytes: Uint8Array; contentType: string }> {
      return call(
        'GET',
        `/api/images/${id}${kind === 'thumb' ? '/thumb' : ''}`,
        { timeoutMs: bytesTimeout },
        async (res) => ({
          bytes: new Uint8Array(await res.arrayBuffer()),
          contentType: res.headers.get('content-type') ?? ''
        })
      )
    },

    /**
     * 폰이 만든 썸네일 올리기 (클라우드 생성분에 썸네일이 없을 때 한 번).
     * 형식은 blob 이 가진 그대로 (image/webp, WebP 를 못 만드는 기기는 image/jpeg).
     */
    putThumb(id: string, blob: Blob): Promise<void> {
      return call(
        'PUT',
        `/api/images/${id}/thumb`,
        {
          headers: { 'content-type': blob.type || 'image/webp' },
          body: blob,
          timeoutMs: bytesTimeout
        },
        async () => undefined
      )
    }
  }
}

export type Api = ReturnType<typeof createApi>
