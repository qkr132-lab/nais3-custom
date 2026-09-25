import { safeStorage } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { getDb } from '../db'
import { getNaiToken, getSetting, setNaiToken, setSetting } from '../db/settings'
import { imagesRoot } from '../images/storage'
import { pruneSceneExtras, type SceneExtrasFile } from '../../shared/scene-bundle'

/**
 * NAIS3 데이터 내보내기/가져오기 (백업/이전).
 * 라이브러리(캐릭터·조각·바이브·캐릭레퍼·폴더)·씬·프롬프트 프리셋·현재 프롬프트를 JSON으로.
 * BLOB(썸네일)은 base64로, 바이브/캐릭레퍼의 실제 이미지 파일은 __image(base64)로 인라인해 이식성 확보.
 */

// 내보낼 테이블 (히스토리 images·anlas_log·settings는 제외 — 기기별/대용량)
const TABLES = [
  'character_folders',
  'character_prompts',
  'fragment_folders',
  'fragments',
  'vibe_folders',
  'vibe_images',
  'charref_folders',
  'charref_images',
  'scene_presets',
  'gen_scenes',
  'prompt_presets'
] as const

// file_path의 실제 이미지를 인라인해야 하는 테이블
const IMAGE_TABLES = new Set(['vibe_images', 'charref_images'])

/**
 * 휴지통을 쓰는 테이블 (커스텀) — 지운 행은 백업에 싣지 않는다.
 * 통째로 뜨면 휴지통 씬·캐릭터까지 따라가 "지운 게 백업에 같이 들어간다"가 된다.
 * 실수 복구용 휴지통은 자동 DB 스냅샷(backups/*.db)이 따로 들고 있다.
 */
const SOFT_DELETE = new Set<string>(['character_folders', 'character_prompts', 'gen_scenes'])

/** scene_extras에서 백업에 안 실린 씬·캐릭터의 흔적을 걷어낸다. 손상돼 있으면 그대로 둔다 */
function pruneExtrasSetting(raw: string, liveScenes: Set<number>, liveChars: Set<number>): string {
  try {
    return JSON.stringify(
      pruneSceneExtras(
        JSON.parse(raw) as SceneExtrasFile,
        (id) => liveScenes.has(id),
        (id) => liveChars.has(id)
      )
    )
  } catch {
    return raw
  }
}

// 백업에 항상 포함하는 앱 설정 (비밀 아님 — 이식 가능한 사용자 취향/구성, 커스텀)
const SETTINGS_KEYS = [
  'web_quick_links',
  'r2_favorites',
  'notify_on_complete',
  'image_trash_minutes',
  'trash_retention_days',
  'backup_max_mb',
  'gen_streaming',
  'gen_delay_ms',
  'auto_save',
  'image_format',
  'date_folders',
  'scene_extras'
] as const

type Row = Record<string, unknown>

function encodeValue(v: unknown): unknown {
  if (Buffer.isBuffer(v)) return { __blob: v.toString('base64') }
  return v
}
function decodeValue(v: unknown): unknown {
  if (v && typeof v === 'object' && '__blob' in (v as object)) {
    return Buffer.from((v as { __blob: string }).__blob, 'base64')
  }
  return v
}

