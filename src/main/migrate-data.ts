import { app } from 'electron'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { cp } from 'fs/promises'
import { basename, join } from 'path'
import Database from 'better-sqlite3'

/**
 * 데이터 폴더 분리 이관 (v1.5.0, 커스텀).
 *
 * v1.1.6~v1.4.3은 공식 NAIS3와 같은 폴더(%APPDATA%\NAIS3)를 공유했는데,
 * 커스텀 마이그레이션이 DB user_version을 올려버려 **공식 NAIS3가 그 DB를
 * 못 열고 "데이터베이스 오류"로 죽는 사고**가 실제로 발생했다.
 *
 * v1.5.0부터 자체 폴더(%APPDATA%\NAIS3 Custom)를 쓰며, 첫 실행 때 한 번:
 * 1. 공유 폴더의 DB·라이브러리·레퍼런스·웹 세션을 자체 폴더로 **복사** (원본 보존)
 * 2. 공유 폴더의 DB를 커스텀이 손대기 직전 백업(pre-migration-v{N}.db 중
 *    가장 오래된 것)으로 되돌려 **공식 NAIS3를 복구**
 *
 * userData 접근(initDb 등) 전에 호출해야 한다.
 */

const MARKER = '.migrated-from-shared-v1'
const DB_FILES = ['nais3.db', 'nais3.db-wal', 'nais3.db-shm']

/** Electron 세션 폴더 안의 무거운 캐시들 — 복사 제외 (수 GB일 수 있어 첫 실행이 멈춘 사고 원인).
 *  로그인 유지에 필요한 Cookies/Local Storage 등 작은 것만 넘어간다 */
const HEAVY_CACHE_DIRS = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Service Worker',
  'blob_storage',
  'Dictionaries',
  'component_crx_cache',
  'Crashpad'
])

/** 이관이 아직 안 됐는지 (스플래시 표시 판단용) */
export function needsMigration(): boolean {
  const customDir = app.getPath('userData')
  return (
    !existsSync(join(customDir, MARKER)) &&
    existsSync(join(app.getPath('appData'), 'NAIS3', 'nais3.db'))
  )
}

/**
 * 비동기 이관 — 반드시 창(스플래시)을 띄운 뒤 호출할 것.
 * v1.5.0~1.5.6은 이걸 창 없이 동기로 돌려서, 공유 폴더가 크면(웹 캐시 수 GB)
 * 앱이 몇 분간 "반응 없음"으로 보였고 강제 종료 → 마커 미기록 → 무한 반복되는
 * 사고가 실제로 났다. 이제: 캐시 제외 + 비동기 + 단계별 보호.
 */
export async function migrateFromSharedFolder(): Promise<void> {
  const customDir = app.getPath('userData') // %APPDATA%\NAIS3 Custom
  const sharedDir = join(app.getPath('appData'), 'NAIS3')
  mkdirSync(customDir, { recursive: true })
  const marker = join(customDir, MARKER)
  if (existsSync(marker)) return

  try {
    const sharedDb = join(sharedDir, 'nais3.db')
    if (existsSync(sharedDb)) {
      // v1.1.0~1.1.5 시절 잔재 DB가 자체 폴더에 남아있으면 치워둔다 (공유 폴더가 최신)
      if (existsSync(join(customDir, 'nais3.db'))) {
        const stale = join(customDir, `stale-${Date.now()}`)
        mkdirSync(stale, { recursive: true })
        for (const f of DB_FILES) {
          const p = join(customDir, f)
          if (existsSync(p)) renameSync(p, join(stale, f))
        }
      }

      // ① DB 3종 복사 (WAL 포함 — SQLite가 알아서 복구). 이것만은 실패 시 재시도해야 하므로
      //    outer try가 잡아 마커를 안 쓴다
      for (const f of DB_FILES) {
        const src = join(sharedDir, f)
        if (existsSync(src)) copyFileSync(src, join(customDir, f))
      }

      // ②-a 파일 저장소 복사 — 개별 실패(락 등)가 다음 단계를 막지 않게 각각 보호
      for (const d of ['library', 'refs']) {
        try {
          const src = join(sharedDir, d)
          if (existsSync(src)) await cp(src, join(customDir, d), { recursive: true, force: true })
        } catch (e) {
          console.error(`[migrate-data] ${d} 복사 실패(건너뜀):`, e)
        }
      }
      // ②-b 웹 세션 — 무거운 캐시 폴더 제외(사고 원인), 쿠키/로컬스토리지 등만
      try {
        const src = join(sharedDir, 'Partitions')
        if (existsSync(src)) {
          await cp(src, join(customDir, 'Partitions'), {
            recursive: true,
            force: true,
            filter: (p) => !HEAVY_CACHE_DIRS.has(basename(p))
          })
        }
      } catch (e) {
        console.error('[migrate-data] Partitions 복사 실패(건너뜀):', e)
      }

      // ③ 복사해온 DB의 절대 경로 재작성 — 실패해도 치명적이지 않음 (공유 폴더가 남아있으면 동작)
      try {
        rewriteAbsolutePaths(join(customDir, 'nais3.db'), sharedDir, customDir)
        // 첫 실행 안내 플래그 — 렌더러가 "폴더가 옮겨졌다"는 1회성 안내창을 띄우게
        setDbFlag(join(customDir, 'nais3.db'), 'folder_moved_notice', '1')
      } catch (e) {
        console.error('[migrate-data] 경로 재작성 실패(건너뜀):', e)
      }

      // ④ 공식 NAIS3 복구 — 남의 앱 살리기(best-effort). 실패해도 마커는 쓴다
      try {
        repairOfficialDb(sharedDir)
      } catch (e) {
        console.error('[migrate-data] 공식 DB 복구 실패(건너뜀):', e)
      }
    }
    writeFileSync(marker, new Date().toISOString())
  } catch (e) {
    // DB 복사 실패 — 마커를 쓰지 않으므로 다음 실행에서 재시도. 앱 자체는 계속 뜬다
    console.error('[migrate-data] 이관 실패:', e)
  }
}

