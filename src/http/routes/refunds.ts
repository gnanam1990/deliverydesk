import type { App } from '../server.ts';
import { tx, all } from '../../db/db.ts';
import { withIdempotency } from '../../domain/idempotency.ts';
import { actorKey } from '../../domain/auth.ts';
import {
  proposeRefund,
  approveRefund,
  declineRefund,
  getRefund,
  refundView,
  refundEligibility,
} from '../../domain/refunds.ts';
import { getCase } from '../../domain/cases.ts';
import { listReviewItems, resolveReviewItem } from '../../domain/review.ts';
import { fieldMetrics } from '../../domain/metrics.ts';
import type { ReviewItem } from '../../domain/types.ts';

const itemView = (i: ReviewItem) => ({
  id: i.id,
  orderId: i.order_id,
  caseId: i.case_id,
  kind: i.kind,
  reason: i.reason,
  evidence: JSON.parse(i.evidence) as Record<string, unknown>,
  state: i.state,
  createdAt: i.created_at,
  resolvedAt: i.resolved_at,
});

export function registerRefundRoutes(app: App): void {
  // Merchant operator proposes a refund on a case (support role).
  app.route('POST', '/cases/{id}/refund-proposals', {
    auth: { kind: 'operator' },
    handler: (ctx) => {
      const res = tx(ctx.db, () =>
        withIdempotency(
          ctx.db,
          {
            key: ctx.idempotencyKey,
            actorKey: actorKey(ctx.actor!),
            endpoint: 'POST /cases/{id}/refund-proposals',
            payload: { case: ctx.params['id'], body: ctx.body },
          },
          () => {
            const reason =
              typeof (ctx.body as Record<string, unknown>)?.['reason'] === 'string'
                ? ((ctx.body as Record<string, unknown>)['reason'] as string)
                : 'fulfillment_unavailable';
            const r = proposeRefund(ctx.db, ctx.actor!, ctx.params['id']!, reason);
            return { status: 201, body: refundView(ctx.db, r) };
          },
        ),
      );
      return { status: res.status, json: res.body };
    },
  });

  // Eligibility preview for the console (proposed/authorized/pending/settled UI).
  app.route('GET', '/cases/{id}/refund-eligibility', {
    auth: { kind: 'operator' },
    handler: (ctx) => {
      const c = getCase(ctx.db, ctx.params['id']!);
      return { status: 200, json: refundEligibility(ctx.db, c.order_id) };
    },
  });

  // Finance approval — a different authority than case access.
  app.route('POST', '/refunds/{id}/approve', {
    auth: { kind: 'operator', role: 'finance' },
    handler: (ctx) => {
      const res = tx(ctx.db, () =>
        withIdempotency(
          ctx.db,
          {
            key: ctx.idempotencyKey,
            actorKey: actorKey(ctx.actor!),
            endpoint: 'POST /refunds/{id}/approve',
            payload: { refund: ctx.params['id'] },
          },
          () => ({
            status: 200,
            body: refundView(ctx.db, approveRefund(ctx.db, ctx.actor!, ctx.params['id']!)),
          }),
        ),
      );
      return { status: res.status, json: res.body };
    },
  });

  app.route('POST', '/refunds/{id}/decline', {
    auth: { kind: 'operator' },
    handler: (ctx) => {
      const b = (ctx.body ?? {}) as Record<string, unknown>;
      const reason = typeof b['reason'] === 'string' ? b['reason'] : 'operator declined';
      return {
        status: 200,
        json: refundView(ctx.db, declineRefund(ctx.db, ctx.actor!, ctx.params['id']!, reason)),
      };
    },
  });

  app.route('GET', '/refunds/{id}', {
    auth: { kind: 'operator' },
    handler: (ctx) => ({ status: 200, json: refundView(ctx.db, getRefund(ctx.db, ctx.params['id']!)) }),
  });

  app.route('GET', '/refunds', {
    auth: { kind: 'operator' },
    handler: (ctx) => {
      const rows = all<{ id: string }>(
        ctx.db,
        `SELECT r.id FROM refunds r JOIN cases c ON c.id = r.case_id WHERE c.merchant_id = ? ORDER BY r.created_at DESC`,
        ctx.actor!.merchantId!,
      );
      return { status: 200, json: rows.map((r) => refundView(ctx.db, getRefund(ctx.db, r.id))) };
    },
  });

  app.route('GET', '/console/metrics', {
    auth: { kind: 'operator' },
    handler: (ctx) => ({ status: 200, json: fieldMetrics(ctx.db, ctx.actor!.merchantId!) }),
  });

  // Merchant review queue.
  app.route('GET', '/console/review-items', {
    auth: { kind: 'operator' },
    handler: (ctx) => ({
      status: 200,
      json: listReviewItems(ctx.db, ctx.actor!.merchantId!).map(itemView),
    }),
  });

  app.route('POST', '/console/review-items/{id}/resolve', {
    auth: { kind: 'operator' },
    handler: (ctx) => ({
      status: 200,
      json: itemView(resolveReviewItem(ctx.db, ctx.actor!, ctx.params['id']!)),
    }),
  });
}
