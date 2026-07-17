import Database from 'better-sqlite3'
import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { migrations, reconcileSchema } from './migrations'

/** 현재 시각(ms) — 자동 백업 주기 판정용 (Date.now는 메인 프로세스에서 정상 동작) */
function nowMs(): number {
  return Date.now()
}

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!db) throw new Error('DB not initialized — call initDb() first')
  return db
}

export function getDbPath(): string {
  return join(app.getPath('userData'), 'nais3.db')
}

/**
 * DB 열기 + 마이그레이션.
 *
 * 안전장치 (NAIS2 세이브 유실 문제의 근본 대책):
 * - WAL 모드: 크래시 시에도 커밋된 데이터 보존
 * - 마이그레이션 필요 시 실행 전 파일 백업 자동 생성 (pre-migration-v{N}.db)
 * - 각 마이그레이션은 개별 트랜잭션: 실패하면 해당 버전 이전 상태로 남고 앱은 에러 표면화
 */
export function initDb(): { version: number; path: string } {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  const path = getDbPath()

  db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  const current = db.pragma('user_version', { simple: true }) as number
  const target = migrations.length

  if (current < target) {
    if (current > 0 && existsSync(path)) {
      backupBeforeMigration(path, current)
    }
    for (let v = current; v < target; v++) {
      const migrate = db.transaction(() => {
        migrations[v](db!)
        db!.pragma(`user_version = ${v + 1}`)
      })
      migrate()
    }
  } else if (current > target) {
    // 다운그레이드된 앱이 미래 버전 DB를 여는 상황 — 조용히 진행하면 데이터가 깨진다
    throw new Error(
      `DB version ${current} is newer than app supports (${target}). ` +
        'NAIS3를 최신 버전으로 업데이트하세요.'
    )
  }

  // user_version이 (공식 NAIS3와의 충돌 등으로) 실제 스키마와 어긋난 DB 자가복구 — 항상 실행, 정상 DB엔 no-op
  reconcileSchema(db)

  return { version: target, path }
}

function backupBeforeMigration(path: string, fromVersion: number): void {
  const backupDir = join(app.getPath('userData'), 'backups')
  mkdirSync(backupDir, { recursive: true })
  copyFileSync(path, join(backupDir, `pre-migration-v${fromVersion}.db`))
  pruneBackups(backupDir, 10)
}

function pruneBackups(backupDir: string, keep: number): void {
  const files = readdirSync(backupDir)
    .filter((f) => f.endsWith('.db'))
    .sort()
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    rmSync(join(backupDir, f))
  }
}

/** 백업 폴더 총 용량이 상한을 넘으면 오래된 것부터 삭제 (최신 minKeep개는 항상 보존).
 *  maxBytes <= 0 = 무제한 (용량 정리 안 함) */
function pruneBackupsBySize(backupDir: string, maxBytes: number, minKeep = 3): void {
  if (maxBytes <= 0) return
  const files = readdirSync(backupDir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => {
      const st = statSync(join(backupDir, f))
      return { f, size: st.size, mtime: st.mtimeMs }
    })
    .sort((a, b) => a.mtime - b.mtime) // 오래된 것 먼저
  let total = files.reduce((s, x) => s + x.size, 0)
  let i = 0
  while (total > maxBytes && files.length - i > minKeep) {
    rmSync(join(backupDir, files[i].f))
    total -= files[i].size
    i++
  }
}

/** 백업 폴더 현황 (설정 UI 표시용) */
export function backupInfo(): { dir: string; count: number; totalBytes: number } {
  const dir = join(app.getPath('userData'), 'backups')
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.db'))
    const totalBytes = files.reduce((s, f) => s + statSync(join(dir, f)).size, 0)
    return { dir, count: files.length, totalBytes }
  } catch {
    return { dir, count: 0, totalBytes: 0 }
  }
}

/** 설정된 백업 용량 상한(MB) — 기본 512, 0 = 무제한 */
function backupMaxBytes(): number {
  const db = getDb()
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'backup_max_mb'`).get() as
    | { value: string }
    | undefined
  const mb = Number(row?.value ?? '512')
  return Number.isFinite(mb) ? mb * 1024 * 1024 : 512 * 1024 * 1024
}

/** 주기 백업용: 압축 정리된 스냅샷을 원자적으로 생성.
 *  개수(30개) + 총 용량(설정 backup_max_mb, 기본 512MB) 이중 상한으로 정리 */
export function backupNow(): string {
  const backupDir = join(app.getPath('userData'), 'backups')
  mkdirSync(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = join(backupDir, `auto-${stamp}.db`)
  getDb().exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`)
  pruneBackups(backupDir, 30)
  pruneBackupsBySize(backupDir, backupMaxBytes())
  return dest
}

/**
 * 앱 시작 시 자동 백업 (커스텀 — 하루 1회). 마지막 auto-* 스냅샷이 20시간 넘게 오래됐으면 새로 뜬다.
 * 씬/캐릭터/프롬프트/조각/설정(커스텀 확장 포함) 전부가 이 DB에 있으므로 통째로 지켜진다.
 */
export function autoBackupIfDue(): void {
  try {
    const backupDir = join(app.getPath('userData'), 'backups')
    mkdirSync(backupDir, { recursive: true })
    const autos = readdirSync(backupDir)
      .filter((f) => f.startsWith('auto-') && f.endsWith('.db'))
      .sort()
    const last = autos[autos.length - 1]
    if (last) {
      const lastTime = statSync(join(backupDir, last)).mtimeMs
      if (nowMs() - lastTime < 20 * 60 * 60 * 1000) return // 아직 최근 백업 있음
    }
    backupNow()
  } catch {
    // 백업 실패가 앱 시작을 막지 않게
  }
}

export function closeDb(): void {
  db?.close()
  db = null
}
