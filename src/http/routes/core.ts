import type { App } from '../server.ts';
import { getOrder, listOrdersForBuyer, lookupOrderByExternal } from '../../domain/orders.ts';
import { badRequest } from '../../domain/errors.ts';
import { one } from '../../db/db.ts';
import type { Payment, Fulfillment } from '../../domain/types.ts';
import type { Order } from '../../domain/types.ts';

export function orderView(db: import('../../db/db.ts').Db, order: Order) {
  const payment = one<Payment>(
    db,
    "SELECT * FROM payments WHERE order_id = ? AND state = 'confirmed' ORDER BY created_at LIMIT 1",
    order.id,
  );
  const fulfillment = one<Fulfillment>(
    db,
    'SELECT * FROM fulfillments WHERE order_id = ? ORDER BY revision DESC LIMIT 1',
    order.id,
  );
  return {
    id: order.id,
    externalOrderId: order.external_order_id,
    merchantId: order.merchant_id,
    buyerId: order.buyer_id,
    amountMinor: order.amount_minor,
    asset: order.asset,
    description: order.description,
    invoiceRef: order.invoice_ref,
    state: order.state,
    createdAt: order.created_at,
    payment: payment
      ? { state: payment.state, rail: payment.rail, confirmedAt: payment.confirmed_at }
      : null,
    fulfillment: fulfillment
      ? {
          revision: fulfillment.revision,
          state: fulfillment.state,
          artifactDigest: fulfillment.artifact_digest,
          evidenceNote: fulfillment.evidence_note,
        }
      : null,
  };
}

export function registerCoreRoutes(app: App): void {
  app.route('GET', '/healthz', {
    auth: { kind: 'none' },
    handler: () => ({ status: 200, json: { status: 'ok' } }),
  });

  // Buyer order lookup: GET /orders/lookup?merchant_id=..&external_id=E7
  app.route('GET', '/orders/lookup', {
    auth: { kind: 'buyer' },
    handler: (ctx) => {
      const merchantId = ctx.query.get('merchant_id');
      const externalId = ctx.query.get('external_id');
      if (!merchantId || !externalId) {
        throw badRequest('merchant_id and external_id are required');
      }
      const order = lookupOrderByExternal(ctx.db, ctx.actor!, merchantId, externalId);
      return { status: 200, json: orderView(ctx.db, order) };
    },
  });

  app.route('GET', '/orders/{id}', {
    auth: { kind: 'buyer' },
    handler: (ctx) => {
      const order = getOrder(ctx.db, ctx.actor!, ctx.params['id']!);
      return { status: 200, json: orderView(ctx.db, order) };
    },
  });

  // Operator read of the same order within their merchant tenant.
  app.route('GET', '/console/orders/{id}', {
    auth: { kind: 'operator' },
    handler: (ctx) => {
      const order = getOrder(ctx.db, ctx.actor!, ctx.params['id']!);
      return { status: 200, json: orderView(ctx.db, order) };
    },
  });

  app.route('GET', '/orders', {
    auth: { kind: 'buyer' },
    handler: (ctx) => {
      const orders = listOrdersForBuyer(ctx.db, ctx.actor!.id);
      return { status: 200, json: orders.map((o) => orderView(ctx.db, o)) };
    },
  });
}
