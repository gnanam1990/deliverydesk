import type { Db } from '../db/db.ts';
import { all, one, tx } from '../db/db.ts';
import type { Config } from '../config.ts';
import { newId } from '../ids.ts';
import { now } from '../clock.ts';
import type { Actor, Case, Merchant, Order, Refund } from './types.ts';
import { badRequest, conflict, forbidden, notFound } from './errors.ts';
import { appendCaseEvent } from './timeline.ts';
import { openReviewItem } from './review.ts';
import { enqueue, registerOutboxDispatcher } from './outbox.ts';
import { orderPaymentConfirmed } from './payments.ts';
import { latestFulfillment } from './fulfillments.ts';
import { activeRetrievalForOrder } from './cases.ts';
import { dispatchRefund, checkSettlement, ProviderTimeout, ProviderError } from '../adapters/refundProvider.ts';
import { confirmedRetrievalExists } from './cases.ts';

/**
 * Refund decision and settlement (FR-05/INV-05). Dispatch and settlement are
 * tracked as distinct provider interactions. Approval is serialized against
 * delivery on the order: an active/ambiguous retrieval defers dispatch, a
 * delivered case declines the refund, and an in-flight refund prevents new
 * entitlements. An ambiguous dispatch stops automatic redispatch.
 */

const IN_FLIGHT: string[] = ['authorized', 'dispatch_pending', 'dispatched', 'settlement_investigation'];

export function getRefund(db: Db, id: string): Refund {
  const r = one<Refund>(db, 'SELECT * FROM refunds WHERE id = ?', id);
  if (!r) throw notFound('refund not found');
  return r;
}

export function refundForOrder(db: Db, orderId: string): Refund | undefined {
  return one<Refund>(
    db,
    'SELECT * FROM refunds WHERE order_id = ? ORDER BY created_at DESC LIMIT 1',
    orderId,
  );
}

/** An in-flight or settled refund blocks new redelivery entitlements. */
export function refundBlocksRedelivery(db: Db, orderId: string): Refund | undefined {
  return one<Refund>(
    db,
    `SELECT * FROM refunds WHERE order_id = ? AND state IN (${IN_FLIGHT.map(() => '?').join(',')}, 'settled')`,
    orderId,
    ...IN_FLIGHT,
    'settled',
  );
}

export interface Eligibility {
  eligible: boolean;
  reason: string;
}

/**
 * Full-refund eligibility: confirmed payment, fulfillment definitively
 * unavailable (irrevocably_failed), no final delivery, no settled refund.
 */
export function refundEligibility(db: Db, orderId: string): Eligibility {
  const order = one<Order>(db, 'SELECT * FROM orders WHERE id = ?', orderId);
  if (!order) return { eligible: false, reason: 'order_missing' };
  if (!orderPaymentConfirmed(db, orderId)) return { eligible: false, reason: 'no_confirmed_payment' };
  if (confirmedRetrievalExists(db, orderId)) {
    return { eligible: false, reason: 'delivery_confirmed' };
  }
  const settled = one<Refund>(
    db,
    "SELECT id FROM refunds WHERE order_id = ? AND state = 'settled'",
    orderId,
  );
  if (settled) return { eligible: false, reason: 'already_refunded' };
  const f = latestFulfillment(db, orderId);
  if (!f || f.state !== 'irrevocably_failed') {
    return { eligible: false, reason: 'fulfillment_not_definitively_failed' };
  }
  return { eligible: true, reason: 'eligible' };
}

