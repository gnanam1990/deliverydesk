# DeliveryDesk · Demonstration script

**Input and expected outcome.** Buyer A paid 250 USD cents for order E7. Browser times out. Seller revision 4 reports a finished 3 KB export with digest D. Deliver D on A's authenticated request and close on receipt; there is one original payment and zero refunds. An older running event at revision 3 cannot reopen the case, and buyer B receives no artifact.

**Operator surfaces.** Buyer timeline labels paid, export ready, artifact retrieved and acknowledged separately. Merchant inbox tracks stale cases, missing events, blocked refunds and redelivery authorization. Show expiry and a reissue action for eligible buyers; never print bearer links into the support timeline.

**Failure to demonstrate.** Record external event IDs and causal revisions, use an inbox and transactionally schedule work. Poll when webhook delivery fails. Use a merchant refund idempotency key if supported. On a split response query provider settlement before resuming and route unsupported lookups to manual review.

Create a labeled, rights-cleared sample through the import or creation UI. Identify the seeded input separately from all real actions and receipts. Record with two appropriate role sessions where required, browser refresh and worker restart. Use a final export or read-only case view tied to the input revision; show any unsupported capabilities as such. Record actual outcomes next to expected outcomes in the target repo.
