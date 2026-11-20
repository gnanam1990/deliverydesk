import type { Db } from '../db/db.ts';
import { all, one } from '../db/db.ts';
import { newId } from '../ids.ts';
import { now } from '../clock.ts';
import type { Actor, ReviewItem } from './types.ts';
import { forbidden, notFound } from './errors.ts';

/**
 * Merchant review queue: anything the state machine cannot resolve
 * automatically lands here for a person (KITE-AND-PROVIDERS: where merchant
 * capability is absent, keep the case unresolved for a person).
 */
export function openReviewItem(
  db: Db,
  input: {
    merchantId: string;
    orderId?: string;
    caseId?: string;
    kind: string;
    reason: string;
    evidence?: Record<string, unknown>;
  },
): ReviewItem {
  const item: ReviewItem = {
    id: newId('rev'),
    merchant_id: input.merchantId,
    order_id: input.orderId ?? null,
    case_id: input.caseId ?? null,
    kind: input.kind,
    reason: input.reason,
    evidence: JSON.stringify(input.evidence ?? {}),
    state: 'open',
    created_at: now(),
    resolved_at: null,
    resolved_by: null,
  };
  // Dedupe: an identical open item on the same order is not recreated.
  const prior = one<ReviewItem>(
    db,
    "SELECT * FROM review_items WHERE merchant_id = ? AND kind = ? AND IFNULL(order_id,'') = IFNULL(?, '') AND state = 'open'",
    item.merchant_id,
    item.kind,
    item.order_id,
  );
  if (prior) return prior;
  db.prepare(
    `INSERT INTO review_items (id, merchant_id, order_id, case_id, kind, reason, evidence, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
  ).run(
    item.id,
    item.merchant_id,
    item.order_id,
    item.case_id,
    item.kind,
    item.reason,
    item.evidence,
    item.created_at,
  );
  return item;
}

export function listReviewItems(db: Db, merchantId: string, state?: string): ReviewItem[] {
  if (state) {
    return all<ReviewItem>(
      db,
      'SELECT * FROM review_items WHERE merchant_id = ? AND state = ? ORDER BY created_at',
      merchantId,
      state,
    );
  }
  return all<ReviewItem>(
    db,
    'SELECT * FROM review_items WHERE merchant_id = ? ORDER BY created_at',
    merchantId,
  );
}

export function resolveReviewItem(db: Db, actor: Actor, itemId: string): ReviewItem {
  const item = one<ReviewItem>(db, 'SELECT * FROM review_items WHERE id = ?', itemId);
  if (!item) throw notFound('review item not found');
  if (actor.kind !== 'operator' || item.merchant_id !== actor.merchantId) {
    throw forbidden('outside your merchant');
  }
  db.prepare(
    "UPDATE review_items SET state = 'resolved', resolved_at = ?, resolved_by = ? WHERE id = ?",
  ).run(now(), actor.id, item.id);
  return { ...item, state: 'resolved', resolved_at: now(), resolved_by: actor.id };
}
