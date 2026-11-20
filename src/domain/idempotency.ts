import type { Db } from '../db/db.ts';
import { one } from '../db/db.ts';
import { sha256 } from '../ids.ts';
import { now } from '../clock.ts';
import { conflict } from './errors.ts';

interface IdemRow {
  key: string;
  actor_key: string;
  endpoint: string;
  payload_hash: string;
  status: string;
  response: string | null;
  created_at: string;
}

export interface StoredResponse {
  status: number;
  body: unknown;
}

/**
 * Durable idempotency for side-effecting commands (TDD "HTTP and worker
 * boundaries"). Identical retry returns the stored operation reference; a
 * different payload under the same key yields a conflict.
 */
export function withIdempotency(
  db: Db,
  input: { key: string | undefined; actorKey: string; endpoint: string; payload: unknown },
  fn: () => StoredResponse,
): StoredResponse {
  if (!input.key) return fn();
  const endpoint = input.endpoint;
  const payloadHash = sha256(JSON.stringify(input.payload ?? null));
  const existing = one<IdemRow>(
    db,
    'SELECT * FROM idempotency_keys WHERE key = ? AND actor_key = ? AND endpoint = ?',
    input.key,
    input.actorKey,
    endpoint,
  );
  if (existing) {
    if (existing.payload_hash !== payloadHash) {
      throw conflict('idempotency key reused with a different payload', {
        endpoint,
      });
    }
    if (existing.response != null) {
      return JSON.parse(existing.response) as StoredResponse;
    }
    // Recorded but unfinished (crash between claim and response) — treat as in-flight.
    throw conflict('operation with this idempotency key is still in flight');
  }
  db.prepare(
    `INSERT INTO idempotency_keys (key, actor_key, endpoint, payload_hash, status, response, created_at)
     VALUES (?, ?, ?, ?, 'in_flight', NULL, ?)`,
  ).run(input.key, input.actorKey, endpoint, payloadHash, now());
  try {
    const res = fn();
    db.prepare('UPDATE idempotency_keys SET status = ?, response = ? WHERE key = ? AND actor_key = ? AND endpoint = ?').run(
      'completed',
      JSON.stringify(res),
      input.key,
      input.actorKey,
      endpoint,
    );
    return res;
  } catch (e) {
    db.prepare('DELETE FROM idempotency_keys WHERE key = ? AND actor_key = ? AND endpoint = ?').run(
      input.key,
      input.actorKey,
      endpoint,
    );
    throw e;
  }
}
