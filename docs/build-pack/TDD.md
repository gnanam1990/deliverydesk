# DeliveryDesk · Technical design

## Architecture and ownership

Preserve an established target repo's stack and conventions. For a greenfield target the proposed baseline is a typed HTTP application, PostgreSQL, a supervised background worker and a role-aware web console. Use object storage for large evidence, opaque references in the database, and server-side authorization on retrieval. A transaction writes a domain decision and its outbox row together. A worker processes external side effects and stores a durable result independently of the browser session.

**Actors.** Buyer opens an order-specific recovery case. A merchant operator grants redelivery or reviews a proposed refund. A connector reconciles verified payment and the merchant-controlled asynchronous order. A finance operator inspects final refund settlement.

## Domain schema

Merchant(id,connector), Order(id,merchant_id,buyer_id,external_order_id,amount_minor,asset), Payment(id,rail,transfer_ref,event_index,order_id), Fulfillment(id,order_id,source_version,artifact_digest), Case(id,order_id,reason,disposition,version), AccessGrant(id,case_id,subject_id,artifact_digest,expires_at), Refund(id,order_id,approval_id,provider_key,settlement_ref,state), Inbox(merchant_id,event_id), Outbox(action_id,payload_hash). Unique merchant/external order, active case per order and payment transfer event. Retrieval(id,order_id,grant_id,buyer_id,artifact_digest,state,bytes_transferred,completed_at). A per-order exclusion lock serializes retrieval and refund claims.

Index tenant-scoped business keys, workflow status and pending work. Version migrations and test forward migration from a populated previous schema. Write quantities and currency using explicit units and integer minor or token units. Persist the precision alongside provider amounts. A comparison involving different currencies requires an explicit valuation source and timestamp.

## HTTP and worker boundaries

POST /orders/{id}/cases; POST /connectors/{merchant}/events; POST /cases/{id}/refresh; GET /cases/{id}; POST /cases/{id}/redelivery; GET /grants/{id}/artifact; POST /cases/{id}/acknowledge; POST /cases/{id}/refund-proposals; POST /refunds/{id}/approve; GET /refunds/{id}. Require idempotency keys on side effects.

Apply tenant membership and action scope on the server. Use a durable idempotency key on commands that can trigger work or payment. An identical retry returns the stored operation reference. A different payload under the same key yields a conflict. Keep polling and webhooks causally tied to the original operation. Apply provider signature verification when supported and reject unverified callbacks as evidence of settlement.

## Decision procedure

Join verified payment to seller invoice plus quote ID, asset and amount. Derive state from monotonic merchant revision, actual artifact existence and digest. A status of complete without a readable matching artifact is incomplete. Serialize refund approval and redelivery on the order; revoke unused grants when a refund becomes eligible. A dispatched ambiguous refund blocks further attempts until verified. A successful download receipt or explicit buyer acknowledgment is distinct from an artifact being ready. Atomically claim the order before streaming bytes. A pending or ambiguous retrieval blocks refund until reconciled. The same buyer can resume the original digest under the fenced retrieval ID. A complete server stream alone cannot prove client consumption; require an authenticated client digest receipt or explicit acknowledgment to close delivered.

## State model

Payment pending/confirmed/mismatch; fulfillment queued/running/ready/irrevocably_failed/unknown; case investigating → available → delivered or refund_review → refund_pending → refunded, with manual_review for ambiguity. Late fulfillment after refund or unreconciled refund cannot create a new entitlement.

## Recovery

Record external event IDs and causal revisions, use an inbox and transactionally schedule work. Poll when webhook delivery fails. Use a merchant refund idempotency key if supported. On a split response query provider settlement before resuming and route unsupported lookups to manual review.

Use a compare-and-set version or row lock for conflicting decisions. Persist an intent before dispatch. If the provider cannot establish what happened, expose a pending-reconciliation state and stop automatic redispatch. Reconcile with the original provider reference, exact amount and scope. Maintain append-only corrections where users depend on the original evidence.

## Operations and integration

Record operation ID, actor role, decision code, latency and the external reference in access-controlled logs. Track stalled operations by age and surface them to the responsible role. Run migrations before workers, test a process restart during an in-flight request, and check convergence from an independently restored database. Deploy web and worker with separate credentials. See [the integration contract](KITE-AND-PROVIDERS.md) and [the tests](TEST-PLAN.md).
