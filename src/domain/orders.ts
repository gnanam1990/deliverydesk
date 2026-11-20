import type { Db } from '../db/db.ts';
import { all, one, tx } from '../db/db.ts';
import { newId } from '../ids.ts';
import { now } from '../clock.ts';
import type { Actor, Order } from './types.ts';
import { conflict, forbidden, notFound } from './errors.ts';

export interface OrderInput {
  merchantId: string;
  buyerId: string;
  externalOrderId: string;
  amountMinor: number;
  asset: string;
  invoiceRef: string;
  description?: string;
}

/**
 * Merchant-scoped idempotent order storage (FR-01/INV-01). An external order
 * ID is unique only inside its merchant: two merchants may both own 'E7',
 * while a re-registration inside the same merchant returns the stored row —
 * or conflicts when attributes differ.
 */
export function registerOrder(db: Db, input: OrderInput): { order: Order; created: boolean } {
  return tx(db, () => {
    const existing = one<Order>(
      db,
      'SELECT * FROM orders WHERE merchant_id = ? AND external_order_id = ?',
      input.merchantId,
      input.externalOrderId,
    );
    if (existing) {
      const same =
        existing.buyer_id === input.buyerId &&
        existing.amount_minor === input.amountMinor &&
        existing.asset === input.asset &&
        existing.invoice_ref === input.invoiceRef;
      if (!same) {
        throw conflict(
          `order '${input.externalOrderId}' exists under merchant '${input.merchantId}' with different attributes`,
        );
      }
      return { order: existing, created: false };
    }
    const order: Order = {
      id: newId('ord'),
      merchant_id: input.merchantId,
      buyer_id: input.buyerId,
      external_order_id: input.externalOrderId,
      amount_minor: input.amountMinor,
      asset: input.asset,
      description: input.description ?? '',
      invoice_ref: input.invoiceRef,
      state: 'open',
      created_at: now(),
    };
    db.prepare(
      `INSERT INTO orders (id, merchant_id, buyer_id, external_order_id, amount_minor, asset, description, invoice_ref, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    ).run(
      order.id,
      order.merchant_id,
      order.buyer_id,
      order.external_order_id,
      order.amount_minor,
      order.asset,
      order.description,
      order.invoice_ref,
      order.created_at,
    );
    return { order, created: true };
  });
}

/**
 * Buyer order lookup: a buyer resolves their own order by the merchant's
 * external reference. Cross-buyer access is denied, not merely hidden.
 */
export function lookupOrderByExternal(
  db: Db,
  actor: Actor,
  merchantId: string,
  externalOrderId: string,
): Order {
  const order = one<Order>(
    db,
    'SELECT * FROM orders WHERE merchant_id = ? AND external_order_id = ?',
    merchantId,
    externalOrderId,
  );
  if (!order) throw notFound('order not found');
  assertOrderReadable(db, actor, order);
  return order;
}

export function getOrder(db: Db, actor: Actor, orderId: string): Order {
  const order = one<Order>(db, 'SELECT * FROM orders WHERE id = ?', orderId);
  if (!order) throw notFound('order not found');
  assertOrderReadable(db, actor, order);
  return order;
}

/** Tenant rule: buyer reads only own orders; operator only own merchant. */
export function assertOrderReadable(db: Db, actor: Actor, order: Order): void {
  if (actor.kind === 'buyer' && order.buyer_id === actor.id) return;
  if (actor.kind === 'operator' && order.merchant_id === actor.merchantId) return;
  throw forbidden('order is outside your tenant scope');
}

/** Same rule for writes that act on behalf of the buyer. */
export function assertBuyerOwns(actor: Actor, order: Order): void {
  if (actor.kind !== 'buyer' || order.buyer_id !== actor.id) {
    throw forbidden('only the owning buyer can perform this action');
  }
}

export function listOrdersForBuyer(db: Db, buyerId: string): Order[] {
  return all<Order>(db, 'SELECT * FROM orders WHERE buyer_id = ? ORDER BY created_at', buyerId);
}

export function listOrdersForMerchant(db: Db, merchantId: string): Order[] {
  return all<Order>(
    db,
    'SELECT * FROM orders WHERE merchant_id = ? ORDER BY created_at',
    merchantId,
  );
}
