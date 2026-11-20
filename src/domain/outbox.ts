import type { Db } from '../db/db.ts';
import { all, one } from '../db/db.ts';
import type { Config } from '../config.ts';
import { newId, sha256 } from '../ids.ts';
import { now, isoFromNow } from '../clock.ts';
import type { OutboxRow } from './types.ts';

/**
 * Transactional outbox: a domain decision and the side-effect intent are
 * written in the same transaction (TDD "Architecture"). The worker drains
 * pending actions and records a durable result.
 */
export function enqueue(
  db: Db,
  kind: string,
  payload: Record<string, unknown>,
  opts: { actionId?: string; delayMs?: number } = {},
): string {
  const json = JSON.stringify(payload);
  const actionId = opts.actionId ?? newId('act');
  db.prepare(
    `INSERT INTO outbox (action_id, kind, payload, payload_hash, state, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(actionId, kind, json, sha256(json), isoFromNow(opts.delayMs ?? 0), now(), now());
  return actionId;
}

export type OutboxDispatcher = (
  db: Db,
  config: Config,
  payload: Record<string, unknown>,
) => Promise<{ ok: boolean; result?: string; retryAfterMs?: number }>;

const dispatchers = new Map<string, OutboxDispatcher>();

export function registerOutboxDispatcher(kind: string, fn: OutboxDispatcher): void {
  dispatchers.set(kind, fn);
}

export function pendingCount(db: Db): number {
  const r = one<{ n: number }>(
    db,
    "SELECT COUNT(*) AS n FROM outbox WHERE state = 'pending'",
  );
  return r?.n ?? 0;
}

/** Drain due outbox rows once. Returns count of dispatched actions. */
export async function drainOutbox(db: Db, config: Config): Promise<number> {
  const due = all<OutboxRow>(
    db,
    "SELECT * FROM outbox WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY seq LIMIT 20",
    now(),
  );
  let done = 0;
  for (const row of due) {
    const dispatcher = dispatchers.get(row.kind);
    if (!dispatcher) {
      db.prepare("UPDATE outbox SET state = 'failed', result = ?, updated_at = ? WHERE seq = ?").run(
        `no dispatcher for kind '${row.kind}'`,
        now(),
        row.seq,
      );
      continue;
    }
    // Mark dispatched-before-work so a crash mid-effect shows an attempt
    // rather than a silent pending row.
    db.prepare('UPDATE outbox SET attempts = attempts + 1, updated_at = ? WHERE seq = ?').run(
      now(),
      row.seq,
    );
    try {
      const res = await dispatcher(db, config, JSON.parse(row.payload));
      if (res.ok) {
        db.prepare("UPDATE outbox SET state = 'done', result = ?, updated_at = ? WHERE seq = ?").run(
          res.result ?? 'ok',
          now(),
          row.seq,
        );
        done++;
      } else if (res.retryAfterMs != null) {
        db.prepare("UPDATE outbox SET next_attempt_at = ?, result = ?, updated_at = ? WHERE seq = ?").run(
          isoFromNow(res.retryAfterMs),
          res.result ?? 'retry',
          now(),
          row.seq,
        );
      } else {
        db.prepare("UPDATE outbox SET state = 'failed', result = ?, updated_at = ? WHERE seq = ?").run(
          res.result ?? 'failed',
          now(),
          row.seq,
        );
      }
    } catch (e) {
      db.prepare("UPDATE outbox SET next_attempt_at = ?, result = ?, updated_at = ? WHERE seq = ?").run(
        isoFromNow(5000),
        `dispatcher threw: ${(e as Error).message}`,
        now(),
        row.seq,
      );
    }
  }
  return done;
}
