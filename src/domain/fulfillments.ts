import type { Db } from '../db/db.ts';
import { all, one, tx } from '../db/db.ts';
import type { Config } from '../config.ts';
import { newId } from '../ids.ts';
import { now } from '../clock.ts';
import type { ConnectorEvent, DomainCtx } from './inbox.ts';
import { ingestEvent } from './inbox.ts';
import { enqueue, registerOutboxDispatcher } from './outbox.ts';
import { hasArtifact, readArtifact, storeArtifact } from './artifacts.ts';
import { appendCaseEvent } from './timeline.ts';
import { fetchStatus, fetchArtifactBytes } from '../adapters/merchantService.ts';
import { openReviewItem } from './review.ts';
import type {
  Case,
  Fulfillment,
  FulfillmentState,
  Merchant,
  Order,
  Refund,
} from './types.ts';

/**
 * Asynchronous fulfillment (FR-03/INV-03). Merchant status reports carry a
 * monotonic revision; the canonical row is append-only per revision. A
 * reported `complete` becomes `ready` only when artifact bytes retrievable
 * from the store match the declared digest — a status alone is never proof.
 */

export interface StatusPayload {
  revision: number;
  status: string;
  artifact_digest?: string;
  artifact_ref?: string;
  /** Inline bytes (emulator/loopback transport). */
  artifact_b64?: string;
  note?: string;
}

function latestRevision(db: Db, orderId: string): number {
  const r = one<{ rev: number | null }>(
    db,
    'SELECT MAX(revision) AS rev FROM fulfillments WHERE order_id = ?',
    orderId,
  );
  return r?.rev ?? 0;
}

