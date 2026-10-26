// A D1-compatible stand-in over Node's built-in SQLite, for the Worker tests.
// Adapted from MagicalMomentsVacation/tests/helpers/fakeD1.ts.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

class FakeStatement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...values) {
    return new FakeStatement(this.db, this.sql, values.map((v) => (v === undefined ? null : v)));
  }

  async all() {
    return this.allSync();
  }

  allSync() {
    return { results: this.db.prepare(this.sql).all(...this.params), success: true, meta: {} };
  }

  async first(column) {
    const row = this.db.prepare(this.sql).get(...this.params);
    if (!row) return null;
    return column ? row[column] : row;
  }

  async run() {
    return this.runSync();
  }

  runSync() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

export function fakeD1() {
  const db = new DatabaseSync(':memory:');
  const dir = join(import.meta.dirname, '..', '..', 'migrations');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(dir, file), 'utf8'));
  }
  return {
    prepare: (sql) => new FakeStatement(db, sql),
    // All-or-nothing and one batch at a time, like D1 (synchronous, so concurrent batches can't interleave).
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const results = statements.map((s) => (/^\s*(select|with)/i.test(s.sql) ? s.allSync() : s.runSync()));
        db.exec('COMMIT');
        return results;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    async exec(sql) {
      db.exec(sql);
      return { count: 1, duration: 0 };
    },
  };
}
