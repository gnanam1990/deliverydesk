import type { Db } from '../db/db.ts';
import { all, one, tx } from '../db/db.ts';
import { newId, sha256 } from '../ids.ts';
import { now } from '../clock.ts';
import type { InboxEvent, Merchant } from './types.ts';

/**
 * Connector event handlers, keyed by event `kind`. M02+ register the
 * domain processors; intake itself only authenticates and persists.
 */
export type EventHandler = (db: Db, merchant: Merchant, event: ConnectorEvent) => string;

export interface ConnectorEvent {
  event_id: string;
  kind: string;
  order_external_id?: string;
  payload: Record<string, unknown>;
}

const handlers = new Map<string, EventHandler>();

export function registerEventHandler(kind: string, fn: EventHandler): void {
  handlers.set(kind, fn);
}

export interface IngestResult {
  status: 'processed' | 'duplicate' | 'unhandled';
  inboxId: string;
  detail: string;
}

/**
 * Persist a verified connector event and dispatch it. Dedupe on
 * (merchant_id, event_id) gives callback replay protection at the storage
 * layer; reordered events are applied by revision rules in the handlers.
 * Called only after signature verification (SECURITY.md).
 */
export function ingestEvent(db: Db, merchant: Merchant, event: ConnectorEvent): IngestResult {
  return tx(db, () => {
    const payloadJson = JSON.stringify(event.payload);
    const prior = one<InboxEvent>(
      db,
      'SELECT * FROM inbox_events WHERE merchant_id = ? AND event_id = ?',
      merchant.id,
      event.event_id,
    );
    if (prior) {
      return {
        status: 'duplicate',
        inboxId: prior.id,
        detail: `event ${event.event_id} already received`,
      };
    }
    const row: InboxEvent = {
      id: newId('inb'),
      merchant_id: merchant.id,
      event_id: event.event_id,
      kind: event.kind,
      payload: payloadJson,
      payload_hash: sha256(payloadJson),
      received_at: now(),
      processed_at: null,
      result: null,
    };
    db.prepare(
      `INSERT INTO inbox_events (id, merchant_id, event_id, kind, payload, payload_hash, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.merchant_id,
      row.event_id,
      row.kind,
      row.payload,
      row.payload_hash,
      row.received_at,
    );

    const handler = handlers.get(event.kind);
    let result: string;
    let status: IngestResult['status'];
    if (!handler) {
      result = `no handler for kind '${event.kind}'`;
      status = 'unhandled';
    } else {
      try {
        result = handler(db, merchant, event);
        status = 'processed';
      } catch (e) {
        result = `handler error: ${(e as Error).message}`;
        status = 'unhandled';
      }
    }
    db.prepare('UPDATE inbox_events SET processed_at = ?, result = ? WHERE id = ?').run(
      status === 'processed' ? now() : null,
      result,
      row.id,
    );
    return { status, inboxId: row.id, detail: result };
  });
}

export function listInbox(db: Db, merchantId: string): InboxEvent[] {
  return all<InboxEvent>(
    db,
    'SELECT * FROM inbox_events WHERE merchant_id = ? ORDER BY received_at',
    merchantId,
  );
}

export function unprocessedCount(db: Db, merchantId: string): number {
  const r = one<{ n: number }>(
    db,
    'SELECT COUNT(*) AS n FROM inbox_events WHERE merchant_id = ? AND processed_at IS NULL',
    merchantId,
  );
  return r?.n ?? 0;
}