function insertFulfillment(
  db: Db,
  f: Omit<Fulfillment, 'id' | 'created_at' | 'updated_at'>,
): Fulfillment {
  const row: Fulfillment = { ...f, id: newId('ful'), created_at: now(), updated_at: now() };
  db.prepare(
    `INSERT INTO fulfillments (id, order_id, revision, state, reported_status, artifact_digest, artifact_ref, evidence_note, source_event_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.order_id,
    row.revision,
    row.state,
    row.reported_status,
    row.artifact_digest,
    row.artifact_ref,
    row.evidence_note,
    row.source_event_id,
    row.created_at,
    row.updated_at,
  );
  return row;
}

/** When a fulfillment becomes ready, an investigating case advances. */
function onReady(db: Db, orderId: string, digest: string, revision: number): void {
  const open = one<Case>(
    db,
    "SELECT * FROM cases WHERE order_id = ? AND state = 'investigating' ORDER BY created_at LIMIT 1",
    orderId,
  );
  if (!open) return;
  db.prepare("UPDATE cases SET state = 'available', version = version + 1 WHERE id = ?").run(open.id);
  appendCaseEvent(db, open.id, 'worker', 'fulfillment', 'fulfillment.ready', {
    revision,
    artifactDigest: digest,
  });
}

/**
 * Re-derive ready for a 'complete'-reported revision whose artifact bytes
 * just became retrievable. Called after an artifact fetch completes.
 */
export function reevaluateReady(db: Db, config: Config, orderId: string): boolean {
  const candidates = all<Fulfillment>(
    db,
    `SELECT * FROM fulfillments
     WHERE order_id = ? AND state = 'unknown' AND reported_status = 'complete' AND artifact_digest IS NOT NULL
     ORDER BY revision DESC`,
    orderId,
  );
  for (const f of candidates) {
    if (hasArtifact(config, f.artifact_digest!)) {
      db.prepare("UPDATE fulfillments SET state = 'ready', evidence_note = ?, updated_at = ? WHERE id = ?").run(
        'artifact verified after fetch',
        now(),
        f.id,
      );
      onReady(db, orderId, f.artifact_digest!, f.revision);
      return true;
    }
  }
  return false;
}

/** Core status application shared by webhook events and poller reports. */
export function applyStatus(
  ctx: DomainCtx,
  merchant: Merchant,
  orderExternalId: string,
  p: StatusPayload,
  sourceEventId: string,
): string {
  const { db, config } = ctx;
  return tx(db, () => {
    const order = one<Order>(
      db,
      'SELECT * FROM orders WHERE merchant_id = ? AND external_order_id = ?',
      merchant.id,
      orderExternalId,
    );
    if (!order) return 'unknown_order';
    if (!Number.isInteger(p.revision) || p.revision < 1) return 'bad_revision';

    const latest = latestRevision(db, order.id);
    // Monotonicity: a report at or below the applied revision is stale and
    // ignored — an older running event cannot reopen anything (INV-07).
    if (p.revision <= latest) return `stale_revision:${p.revision}<=${latest}`;

    let state: FulfillmentState;
    let evidence: string | null = p.note ?? null;
    let artifactDigest: string | null = p.artifact_digest ?? null;

    switch (p.status) {
      case 'queued':
        state = 'queued';
        break;
      case 'running':
        state = 'running';
        break;
      case 'failed':
        state = 'irrevocably_failed';
        evidence = p.note ?? 'merchant reported permanent failure';
        break;
      case 'complete': {
        if (p.artifact_b64 != null) {
          // Inline bytes: store, verify declared digest.
          const stored = storeArtifact(db, config, Buffer.from(p.artifact_b64, 'base64'));
          if (artifactDigest == null) {
            artifactDigest = stored.digest;
          }
          if (stored.digest === artifactDigest) {
            state = 'ready';
            evidence = 'artifact received inline and verified';
          } else {
            state = 'unknown';
            evidence = `digest_mismatch: declared ${artifactDigest.slice(0, 16)} stored ${stored.digest.slice(0, 16)}`;
          }
        } else if (artifactDigest && hasArtifact(config, artifactDigest)) {
          state = 'ready';
          evidence = 'artifact already stored and verified';
        } else if (p.artifact_ref) {
          state = 'unknown';
          evidence = 'artifact_fetch_pending';
          enqueue(
            db,
            'artifact.fetch',
            {
              merchant_id: merchant.id,
              order_id: order.id,
              digest: artifactDigest,
              artifact_ref: p.artifact_ref,
            },
            { actionId: `artifact-fetch:${order.id}:${artifactDigest ?? 'unknown'}` },
          );
        } else {
          // T-006 boundary: reported complete but nothing retrievable.
          state = 'unknown';
          evidence = 'artifact_missing: reported complete with no artifact reference';
        }
        break;
      }
      default:
        state = 'unknown';
        evidence = `unrecognized_status:${p.status}`;
    }

    insertFulfillment(db, {
      order_id: order.id,
      revision: p.revision,
      state,
      reported_status: p.status,
      artifact_digest: artifactDigest,
      artifact_ref: p.artifact_ref ?? null,
      evidence_note: evidence,
      source_event_id: sourceEventId,
    });
    if (state === 'ready' && artifactDigest) {
      // T-014: a ready report arriving after refund settlement preserves the
      // settled disposition and sends the conflict to a person. It must not
      // reopen a case or create any new entitlement.
      const settledRefund = one<Refund>(
        db,
        "SELECT * FROM refunds WHERE order_id = ? AND state = 'settled'",
        order.id,
      );
      if (settledRefund) {
        const c = one<Case>(db, 'SELECT * FROM cases WHERE id = ?', settledRefund.case_id);
        openReviewItem(db, {
          merchantId: merchant.id,
          orderId: order.id,
          caseId: settledRefund.case_id,
          kind: 'late_ready_after_refund',
          reason: 'artifact became ready after refund settlement',
          evidence: {
            revision: p.revision,
            artifactDigest,
            sourceEventId,
            refundId: settledRefund.id,
            settlementRef: settledRefund.settlement_ref,
          },
        });
        if (c) {
          appendCaseEvent(db, c.id, 'connector', sourceEventId, 'fulfillment.late_ready_after_refund', {
            revision: p.revision,
            artifactDigest,
            refundId: settledRefund.id,
          });
        }
      } else {
        onReady(db, order.id, artifactDigest, p.revision);
      }
    }
    return `${state}:rev${p.revision}`;
  });
}

/** Connector event handler for kind 'fulfillment.status'. */
export function applyMerchantStatus(
  ctx: DomainCtx,
  merchant: Merchant,
  event: ConnectorEvent,
): string {
  const p = event.payload as Record<string, unknown>;
  const status: StatusPayload = {
    revision: Number(p['revision'] ?? 0),
    status: String(p['status'] ?? ''),
  };
  if (p['artifact_digest'] != null) status.artifact_digest = String(p['artifact_digest']);
  if (p['artifact_ref'] != null) status.artifact_ref = String(p['artifact_ref']);
  if (p['artifact_b64'] != null) status.artifact_b64 = String(p['artifact_b64']);
  if (p['note'] != null) status.note = String(p['note']);
  return applyStatus(
    ctx,
    merchant,
    event.order_external_id ?? String(p['order_external_id'] ?? ''),
    status,
    event.event_id,
  );
}

export function latestFulfillment(db: Db, orderId: string): Fulfillment | undefined {
  return one<Fulfillment>(
    db,
    'SELECT * FROM fulfillments WHERE order_id = ? ORDER BY revision DESC LIMIT 1',
    orderId,
  );
}

export function isReady(db: Db, orderId: string): { ready: boolean; digest?: string } {
  const f = latestFulfillment(db, orderId);
  if (f?.state === 'ready' && f.artifact_digest) {
    return { ready: true, digest: f.artifact_digest };
  }
  return { ready: false };
}

/**
 * Worker task: poll the merchant status API for orders whose fulfillment is
 * not terminal — the reconciliation path for suppressed/failed webhooks
 * (FR-07). Reports flow through the same signed-event intake so dedupe and
 * revision rules are identical; poll event ids are provider-stable per
 * revision.
 */
export async function pollMerchantStatuses(db: Db, config: Config): Promise<number> {
  const pending = all<{ o: Order } & { merchant_id: string }>(
    db,
    `SELECT o.*, o.merchant_id AS merchant_id FROM orders o
     WHERE EXISTS (
       SELECT 1 FROM cases c WHERE c.order_id = o.id
         AND c.state NOT IN ('delivered', 'refunded', 'closed')
     ) OR (
       o.state = 'paid' AND NOT EXISTS (
         SELECT 1 FROM fulfillments f WHERE f.order_id = o.id
           AND f.state IN ('ready', 'irrevocably_failed')
       )
     )`,
  );
  const merchants = new Map<string, Merchant>();
  let applied = 0;
  for (const order of pending as unknown as Order[]) {
    let merchant = merchants.get(order.merchant_id);
    if (!merchant) {
      merchant = one<Merchant>(db, 'SELECT * FROM merchants WHERE id = ?', order.merchant_id);
      if (!merchant) continue;
      merchants.set(order.merchant_id, merchant);
    }
    if (!merchant.status_base_url) continue;
    try {
      const report = await fetchStatus(config, merchant, order.external_order_id);
      if (!report) continue;
      const result = ingestEvent(
        { db, config },
        merchant,
        {
          event_id: report.event_id,
          kind: 'fulfillment.status',
          order_external_id: order.external_order_id,
          payload: {
            revision: report.revision,
            status: report.status,
            artifact_digest: report.artifact_digest,
            artifact_ref: report.artifact_url,
            note: report.note,
          },
        },
      );
      if (result.status === 'processed' && !result.detail.startsWith('stale')) applied++;
    } catch (e) {
      // Transient adapter failures are retried next tick; logged without payloads.
      console.error(`[worker] status poll for ${order.external_order_id}: ${(e as Error).message}`);
    }
  }
  return applied;
}

/** Outbox effect: pull a reported artifact into the store and re-derive. */
export function registerArtifactFetchDispatcher(): void {
  registerOutboxDispatcher('artifact.fetch', async (db, config, payload) => {
    const merchant = one<Merchant>(
      db,
      'SELECT * FROM merchants WHERE id = ?',
      String(payload['merchant_id']),
    );
    if (!merchant) return { ok: false, result: 'merchant missing' };
    try {
      const bytes = await fetchArtifactBytes(config, merchant, String(payload['artifact_ref']));
      const stored = storeArtifact(db, config, bytes);
      const expected = payload['digest'] != null ? String(payload['digest']) : null;
      if (expected && stored.digest !== expected) {
        return {
          ok: false,
          result: `digest_mismatch expected ${expected.slice(0, 16)} got ${stored.digest.slice(0, 16)}`,
        };
      }
      tx(db, () => reevaluateReady(db, config, String(payload['order_id'])));
      return { ok: true, result: `stored:${stored.digest.slice(0, 16)}` };
    } catch (e) {
      return { ok: false, result: (e as Error).message, retryAfterMs: 10_000 };
    }
  });
}
