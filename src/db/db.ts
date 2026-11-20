import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { migrate } from './migrate.ts';

export type Db = DatabaseSync;

export function openDb(dbPath: string, runMigrations = true): Db {
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (runMigrations) migrate(db);
  return db;
}

const txDepth = new WeakMap<Db, number>();

/**
 * Run `fn` inside an IMMEDIATE write transaction. BEGIN IMMEDIATE acquires the
 * database write lock up front, serializing conflicting claims (retrieval vs
 * refund) the way a per-order exclusion lock does (TDD "Decision procedure").
 * Nested calls degrade to SAVEPOINTs so domain operations compose.
 */
export function tx<T>(db: Db, fn: () => T): T {
  const depth = txDepth.get(db) ?? 0;
  if (depth > 0) {
    const sp = `dd_sp_${depth}`;
    db.exec(`SAVEPOINT ${sp}`);
    txDepth.set(db, depth + 1);
    try {
      const out = fn();
      db.exec(`RELEASE SAVEPOINT ${sp}`);
      return out;
    } catch (e) {
      db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
      db.exec(`RELEASE SAVEPOINT ${sp}`);
      throw e;
    } finally {
      txDepth.set(db, depth);
    }
  }
  db.exec('BEGIN IMMEDIATE');
  txDepth.set(db, 1);
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw e;
  } finally {
    txDepth.delete(db);
  }
}

/** Read-only convenience. */
export function one<T>(db: Db, sql: string, ...args: (string | number | null)[]): T | undefined {
  return db.prepare(sql).get(...args) as T | undefined;
}

export function all<T>(db: Db, sql: string, ...args: (string | number | null)[]): T[] {
  return db.prepare(sql).all(...args) as T[];
}
