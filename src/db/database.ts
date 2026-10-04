import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './migrations.js';

export type Db = DatabaseSync;

/** Opens (and migrates) the SQLite database. Pass ":memory:" for tests. */
export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);');
  const applied = new Set((db.prepare('SELECT id FROM schema_migrations').all() as { id: number }[]).map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    transaction(db, () => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, new Date().toISOString());
    });
  }
}

/** Nesting depth per connection (savepoints for nested calls). */
const depths = new WeakMap<Db, number>();

/** Best-effort undo; a secondary failure must not mask the original error. */
function rollbackQuietly(db: Db, top: boolean, savepoint: string): void {
  try {
    if (top) {
      if (db.isTransaction) db.exec('ROLLBACK');
    } else {
      db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
    }
  } catch {
    // ignore: the original error is rethrown by the caller
  }
}

/**
 * Runs fn inside a transaction (supports nesting via savepoints). The depth counter is restored exactly once
 * on every path, and a failed COMMIT (disk full, I/O error, deferred constraint) never leaves the connection
 * stuck inside an open transaction.
 */
export function transaction<T>(db: Db, fn: () => T): T {
  const depth = depths.get(db) ?? 0;
  const top = depth === 0;
  const savepoint = `sp_${depth}`;
  // Self-heal: an outer transaction left open by an earlier failure would swallow every later write.
  if (top && db.isTransaction) rollbackQuietly(db, true, savepoint);
  db.exec(top ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
  depths.set(db, depth + 1);
  let result: T;
  try {
    result = fn();
  } catch (err) {
    depths.set(db, depth);
    rollbackQuietly(db, top, savepoint);
    throw err;
  }
  depths.set(db, depth);
  try {
    db.exec(top ? 'COMMIT' : `RELEASE ${savepoint}`);
  } catch (err) {
    rollbackQuietly(db, top, savepoint);
    throw err;
  }
  return result;
}

export const nowIso = (): string => new Date().toISOString();

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text == null || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
