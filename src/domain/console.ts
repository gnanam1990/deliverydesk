import type { Db } from '../db/db.ts';
import { all, one } from '../db/db.ts';
import type { Case, CaseEvent, Fulfillment, Payment, Refund, Retrieval } from './types.ts';

/**
 * Support-console read model (FR-06). It reconstructs the order's evidence
 * chronology from durable rows instead of trusting a single case status:
 * payment, export revisions, case events, retrieval and refund outcomes all
 * keep their exact persisted timestamps.
 */
export interface TimelineItem {
  at: string;
  sort: number;
  label: string;
  detail: string;
  href?: string;
}

const short = (v: string | null | undefined, n = 16): string => (v ? v.slice(0, n) : '');

export function caseEvidenceTimeline(db: Db, c: Case, opts: { operator: boolean }): TimelineItem[] {
  const items: TimelineItem[] = [];
  const payments = all<Payment>(
    db,
    'SELECT * FROM payments WHERE order_id = ? ORDER BY created_at, id',
    c.order_id,
  );
  for (const p of payments) {
    const at = p.confirmed_at ?? p.created_at;
    items.push({
      at,
      sort: 10,
      label: p.state === 'confirmed' ? 'Payment confirmed' : 'Payment quarantined',
      detail:
        p.state === 'confirmed'
          ? `${p.amount_minor} ${p.asset} on ${p.rail}; transfer ${p.transfer_ref}`
          : `${p.amount_minor} ${p.asset}; quarantined as ${p.quarantine_reason ?? 'mismatch'}`,
      href: opts.operator && p.state === 'confirmed' ? `/console/payments/${p.id}/receipt` : undefined,
    });
  }

  const fulfillments = all<Fulfillment>(
    db,
    'SELECT * FROM fulfillments WHERE order_id = ? ORDER BY revision',
    c.order_id,
  );
  for (const f of fulfillments) {
    const label =
      f.state === 'ready'
        ? 'Export ready'
        : f.state === 'irrevocably_failed'
          ? 'Export unavailable'
          : f.state === 'unknown'
            ? 'Export needs investigation'
            : `Export ${f.state}`;
    items.push({
      at: f.created_at,
      sort: 20,
      label,
      detail: `revision ${f.revision}; ${f.evidence_note ?? f.reported_status}${f.artifact_digest ? `; digest ${short(f.artifact_digest)}` : ''}`,
    });
  }

  const retrievals = all<Retrieval>(
    db,
    'SELECT * FROM retrievals WHERE order_id = ? ORDER BY started_at, id',
    c.order_id,
  );
  for (const r of retrievals) {
    items.push({
      at: r.started_at,
      sort: 40,
      label: 'Artifact retrieval started',
      detail: `retrieval ${r.id}; digest ${short(r.artifact_digest)}`,
    });
    if (r.stream_finished_at) {
      items.push({
        at: r.stream_finished_at,
        sort: 45,
        label: r.state === 'interrupted' ? 'Artifact stream interrupted' : 'Artifact retrieved',
        detail: `${r.bytes_transferred} bytes transferred`,
      });
    }
    if (r.completed_at) {
      items.push({
        at: r.completed_at,
        sort: 50,
        label: r.state === 'confirmed' ? 'Authenticated delivery receipt' : `Retrieval ${r.state}`,
        detail: `state ${r.state}; ${r.bytes_transferred} bytes`,
      });
    }
  }

  const refund = one<Refund>(
    db,
    'SELECT * FROM refunds WHERE order_id = ? ORDER BY created_at DESC LIMIT 1',
    c.order_id,
  );
  if (refund) {
    items.push({
      at: refund.created_at,
      sort: 60,
      label: 'Refund proposed',
      detail: `${refund.amount_minor} ${refund.asset} proposed by ${refund.proposed_by}`,
    });
    if (refund.approved_at) {
      items.push({
        at: refund.approved_at,
        sort: 61,
        label: 'Refund authorized',
        detail: `approved by ${refund.approved_by ?? 'operator'}`,
      });
    }
    if (refund.dispatched_at) {
      items.push({
        at: refund.dispatched_at,
        sort: 62,
        label: 'Refund pending provider settlement',
        detail: `provider reference ${refund.settlement_ref ?? 'not returned'}`,
      });
    }
    if (refund.state === 'settlement_investigation') {
      items.push({
        at: refund.dispatched_at ?? refund.approved_at ?? refund.created_at,
        sort: 63,
        label: 'Pending investigation',
        detail: 'provider dispatch outcome is unknown; not settled',
      });
    }
    if (refund.settled_at) {
      items.push({
        at: refund.settled_at,
        sort: 64,
        label: 'Refund settled',
        detail: `provider settlement ${refund.settlement_ref ?? 'confirmed'}`,
      });
    }
  }

  for (const e of all<CaseEvent>(
    db,
    'SELECT * FROM case_events WHERE case_id = ? ORDER BY seq',
    c.id,
  )) {
    const detail = JSON.parse(e.detail) as Record<string, unknown>;
    items.push({
      at: e.created_at,
      sort: e.kind === 'case.delivered' ? 70 : 65,
      label: labelForCaseEvent(e.kind),
      detail: describeEvent(e.kind, detail),
    });
  }

  return items.sort((a, b) => a.at.localeCompare(b.at) || a.sort - b.sort || a.label.localeCompare(b.label));
}

