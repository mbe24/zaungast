// The Node SqlDriver: node:sqlite (a Node *builtin* — no npm dependency). Wired as the default only at
// the Node entry (store-api / ingest), so the browser graph never imports node:sqlite. DatabaseSync
// already matches SqlStatement/SqlDatabase structurally; the only behavior added here is `deleteOnClose`,
// which unlinks a throwaway native-built .db on close (formerly ChatStore's tempFile handling).
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import type { SqlDatabase, SqlDriver, SqlStatement } from './sql-driver.js';

class NodeSqlDatabase implements SqlDatabase {
  constructor(
    private readonly db: DatabaseSync,
    private readonly deletePath?: string,
  ) {}
  exec(sql: string): void {
    this.db.exec(sql);
  }
  prepare(sql: string): SqlStatement {
    return this.db.prepare(sql);
  }
  close(): void {
    this.db.close();
    if (this.deletePath) {
      try {
        rmSync(this.deletePath, { force: true, recursive: true });
      } catch {
        /* best-effort cleanup of the native engine's throwaway .db dir */
      }
    }
  }
}

export const nodeSqlDriver: SqlDriver = {
  open(target, opts = {}) {
    const db = opts.readOnly
      ? new DatabaseSync(target, { readOnly: true })
      : new DatabaseSync(target);
    return new NodeSqlDatabase(db, opts.deleteOnClose ? target : undefined);
  },
};
