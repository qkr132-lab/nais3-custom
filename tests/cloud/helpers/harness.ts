// 테스트 전용 — 허브 한 대를 통째로 흉내 내는 도구 묶음.
// node:sqlite(DO SQL) + Map(R2) + 가짜 NAI(주입 fetch) + 손으로 돌리는 시계·알람.
import type {
  CloudImageMeta,
  CloudLibrary,
  CloudSceneLite
} from '../../../src/shared/cloud-contract'
import { handleAlarm } from '../../../cloud/src/core/alarm'
import type { HubDeps, SqlLike } from '../../../cloud/src/core/deps'
import { handleRequest } from '../../../cloud/src/core/router'
import { ensureSchema } from '../../../cloud/src/core/schema'
import { recountImages } from '../../../cloud/src/core/store'
import { FakeNai } from './nai'
import { MemoryBucket } from './r2'
import { createTestSql, type TestSql } from './sql'

export const PC_SECRET = 'test-pc-secret-0123456789abcdef'
/** 가짜 NAI 토큰 — 어떤 응답에도 나오면 안 된다 */
export const NAI_TOKEN = 'pst-test-0123456789abcdefghij'
export const ORIGIN = 'https://nais3-cloud.test'
export const NAI_HOST = 'http://nai.test'
export const T0 = 1_800_000_000_000

/** 응답 본문을 느슨하게 읽는 테스트용 모양 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Dict = Record<string, any>

export interface CallInit {
  /** 'pc' = x-nais-pc 헤더, 문자열 = 폰 Bearer 토큰, 없으면 인증 없음 */
  auth?: 'pc' | string
  /** JSON 본문 */
  body?: unknown
  /** 원본 본문 (이진 등) */
  raw?: BodyInit
  headers?: Record<string, string>
}

export class Harness {
  readonly sql: TestSql = createTestSql()
  readonly bucket = new MemoryBucket()
  readonly nai = new FakeNai()
  clock = T0
  /** setAlarm 으로 걸린 시각들 (기록) */
  readonly alarmLog: number[] = []
  pendingAlarm: number | null = null
  private seed = 12345
  randomFn: () => number = () => {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0
    return this.seed / 4294967296
  }
  readonly deps: HubDeps

  /** env.PC_SECRET 를 안 주면 기본값, 명시적으로 undefined 를 주면 「서버에 비밀값 없음」 */
  constructor(env: { PC_SECRET?: string } = {}) {
    ensureSchema(this.sql)
    this.deps = {
      sql: this.sql,
      bucket: this.bucket,
      now: () => this.clock,
      random: () => this.randomFn(),
      fetch: this.nai.fetch,
      env: { PC_SECRET: ('PC_SECRET' in env ? env.PC_SECRET : PC_SECRET) as string, NAI_HOST },
      setAlarm: (at) => {
        this.alarmLog.push(at)
        this.pendingAlarm = at
      },
      origin: ORIGIN
    }
  }

  tick(ms: number): void {
    this.clock += ms
  }

  /**
   * DO 인스턴스가 내려갔다 올라온 것처럼 — 인스턴스 메모리(켜짐 표시·그림 수·정리 시각 등)는 비고 저장소는 그대로.
   * 메모리는 sql 객체 단위로 붙어 있으므로 같은 저장소를 가리키는 새 객체로 바꾸면 된다
   */
  restartInstance(): void {
    const inner = this.sql
    this.deps.sql = {
      exec: ((query: string, ...bindings: unknown[]) =>
        inner.exec(query, ...bindings)) as SqlLike['exec']
    }
  }

  async call(method: string, path: string, init: CallInit = {}): Promise<Response> {
    const headers: Record<string, string> = { ...init.headers }
    if (init.auth === 'pc') headers['x-nais-pc'] = PC_SECRET
    else if (init.auth) headers['authorization'] = `Bearer ${init.auth}`
    let body: BodyInit | undefined = init.raw
    if (init.body !== undefined) {
      body = JSON.stringify(init.body)
      headers['content-type'] = 'application/json'
    }
    const request = new Request(`${ORIGIN}${path}`, { method, headers, body })
    return handleRequest(this.deps, request)
  }

  async pc(method: string, path: string, body?: unknown): Promise<Response> {
    return this.call(method, path, { auth: 'pc', body })
  }

  async phone(token: string, method: string, path: string, body?: unknown): Promise<Response> {
    return this.call(method, path, { auth: token, body })
  }

  /** 응답 JSON 을 읽는다 (상태 코드도 함께) */
  async read(response: Response): Promise<{ status: number; json: Dict }> {
    return { status: response.status, json: (await response.json()) as Dict }
  }

