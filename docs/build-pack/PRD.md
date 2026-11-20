# DeliveryDesk · Product requirements

## Product decision

Recover paid digital exports from one participating seller with an order/status lookup and an authorized fulfillment store. Preserve exactly one financial disposition per paid unit. Model redelivery entitlements, incomplete evidence and explicit refund approval. Pilot single-item orders and full refunds.

**Buyer and commercial hypothesis.** Paid API and digital-goods merchants. Price per active merchant and resolved exception. Start with a seller who controls both its payment and order APIs.

**People and responsibilities.** Buyer opens an order-specific recovery case. A merchant operator grants redelivery or reviews a proposed refund. A connector reconciles verified payment and the merchant-controlled asynchronous order. A finance operator inspects final refund settlement.

## Customer journey

A paid export times out in the buyer UI. The buyer opens a case against its order. The merchant worker reports completion later. The buyer authenticates, retrieves the original artifact and acknowledgment closes the case. If fulfillment is definitively unavailable, the merchant may authorize an eligible refund.

## Acceptance scene

Buyer A paid 250 USD cents for order E7. Browser times out. Seller revision 4 reports a finished 3 KB export with digest D. Deliver D on A's authenticated request and close on receipt; there is one original payment and zero refunds. An older running event at revision 3 cannot reopen the case, and buyer B receives no artifact.

## Behaviors for the team

- **FR-01 · Merchant enrollment and order identity.** Configure one participating seller, tenant access rules, buyer order lookup and callback identity. Introduce merchant-scoped idempotent order storage.
- **FR-02 · Payment matching.** Parse a verified connector receipt, normalize asset and amount, and join it to the original invoice and event reference.
- **FR-03 · Asynchronous fulfillment.** Implement a persistent asynchronous export job and merchant status adapter. Track monotonic revisions and readable evidence-backed artifact references.
- **FR-04 · Case intake and redelivery.** Deduplicate buyer cases, authorize same-buyer redelivery and implement short-lived grants to the original immutable artifact; record completion receipts or acknowledgment. Persist a fenced retrieval claim before streaming and record the authenticated digest receipt or buyer acknowledgment.
- **FR-05 · Refund decision and settlement.** Build full-refund eligibility, merchant approval, revocation of unconsumed grants and serialized disposition. Track dispatch and settlement distinctly.
- **FR-06 · Support console and buyer timeline.** Build case timeline, evidence-aware status, operator ownership, stale-case filters and buyer refresh. Include distinct proposed, authorized, pending and settled refund badges.
- **FR-07 · Connector reconciliation and field trial.** Replay omitted, duplicated, reordered and late merchant events through connector endpoints. Add metrics for unique resolved orders, second charges, time to retrieval and false closures.

The [acceptance contract](CORE-CONTRACT.md) defines the fail/hold conditions for each requirement. Show the operator the responsible actor, decision reason, missing input and next possible action.

## Demand and release evidence

Pilot an export service with a real signing secret, persistent order API and recoverable artifact storage controlled by the pilot operator. Validate one provider sandbox or authorized small transaction separately. Track cases resolved without a second payment, time to recovery, false closures and support cost.

Track completed cases over attempted cases, human exceptions, time to resolution and direct provider costs. Preserve the denominator and separate demonstration records from pilot records. Compare with the buyer's current manual workflow on the same cases. The adjacent Atlas project is [Recibo](https://ethglobal.com/showcase/recibo-5xkrv); customer willingness to pay requires pilot evidence.

## Larger team scope

- Merchant order/fulfillment adapter certification and event replay
- Partial delivery, expiring redelivery links and replacement artifact history
- Merchant-approved partial refunds and exception triage with aging
- Buyer self-service lookup, case correspondence and merchant SLA reporting

These are product surfaces for a substantial team backlog. Size independently deliverable changes from real integrations, acceptance cases and findings. Around 500 meaningful commits is a scope preference. Actual change count follows the implementation.