/** 복사된 DB의 settings 테이블에 KV 하나 기록 (렌더러 안내 플래그용) */
function setDbFlag(dbPath: string, key: string, value: string): void {
  if (!existsSync(dbPath)) return
  const db = new Database(dbPath)
  try {
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, value)
  } catch {
    // settings 테이블이 없는 구버전 DB면 무시
  } finally {
    db.close()
  }
}

/** 복사된 DB 안의 "공유 폴더 절대 경로"를 자체 폴더 경로로 치환 (테이블 없으면 조용히 건너뜀) */
function rewriteAbsolutePaths(dbPath: string, fromDir: string, toDir: string): void {
  if (!existsSync(dbPath)) return
  const db = new Database(dbPath)
  try {
    const from = fromDir.endsWith('\\') || fromDir.endsWith('/') ? fromDir : fromDir + '\\'
    const to = toDir.endsWith('\\') || toDir.endsWith('/') ? toDir : toDir + '\\'
    for (const table of ['library_images', 'vibe_images', 'charref_images']) {
      try {
        db.prepare(
          `UPDATE ${table} SET file_path = ? || substr(file_path, ?) WHERE substr(file_path, 1, ?) = ?`
        ).run(to, from.length + 1, from.length, from)
      } catch {
        // 구버전 DB에 테이블이 없을 수 있음
      }
    }
  } finally {
    db.close()
  }
}

// 커스텀과 공식 NAIS3의 DB 스키마가 완전히 같은 마지막 버전.
// 공식·커스텀 모두 v1~v11까지는 동일하고, v12부터 서로 다른 마이그레이션으로 갈라진다
// (공식 v12=라이브러리, v13=정렬, v14=프리셋조각 / 커스텀 v13=variety+, v14=휴지통, v15=번호).
// 따라서 v11 스냅샷은 양쪽 다 열 수 있고, 공식은 이를 자기 v12~ 마이그레이션으로 이어받는다.
const LAST_SHARED_VERSION = 11

/**
 * 공유 폴더의 DB가 커스텀 스키마(공식이 못 여는 버전)로 올라가 있으면,
 * 두 앱이 갈라지기 전(v11) 상태의 pre-migration 백업으로 되돌려 공식 NAIS3를 살린다.
 * 공식은 이 v11 DB를 열어 자신의 v12~ 마이그레이션을 다시 적용하므로 정상 복구된다.
 * - 후보: pre-migration-v{1..11}.db 중 가장 높은 버전 (= 갈라지기 직전 최신 상태)
 * - 현재(커스텀) DB는 backups/custom-final-*.db 로 먼저 보존
 * - 후보가 없으면(처음부터 커스텀만 쓴 사용자 등) 아무것도 하지 않음
 */
function repairOfficialDb(sharedDir: string): void {
  const backupDir = join(sharedDir, 'backups')
  if (!existsSync(backupDir)) return
  const candidates = readdirSync(backupDir)
    .map((f) => {
      const m = /^pre-migration-v(\d+)\.db$/.exec(f)
      return m ? { f, v: Number(m[1]) } : null
    })
    .filter((x): x is { f: string; v: number } => x !== null && x.v >= 1 && x.v <= LAST_SHARED_VERSION)
    .sort((a, b) => b.v - a.v)
  if (candidates.length === 0) return // 갈라지기 전 백업 없음 — 건드리지 않음

  const dbPath = join(sharedDir, 'nais3.db')
  if (!existsSync(dbPath)) return
  // 현재(커스텀 스키마) DB를 안전 보존 후 공식 시절 백업으로 교체
  copyFileSync(dbPath, join(backupDir, `custom-final-${Date.now()}.db`))
  copyFileSync(join(backupDir, candidates[0].f), dbPath)
  // 새 DB와 안 맞는 WAL/SHM 잔재 제거 (남아 있으면 공식 앱이 또 못 연다)
  for (const f of ['nais3.db-wal', 'nais3.db-shm']) {
    const p = join(sharedDir, f)
    if (existsSync(p)) rmSync(p, { force: true })
  }
}
