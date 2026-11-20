/**
 * Domain model and state enums. States follow TDD.md "State model":
 *   payment:      pending | confirmed | mismatch
 *   fulfillment:  queued | running | ready | irrevocably_failed | unknown
 *   case:         investigating | available | delivered |
 *                 refund_review | refund_pending | refunded | manual_review | closed
 *   retrieval:    claimed | streaming | awaiting_receipt |
 *                 interrupted | confirmed | abandoned | failed
 *   refund:       proposed | authorized | dispatch_pending | dispatched |
 *                 settled | settlement_investigation | declined | failed
 */

export type PaymentState = 'pending' | 'confirmed' | 'mismatch';
export type FulfillmentState =
  | 'queued'
  | 'running'
  | 'ready'
  | 'irrevocably_failed'
  | 'unknown';
export type CaseState =
  | 'investigating'
  | 'available'
  | 'delivered'
  | 'refund_review'
  | 'refund_pending'
  | 'refunded'
  | 'manual_review'
  | 'closed';
export type RetrievalState =
  | 'claimed'
  | 'streaming'
  | 'awaiting_receipt'
  | 'interrupted'
  | 'confirmed'
  | 'abandoned'
  | 'failed';
export type RefundState =
  | 'proposed'
  | 'authorized'
  | 'dispatch_pending'
  | 'dispatched'
  | 'settled'
  | 'settlement_investigation'
  | 'declined'
  | 'failed';

/** Non-terminal retrieval states block refund dispatch while ambiguous. */
export const ACTIVE_RETRIEVAL_STATES: RetrievalState[] = [
  'claimed',
  'streaming',
  'awaiting_receipt',
  'interrupted',
];

/** Terminal refund states after which no delivery-side disposition may fire. */
export const SETTLED_REFUND_STATES: RefundState[] = ['settled'];

export type ActorKind = 'buyer' | 'operator' | 'connector' | 'worker' | 'system';

export interface Actor {
  kind: ActorKind;
  id: string;
  merchantId?: string;
  roles?: string[];
}

export interface Merchant {
  id: string;
  name: string;
  connector_kind: string;
  callback_secret: string;
  status_base_url: string | null;
  refund_base_url: string | null;
  created_at: string;
}

export interface Buyer {
  id: string;
  merchant_id: string;
  external_ref: string;
  token_hash: string;
  display_name: string;
  created_at: string;
}

export interface Operator {
  id: string;
  merchant_id: string;
  name: string;
  roles: string;
  token_hash: string;
  revoked_at: string | null;
  created_at: string;
}

export interface Order {
  id: string;
  merchant_id: string;
  buyer_id: string;
  external_order_id: string;
  amount_minor: number;
  asset: string;
  description: string;
  invoice_ref: string;
  state: string;
  created_at: string;
}

export interface Payment {
  id: string;
  order_id: string | null;
  merchant_id: string;
  rail: string;
  transfer_ref: string;
  event_index: number;
  amount_minor: number;
  asset: string;
  invoice_ref: string;
  receipt_hash: string;
  state: PaymentState;
  quarantine_reason: string | null;
  created_at: string;
  confirmed_at: string | null;
}

export interface Fulfillment {
  id: string;
  order_id: string;
  revision: number;
  state: FulfillmentState;
  reported_status: string;
  artifact_digest: string | null;
  artifact_ref: string | null;
  evidence_note: string | null;
  source_event_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Case {
  id: string;
  order_id: string;
  merchant_id: string;
  buyer_id: string;
  reason: string;
  state: CaseState;
  disposition: string | null;
  version: number;
  owner_operator_id: string | null;
  opened_by: string;
  evidence_note: string | null;
  created_at: string;
  closed_at: string | null;
}

export interface CaseEvent {
  seq: number;
  case_id: string;
  actor_kind: ActorKind;
  actor_id: string;
  kind: string;
  detail: string;
  created_at: string;
}

export interface AccessGrant {
  id: string;
  case_id: string;
  order_id: string;
  subject_id: string;
  artifact_digest: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  created_at: string;
}

export interface Retrieval {
  id: string;
  order_id: string;
  grant_id: string;
  buyer_id: string;
  artifact_digest: string;
  state: RetrievalState;
  bytes_transferred: number;
  client_digest: string | null;
  started_at: string;
  stream_finished_at: string | null;
  completed_at: string | null;
}

export interface Refund {
  id: string;
  order_id: string;
  case_id: string;
  amount_minor: number;
  asset: string;
  provider_key: string;
  idempotency_key: string;
  state: RefundState;
  settlement_ref: string | null;
  proposed_by: string;
  approved_by: string | null;
  decline_reason: string | null;
  created_at: string;
  approved_at: string | null;
  dispatched_at: string | null;
  settled_at: string | null;
}

export interface InboxEvent {
  id: string;
  merchant_id: string;
  event_id: string;
  kind: string;
  payload: string;
  payload_hash: string;
  received_at: string;
  processed_at: string | null;
  result: string | null;
}

export interface OutboxRow {
  seq: number;
  action_id: string;
  kind: string;
  payload: string;
  payload_hash: string;
  state: string;
  attempts: number;
  next_attempt_at: string;
  result: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReviewItem {
  id: string;
  merchant_id: string;
  order_id: string | null;
  case_id: string | null;
  kind: string;
  reason: string;
  evidence: string;
  state: string;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}
