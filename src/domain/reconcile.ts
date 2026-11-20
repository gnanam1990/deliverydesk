import { all, one, tx } from '../db/db.ts';
import { now } from '../clock.ts';
import { handlerFor, type ConnectorEvent, type DomainCtx } from './inbox.ts';
import type { InboxEvent, Merchant } from './types.ts';

/**
 * Inbox reconciliation (FR-07/INV-07). A handler crash leaves the verified
 * event persisted but unprocessed; a later worker replays that same stored
 * event, preserving its event id, order scope and payload rather than
 * treating the retry as a new callback.
 */
export function reconcileInbox(ctx: DomainCtx): number {
  const pending = all<InboxEvent>(
    ctx.db,
    'SELECT * FROM inbox_events WHERE processed_at IS NULL ORDER BY received_at, id',
  );
  let processed = 0;
  for (const row of pending) {
    const merchant = one<Merchant>(
      ctx.db,
      'SELECT * FROM merchants WHERE id = ?',
      row.merchant_id,
    );
    if (!merchant) {
      mark(row, 'merchant missing');
      continue;
    }
    const handler = handlerFor(row.kind);
    if (!handler) {
      mark(row, `no handler for kind '${row.kind}'`);
      continue;
    }
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const event: ConnectorEvent = {
      event_id: row.event_id,
      kind: row.kind,
      order_external_id: row.order_external_id ?? undefined,
      payload,
    };
    try {
      const result = tx(ctx.db, () => handler(ctx, merchant, event));
      ctx.db.prepare('UPDATE inbox_events SET processed_at = ?, result = ? WHERE id = ?').run(
        now(),
        result,
        row.id,
      );
      processed++;
    } catch (e) {
      mark(row, `handler error: ${(e as Error).message}`);
    }
  }
  return processed;

  function mark(row: InboxEvent, result: string): void {
    ctx.db.prepare('UPDATE inbox_events SET result = ? WHERE id = ?').run(result, row.id);
  }
}
