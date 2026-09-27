import Database from 'better-sqlite3'
import { existsSync, readdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import type { BackupDbFile, BackupPreset } from '../../shared/types'
import { getDb } from '../db'

/**
 * 백업 DB에서 씬 프리셋 가져오기 (커스텀).
 *
 * 프리셋 휴지통이 생기기 전엔 프리셋을 지우면 안의 씬까지 곧바로 사라졌다.
 * 자동 백업(backups/*.db)에는 남아 있으니 거기서 골라 지금 DB로 옮겨 온다.
 * - 백업은 읽기 전용으로만 연다. 수 GB여도 필요한 행만 읽는다.
 * - 백업이 옛 스키마일 수 있다 — 양쪽에 다 있는 열만 옮기고, 없는 열은 지금 기본값.
 * - 원래 id가 비어 있으면 그대로 쓰고, 차 있으면 새 id를 받는다. 씬별 설정 키도 최종 id로 옮긴다.
 */

/** 백업 폴더의 .db 파일 — 최근 것부터 */
export function listBackupFiles(dir: string): BackupDbFile[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const files: BackupDbFile[] = []
  for (const name of names) {
    if (!name.endsWith('.db')) continue
    try {
      const st = statSync(join(dir, name))
      if (st.isFile()) files.push({ name, size: st.size, mtime: st.mtimeMs })
    } catch {
      // 읽는 사이 지워진 파일은 건너뜀
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime)
}

type Row = Record<string, unknown>

/**
 * 백업을 읽기 전용으로 열어 run을 돌린다.
 * WAL 표시가 된 사본(pre-migration-*)은 읽기 전용이어도 SQLite가 옆에 -wal/-shm을 만든다 —
 * 원래 없던 것만 닫은 뒤 치운다. 백업 파일 자체는 건드리지 않는다.
 */
function withBackup<T>(path: string, run: (backup: Database.Database) => T): T {
  const sidecars = [`${path}-wal`, `${path}-shm`].filter((f) => !existsSync(f))
  const backup = new Database(path, { readonly: true, fileMustExist: true })
  try {
    return run(backup)
  } finally {
    backup.close()
    for (const f of sidecars) {
      try {
        if (existsSync(f)) unlinkSync(f)
      } catch {
        // 남아도 백업 내용엔 지장 없음
      }
    }
  }
}

function columnsOf(db: Pick<Database.Database, 'prepare'>, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
}

const quote = (col: string): string => `"${col.replace(/"/g, '""')}"`

/** 백업 스키마 — 프리셋·씬 표가 없거나 씬에 소속 열(v8 이전)이 없으면 null */
interface BackupShape {
  presetCols: string[]
  sceneCols: string[]
  /** 가져올 씬 조건 — 살아 있던 씬 + 프리셋과 함께 휴지통에 간 씬(삭제 시각이 프리셋과 같음).
   *  따로 지운 씬은 뺀다. 백업에 휴지통 열이 없으면 조건 없음 */
  sceneAlive: string
  kindExpr: string
}

function shapeOf(backup: Database.Database): BackupShape | null {
  const presetCols = columnsOf(backup, 'scene_presets')
  const sceneCols = columnsOf(backup, 'gen_scenes')
  if (!presetCols.includes('name') || !sceneCols.includes('preset_id')) return null
  return {
    presetCols,
    sceneCols,
    sceneAlive: !sceneCols.includes('deleted_at')
      ? ''
      : presetCols.includes('deleted_at')
        ? ' AND (deleted_at IS NULL OR deleted_at = (SELECT sp.deleted_at FROM scene_presets sp WHERE sp.id = gen_scenes.preset_id))'
        : ' AND deleted_at IS NULL',
    kindExpr: presetCols.includes('kind') ? 'kind' : "'scene'"
  }
}

const kindOf = (v: unknown): 'scene' | 'background' => (v === 'background' ? 'background' : 'scene')

/**
 * 백업 속 프리셋 목록. 백업 때 휴지통에 있던 프리셋도 넣는다 — 휴지통에서 자동 영구 삭제된 뒤엔
 * 백업이 유일한 복구 길이다. sceneCount = 가져오면 함께 올 씬 수.
 * exists = 지금 같은 종류·같은 이름의 살아 있는 프리셋이 있음 — id는 새 프리셋이 물려받을 수 있어 보지 않는다
 */
export function listBackupPresets(path: string): BackupPreset[] {
  return withBackup(path, (backup) => {
    const shape = shapeOf(backup)
    if (!shape) return []
    const rows = backup
      .prepare(
        `SELECT id, name, ${shape.kindExpr} AS kind,
                (SELECT COUNT(*) FROM gen_scenes WHERE preset_id = p.id${shape.sceneAlive}) AS sceneCount
         FROM scene_presets p
         ORDER BY ${shape.kindExpr}, sort_order, id`
      )
      .all() as { id: number; name: string; kind: unknown; sceneCount: number }[]
    const live = getDb().prepare(
      'SELECT 1 FROM scene_presets WHERE deleted_at IS NULL AND kind = ? AND name = ?'
    )
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: kindOf(r.kind),
      sceneCount: r.sceneCount,
      exists: !!live.get(kindOf(r.kind), r.name)
    }))
  })
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (raw == null) return null
  try {
    const v = JSON.parse(raw) as unknown
    return isObject(v) ? v : null
  } catch {
    return null
  }
}