/** Merchant operator proposes a full refund on a case. */
export function proposeRefund(
  db: Db,
  actor: Actor,
  caseId: string,
  reason: string,
): Refund {
  return tx(db, () => {
    const c = one<Case>(db, 'SELECT * FROM cases WHERE id = ?', caseId);
    if (!c) throw notFound('case not found');
    if (actor.kind !== 'operator' || c.merchant_id !== actor.merchantId) {
      throw forbidden('refund proposals are merchant-scoped operator actions');
    }
    if (c.state === 'delivered' || c.state === 'refunded' || c.state === 'closed') {
      throw conflict(`case is already ${c.state}`);
    }
    const elig = refundEligibility(db, c.order_id);
    if (!elig.eligible) {
      throw conflict(`order is not refund-eligible: ${elig.reason}`);
    }
    const existing = refundForOrder(db, c.order_id);
    if (existing && existing.state !== 'declined' && existing.state !== 'failed') {
      return existing; // one canonical refund disposition per order
    }
    const order = one<Order>(db, 'SELECT * FROM orders WHERE id = ?', c.order_id)!;
    const r: Refund = {
      id: newId('rf'),
      order_id: c.order_id,
      case_id: c.id,
      amount_minor: order.amount_minor,
      asset: order.asset,
      provider_key: `rf:${newId('pk')}`,
      idempotency_key: `rf-dispatch:${newId('idem')}`,
      state: 'proposed',
      settlement_ref: null,
      proposed_by: actor.id,
      approved_by: null,
      decline_reason: null,
      created_at: now(),
      approved_at: null,
      dispatched_at: null,
      settled_at: null,
    };
    db.prepare(
      `INSERT INTO refunds (id, order_id, case_id, amount_minor, asset, provider_key, idempotency_key, state, proposed_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`,
    ).run(
      r.id, r.order_id, r.case_id, r.amount_minor, r.asset,
      r.provider_key, r.idempotency_key, r.proposed_by, r.created_at,
    );
    db.prepare("UPDATE cases SET state = 'refund_review', version = version + 1 WHERE id = ?").run(c.id);
    appendCaseEvent(db, c.id, 'operator', actor.id, 'refund.proposed', {
      refundId: r.id,
      amountMinor: r.amount_minor,
      asset: r.asset,
      reason,
    });
    return r;
  });
}

/**
 * Merchant approval — requires the finance role, distinct from support case
 * access (SECURITY.md). Serializes disposition on the order: the intent and
 * the outbox dispatch row are written atomically.
 */
export function approveRefund(db: Db, actor: Actor, refundId: string): Refund {
  return tx(db, () => {
    const r = getRefund(db, refundId);
    const c = one<Case>(db, 'SELECT * FROM cases WHERE id = ?', r.case_id)!;
    if (actor.kind !== 'operator' || c.merchant_id !== actor.merchantId) {
      throw forbidden('outside your merchant');
    }
    if (!actor.roles?.includes('finance')) {
      throw forbidden('refund approval requires the finance role');
    }
    if (r.state !== 'proposed') {
      if (r.state === 'authorized' || IN_FLIGHT.includes(r.state)) return r;
      throw conflict(`refund is ${r.state}; cannot approve`);
    }
    // Serialized disposition (INV-05): delivered cases cannot take the
    // refund path.
    if (c.state === 'delivered' || confirmedRetrievalExists(db, r.order_id)) {
      db.prepare("UPDATE refunds SET state = 'declined', decline_reason = ? WHERE id = ?").run(
        'order delivered before approval',
        r.id,
      );
      db.prepare("UPDATE cases SET state = 'delivered', version = version + 1 WHERE id = ?").run(c.id);
      appendCaseEvent(db, c.id, 'operator', actor.id, 'refund.declined', {
        reason: 'order delivered before approval',
      });
      return { ...r, state: 'declined' };
    }
    const elig = refundEligibility(db, r.order_id);
    if (!elig.eligible) {
      db.prepare("UPDATE refunds SET state = 'declined', decline_reason = ? WHERE id = ?").run(
        elig.reason,
        r.id,
      );
      appendCaseEvent(db, c.id, 'operator', actor.id, 'refund.declined', { reason: elig.reason });
      return { ...r, state: 'declined' };
    }

    // Revoke every unconsumed grant on the order — a refund in flight ends
    // redelivery entitlement issuance.
    db.prepare(
      "UPDATE access_grants SET revoked_at = ?, revoked_reason = 'refund_authorized' WHERE order_id = ? AND revoked_at IS NULL",
    ).run(now(), r.order_id);

    db.prepare(
      "UPDATE refunds SET state = 'authorized', approved_by = ?, approved_at = ? WHERE id = ?",
    ).run(actor.id, now(), r.id);
    db.prepare("UPDATE cases SET state = 'refund_pending', version = version + 1 WHERE id = ?").run(c.id);
    appendCaseEvent(db, c.id, 'operator', actor.id, 'refund.authorized', {
      refundId: r.id,
      approvedBy: actor.id,
    });
    // Intent and side effect committed together — the worker dispatches.
    enqueue(
      db,
      'refund.dispatch',
      { refund_id: r.id },
      { actionId: `refund-dispatch:${r.id}` },
    );
    return { ...r, state: 'authorized' };
  });
}