function labelForCaseEvent(kind: string): string {
  switch (kind) {
    case 'case.opened': return 'Case opened';
    case 'fulfillment.ready': return 'Export ready';
    case 'grant.issued': return 'Redelivery grant issued';
    case 'case.delivered': return 'Delivery acknowledged';
    case 'retrieval.abandoned': return 'Retrieval reconciled';
    case 'refund.proposed': return 'Refund proposed';
    case 'refund.authorized': return 'Refund authorized';
    case 'refund.dispatched': return 'Refund pending provider settlement';
    case 'refund.settled': return 'Refund settled';
    case 'refund.investigation': return 'Pending investigation';
    case 'refund.declined': return 'Refund declined';
    case 'case.claimed': return 'Case ownership claimed';
    default: return kind.replaceAll('.', ' ');
  }
}

function describeEvent(kind: string, detail: Record<string, unknown>): string {
  switch (kind) {
    case 'case.delivered':
      return `${detail['evidence'] ?? 'delivery evidence'}; digest ${short(String(detail['artifactDigest'] ?? ''))}`;
    case 'grant.issued':
      return `grant ${detail['grantRef'] ?? ''}; expires ${detail['expiresAt'] ?? ''}`;
    case 'refund.investigation':
    case 'refund.declined':
      return String(detail['reason'] ?? 'operator review required');
    case 'fulfillment.ready':
      return `revision ${detail['revision'] ?? ''}; digest ${short(String(detail['artifactDigest'] ?? ''))}`;
    default:
      return Object.entries(detail).map(([k, v]) => `${k}=${String(v)}`).join('; ') || 'recorded';
  }
}

export interface ConsoleCaseRow {
  id: string;
  externalOrderId: string;
  state: string;
  reason: string;
  stale: boolean;
  owner: string | null;
  refundState: string | null;
}

export function consoleCaseQueue(
  db: Db,
  merchantId: string,
  opts: { staleOnly?: boolean; mine?: string; staleBefore: string },
): ConsoleCaseRow[] {
  const rows = all<Case & { external_order_id: string; refund_state: string | null }>(
    db,
    `SELECT c.*, o.external_order_id,
       (SELECT r.state FROM refunds r WHERE r.order_id = c.order_id ORDER BY r.created_at DESC LIMIT 1) AS refund_state
     FROM cases c JOIN orders o ON o.id = c.order_id
     WHERE c.merchant_id = ?
     ORDER BY CASE WHEN c.state IN ('delivered','refunded','closed') THEN 1 ELSE 0 END, c.created_at DESC`,
    merchantId,
  );
  return rows
    .map((c) => ({
      id: c.id,
      externalOrderId: c.external_order_id,
      state: c.state,
      reason: c.reason,
      stale: !['delivered', 'refunded', 'closed'].includes(c.state) && c.created_at <= opts.staleBefore,
      owner: c.owner_operator_id,
      refundState: c.refund_state,
    }))
    .filter((c) => (!opts.staleOnly || c.stale) && (!opts.mine || c.owner === opts.mine));
}
