import type { Db } from '../db/db.ts';
import { all, one } from '../db/db.ts';

/**
 * Field-trial metrics (FR-07). Counts are computed from durable domain rows,
 * not derived from log counters, so replay/restart cannot double-count.
 */
export function fieldMetrics(db: Db, merchantId: string) {
  const resolved = one<{ n: number }>(
    db,
    `SELECT COUNT(DISTINCT c.order_id) AS n
     FROM cases c
     WHERE c.merchant_id = ? AND c.state IN ('delivered','refunded','closed')`,
    merchantId,
  )!.n;

  // A second charge means >1 confirmed canonical payment for an order.
  const secondCharges = one<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM (
       SELECT order_id FROM payments
       WHERE merchant_id = ? AND order_id IS NOT NULL AND state = 'confirmed'
       GROUP BY order_id HAVING COUNT(*) > 1
     )`,
    merchantId,
  )!.n;

  const duplicateTransferAttempts = one<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM inbox_events
     WHERE merchant_id = ? AND kind = 'payment.receipt' AND result LIKE 'duplicate_transfer:%'`,
    merchantId,
  )!.n;

  const retrievalDurations = all<{ ms: number }>(
    db,
    `SELECT CAST((julianday(COALESCE(r.completed_at, r.stream_finished_at)) - julianday(c.created_at)) * 86400000 AS INTEGER) AS ms
     FROM retrievals r JOIN cases c ON c.order_id = r.order_id
     WHERE c.merchant_id = ? AND r.state = 'confirmed' AND COALESCE(r.completed_at, r.stream_finished_at) IS NOT NULL`,
    merchantId,
  ).map((r) => Math.max(0, r.ms));
  retrievalDurations.sort((a, b) => a - b);

  const falseClosures = one<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM cases c
     WHERE c.merchant_id = ? AND c.state = 'delivered' AND NOT EXISTS (
       SELECT 1 FROM retrievals r WHERE r.order_id = c.order_id AND r.state = 'confirmed'
     )`,
    merchantId,
  )!.n;

  const lateReadyReviews = one<{ n: number }>(
    db,
    "SELECT COUNT(*) AS n FROM review_items WHERE merchant_id = ? AND kind = 'late_ready_after_refund'",
    merchantId,
  )!.n;

  return {
    merchantId,
    uniqueResolvedOrders: resolved,
    secondCharges,
    duplicateTransferAttempts,
    timeToRetrieval: {
      count: retrievalDurations.length,
      p50Ms: retrievalDurations.length ? retrievalDurations[Math.floor((retrievalDurations.length - 1) / 2)] : null,
      maxMs: retrievalDurations.length ? retrievalDurations[retrievalDurations.length - 1] : null,
    },
    falseClosures,
    lateReadyReviewItems: lateReadyReviews,
  };
}
