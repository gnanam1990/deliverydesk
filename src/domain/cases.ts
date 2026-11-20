import type { Db } from '../db/db.ts';
import { all, one, tx } from '../db/db.ts';
import { newId } from '../ids.ts';
import { now, isoFromNow } from '../clock.ts';
import type { Config } from '../config.ts';
import type {
  AccessGrant,
  Actor,
  Case,
  Order,
  Payment,
  Retrieval,
} from './types.ts';
import { ACTIVE_RETRIEVAL_STATES } from './types.ts';
import { badRequest, conflict, forbidden, gone, notFound } from './errors.ts';
import { appendCaseEvent, caseTimeline } from './timeline.ts';
import { orderPaymentConfirmed } from './payments.ts';
import { isReady } from './fulfillments.ts';

/**
 * Case intake and redelivery (FR-04/INV-04). One active case per order.
 * Redelivery issues short-lived grants bound to the original immutable
 * artifact digest — it never opens a new purchase and cannot change the
 * delivered digest. Retrieval is a fenced claim persisted before streaming;
 * delivery closes only on an authenticated digest receipt or explicit
 * buyer acknowledgment.
 */

export function activeCaseForOrder(db: Db, orderId: string): Case | undefined {
  return one<Case>(
    db,
    `SELECT * FROM cases WHERE order_id = ? AND state NOT IN ('delivered','refunded','closed')
     ORDER BY created_at LIMIT 1`,
    orderId,
  );
}

export function getCase(db: Db, caseId: string): Case {
  const c = one<Case>(db, 'SELECT * FROM cases WHERE id = ?', caseId);
  if (!c) throw notFound('case not found');
  return c;
}

export function assertCaseReadable(actor: Actor, c: Case): void {
  if (actor.kind === 'buyer' && c.buyer_id === actor.id) return;
  if (actor.kind === 'operator' && c.merchant_id === actor.merchantId) return;
  throw forbidden('case is outside your tenant scope');
}

export function assertCaseOwner(actor: Actor, c: Case): void {
  if (actor.kind !== 'buyer' || c.buyer_id !== actor.id) {
    throw forbidden('only the owning buyer can act on this case');
  }
}

/**
 * Open (or return) the active case for an order. The buyer deduplicates by
 * order — repeated opens return the same case. Initial state reflects the
 * current fulfillment evidence: already-ready artifacts open 'available'.
 */
export function openCase(
  db: Db,
  actor: Actor,
  order: Order,
  reason: string,
): { kase: Case; created: boolean } {
  return tx(db, () => {
    if (order.buyer_id !== actor.id) {
      throw forbidden('only the owning buyer can open a case on this order');
    }
    const existing = activeCaseForOrder(db, order.id);
    if (existing) return { kase: existing, created: false };
    const ready = isReady(db, order.id);
    const kase: Case = {
      id: newId('case'),
      order_id: order.id,
      merchant_id: order.merchant_id,
      buyer_id: order.buyer_id,
      reason,
      state: ready.ready ? 'available' : 'investigating',
      disposition: null,
      version: 1,
      owner_operator_id: null,
      opened_by: actor.id,
      evidence_note: null,
      created_at: now(),
      closed_at: null,
    };
    db.prepare(
      `INSERT INTO cases (id, order_id, merchant_id, buyer_id, reason, state, disposition, version, owner_operator_id, opened_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 1, NULL, ?, ?)`,
    ).run(
      kase.id,
      kase.order_id,
      kase.merchant_id,
      kase.buyer_id,
      kase.reason,
      kase.state,
      kase.opened_by,
      kase.created_at,
    );
    appendCaseEvent(db, kase.id, 'buyer', actor.id, 'case.opened', { reason });
    if (ready.ready) {
      appendCaseEvent(db, kase.id, 'system', 'fulfillment', 'fulfillment.ready', {
        artifactDigest: ready.digest,
      });
    }
    return { kase, created: true };
  });
}

/** Buyer refresh re-derives state from current evidence. */
export function refreshCase(db: Db, actor: Actor, caseId: string): Case {
  return tx(db, () => {
    const c = getCase(db, caseId);
    assertCaseOwner(actor, c);
    if (c.state === 'investigating') {
      const ready = isReady(db, c.order_id);
      if (ready.ready) {
        db.prepare("UPDATE cases SET state = 'available', version = version + 1 WHERE id = ?").run(c.id);
        appendCaseEvent(db, c.id, 'system', 'refresh', 'fulfillment.ready', {
          artifactDigest: ready.digest,
        });
        return { ...c, state: 'available', version: c.version + 1 };
      }
    }
    return c;
  });
}

