# DeliveryDesk · module index

These are dependency-ordered work units. Once a contract is agreed, UI, adapter and test contributors may proceed on fixtures matching that contract and integrate against its real implementation before acceptance.

1. [M01 · Merchant enrollment and order identity](prompts/M01.md) — Configure one participating seller, tenant access rules, buyer order lookup and callback identity. Introduce merchant-scoped idempotent order storage.
2. [M02 · Payment matching](prompts/M02.md) — Parse a verified connector receipt, normalize asset and amount, and join it to the original invoice and event reference.
3. [M03 · Asynchronous fulfillment](prompts/M03.md) — Implement a persistent asynchronous export job and merchant status adapter. Track monotonic revisions and readable evidence-backed artifact references.
4. [M04 · Case intake and redelivery](prompts/M04.md) — Deduplicate buyer cases, authorize same-buyer redelivery and implement short-lived grants to the original immutable artifact; record completion receipts or acknowledgment. Persist a fenced retrieval claim before streaming and record the authenticated digest receipt or buyer acknowledgment.
5. [M05 · Refund decision and settlement](prompts/M05.md) — Build full-refund eligibility, merchant approval, revocation of unconsumed grants and serialized disposition. Track dispatch and settlement distinctly.
6. [M06 · Support console and buyer timeline](prompts/M06.md) — Build case timeline, evidence-aware status, operator ownership, stale-case filters and buyer refresh. Include distinct proposed, authorized, pending and settled refund badges.
7. [M07 · Connector reconciliation and field trial](prompts/M07.md) — Replay omitted, duplicated, reordered and late merchant events through connector endpoints. Add metrics for unique resolved orders, second charges, time to retrieval and false closures.
