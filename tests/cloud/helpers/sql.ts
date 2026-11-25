// 테스트 전용 — DO 의 ctx.storage.sql 과 같은 모양(exec(query, ...bindings) → { toArray, one, rowsWritten })을
// Node 24 의 node:sqlite 로 흉내 낸다. 실제 DO 가 거절하는 것(undefined·boolean 바인딩, 쿼리당 100개 초과)은
// 여기서도 던져서, 테스트가 통과하는데 실서버에서만 깨지는 일을 줄인다.
// 무료 요금제 지표(쓰기 행 · 반환 행 · 인덱스 없이 훑은 표)도 센다 — stats() / resetStats().
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { SqlCursorLike, SqlLike, SqlValue } from '../../../cloud/src/core/deps'

/** 작은따옴표 문자열 밖의 `;` 로만 문장을 나눈다 */
function splitStatements(query: string): string[] {
  const out: string[] = []
  let current = ''
  let quoted = false
  for (const ch of query) {
    if (ch === "'") quoted = !quoted
    if (ch === ';' && !quoted) {
      if (current.trim()) out.push(current)
      current = ''
    } else current += ch
  }
  if (current.trim()) out.push(current)
  return out
}

function countPlaceholders(statement: string): number {
  let count = 0
  let quoted = false
  for (const ch of statement) {
    if (ch === "'") quoted = !quoted
    else if (ch === '?' && !quoted) count++
  }
  return count
}

function checkBinding(value: unknown): SQLInputValue {
  if (value === undefined)
    throw new TypeError('SQL 바인딩에 undefined 를 넣을 수 없습니다 (null 로)')
  if (typeof value === 'boolean')
    throw new TypeError('SQL 바인딩에 boolean 을 넣을 수 없습니다 (0/1 로)')
  if (value === null || typeof value === 'string' || typeof value === 'number') return value
  throw new TypeError(`지원하지 않는 SQL 바인딩: ${typeof value}`)
}

/** 시험이 재는 DO 무료 요금제 지표 */
export interface SqlStats {
  /** INSERT/UPDATE/DELETE 가 바꾼 표 행 수 (node:sqlite changes()) — 실제 DO 는 여기에 인덱스 항목도 센다 */
  written: number
  /** SELECT 가 돌려준 행 수 */
  returned: number
  /** 쿼리 계획이 인덱스 없이 표를 처음부터 끝까지 훑는다고 한 횟수 (표 이름별) */
  fullScans: Record<string, number>
  /** 그 전체 훑기가 읽는 행 수의 합 (훑는 순간 표의 행 수 기준) */
  scannedRows: number
}

export interface TestSql extends SqlLike {
  readonly db: DatabaseSync
  /** 지표를 0 으로 돌리고 이 시점부터 센다 */
  resetStats(): void
  stats(): SqlStats
}

/**
 * 쿼리 계획 줄에서 표 전체를 훑는 표 이름을 뽑는다 — `SCAN images`, `SCAN images USING COVERING INDEX …`(COUNT 처럼 인덱스를 끝까지 읽음).
 * `SCAN images USING INDEX …` 는 정렬만 인덱스로 받는 것이라 LIMIT 에서 멈추므로 훑기로 세지 않는다
 */
function scannedTables(plan: string[]): string[] {
  const tables: string[] = []
  for (const detail of plan) {
    // `SCAN 2-ROW VALUES CLAUSE` · `SCAN CONSTANT ROW` · `SCAN SUBQUERY 1` 은 표가 아니다 — 이름은 글자로 시작해야 한다
    const m = /^SCAN (?:TABLE )?([A-Za-z_]\w*)/.exec(detail)
    if (!m || /^(CONSTANT|SUBQUERY|VALUES)$/i.test(m[1])) continue
    if (/ USING INDEX /.test(detail)) continue
    tables.push(m[1])
  }
  return tables
}

const MEASURED = /^\s*(select|with|update|delete|insert)\b/i

export function createTestSql(): TestSql {
  const db = new DatabaseSync(':memory:')
  let counted: SqlStats = { written: 0, returned: 0, fullScans: {}, scannedRows: 0 }
  const isTable = (name: string): boolean =>
    db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !=
    undefined
  const rowCount = (table: string): number =>
    Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()!.c)

  const sql: TestSql = {
    db,
    resetStats() {
      counted = { written: 0, returned: 0, fullScans: {}, scannedRows: 0 }
    },
    stats() {
      return { ...counted, fullScans: { ...counted.fullScans } }
    },
    exec<T extends Record<string, SqlValue> = Record<string, SqlValue>>(
      query: string,
      ...bindings: unknown[]
    ): SqlCursorLike<T> {
      const statements = splitStatements(query)
      let offset = 0
      let rows: T[] = []
      let rowsWritten = 0
      for (const statement of statements) {
        const n = countPlaceholders(statement)
        if (n > 100) throw new Error('too many SQL variables (DO 는 쿼리당 100개까지)')
        const args = bindings.slice(offset, offset + n).map(checkBinding)
        if (args.length !== n) throw new Error(`바인딩 개수 불일치: 필요 ${n}, 받은 ${args.length}`)
        offset += n
        const stmt = db.prepare(statement)
        // 읽기 행의 아래 한계 — 인덱스 없이 표 전체를 훑는 쿼리를 계획에서 찾아 그 표의 행 수를 더한다
        if (MEASURED.test(statement)) {
          const plan = db
            .prepare(`EXPLAIN QUERY PLAN ${statement}`)
            .all(...args)
            .map((row) => String((row as { detail?: unknown }).detail ?? ''))
          for (const table of scannedTables(plan)) {
            if (!isTable(table)) continue
            counted.fullScans[table] = (counted.fullScans[table] ?? 0) + 1
            counted.scannedRows += rowCount(table)
          }
        }
        const reads =
          /^\s*(select|with|pragma)\b/i.test(statement) || /\breturning\b/i.test(statement)
        if (reads) {
          rows = stmt.all(...args).map((row) => ({ ...row })) as T[]
          counted.returned += rows.length
          if (/^\s*(insert|update|delete)\b/i.test(statement)) {
            rowsWritten = Number(db.prepare('SELECT changes() AS c').get()!.c)
          }
        } else {
          rows = []
          rowsWritten = Number(stmt.run(...args).changes)
        }
        counted.written += rowsWritten
      }
      if (offset !== bindings.length) throw new Error('바인딩이 남았습니다')
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`one(): 행이 ${rows.length}개입니다`)
          return rows[0]
        },
        rowsWritten
      }
    }
  }
  return sql
}