export function exportAll(includeSecrets = false): Record<string, unknown> {
  const db = getDb()
  const tables: Record<string, Row[]> = {}
  for (const t of TABLES) {
    const live = SOFT_DELETE.has(t) ? ' WHERE deleted_at IS NULL' : ''
    const rows = db.prepare(`SELECT * FROM ${t}${live}`).all() as Row[]
    tables[t] = rows.map((r) => {
      const out: Row = {}
      for (const [k, v] of Object.entries(r)) out[k] = encodeValue(v)
      // 바이브/캐릭레퍼 이미지 파일 인라인 (이식성)
      if (IMAGE_TABLES.has(t) && typeof r.file_path === 'string') {
        try {
          out.__image = readFileSync(r.file_path).toString('base64')
        } catch {
          out.__image = null // 파일 없으면 스킵
        }
      }
      return out
    })
  }

  // 휴지통 폴더를 빼면서 끊긴 참조 — 살아 있는 폴더·카드가 사라진 폴더를 가리키지 않게
  const liveFolders = new Set(tables.character_folders.map((r) => r.id as number))
  for (const r of tables.character_folders) {
    if (r.parent_id != null && !liveFolders.has(r.parent_id as number)) r.parent_id = null
  }
  for (const r of tables.character_prompts) {
    if (r.folder_id != null && !liveFolders.has(r.folder_id as number)) r.folder_id = null
  }
  const liveScenes = new Set(tables.gen_scenes.map((r) => r.id as number))
  const liveChars = new Set(tables.character_prompts.map((r) => r.id as number))

  // 앱 설정(비밀 아님) — 항상 포함 (커스텀)
  const settings: Record<string, string> = {}
  for (const k of SETTINGS_KEYS) {
    const v = getSetting(k)
    if (v == null) continue
    // 씬별 캐릭터 추가·큐 반복 — 지운 씬의 설정과 지운 캐릭터를 가리키는 좌석·태그를 뺀다
    settings[k] = k === 'scene_extras' ? pruneExtrasSetting(v, liveScenes, liveChars) : v
  }

  const out: Record<string, unknown> = {
    _app: 'NAIS3',
    _version: 1,
    mainParams: getSetting('main_params') || null,
    settings,
    tables
  }

  // 계정 정보 — 사용자가 명시적으로 동의했을 때만, 평문으로 (DPAPI 암호문은 다른 PC에서 못 푼다).
  // 가져오는 쪽에서 그 PC의 DPAPI로 재암호화된다 (커스텀)
  if (includeSecrets) {
    const secrets: Record<string, unknown> = {}
    const token = getNaiToken()
    if (token) secrets.naiToken = token
    const r2 = getSetting('r2_auth_encrypted')
    if (r2) {
      try {
        // r2/client.ts와 동일 포맷 — 복호화해 평문 JSON으로
        const buf = Buffer.from(r2, 'base64')
        secrets.r2Auth = JSON.parse(
          safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf-8')
        )
      } catch {
        // 복호화 실패 시 제외
      }
    }
    if (Object.keys(secrets).length > 0) {
      out.secrets = secrets
      out._secretsWarning = '⚠️ 이 파일에는 NAI 토큰/클라우드플레어 인증이 평문으로 들어있습니다. 공유하지 마세요.'
    }
  }
  return out
}

/** 가져오기 — replace: 기존 라이브러리를 지우고 교체(복원). false면 미구현(현재 replace만). */
export function importAll(data: Record<string, unknown>): { imported: number } {
  const tables = (data.tables ?? {}) as Record<string, Row[]>
  const db = getDb()
  const libDir = join(imagesRoot(), '_imported')
  mkdirSync(libDir, { recursive: true })

  let imported = 0
  const tx = db.transaction(() => {
    // 자식→부모 순서 무관하게, 전체 교체: 먼저 모두 비우고(역순) 다시 삽입
    for (const t of [...TABLES].reverse()) db.prepare(`DELETE FROM ${t}`).run()

    for (const t of TABLES) {
      const rows = tables[t]
      if (!Array.isArray(rows)) continue
      for (const raw of rows) {
        const row: Row = {}
        for (const [k, v] of Object.entries(raw)) {
          if (k === '__image') continue
          row[k] = decodeValue(v)
        }
        // 이미지 파일 복원 → 새 경로로 재기록
        if (IMAGE_TABLES.has(t) && typeof raw.__image === 'string') {
          const ext = String(row.file_path ?? '').endsWith('.webp') ? 'webp' : 'png'
          const fp = join(libDir, `${t}_${row.id}_${Date.now()}.${ext}`)
          writeFileSync(fp, Buffer.from(raw.__image, 'base64'))
          row.file_path = fp
        }
        const cols = Object.keys(row)
        const placeholders = cols.map(() => '?').join(', ')
        db.prepare(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${placeholders})`).run(
          ...cols.map((c) => row[c] as never)
        )
        imported++
      }
    }
    if (typeof data.mainParams === 'string') setSetting('main_params', data.mainParams)

    // 앱 설정 복원 (커스텀) — 화이트리스트만
    const settings = data.settings as Record<string, string> | undefined
    if (settings && typeof settings === 'object') {
      for (const k of SETTINGS_KEYS) {
        if (typeof settings[k] === 'string') setSetting(k, settings[k])
      }
    }
  })
  tx()

  // 계정 정보 복원 (커스텀) — 이 PC의 DPAPI로 재암호화해 저장
  const secrets = data.secrets as { naiToken?: string; r2Auth?: unknown } | undefined
  if (secrets && typeof secrets === 'object') {
    if (typeof secrets.naiToken === 'string' && secrets.naiToken.trim()) {
      setNaiToken(secrets.naiToken)
    }
    if (secrets.r2Auth && typeof secrets.r2Auth === 'object') {
      const json = JSON.stringify(secrets.r2Auth)
      const enc = safeStorage.isEncryptionAvailable()
        ? safeStorage.encryptString(json).toString('base64')
        : Buffer.from(json).toString('base64')
      setSetting('r2_auth_encrypted', enc)
    }
  }
  return { imported }
}
