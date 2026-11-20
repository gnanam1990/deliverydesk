# DeliveryDesk · Master build prompt

Build DeliveryDesk in the repository supplied with this pack. The product's first complete journey is the following.

A paid export times out in the buyer UI. The buyer opens a case against its order. The merchant worker reports completion later. The buyer authenticates, retrieves the original artifact and acknowledgment closes the case. If fulfillment is definitively unavailable, the merchant may authorize an eligible refund.

## Intake

Read repository instructions and inspect the current branch, HEAD, uncommitted work, existing architecture, locked dependencies, test commands and any ongoing implementation. Check [source baselines](SOURCES.md) before reusing upstream work. Record whether this is a dedicated greenfield project or an extension. For an existing implementation, trace each claimed capability from its real entry point before assigning completion. Preserve user changes.

## Build

Follow [the module index](MODULES.md). Drive changes from observable failing behavior. Implement actual domain rules, authorization, UI/API, storage and recovery. Use test doubles for deterministic fault injection and pair them with real local integration tests. Keep independent work moving when a partner dependency blocks one path. Expose each blocked external feature honestly in the UI and status ledger.

## Evidence and exit

Buyer A paid 250 USD cents for order E7. Browser times out. Seller revision 4 reports a finished 3 KB export with digest D. Deliver D on A's authenticated request and close on receipt; there is one original payment and zero refunds. An older running event at revision 3 cannot reopen the case, and buyer B receives no artifact.

Show the normal workflow in a clean checkout, exercise failure and restart, and leave evidence tied to the exact tested revision. A recorded demo uses the running product and permitted inputs. Verify logs, screenshots and exports are redacted. Local building and testing begin when the owner invokes this prompt for the supplied target. Remote publishing, deployment, paid calls, account creation, signing and public submissions need action-specific authority. Use the owner’s existing grants when applicable.

After every module, and before yielding, update the [continuation records](DELIVERY.md). Tell the next agent what already works, what failed, the last command, and the first concrete operation to perform.