/**
 * 고른 프리셋과 그 안의 씬을 한 트랜잭션으로 가져온다. 휴지통에 있던 프리셋도 살아 있는 것으로.
 * 프리셋은 같은 종류의 맨 끝에 붙는다. 씬 순서는 백업 그대로.
 * 씬별 설정(scene_extras의 additions·transparentBackgrounds)과 프리셋별 R2 동기화 설정도
 * 최종 id로 옮긴다 — 지금 이미 있는 항목은 덮어쓰지 않는다.
 */
export function importBackupPresets(
  path: string,
  presetIds: number[]
): { presets: number; scenes: number } {
  const wanted = [...new Set(presetIds)].filter((id) => Number.isInteger(id))
  if (wanted.length === 0) return { presets: 0, scenes: 0 }
  return withBackup(path, (backup) => {
    const shape = shapeOf(backup)
    if (!shape) return { presets: 0, scenes: 0 }
    const db = getDb()

    // 옮길 열 = 양쪽에 다 있는 열. id·소속·순서·삭제 표시는 따로 정한다
    const nowPresetCols = new Set(columnsOf(db, 'scene_presets'))
    const nowSceneCols = new Set(columnsOf(db, 'gen_scenes'))
    const presetCopy = shape.presetCols.filter(
      (c) => nowPresetCols.has(c) && !['id', 'sort_order', 'deleted_at'].includes(c)
    )
    const sceneCopy = shape.sceneCols.filter(
      (c) => nowSceneCols.has(c) && !['id', 'preset_id', 'deleted_at'].includes(c)
    )

    const presetRows = backup
      .prepare(
        `SELECT * FROM scene_presets WHERE id IN (${wanted.map(() => '?').join(',')})
         ORDER BY ${shape.kindExpr}, sort_order, id`
      )
      .all(...wanted) as Row[]
    if (presetRows.length === 0) return { presets: 0, scenes: 0 }

    const hasBackupSettings = columnsOf(backup, 'settings').includes('value')
    const backupSetting = (key: string): string | null =>
      hasBackupSettings
        ? ((
            backup.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
              { value: string } | undefined
          )?.value ?? null)
        : null
    const readSetting = (key: string): string | null =>
      (
        db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
          { value: string } | undefined
      )?.value ?? null
    const writeSetting = (key: string, value: string): void => {
      db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).run(key, value)
    }

    const insertRow = (table: string, cols: string[], values: unknown[]): number =>
      Number(
        db
          .prepare(
            `INSERT INTO ${table} (${cols.map(quote).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
          )
          .run(...values).lastInsertRowid
      )

    // 원래 id가 빈 것부터 넣는다 — 새 id(맨 끝 번호)가 먼저 들어가 그 자리를 차지하지 않게
    const keepFirst = <T extends { keep: boolean }>(items: T[]): T[] => [
      ...items.filter((x) => x.keep),
      ...items.filter((x) => !x.keep)
    ]

    let sceneTotal = 0
    const presetMap = new Map<number, number>()
    const sceneMaps = new Map<number, Map<number, number>>()

    db.transaction(() => {
      // ── 프리셋 ──
      const lastOrder = new Map<string, number>()
      const nextOrder = (kind: string): number => {
        const prev =
          lastOrder.get(kind) ??
          (
            db
              .prepare(
                'SELECT COALESCE(MAX(sort_order), -1) AS m FROM scene_presets WHERE kind = ?'
              )
              .get(kind) as { m: number }
          ).m
        lastOrder.set(kind, prev + 1)
        return prev + 1
      }
      const presetTaken = db.prepare('SELECT 1 FROM scene_presets WHERE id = ?')
      const plans = presetRows.map((row) => {
        const id = Number(row.id)
        return {
          row,
          id,
          sortOrder: nextOrder(kindOf(row.kind)),
          // 지운 프리셋의 R2 추적 기록이 남은 id는 비어 있어도 쓰지 않는다 — 되살아난 프리셋의
          // 동기화가 그 기록을 "즐겨찾기 해제"로 읽어 클라우드 사본을 지워 버린다
          keep: !presetTaken.get(id) && readSetting(`r2_sync_state_${id}`) == null
        }
      })
      for (const p of keepFirst(plans)) {
        const cols = [...(p.keep ? ['id'] : []), ...presetCopy, 'sort_order']
        const values = [...(p.keep ? [p.id] : []), ...presetCopy.map((c) => p.row[c]), p.sortOrder]
        presetMap.set(p.id, insertRow('scene_presets', cols, values))
      }

      // ── 씬 (따로 지운 씬은 뺀다. 휴지통 프리셋과 함께 지운 씬은 살아 있는 씬으로 넣는다) ──
      const sceneSql = `SELECT * FROM gen_scenes WHERE preset_id = ?${shape.sceneAlive} ORDER BY sort_order, id`
      const sceneTaken = db.prepare('SELECT 1 FROM gen_scenes WHERE id = ?')
      const keepScene = new Set<number>()
      for (const oldPreset of presetMap.keys()) {
        for (const r of backup
          .prepare(`SELECT id FROM gen_scenes WHERE preset_id = ?${shape.sceneAlive}`)
          .all(oldPreset) as { id: number }[]) {
          if (!sceneTaken.get(r.id)) keepScene.add(r.id)
        }
      }
      for (const keep of [true, false]) {
        for (const [oldPreset, newPreset] of presetMap) {
          const map = sceneMaps.get(oldPreset) ?? new Map<number, number>()
          sceneMaps.set(oldPreset, map)
          for (const s of backup.prepare(sceneSql).iterate(oldPreset) as Iterable<Row>) {
            const id = Number(s.id)
            if (keepScene.has(id) !== keep) continue
            const cols = [...(keep ? ['id'] : []), 'preset_id', ...sceneCopy]
            const values = [...(keep ? [id] : []), newPreset, ...sceneCopy.map((c) => s[c])]
            map.set(id, insertRow('gen_scenes', cols, values))
            sceneTotal++
          }
        }
      }

      // ── 씬별 설정: scene_extras[필드][프리셋 id][씬 id] ──
      const fromExtras = parseObject(backupSetting('scene_extras'))
      const nowRaw = readSetting('scene_extras')
      // 지금 값이 손상돼 있으면 건드리지 않는다 (덮어쓰면 남은 걸 날린다)
      const nowExtras = nowRaw == null ? {} : parseObject(nowRaw)
      if (fromExtras && nowExtras) {
        let changed = false
        for (const field of ['additions', 'transparentBackgrounds']) {
          const src = fromExtras[field]
          if (!isObject(src)) continue
          if (nowExtras[field] !== undefined && !isObject(nowExtras[field])) continue
          for (const [oldPreset, newPreset] of presetMap) {
            const srcScenes = src[String(oldPreset)]
            if (!isObject(srcScenes)) continue
            for (const [oldScene, newScene] of sceneMaps.get(oldPreset) ?? []) {
              if (!Object.hasOwn(srcScenes, String(oldScene))) continue
              const target = (nowExtras[field] ??= {}) as Record<string, unknown>
              if (target[String(newPreset)] !== undefined && !isObject(target[String(newPreset)]))
                continue
              const scenes = (target[String(newPreset)] ??= {}) as Record<string, unknown>
              if (Object.hasOwn(scenes, String(newScene))) continue
              scenes[String(newScene)] = srcScenes[String(oldScene)]
              changed = true
            }
          }
        }
        if (changed) writeSetting('scene_extras', JSON.stringify(nowExtras))
      }

      // ── 프리셋별 R2 동기화 설정 (r2_sync_cfg_{id}) ──
      // 추적 기록(r2_sync_state_)은 옮기지 않는다 — 이미지 id 기준인데 이미지는 가져오지 않는다
      for (const [oldPreset, newPreset] of presetMap) {
        const cfg = backupSetting(`r2_sync_cfg_${oldPreset}`)
        if (cfg == null) continue
        if (
          readSetting(`r2_sync_cfg_${newPreset}`) != null ||
          readSetting(`r2_sync_state_${newPreset}`) != null
        )
          continue
        writeSetting(`r2_sync_cfg_${newPreset}`, cfg)
      }
    })()

    return { presets: presetMap.size, scenes: sceneTotal }
  })
}