/**
 * Authorize same-buyer redelivery: issue a short-lived grant bound to the
 * original artifact digest. The grant token itself is never written to the
 * timeline or logs (UI-SPEC).
 */
export function issueGrant(
  db: Db,
  config: Config,
  actor: Actor,
  caseId: string,
): AccessGrant {
  return tx(db, () => {
    const c = getCase(db, caseId);
    assertCaseOwner(actor, c);
    if (c.state === 'delivered' || c.state === 'refunded' || c.state === 'closed') {
      throw conflict(`case is already ${c.state}`);
    }
    if (!orderPaymentConfirmed(db, c.order_id)) {
      throw conflict('order has no confirmed payment');
    }
    // INV-05: an in-flight or settled refund ends redelivery entitlement.
    const blockingRefund = one<{ id: string; state: string }>(
      db,
      "SELECT id, state FROM refunds WHERE order_id = ? AND state IN ('authorized','dispatch_pending','dispatched','settlement_investigation','settled')",
      c.order_id,
    );
    if (blockingRefund) {
      throw conflict(`refund ${blockingRefund.state} — redelivery unavailable`, {
        refundId: blockingRefund.id,
      });
    }
    const ready = isReady(db, c.order_id);
    if (!ready.ready) {
      throw conflict('fulfillment is not ready — nothing to redeliver yet', {
        caseState: c.state,
      });
    }
    const grant: AccessGrant = {
      id: newId('gnt'),
      case_id: c.id,
      order_id: c.order_id,
      subject_id: actor.id,
      artifact_digest: ready.digest!,
      expires_at: isoFromNow(config.grantTtlMs),
      revoked_at: null,
      revoked_reason: null,
      created_at: now(),
    };
    db.prepare(
      `INSERT INTO access_grants (id, case_id, order_id, subject_id, artifact_digest, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      grant.id,
      grant.case_id,
      grant.order_id,
      grant.subject_id,
      grant.artifact_digest,
      grant.expires_at,
      grant.created_at,
    );
    appendCaseEvent(db, c.id, 'buyer', actor.id, 'grant.issued', {
      grantRef: grant.id.slice(0, 12),
      expiresAt: grant.expires_at,
      artifactDigest: grant.artifact_digest,
    });
    return grant;
  });
}

export function getGrant(db: Db, grantId: string): AccessGrant {
  const g = one<AccessGrant>(db, 'SELECT * FROM access_grants WHERE id = ?', grantId);
  if (!g) throw notFound('grant not found');
  return g;
}

/**
 * Validate a grant for an artifact request. The grant subject must be the
 * authenticated buyer — a copied grant presented by another buyer is denied.
 * Expired or revoked grants fail closed.
 */
export function assertGrantUsable(db: Db, actor: Actor, grant: AccessGrant): void {
  if (actor.kind !== 'buyer') throw forbidden('grants are buyer-scoped');
  if (grant.subject_id !== actor.id) {
    throw forbidden('grant subject does not match the authenticated buyer');
  }
  if (grant.revoked_at) {
    throw gone(`grant revoked: ${grant.revoked_reason ?? 'no reason recorded'}`);
  }
  if (grant.expires_at <= now()) {
    throw gone('grant expired — request a fresh redelivery grant');
  }
}

/** A confirmed retrieval = final delivery evidence for disposition rules. */
export function confirmedRetrievalExists(db: Db, orderId: string): boolean {
  return (
    one<{ n: number }>(
      db,
      "SELECT COUNT(*) AS n FROM retrievals WHERE order_id = ? AND state = 'confirmed'",
      orderId,
    )!.n > 0
  );
}

export function activeRetrievalForOrder(db: Db, orderId: string): Retrieval | undefined {
  return one<Retrieval>(
    db,
    `SELECT * FROM retrievals WHERE order_id = ? AND state IN (${ACTIVE_RETRIEVAL_STATES.map(() => '?').join(',')})
     ORDER BY started_at DESC LIMIT 1`,
    orderId,
    ...ACTIVE_RETRIEVAL_STATES,
  );
}

/** Does a pending/ambiguous retrieval block refund dispatch for this order? */
export function retrievalBlocksRefund(db: Db, orderId: string): Retrieval | undefined {
  return activeRetrievalForOrder(db, orderId);
}

/**
 * Fenced retrieval claim (persisted BEFORE bytes move). Re-GET on the same
 * grant resumes the same retrieval row; a conflicting active claim on the
 * order yields a retryable conflict.
 */
export function claimRetrieval(
  db: Db,
  actor: Actor,
  grant: AccessGrant,
): Retrieval {
  return tx(db, () => {
    assertGrantUsable(db, actor, grant);
    const existingForGrant = one<Retrieval>(
      db,
      `SELECT * FROM retrievals WHERE grant_id = ? AND buyer_id = ? AND state IN (${ACTIVE_RETRIEVAL_STATES.map(() => '?').join(',')})
       ORDER BY started_at DESC LIMIT 1`,
      grant.id,
      actor.id,
      ...ACTIVE_RETRIEVAL_STATES,
    );
    if (existingForGrant) {
      // Resume the original fenced claim (same buyer, same digest).
      return existingForGrant;
    }
    const blocking = activeRetrievalForOrder(db, grant.order_id);
    if (blocking) {
      throw conflict('another retrieval for this order is already in flight', {
        retrievalId: blocking.id,
        state: blocking.state,
      });
    }
    const r: Retrieval = {
      id: newId('ret'),
      order_id: grant.order_id,
      grant_id: grant.id,
      buyer_id: actor.id,
      artifact_digest: grant.artifact_digest,
      state: 'claimed',
      bytes_transferred: 0,
      client_digest: null,
      started_at: now(),
      stream_finished_at: null,
      completed_at: null,
    };
    db.prepare(
      `INSERT INTO retrievals (id, order_id, grant_id, buyer_id, artifact_digest, state, bytes_transferred, started_at)
       VALUES (?, ?, ?, ?, ?, 'claimed', 0, ?)`,
    ).run(r.id, r.order_id, r.grant_id, r.buyer_id, r.artifact_digest, r.started_at);
    return r;
  });
}

export function markStreaming(db: Db, retrievalId: string): void {
  // Resume transitions 'interrupted' back to 'streaming': the same buyer
  // restarts the original fenced claim for the same digest.
  db.prepare("UPDATE retrievals SET state = 'streaming' WHERE id = ? AND state IN ('claimed','streaming','interrupted')").run(
    retrievalId,
  );
}

export function finishStream(db: Db, retrievalId: string, bytesTransferred: number): void {
  db.prepare(
    "UPDATE retrievals SET state = 'awaiting_receipt', bytes_transferred = ?, stream_finished_at = ? WHERE id = ?",
  ).run(bytesTransferred, now(), retrievalId);
}

/** Aborted/partial stream — ambiguous, blocks refund until reconciled. */
export function interruptStream(db: Db, retrievalId: string, bytesTransferred: number): void {
  db.prepare(
    "UPDATE retrievals SET state = 'interrupted', bytes_transferred = ?, stream_finished_at = ? WHERE id = ? AND state IN ('claimed','streaming')",
  ).run(bytesTransferred, now(), retrievalId);
}

export function getRetrieval(db: Db, id: string): Retrieval {
  const r = one<Retrieval>(db, 'SELECT * FROM retrievals WHERE id = ?', id);
  if (!r) throw notFound('retrieval not found');
  return r;
}

/**
 * Authenticated client digest receipt: the downloaded bytes hashed to the
 * original digest. Closes the case as delivered — a completed server stream
 * alone is never proof of client consumption (TDD "Decision procedure").
 */
export function recordRetrievalReceipt(
  db: Db,
  actor: Actor,
  retrievalId: string,
  clientDigest: string,
): { retrieval: Retrieval; kase: Case } {
  return tx(db, () => {
    const r = getRetrieval(db, retrievalId);
    if (actor.kind !== 'buyer' || r.buyer_id !== actor.id) {
      throw forbidden('retrieval belongs to another buyer');
    }
    if (r.state === 'confirmed') {
      return { retrieval: r, kase: closeCaseDelivered(db, r) };
    }
    if (r.state !== 'awaiting_receipt') {
      throw conflict(`retrieval is ${r.state}; cannot accept a receipt`);
    }
    if (clientDigest !== r.artifact_digest) {
      throw conflict('client digest does not match the artifact digest');
    }
    db.prepare(
      "UPDATE retrievals SET state = 'confirmed', client_digest = ?, completed_at = ? WHERE id = ?",
    ).run(clientDigest, now(), r.id);
    // The grant is consumed — it cannot be replayed.
    db.prepare(
      "UPDATE access_grants SET revoked_at = ?, revoked_reason = 'consumed' WHERE id = ? AND revoked_at IS NULL",
    ).run(now(), r.grant_id);
    return { retrieval: { ...r, state: 'confirmed' }, kase: closeCaseDelivered(db, r) };
  });
}

function closeCaseDelivered(db: Db, r: Retrieval): Case {
  const c = one<Case>(
    db,
    "SELECT * FROM cases WHERE order_id = ? AND state NOT IN ('delivered','refunded','closed') ORDER BY created_at LIMIT 1",
    r.order_id,
  );
  if (!c) {
    // Already terminal — redelivery confirmed after close is a no-op read.
    const closed = one<Case>(
      db,
      'SELECT * FROM cases WHERE order_id = ? ORDER BY created_at DESC LIMIT 1',
      r.order_id,
    )!;
    return closed;
  }
  db.prepare(
    "UPDATE cases SET state = 'delivered', disposition = 'delivered', version = version + 1, evidence_note = ?, closed_at = ? WHERE id = ?",
  ).run(`delivered digest ${r.artifact_digest.slice(0, 16)} via retrieval ${r.id}`, now(), c.id);
  db.prepare("UPDATE orders SET state = 'delivered' WHERE id = ?").run(r.order_id);
  appendCaseEvent(db, c.id, 'buyer', r.buyer_id, 'case.delivered', {
    retrievalId: r.id,
    artifactDigest: r.artifact_digest,
    evidence: 'authenticated_digest_receipt',
  });
  return { ...c, state: 'delivered', disposition: 'delivered' };
}

/** Explicit buyer acknowledgment — the alternate closure path. */
export function acknowledgeCase(db: Db, actor: Actor, caseId: string): Case {
  return tx(db, () => {
    const c = getCase(db, caseId);
    assertCaseOwner(actor, c);
    if (c.state === 'delivered') return c;
    if (c.state === 'refunded' || c.state === 'closed') {
      throw conflict(`case is already ${c.state}`);
    }
    // Acknowledgment is valid once bytes have been retrieved (stream done)
    // or the artifact is otherwise ready and the buyer attests receipt.
    const done = one<Retrieval>(
      db,
      "SELECT * FROM retrievals WHERE order_id = ? AND buyer_id = ? AND state IN ('awaiting_receipt','confirmed') ORDER BY started_at DESC LIMIT 1",
      c.order_id,
      actor.id,
    );
    if (!done) {
      throw conflict('no completed retrieval to acknowledge');
    }
    db.prepare(
      "UPDATE retrievals SET state = 'confirmed', completed_at = COALESCE(completed_at, ?) WHERE id = ?",
    ).run(now(), done.id);
    db.prepare(
      "UPDATE cases SET state = 'delivered', disposition = 'delivered', version = version + 1, evidence_note = ?, closed_at = ? WHERE id = ?",
    ).run(`buyer acknowledgment of ${done.artifact_digest.slice(0, 16)}`, now(), c.id);
    db.prepare("UPDATE orders SET state = 'delivered' WHERE id = ?").run(c.order_id);
    appendCaseEvent(db, c.id, 'buyer', actor.id, 'case.delivered', {
      retrievalId: done.id,
      artifactDigest: done.artifact_digest,
      evidence: 'buyer_acknowledgment',
    });
    return { ...c, state: 'delivered', disposition: 'delivered' };
  });
}

/** Operator reconcile: mark an interrupted/pending retrieval abandoned. */
export function abandonRetrieval(db: Db, actor: Actor, retrievalId: string): Retrieval {
  return tx(db, () => {
    const r = getRetrieval(db, retrievalId);
    if (actor.kind !== 'operator') throw forbidden('operator action');
    const c = one<Case>(db, 'SELECT * FROM cases WHERE order_id = ?', r.order_id);
    if (c && c.merchant_id !== actor.merchantId) throw forbidden('outside your merchant');
    if (!ACTIVE_RETRIEVAL_STATES.includes(r.state)) {
      throw conflict(`retrieval is ${r.state}; nothing to abandon`);
    }
    db.prepare("UPDATE retrievals SET state = 'abandoned', completed_at = ? WHERE id = ?").run(
      now(),
      r.id,
    );
    if (c) {
      appendCaseEvent(db, c.id, 'operator', actor.id, 'retrieval.abandoned', {
        retrievalId: r.id,
        bytesTransferred: r.bytes_transferred,
      });
    }
    return { ...r, state: 'abandoned' };
  });
}

/** Operator takes ownership of a case (support console assignment). */
export function claimCaseOwnership(db: Db, actor: Actor, caseId: string): Case {
  return tx(db, () => {
    const c = getCase(db, caseId);
    assertCaseReadable(actor, c);
    if (actor.kind !== 'operator') throw forbidden('operator action');
    db.prepare('UPDATE cases SET owner_operator_id = ?, version = version + 1 WHERE id = ?').run(
      actor.id,
      c.id,
    );
    appendCaseEvent(db, c.id, 'operator', actor.id, 'case.claimed', {});
    return { ...c, owner_operator_id: actor.id };
  });
}

export interface CaseView {
  id: string;
  orderId: string;
  externalOrderId: string;
  state: string;
  disposition: string | null;
  version: number;
  reason: string;
  buyerId: string;
  merchantId: string;
  ownerOperatorId: string | null;
  evidenceNote: string | null;
  createdAt: string;
  closedAt: string | null;
  payment: { state: string; rail: string; transferRef: string; confirmedAt: string | null } | null;
  fulfillment: { revision: number; state: string; artifactDigest: string | null; evidenceNote: string | null } | null;
  retrieval: { id: string; state: string; bytesTransferred: number; digest: string } | null;
  refund: { id: string; state: string; amountMinor: number; asset: string } | null;
  timeline: { seq: number; actorKind: string; kind: string; detail: Record<string, unknown>; createdAt: string }[];
}

export function caseView(db: Db, c: Case): CaseView {
  const order = one<Order>(db, 'SELECT * FROM orders WHERE id = ?', c.order_id)!;
  const payment = one<Payment>(
    db,
    "SELECT * FROM payments WHERE order_id = ? AND state = 'confirmed' ORDER BY created_at LIMIT 1",
    c.order_id,
  );
  const f = one<{ revision: number; state: string; artifact_digest: string | null; evidence_note: string | null }>(
    db,
    'SELECT * FROM fulfillments WHERE order_id = ? ORDER BY revision DESC LIMIT 1',
    c.order_id,
  );
  const r = one<Retrieval>(
    db,
    'SELECT * FROM retrievals WHERE order_id = ? ORDER BY started_at DESC LIMIT 1',
    c.order_id,
  );
  const refund = one<{ id: string; state: string; amount_minor: number; asset: string }>(
    db,
    'SELECT * FROM refunds WHERE order_id = ? ORDER BY created_at DESC LIMIT 1',
    c.order_id,
  );
  return {
    id: c.id,
    orderId: c.order_id,
    externalOrderId: order.external_order_id,
    state: c.state,
    disposition: c.disposition,
    version: c.version,
    reason: c.reason,
    buyerId: c.buyer_id,
    merchantId: c.merchant_id,
    ownerOperatorId: c.owner_operator_id,
    evidenceNote: c.evidence_note,
    createdAt: c.created_at,
    closedAt: c.closed_at,
    payment: payment
      ? {
          state: payment.state,
          rail: payment.rail,
          transferRef: payment.transfer_ref,
          confirmedAt: payment.confirmed_at,
        }
      : null,
    fulfillment: f
      ? {
          revision: f.revision,
          state: f.state,
          artifactDigest: f.artifact_digest,
          evidenceNote: f.evidence_note,
        }
      : null,
    retrieval: r
      ? { id: r.id, state: r.state, bytesTransferred: r.bytes_transferred, digest: r.artifact_digest }
      : null,
    refund: refund
      ? { id: refund.id, state: refund.state, amountMinor: refund.amount_minor, asset: refund.asset }
      : null,
    timeline: caseTimeline(db, c.id).map((e) => ({
      seq: e.seq,
      actorKind: e.actor_kind,
      kind: e.kind,
      detail: JSON.parse(e.detail) as Record<string, unknown>,
      createdAt: e.created_at,
    })),
  };
}

export function listCasesForMerchant(db: Db, merchantId: string, opts: { staleBeforeMs?: number } = {}): Case[] {
  return all<Case>(
    db,
    'SELECT * FROM cases WHERE merchant_id = ? ORDER BY created_at DESC',
    merchantId,
  );
}

export function listCasesForBuyer(db: Db, buyerId: string): Case[] {
  return all<Case>(db, 'SELECT * FROM cases WHERE buyer_id = ? ORDER BY created_at DESC', buyerId);
}