export function declineRefund(db: Db, actor: Actor, refundId: string, reason: string): Refund {
  return tx(db, () => {
    const r = getRefund(db, refundId);
    const c = one<Case>(db, 'SELECT * FROM cases WHERE id = ?', r.case_id)!;
    if (actor.kind !== 'operator' || c.merchant_id !== actor.merchantId) {
      throw forbidden('outside your merchant');
    }
    if (r.state !== 'proposed' && r.state !== 'authorized') {
      throw conflict(`refund is ${r.state}; cannot decline`);
    }
    db.prepare("UPDATE refunds SET state = 'declined', decline_reason = ? WHERE id = ?").run(
      reason,
      r.id,
    );
    db.prepare("UPDATE cases SET state = 'investigating', version = version + 1 WHERE id = ?").run(c.id);
    appendCaseEvent(db, c.id, 'operator', actor.id, 'refund.declined', { reason });
    return { ...r, state: 'declined' };
  });
}

/**
 * Outbox dispatcher: the provider call happens here, never inline. Before
 * dispatch the serialized-disposition guard re-runs — a blocked or
 * delivered order never reaches the provider.
 */
export function registerRefundDispatchers(): void {
  registerOutboxDispatcher('refund.dispatch', async (db, config, payload) => {
    const refundId = String(payload['refund_id']);
    const gate = tx(db, () => {
      const r = getRefund(db, refundId);
      if (r.state !== 'authorized') return { action: 'skip' as const, reason: `state ${r.state}` };
      const c = one<Case>(db, 'SELECT * FROM cases WHERE id = ?', r.case_id)!;
      if (c.state === 'delivered' || confirmedRetrievalExists(db, r.order_id)) {
        db.prepare("UPDATE refunds SET state = 'declined', decline_reason = ? WHERE id = ?").run(
          'order delivered before dispatch',
          r.id,
        );
        appendCaseEvent(db, c.id, 'worker', 'refund', 'refund.declined', {
          reason: 'order delivered before dispatch',
        });
        return { action: 'declined' as const };
      }
      const blocked = activeRetrievalForOrder(db, r.order_id);
      if (blocked) {
        // Pending/ambiguous retrieval — dispatch waits for reconcile.
        return { action: 'deferred' as const, retrieval: blocked.id };
      }
      // Persist the intent before the provider call (TDD "Recovery").
      db.prepare("UPDATE refunds SET state = 'dispatch_pending' WHERE id = ?").run(r.id);
      return { action: 'dispatch' as const, refund: r, caseRow: c };
    });

    if (gate.action === 'skip' || gate.action === 'declined') {
      return { ok: true, result: `${gate.action}` };
    }
    if (gate.action === 'deferred') {
      return { ok: false, result: `retrieval ${gate.retrieval} pending`, retryAfterMs: 0 };
    }

    const { refund, caseRow } = gate;
    const merchant = one<Merchant>(
      db,
      'SELECT * FROM merchants WHERE id = ?',
      caseRow.merchant_id,
    )!;
    const order = one<Order>(db, 'SELECT * FROM orders WHERE id = ?', refund.order_id)!;
    try {
      const res = await dispatchRefund(config, merchant, {
        idempotencyKey: refund.idempotency_key,
        orderRef: order.external_order_id,
        amountMinor: refund.amount_minor,
        asset: refund.asset,
      });
      tx(db, () => {
        db.prepare(
          "UPDATE refunds SET state = 'dispatched', settlement_ref = ?, dispatched_at = ? WHERE id = ?",
        ).run(res.refundRef, now(), refund.id);
        appendCaseEvent(db, caseRow.id, 'worker', 'refund', 'refund.dispatched', {
          refundId: refund.id,
          providerRef: res.refundRef,
          provider: 'local-emulator',
        });
      });
      return { ok: true, result: `dispatched:${res.refundRef}` };
    } catch (e) {
      // Timeout or split response: the provider outcome is UNKNOWN. Stop
      // automatic redispatch and route to a person (TDD "Recovery").
      const reason =
        e instanceof ProviderTimeout
          ? 'provider timeout after dispatch attempt'
          : e instanceof ProviderError
            ? `provider error HTTP ${e.statusCode}`
            : (e as Error).message;
      tx(db, () => {
        db.prepare("UPDATE refunds SET state = 'settlement_investigation' WHERE id = ?").run(refund.id);
        db.prepare("UPDATE cases SET state = 'manual_review', version = version + 1 WHERE id = ?").run(caseRow.id);
        appendCaseEvent(db, caseRow.id, 'worker', 'refund', 'refund.investigation', {
          refundId: refund.id,
          reason,
        });
        openReviewItem(db, {
          merchantId: caseRow.merchant_id,
          orderId: refund.order_id,
          caseId: caseRow.id,
          kind: 'refund_dispatch_ambiguous',
          reason,
          evidence: { refundId: refund.id, providerKey: refund.provider_key },
        });
      });
      return { ok: true, result: `investigation:${reason}` };
    }
  });
}