  async pcJson(
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; json: Dict }> {
    return this.read(await this.pc(method, path, body))
  }

  async phoneJson(
    token: string,
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; json: Dict }> {
    return this.read(await this.phone(token, method, path, body))
  }

  /** PC 가 코드를 만들고 폰이 연결한다 → 폰 토큰 */
  async pair(name = '내 폰'): Promise<string> {
    const made = await this.pcJson('POST', '/api/pc/pairing')
    const done = await this.call('POST', '/api/pair', { body: { code: made.json.code, name } })
    const result = (await done.json()) as { token: string }
    return result.token
  }

  /** 걸려 있는 알람을 시각 순서대로 울린다 (시계를 알람 시각으로 옮긴다) */
  async runAlarms(max = 60): Promise<number> {
    let count = 0
    while (this.pendingAlarm != null && count < max) {
      this.clock = Math.max(this.clock, this.pendingAlarm)
      this.pendingAlarm = null
      await handleAlarm(this.deps)
      count++
    }
    return count
  }

  /**
   * PC 가 poll 한 것처럼 만든다 (켜짐 표시).
   * activeJobIds 를 주면 PC 가 큐에 들고 있는 작업 목록으로 보낸다 (안 주면 필드 자체가 없는 옛 요청)
   */
  async pcPoll(
    acceptsJobs = true,
    activeJobIds?: string[],
    extra: Record<string, unknown> = {}
  ): Promise<{
    ops: { id: number; type: string }[]
    jobs: { id: string }[]
    needsFullSync: boolean
  }> {
    const { json } = await this.pcJson('POST', '/api/pc/poll', {
      protocol: 1,
      appVersion: 'test',
      queue: sampleQueue(this.clock),
      acceptsJobs,
      ...(activeJobIds ? { activeJobIds } : {}),
      ...extra
    })
    return json as never
  }

  /** 표에서 한 값을 읽는 단축 */
  kv(key: string): string | null {
    const row = this.sql.exec<{ v: string }>(`SELECT v FROM kv WHERE k = ?`, key).toArray()[0]
    return row ? row.v : null
  }

  jobRow(id: string): Record<string, unknown> {
    return this.sql.exec(`SELECT * FROM jobs WHERE id = ?`, id).one()
  }

  imageRows(): Record<string, unknown>[] {
    return this.sql.exec(`SELECT * FROM images ORDER BY created_at ASC, id ASC`).toArray()
  }
}

// ── 예시 데이터 ─────────────────────────────────────────────────────

export function sampleQueue(updatedAt = T0): {
  running: boolean
  pending: number
  generating: number
  done: number
  failed: number
  generatingSceneId: number | null
  updatedAt: number
} {
  return {
    running: false,
    pending: 0,
    generating: 0,
    done: 0,
    failed: 0,
    generatingSceneId: null,
    updatedAt
  }
}

export function sampleLibrary(): CloudLibrary {
  return {
    presets: [
      { id: 1, name: '기본 씬', kind: 'scene', sortOrder: 0, sceneCount: 2 },
      { id: 2, name: '배경', kind: 'background', sortOrder: 1, sceneCount: 1 }
    ],
    characters: [
      {
        id: 10,
        name: '하나',
        folderId: null,
        enabled: true,
        prompt: 'hana, black hair',
        negativePrompt: '',
        role: null,
        outfitId: null,
        sortOrder: 0
      },
      {
        id: 11,
        name: '두리',
        folderId: null,
        enabled: false,
        prompt: 'duri, blonde hair',
        negativePrompt: '',
        role: null,
        outfitId: null,
        sortOrder: 1
      }
    ],
    charFolders: [],
    outfits: [{ id: 1, name: '교복' }],
    main: {
      prompt: '1girl, solo',
      promptParts: null,
      promptSplit: false,
      negativePrompt: 'lowres',
      model: 'nai-diffusion-4-5-full',
      width: 832,
      height: 1216,
      steps: 28
    },
    naiInfo: null
  }
}

export function sampleScene(
  id: number,
  presetId: number,
  overrides: Partial<CloudSceneLite> = {}
): CloudSceneLite {
  return {
    id,
    presetId,
    kind: 'scene',
    name: `씬 ${id}`,
    prompt: `scene prompt ${id}`,
    negativePrompt: '',
    width: 832,
    height: 1216,
    reserveCount: 1,
    sortOrder: id,
    sourceTags: '',
    targetTags: '',
    exportNo: null,
    ...overrides
  }
}

