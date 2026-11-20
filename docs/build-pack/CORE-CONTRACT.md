# DeliveryDesk · acceptance contract

### FR-01 — Merchant enrollment and order identity

Configure one participating seller, tenant access rules, buyer order lookup and callback identity. Introduce merchant-scoped idempotent order storage.

### INV-01 — Merchant enrollment and order identity

An external order ID is unique only inside its merchant.

### FR-02 — Payment matching

Parse a verified connector receipt, normalize asset and amount, and join it to the original invoice and event reference.

### INV-02 — Payment matching

A payment can fund at most one canonical order for a given transfer event.

### FR-03 — Asynchronous fulfillment

Implement a persistent asynchronous export job and merchant status adapter. Track monotonic revisions and readable evidence-backed artifact references.

### INV-03 — Asynchronous fulfillment

A ready state requires matching retrievable artifact bytes and digest.

### FR-04 — Case intake and redelivery

Deduplicate buyer cases, authorize same-buyer redelivery and implement short-lived grants to the original immutable artifact; record completion receipts or acknowledgment. Persist a fenced retrieval claim before streaming and record the authenticated digest receipt or buyer acknowledgment.

### INV-04 — Case intake and redelivery

Redelivery cannot initiate a new purchase or change the delivered digest.

### FR-05 — Refund decision and settlement

Build full-refund eligibility, merchant approval, revocation of unconsumed grants and serialized disposition. Track dispatch and settlement distinctly.

### INV-05 — Refund decision and settlement

An order with final delivery or an eligible in-flight refund cannot take the other terminal path automatically.

### FR-06 — Support console and buyer timeline

Build case timeline, evidence-aware status, operator ownership, stale-case filters and buyer refresh. Include distinct proposed, authorized, pending and settled refund badges.

### INV-06 — Support console and buyer timeline

Case closure discloses the evidence for its terminal classification.

### FR-07 — Connector reconciliation and field trial

Replay omitted, duplicated, reordered and late merchant events through connector endpoints. Add metrics for unique resolved orders, second charges, time to retrieval and false closures.

### INV-07 — Connector reconciliation and field trial

Event replay and process restart preserve original settlement and entitlement identities.

### NFR-01 — Replayable evidence

A reviewer can reproduce the outcome from the exact input revision, actor scope, persisted decision and redacted evidence reference after a process restart.