/**
 * Worker task: settlement reconciliation. Dispatched refunds poll the
 * provider until terminal; investigation items retry the settlement lookup
 * with the original provider reference (unsupported lookups stay with a
 * person).
 */
export async function reconcileRefunds(db: Db, config: Config): Promise<number> {
  const pending = all<Refund>(
    db,
    "SELECT * FROM refunds WHERE state IN ('dispatched','settlement_investigation')",
  );
  let changed = 0;
  for (const r of pending) {
    const c = one<Case>(db, 'SELECT * FROM cases WHERE id = ?', r.case_id);
    if (!c) continue;
    const merchant = one<Merchant>(db, 'SELECT * FROM merchants WHERE id = ?', c.merchant_id);
    if (!merchant?.refund_base_url || !r.settlement_ref) continue;
    let status;
    try {
      status = await checkSettlement(config, merchant, r.settlement_ref);
    } catch {
      status = 'unknown';
    }
    if (status === 'settled') {
      tx(db, () => {
        db.prepare("UPDATE refunds SET state = 'settled', settled_at = ? WHERE id = ?").run(
          now(),
          r.id,
        );
        db.prepare("UPDATE cases SET state = 'refunded', disposition = 'refunded', version = version + 1, closed_at = ?, evidence_note = ? WHERE id = ?").run(
          now(),
          `refund settled ${r.settlement_ref} (${r.amount_minor} ${r.asset})`,
          r.case_id,
        );
        db.prepare("UPDATE orders SET state = 'refunded' WHERE id = ?").run(r.order_id);
        appendCaseEvent(db, r.case_id, 'worker', 'refund', 'refund.settled', {
          refundId: r.id,
          settlementRef: r.settlement_ref,
        });
      });
      changed++;
    } else if (status === 'failed') {
      tx(db, () => {
        db.prepare("UPDATE refunds SET state = 'failed' WHERE id = ?").run(r.id);
        db.prepare("UPDATE cases SET state = 'manual_review', version = version + 1 WHERE id = ?").run(r.case_id);
        appendCaseEvent(db, r.case_id, 'worker', 'refund', 'refund.failed', {
          refundId: r.id,
          settlementRef: r.settlement_ref,
        });
        openReviewItem(db, {
          merchantId: c.merchant_id,
          orderId: r.order_id,
          caseId: r.case_id,
          kind: 'refund_settlement_failed',
          reason: 'provider reports refund failed',
          evidence: { refundId: r.id, settlementRef: r.settlement_ref },
        });
      });
      changed++;
    }
    // 'pending' and 'unknown' stay — dispatched keeps polling; an
    // investigation never flips to refunded without provider evidence.
  }
  return changed;
}

export function refundView(db: Db, r: Refund) {
  const c = one<Case>(db, 'SELECT * FROM cases WHERE id = ?', r.case_id);
  return {
    id: r.id,
    orderId: r.order_id,
    caseId: r.case_id,
    amountMinor: r.amount_minor,
    asset: r.asset,
    state: r.state,
    settlementRef: r.settlement_ref,
    proposedBy: r.proposed_by,
    approvedBy: r.approved_by,
    declineReason: r.decline_reason,
    createdAt: r.created_at,
    approvedAt: r.approved_at,
    dispatchedAt: r.dispatched_at,
    settledAt: r.settled_at,
    caseState: c?.state ?? null,
  };
}
