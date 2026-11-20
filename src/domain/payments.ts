import type { Db } from '../db/db.ts';
import { all, one, tx } from '../db/db.ts';
import { newId, sha256 } from '../ids.ts';
import { now } from '../clock.ts';
import type { ConnectorEvent, DomainCtx } from './inbox.ts';
import type { Merchant, Order, Payment } from './types.ts';

export interface ReceiptInput {
  rail: string;
  transferRef: string;
  eventIndex: number;
  amountMinor: number;
  asset: string;
  invoiceRef: string;
  payerRef?: string;
}

/**
 * Normalize a connector receipt: amounts are integer minor units only,
 * assets upper-case ISO-style codes. Anything unparseable returns null and
 * the caller quarantines rather than guessing (TDD "Decision procedure").
 */
export function normalizeReceipt(raw: Record<string, unknown>): ReceiptInput | null {
  const amount = raw['amount_minor'];
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0) return null;
  const asset = typeof raw['asset'] === 'string' ? raw['asset'].toUpperCase() : '';
  const invoiceRef = typeof raw['invoice_ref'] === 'string' ? raw['invoice_ref'] : '';
  const transferRef = typeof raw['transfer_ref'] === 'string' ? raw['transfer_ref'] : '';
  const rail = typeof raw['rail'] === 'string' ? raw['rail'] : 'local-rail';
  if (!asset || !invoiceRef || !transferRef) return null;
  return {
    rail,
    transferRef,
    eventIndex: typeof raw['event_index'] === 'number' && Number.isInteger(raw['event_index']) ? raw['event_index'] : 0,
    amountMinor: amount,
    asset,
    invoiceRef,
    payerRef: typeof raw['payer_ref'] === 'string' ? raw['payer_ref'] : undefined,
  };
}

function insertPayment(
  db: Db,
  p: Omit<Payment, 'id' | 'created_at' | 'confirmed_at'>,
  confirmedAt: string | null = null,
): Payment {
  const row: Payment = {
    ...p,
    id: newId('pay'),
    created_at: now(),
    confirmed_at: confirmedAt,
  };
  db.prepare(
    `INSERT INTO payments (id, order_id, merchant_id, rail, transfer_ref, event_index, amount_minor, asset, invoice_ref, receipt_hash, state, quarantine_reason, created_at, confirmed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.order_id,
    row.merchant_id,
    row.rail,
    row.transfer_ref,
    row.event_index,
    row.amount_minor,
    row.asset,
    row.invoice_ref,
    row.receipt_hash,
    row.state,
    row.quarantine_reason,
    row.created_at,
    row.confirmed_at,
  );
  return row;
}

/**
 * Join a verified receipt to its canonical order (FR-02/INV-02). One transfer
 * event (rail, transfer_ref, event_index) funds at most one order — enforced
 * by unique index — so a redelivery of the same transfer collapses into the
 * stored row even under a different callback event_id.
 */
export function recordReceipt(
  ctx: DomainCtx,
  merchant: Merchant,
  event: ConnectorEvent,
): string {
  const db = ctx.db;
  return tx(db, () => {
    const receipt = normalizeReceipt(event.payload);
    const receiptHash = sha256(JSON.stringify(event.payload));

    if (!receipt) {
      insertPayment(db, {
        order_id: null,
        merchant_id: merchant.id,
        rail: 'unknown',
        transfer_ref: `unparseable:${event.event_id}`,
        event_index: 0,
        amount_minor: 0,
        asset: '',
        invoice_ref: '',
        receipt_hash: receiptHash,
        state: 'mismatch',
        quarantine_reason: 'unparseable_receipt',
      });
      return 'quarantined:unparseable_receipt';
    }

    // INV-02: the transfer event may already be bound to a canonical order.
    const existing = one<Payment>(
      db,
      'SELECT * FROM payments WHERE rail = ? AND transfer_ref = ? AND event_index = ?',
      receipt.rail,
      receipt.transferRef,
      receipt.eventIndex,
    );
    if (existing) {
      return `duplicate_transfer:${existing.state}`;
    }

    // Find the order the receipt claims to pay: external id + invoice must
    // agree on one canonical row inside this merchant.
    const byExternal = event.order_external_id
      ? one<Order>(
          db,
          'SELECT * FROM orders WHERE merchant_id = ? AND external_order_id = ?',
          merchant.id,
          event.order_external_id,
        )
      : undefined;
    const byInvoice = one<Order>(
      db,
      'SELECT * FROM orders WHERE merchant_id = ? AND invoice_ref = ?',
      merchant.id,
      receipt.invoiceRef,
    );

    const base = {
      merchant_id: merchant.id,
      rail: receipt.rail,
      transfer_ref: receipt.transferRef,
      event_index: receipt.eventIndex,
      amount_minor: receipt.amountMinor,
      asset: receipt.asset,
      invoice_ref: receipt.invoiceRef,
      receipt_hash: receiptHash,
    };

    const quarantine = (orderId: string | null, reason: string): string => {
      insertPayment(db, { ...base, order_id: orderId, state: 'mismatch', quarantine_reason: reason });
      return `quarantined:${reason}`;
    };

    if (!byExternal && !byInvoice) {
      return quarantine(null, 'unknown_invoice');
    }
    // The external id and invoice point at different orders — never pick one.
    if (byExternal && byInvoice && byExternal.id !== byInvoice.id) {
      return quarantine(byExternal.id, 'invoice_order_conflict');
    }
    const order = (byExternal ?? byInvoice)!;

    // T-004 boundary: correct amount, wrong invoice must not unlock anything.
    if (order.invoice_ref !== receipt.invoiceRef) {
      return quarantine(order.id, 'invoice_mismatch');
    }
    if (order.asset.toUpperCase() !== receipt.asset) {
      return quarantine(order.id, 'asset_mismatch');
    }
    if (order.amount_minor !== receipt.amountMinor) {
      return quarantine(order.id, 'amount_mismatch');
    }

    const payment = insertPayment(db, {
      ...base,
      order_id: order.id,
      state: 'confirmed',
      quarantine_reason: null,
    }, now());
    db.prepare("UPDATE orders SET state = 'paid' WHERE id = ?").run(order.id);
    return `confirmed:${payment.id}`;
  });
}

export function orderPaymentConfirmed(db: Db, orderId: string): boolean {
  return (
    one<{ n: number }>(
      db,
      "SELECT COUNT(*) AS n FROM payments WHERE order_id = ? AND state = 'confirmed'",
      orderId,
    )!.n > 0
  );
}

export function paymentsForOrder(db: Db, orderId: string): Payment[] {
  return all<Payment>(db, 'SELECT * FROM payments WHERE order_id = ? ORDER BY created_at', orderId);
}

export function quarantinedPayments(db: Db, merchantId: string): Payment[] {
  return all<Payment>(
    db,
    "SELECT * FROM payments WHERE merchant_id = ? AND state = 'mismatch' ORDER BY created_at",
    merchantId,
  );
}
