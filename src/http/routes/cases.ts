import type { App, HandlerResult } from '../server.ts';
import { tx, one } from '../../db/db.ts';
import { withIdempotency } from '../../domain/idempotency.ts';
import { actorKey } from '../../domain/auth.ts';
import { badRequest, notFound } from '../../domain/errors.ts';
import {
  openCase,
  getCase,
  assertCaseReadable,
  refreshCase,
  issueGrant,
  getGrant,
  claimRetrieval,
  markStreaming,
  finishStream,
  interruptStream,
  recordRetrievalReceipt,
  acknowledgeCase,
  abandonRetrieval,
  claimCaseOwnership,
  caseView,
  usableGrantForCase,
  listCasesForBuyer,
  listCasesForMerchant,
  getRetrieval,
} from '../../domain/cases.ts';
import { getOrder, lookupOrderByExternal } from '../../domain/orders.ts';
import { readArtifact } from '../../domain/artifacts.ts';
import { caseEvidenceTimeline, consoleCaseQueue } from '../../domain/console.ts';
import { wantsHtml, renderCasePage, renderConsoleQueue, renderBuyerIndex, renderRetrievalPage } from '../render.ts';
import type { Case, Order, Payment } from '../../domain/types.ts';
import type { Ctx } from '../server.ts';

function orderOf(ctx: Ctx): Order {
  return getOrder(ctx.db, ctx.actor!, ctx.params['id']!);
}

function caseOf(ctx: Ctx, param = 'id'): Case {
  const c = getCase(ctx.db, ctx.params[param]!);
  assertCaseReadable(ctx.actor!, c);
  return c;
}

function requestValue(ctx: Ctx, name: string): string | undefined {
  if (ctx.body && typeof ctx.body === 'object') {
    const value = (ctx.body as Record<string, unknown>)[name];
    if (typeof value === 'string') return value;
  }
  const value = new URLSearchParams(ctx.rawBody).get(name);
  return value === null ? undefined : value;
}

