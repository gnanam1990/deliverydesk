# DeliveryDesk · Operator and customer experience

## Work surfaces and primary interaction

Buyer timeline labels paid, export ready, artifact retrieved and acknowledged separately. Merchant inbox tracks stale cases, missing events, blocked refunds and redelivery authorization. Show expiry and a reissue action for eligible buyers; never print bearer links into the support timeline.

**Walkthrough.** A paid export times out in the buyer UI. The buyer opens a case against its order. The merchant worker reports completion later. The buyer authenticates, retrieves the original artifact and acknowledgment closes the case. If fulfillment is definitively unavailable, the merchant may authorize an eligible refund.

## Interaction contract

Start a returning user in their permitted work queue. Open a record on a stable, shareable internal route. Keep input revisions, current state, decision explanation and evidence within the same case. Put actor, cost, scope and irreversible consequences beside the relevant confirmation. After submission, show the persisted operation ID and allow navigation away while the worker runs.

Support loading, empty, in-progress, pending external confirmation, denied, stale revision, completed-with-findings and unavailable states where applicable. Render server values after refresh. Preserve drafts on recoverable errors, show why a retry is or is not allowed, and make partial evidence individually identifiable.

## Accessibility acceptance

Use native controls, keyboard-visible focus, accessible names and text equivalents for status colors. On mobile show the primary task and decision before secondary details. Keep tables navigable with explicit headers, respect reduced motion, announce saved/submitted states and focus the first invalid field. Verify the case flow with keyboard-only navigation at 320 CSS pixels and with screen-reader status announcements. Include the client-appropriate redacted view in the browser proof.
