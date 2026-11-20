import type { App } from '../server.ts';
import { ingestEvent, listInbox } from '../../domain/inbox.ts';
import type { ConnectorEvent } from '../../domain/inbox.ts';
import { badRequest } from '../../domain/errors.ts';
import { tx } from '../../db/db.ts';
import { withIdempotency } from '../../domain/idempotency.ts';
import { actorKey } from '../../domain/auth.ts';
import { unprocessedCount } from '../../domain/inbox.ts';

/**
 * POST /connectors/{merchant}/events — verified merchant callbacks.
 * Signature check happens in server auth resolution BEFORE this handler runs.
 */
export function registerConnectorRoutes(app: App): void {
  app.route('POST', '/connectors/{merchant}/events', {
    auth: { kind: 'connector', merchantParam: 'merchant' },
    handler: (ctx) => {
      const res = tx(ctx.db, () =>
        withIdempotency(
          ctx.db,
          {
            key: ctx.idempotencyKey,
            actorKey: actorKey(ctx.actor!),
            endpoint: `POST /connectors/${ctx.params['merchant']}/events`,
            payload: ctx.body,
          },
          () => {
            const b = (ctx.body ?? {}) as Record<string, unknown>;
            const event: ConnectorEvent = {
              event_id: String(b['event_id'] ?? ''),
              kind: String(b['kind'] ?? ''),
              order_external_id:
                b['order_external_id'] != null ? String(b['order_external_id']) : undefined,
              payload: (b['payload'] ?? {}) as Record<string, unknown>,
            };
            if (!event.event_id || !event.kind) {
              throw badRequest('event_id and kind are required');
            }
            const result = ingestEvent(
              { db: ctx.db, config: ctx.config },
              ctx.connectorMerchant!,
              event,
            );
            return { status: result.status === 'duplicate' ? 200 : 202, body: result };
          },
        ),
      );
      return { status: res.status, json: res.body };
    },
  });

  // Operator inspection of the merchant event inbox (raw receipt evidence).
  app.route('GET', '/connectors/{merchant}/inbox', {
    auth: { kind: 'operator' },
    handler: (ctx) => {
      if (ctx.actor!.merchantId !== ctx.params['merchant']) {
        return { status: 403, json: { code: 'forbidden', message: 'outside your merchant' } };
      }
      const events = listInbox(ctx.db, ctx.params['merchant']!).map((e) => ({
        id: e.id,
        eventId: e.event_id,
        kind: e.kind,
        payloadHash: e.payload_hash,
        receivedAt: e.received_at,
        processedAt: e.processed_at,
        result: e.result,
      }));
      return {
        status: 200,
        json: { events, unprocessed: unprocessedCount(ctx.db, ctx.params['merchant']!) },
      };
    },
  });
}