export function registerCaseRoutes(app: App): void {
  // --- Buyer: open a case on an order (deduplicated) --------------------
  app.route('POST', '/orders/{id}/cases', {
    auth: { kind: 'buyer' },
    handler: (ctx) => {
      const order = orderOf(ctx);
      const res = tx(ctx.db, () =>
        withIdempotency(
          ctx.db,
          {
            key: ctx.idempotencyKey,
            actorKey: actorKey(ctx.actor!),
            endpoint: 'POST /orders/{id}/cases',
            payload: { order: order.id, body: ctx.body },
          },
          () => {
            const reason =
              typeof (ctx.body as Record<string, unknown>)?.['reason'] === 'string'
                ? ((ctx.body as Record<string, unknown>)['reason'] as string)
                : 'export_timeout';
            const { kase, created } = openCase(ctx.db, ctx.actor!, order, reason);
            return { status: created ? 201 : 200, body: caseView(ctx.db, kase) };
          },
        ),
      );
      return { status: res.status, json: res.body };
    },
  });

  // Convenience: open a case by merchant + external id (buyer UI path).
  app.route('POST', '/cases/open-by-external', {
    auth: { kind: 'buyer' },
    handler: (ctx) => {
      const merchantId = requestValue(ctx, 'merchant_id') ?? ctx.actor!.merchantId;
      const externalId = requestValue(ctx, 'external_id');
      if (!merchantId || !externalId) {
        throw badRequest('merchant_id and external_id required');
      }
      const order = lookupOrderByExternal(ctx.db, ctx.actor!, merchantId, externalId);
      const res = tx(ctx.db, () =>
        withIdempotency(
          ctx.db,
          {
            key: ctx.idempotencyKey,
            actorKey: actorKey(ctx.actor!),
            endpoint: 'POST /cases/open-by-external',
            payload: { merchant_id: merchantId, external_id: externalId, reason: requestValue(ctx, 'reason') },
          },
          () => {
            const { kase, created } = openCase(
              ctx.db,
              ctx.actor!,
              order,
              requestValue(ctx, 'reason') ?? 'export_timeout',
            );
            return { status: created ? 201 : 200, body: caseView(ctx.db, kase) };
          },
        ),
      );
      if (wantsHtml(ctx.headers, ctx.query)) {
        return {
          status: 303,
          headers: { location: `/cases/${(res.body as { id: string }).id}` },
          html: '',
        };
      }
      return { status: res.status, json: res.body };
    },
  });

  app.route('GET', '/cases/{id}', {
    auth: { kind: 'buyer' },
    handler: (ctx) => {
      const c = caseOf(ctx);
      const view = caseView(ctx.db, c);
      if (wantsHtml(ctx.headers, ctx.query)) {
        return {
          status: 200,
          html: renderCasePage(view, caseEvidenceTimeline(ctx.db, c, { operator: false }), {
            audience: 'buyer',
          }),
        };
      }
      return { status: 200, json: view };
    },
  });

  // Operator-side case read (merchant tenant scoped). Browsers receive the
  // stable internal record page; API clients receive the JSON view.
  app.route('GET', '/console/cases/{id}', {
    auth: { kind: 'operator' },
    handler: (ctx) => {
      const c = caseOf(ctx);
      const view = caseView(ctx.db, c);
      if (wantsHtml(ctx.headers, ctx.query)) {
        return {
          status: 200,
          html: renderCasePage(view, caseEvidenceTimeline(ctx.db, c, { operator: true }), {
            audience: 'operator',
            providerReceiptHref: view.payment ? `/console/payments/${view.payment.id}/receipt` : undefined,
          }),
        };
      }
      return { status: 200, json: view };
    },
  });

  app.route('GET', '/cases', {
    auth: { kind: 'buyer' },
    handler: (ctx) => ({
      status: 200,
      json: listCasesForBuyer(ctx.db, ctx.actor!.id).map((c) => caseView(ctx.db, c)),
    }),
  });

  // Buyer case index for normal browser entry.
  app.route('GET', '/buyer', {
    auth: { kind: 'buyer' },
    handler: (ctx) => ({
      status: 200,
      html: renderBuyerIndex(
        listCasesForBuyer(ctx.db, ctx.actor!.id).map((c) => ({
          id: c.id,
          externalOrderId: one<{ external_order_id: string }>(
            ctx.db,
            'SELECT external_order_id FROM orders WHERE id = ?',
            c.order_id,
          )!.external_order_id,
          state: c.state,
          reason: c.reason,
        })),
      ),
    }),
  });

  // Operator work queue: ownership and stale filters are durable, not a
  // client-side convenience.
  app.route('GET', '/console', {
    auth: { kind: 'operator' },
    handler: (ctx) => {
      const staleBefore = new Date(Date.now() - ctx.config.caseStaleMs).toISOString();
      const rows = consoleCaseQueue(ctx.db, ctx.actor!.merchantId!, {
        staleOnly: ctx.query.get('stale') === '1',
        mine: ctx.query.get('mine') === '1' ? ctx.actor!.id : undefined,
        staleBefore,
      });
      return {
        status: 200,
        html: renderConsoleQueue(rows, {
          stale: ctx.query.get('stale') === '1',
          mine: ctx.query.get('mine') === '1',
        }),
      };
    },
  });

  app.route('GET', '/console/cases', {
    auth: { kind: 'operator' },
    handler: (ctx) => {
      const staleBefore = new Date(Date.now() - ctx.config.caseStaleMs).toISOString();
      if (ctx.query.get('stale') === '1' || ctx.query.get('mine') === '1') {
        return {
          status: 200,
          json: consoleCaseQueue(ctx.db, ctx.actor!.merchantId!, {
            staleOnly: ctx.query.get('stale') === '1',
            mine: ctx.query.get('mine') === '1' ? ctx.actor!.id : undefined,
            staleBefore,
          }),
        };
      }
      return {
        status: 200,
        json: listCasesForMerchant(ctx.db, ctx.actor!.merchantId!).map((c) =>
          caseView(ctx.db, c),
        ),
      };
    },
  });

  // Provider receipt evidence is operator-only; buyers never receive this link.
  app.route('GET', '/console/payments/{id}/receipt', {
    auth: { kind: 'operator' },
    handler: (ctx) => {
      const p = one<Payment>(
        ctx.db,
        'SELECT * FROM payments WHERE id = ? AND merchant_id = ?',
        ctx.params['id']!,
        ctx.actor!.merchantId!,
      );
      if (!p) throw notFound('payment not found');
      return {
        status: 200,
        json: {
          paymentId: p.id,
          orderId: p.order_id,
          provider: 'local-emulator',
          rail: p.rail,
          transferRef: p.transfer_ref,
          eventIndex: p.event_index,
          amountMinor: p.amount_minor,
          asset: p.asset,
          invoiceRef: p.invoice_ref,
          receiptHash: p.receipt_hash,
          state: p.state,
          confirmedAt: p.confirmed_at,
        },
      };
    },
  });

  // --- Buyer: refresh / redelivery / retrieval / acknowledge ------------
  app.route('POST', '/cases/{id}/refresh', {
    auth: { kind: 'buyer' },
    handler: (ctx) => {
      const view = caseView(ctx.db, refreshCase(ctx.db, ctx.actor!, ctx.params['id']!));
      if (wantsHtml(ctx.headers, ctx.query)) {
        return {
          status: 303,
          headers: { location: `/cases/${ctx.params['id']}` },
          html: '',
        };
      }
      return { status: 200, json: view };
    },
  });

  app.route('GET', '/cases/{id}/retrieve', {
    auth: { kind: 'buyer' },
    handler: (ctx) => {
      const c = caseOf(ctx);
      const grant = usableGrantForCase(ctx.db, ctx.actor!, c.id);
      return {
        status: 200,
        html: renderRetrievalPage(caseView(ctx.db, c), grant),
      };
    },
  });

  app.route('POST', '/cases/{id}/redelivery', {
    auth: { kind: 'buyer' },
    handler: (ctx) => {
      const res = tx(ctx.db, () =>
        withIdempotency(
          ctx.db,
          {
            key: ctx.idempotencyKey,
            actorKey: actorKey(ctx.actor!),
            endpoint: 'POST /cases/{id}/redelivery',
            payload: { case: ctx.params['id'], body: ctx.body ?? ctx.rawBody },
          },
          () => {
            const grant = issueGrant(ctx.db, ctx.config, ctx.actor!, ctx.params['id']!);
            // The grant token returns only to its buyer over this
            // authenticated channel — never into the timeline (UI-SPEC).
            return {
              status: 201,
              body: {
                grantId: grant.id,
                expiresAt: grant.expires_at,
                artifactDigest: grant.artifact_digest,
              },
            };
          },
        ),
      );
      if (wantsHtml(ctx.headers, ctx.query)) {
        return {
          status: 303,
          headers: { location: `/cases/${ctx.params['id']}/retrieve` },
          html: '',
        };
      }
      return { status: res.status, json: res.body };
    },
  });

  /**
   * Artifact stream behind a fenced retrieval claim. The claim row exists
   * before the first byte moves; the buyer then proves receipt via the
   * authenticated digest receipt endpoint (or explicit acknowledgment).
   */
  app.route('GET', '/grants/{id}/artifact', {
    auth: { kind: 'buyer' },
    handler: async (ctx): Promise<HandlerResult> => {
      const grant = getGrant(ctx.db, ctx.params['id']!);
      const retrieval = claimRetrieval(ctx.db, ctx.actor!, grant);
      const bytes = await readArtifact(ctx.config, grant.artifact_digest);

      const CHUNK = 512;
      const db = ctx.db;
      const retId = retrieval.id;
      const iterable = (async function* () {
        markStreaming(db, retId);
        for (let i = 0; i < bytes.length; i += CHUNK) {
          yield bytes.subarray(i, i + CHUNK);
          await new Promise((r) => setImmediate(r));
        }
      })();

      return {
        status: 200,
        bytes: iterable,
        contentType: 'application/octet-stream',
        headers: {
          'content-length': String(bytes.byteLength),
          'content-disposition': `attachment; filename="deliverydesk-export-${grant.artifact_digest.slice(0, 12)}.bin"`,
          'x-artifact-digest': grant.artifact_digest,
          'x-retrieval-id': retrieval.id,
        },
        onStreamEnd: (complete, bytesWritten) => {
          if (complete) finishStream(db, retId, bytesWritten);
          else interruptStream(db, retId, bytesWritten);
        },
      };
    },
  });

  // Authenticated client digest receipt — the real delivery proof.
  app.route('POST', '/retrievals/{id}/receipt', {
    auth: { kind: 'buyer' },
    handler: (ctx) => {
      const b = (ctx.body ?? {}) as Record<string, unknown>;
      if (typeof b['digest'] !== 'string') throw badRequest('digest required');
      const res = tx(ctx.db, () =>
        withIdempotency(
          ctx.db,
          {
            key: ctx.idempotencyKey,
            actorKey: actorKey(ctx.actor!),
            endpoint: 'POST /retrievals/{id}/receipt',
            payload: { retrieval: ctx.params['id'], body: ctx.body },
          },
          () => {
            const { retrieval, kase } = recordRetrievalReceipt(
              ctx.db,
              ctx.actor!,
              ctx.params['id']!,
              b['digest'] as string,
            );
            return { status: 200, body: { retrievalState: retrieval.state, case: caseView(ctx.db, kase) } };
          },
        ),
      );
      return { status: res.status, json: res.body };
    },
  });

  app.route('POST', '/cases/{id}/acknowledge', {
    auth: { kind: 'buyer' },
    handler: (ctx) => {
      const res = tx(ctx.db, () =>
        withIdempotency(
          ctx.db,
          {
            key: ctx.idempotencyKey,
            actorKey: actorKey(ctx.actor!),
            endpoint: 'POST /cases/{id}/acknowledge',
            payload: { case: ctx.params['id'] },
          },
          () => ({
            status: 200,
            body: caseView(ctx.db, acknowledgeCase(ctx.db, ctx.actor!, ctx.params['id']!)),
          }),
        ),
      );
      if (wantsHtml(ctx.headers, ctx.query)) {
        return {
          status: 303,
          headers: { location: `/cases/${ctx.params['id']}` },
          html: '',
        };
      }
      return { status: res.status, json: res.body };
    },
  });

  // --- Operator: ownership + retrieval reconcile ------------------------
  app.route('POST', '/cases/{id}/claim', {
    auth: { kind: 'operator' },
    handler: (ctx) => ({
      status: 200,
      json: caseView(ctx.db, claimCaseOwnership(ctx.db, ctx.actor!, ctx.params['id']!)),
    }),
  });

  app.route('POST', '/retrievals/{id}/abandon', {
    auth: { kind: 'operator' },
    handler: (ctx) => {
      const r = abandonRetrieval(ctx.db, ctx.actor!, ctx.params['id']!);
      return { status: 200, json: { retrievalState: r.state } };
    },
  });

  app.route('GET', '/retrievals/{id}', {
    auth: { kind: 'operator' },
    handler: (ctx) => {
      const r = getRetrieval(ctx.db, ctx.params['id']!);
      return {
        status: 200,
        json: {
          id: r.id,
          orderId: r.order_id,
          state: r.state,
          bytesTransferred: r.bytes_transferred,
          digest: r.artifact_digest,
          startedAt: r.started_at,
          completedAt: r.completed_at,
        },
      };
    },
  });
}