/** 완성 요청 한 건 — 렌더러가 올리는 것과 같이 시드는 -1 (클라우드가 장마다 새로 뽑는다) */
export function sampleRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seed: -1,
    prompt: '1girl, solo',
    negativePrompt: 'lowres',
    model: 'nai-diffusion-4-5-full',
    width: 832,
    height: 1216,
    steps: 28,
    cfgScale: 5,
    cfgRescale: 0,
    sampler: 'k_euler_ancestral',
    noiseSchedule: 'karras',
    variety: false,
    qualityToggle: false,
    ucPreset: 4,
    characterPrompts: [],
    useCoords: false,
    ...overrides
  }
}

/** 씬 한 개짜리 완성 요청 (씬 프롬프트 재병합이 되는 모양) */
export function sampleSceneRequest(
  sceneId: number,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return sampleRequest({
    prompt: 'base tags, scene prompt ' + sceneId,
    sceneId,
    sceneBasePrompt: 'base tags',
    sceneBaseNegativePrompt: 'lowres',
    ...overrides
  })
}

export function preparedItem(
  key: string,
  request: Record<string, unknown>,
  hash = 'h-' + key
): { key: string; hash: string; request: Record<string, unknown> } {
  return { key, hash, request }
}

/** 라이브러리 + 프리셋 1 의 씬 2개 + 완성 요청(메인·씬 1·씬 2) 올리기 */
export async function seedPc(h: Harness): Promise<void> {
  await h.pcJson('PUT', '/api/pc/library', { library: sampleLibrary(), hash: 'lib-1' })
  await h.pcJson('PUT', '/api/pc/scenes', {
    presetId: 1,
    scenes: [sampleScene(1, 1), sampleScene(2, 1)],
    hash: 'scenes-1'
  })
  await h.pcJson('PUT', '/api/pc/scenes', {
    presetId: 2,
    scenes: [sampleScene(3, 2, { kind: 'background' })],
    hash: 'scenes-2'
  })
  await h.pcJson('PUT', '/api/pc/prepared', {
    items: [
      preparedItem('main', sampleRequest()),
      preparedItem('scene:1', sampleSceneRequest(1)),
      preparedItem('scene:2', sampleSceneRequest(2))
    ]
  })
}

/** NAI 토큰 맡기고 클라우드 생성 켜기 */
export async function enableCloudGen(h: Harness): Promise<void> {
  await h.pcJson('PUT', '/api/pc/nai-token', { token: NAI_TOKEN })
  await h.pcJson('PUT', '/api/pc/settings', { cloudGenEnabled: true, keepImages: 2000 })
}

/** 그림 행을 SQL 로 바로 넣는다 (PC 업로드를 수천 번 흉내 내지 않고 큰 보관함을 만들 때) — 카운터는 recountImages 로 맞춘다 */
export function insertImageRows(
  h: Harness,
  count: number,
  make: (index: number) => {
    source?: 'pc' | 'cloud'
    imported?: number
    sceneId?: number | null
    presetId?: number | null
    createdAt?: number
  } = () => ({})
): void {
  for (let i = 0; i < count; i++) {
    const row = make(i)
    const source = row.source ?? 'pc'
    const id = source === 'pc' ? `p${100000 + i}` : `cseed${String(i).padStart(7, '0')}`
    h.sql.exec(
      `INSERT INTO images (id, source, scene_id, preset_id, job_id, seed, width, height, created_at, has_thumb, format, r2_key, sent_payload, imported, pc_image_id)
       VALUES (?, ?, ?, ?, NULL, 1, 832, 1216, ?, 0, ?, ?, NULL, ?, NULL)`,
      id,
      source,
      row.sceneId === undefined ? 1 : row.sceneId,
      row.presetId === undefined ? 1 : row.presetId,
      row.createdAt ?? h.clock - (count - i),
      source === 'pc' ? 'webp' : 'zip',
      `img/${id}.${source === 'pc' ? 'webp' : 'zip'}`,
      row.imported ?? (source === 'pc' ? 0 : 0)
    )
  }
  recountImages(h.sql)
}

export function base64UrlJson(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let text = ''
  for (const b of bytes) text += String.fromCharCode(b)
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** PC 가 그림 한 장을 올린다 */
export async function uploadPcImage(
  h: Harness,
  pcImageId: number,
  meta: Partial<CloudImageMeta> = {},
  bytes: Uint8Array = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4, 87, 69, 66, 80])
): Promise<Response> {
  const full: CloudImageMeta = {
    pcImageId,
    sceneId: 1,
    presetId: 1,
    seed: 777,
    width: 832,
    height: 1216,
    createdAt: h.clock,
    kind: 'scene',
    ...meta
  }
  return h.call('PUT', `/api/pc/images/p${pcImageId}`, {
    auth: 'pc',
    raw: bytes as unknown as BodyInit,
    headers: { 'x-nais-meta': base64UrlJson(full), 'content-type': 'image/webp' }
  })
}
