# DeliveryDesk · Test plan

Every test begins NOT_RUN. [Registry](requirements.json) links each test to one module and its requirement. Run fast domain tests first, then real database/worker integration and normal browser entry points. External integration evidence states its environment and provider.

## Reference end-to-end acceptance

Buyer A paid 250 USD cents for order E7. Browser times out. Seller revision 4 reports a finished 3 KB export with digest D. Deliver D on A's authenticated request and close on receipt; there is one original payment and zero refunds. An older running event at revision 3 cannot reopen the case, and buyer B receives no artifact.

Run from a clean checkout. Capture the action through the UI or supported API, restart at an uncertain boundary, inspect the recovered record with a second authorized session and export the allowed outcome. Verify a different tenant cannot access it. Exercise the chosen provider against an authorized sandbox/test environment; a local boundary emulator is suitable for deterministic fault injection. Qualify each result by environment.

## Module tests

### T-001 — Merchant enrollment and order identity • expected behavior

Status: NOT_RUN

Two merchants can both own order E7 while their buyers see only their own record.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-002 — Merchant enrollment and order identity • failure boundary

Status: NOT_RUN

A forged callback for E7 fails authentication before any case changes.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-003 — Payment matching • expected behavior

Status: NOT_RUN

A receipt for E7 and 250 USD cents records one payment and collapses a duplicate callback.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-004 — Payment matching • failure boundary

Status: NOT_RUN

A matching amount on a different invoice is quarantined and cannot unlock delivery.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-005 — Asynchronous fulfillment • expected behavior

Status: NOT_RUN

Revision 4 plus a readable artifact produces ready, then version 3 running is ignored.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-006 — Asynchronous fulfillment • failure boundary

Status: NOT_RUN

A completed status with missing bytes remains investigating and displays its missing evidence.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-007 — Case intake and redelivery • expected behavior

Status: NOT_RUN

A reopened UI retrieves the original E7 export with zero additional paid calls.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-008 — Case intake and redelivery • failure boundary

Status: NOT_RUN

A copied grant used by buyer B is denied; a partial stream never closes the case as delivered. Race an approved refund against a partial retrieval and verify no refund dispatch while the retrieval is pending or ambiguous.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-009 — Refund decision and settlement • expected behavior

Status: NOT_RUN

Approval for a definitively failed 250-cent order dispatches one refund and reaches refunded after provider settlement.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-010 — Refund decision and settlement • failure boundary

Status: NOT_RUN

Simultaneous grant consumption and refund approval yield at most one actionable disposition.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-011 — Support console and buyer timeline • expected behavior

Status: NOT_RUN

Timeline shows E7 payment before export and authenticated delivery, with the provider receipt linked for authorized staff.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-012 — Support console and buyer timeline • failure boundary

Status: NOT_RUN

A refund API timeout displays pending investigation and cannot display refunded.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-013 — Connector reconciliation and field trial • expected behavior

Status: NOT_RUN

With webhook delivery suppressed, a status lookup recovers revision 4 and delivers D after restart.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-014 — Connector reconciliation and field trial • failure boundary

Status: NOT_RUN

Late ready after settled refund opens a merchant review item without issuing an access grant.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.
