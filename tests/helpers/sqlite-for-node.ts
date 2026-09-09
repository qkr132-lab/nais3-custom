// Test adapter only. Production runs Electron's native better-sqlite3 in a worker.
// Node 24's SQLite lets Vitest query the exact shipped indexes without rebuilding
// (and breaking) Electron's native ABI.
import { DatabaseSync } from 'node:sqlite'
export class TestDatabase extends DatabaseSync {
  constructor(path: string) {
    super(path, { readOnly: true })
  }
  pragma(statement: string): void {
    this.exec(`PRAGMA ${statement}`)
  }
}
