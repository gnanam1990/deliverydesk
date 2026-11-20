# DeliveryDesk · Provider feasibility

**Critical pilot check.** Pilot an export service with a real signing secret, persistent order API and recoverable artifact storage controlled by the pilot operator. Validate one provider sandbox or authorized small transaction separately. Track cases resolved without a second payment, time to recovery, false closures and support cost.

**Open dependency.** Receipt alone cannot prove delivery. Where merchant status or refund capability is absent, keep the case unresolved for a person.

Use a seller adapter with explicit capabilities: quote, execute, inspect status, and refund or cancel only where documented. At intake record the real service identifier, endpoint, network, asset, quote expiry, verification method and test environment. Store the price and terms the operator saw. Keep local-only and verified external outcomes separately identifiable.

Kite Passport documents task-scoped spending sessions and multi-rail merchant payments. The official allowance guide describes fallback to an account allowance after session expiry. If spend must be restricted to the task, check the effective payment source at dispatch. Use a session-bound execution route that fails closed, or an isolated agent with no fallback funding. If neither can be demonstrated, leave automatic paid execution disabled. No claim of native Kite L1 settlement follows from a Passport integration. Never invent fee splitting, merchant refunds, human payout, delivery status or buyer identity from a generic receipt.

For a partner gap, build the actual local business workflow against a team-controlled, explicitly labeled merchant/service or import permitted artifacts through the real intake route. Mark the missing external behavior in the handoff. For any paid verification, record separate owner authority covering seller, rail, amount and purpose before dispatch.

[Payments](https://docs.gokite.ai/passport/payments) · [Task sessions](https://docs.gokite.ai/passport/payments/allowance) · [Seller integration](https://docs.gokite.ai/passport/seller)
