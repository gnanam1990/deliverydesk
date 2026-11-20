# DeliveryDesk · Reuse and evidence

The owner’s GitHub inventory and selected source files were reviewed on 20 November 2026. Each link below pins the reviewed revision. Inspect current target behavior, compatibility and license at intake. If private access is unavailable, implement the specified interface independently and record that choice. This pack contains no upstream source code or credentials.

### kiteshop

Pinned baseline `bb427e5444b2310cf6bc686be4d1ae4a86a1f2e2` (public). Reuse payment verification approaches. Add fulfillment tracking, redelivery permissions and merchant support tooling.

[verify-payment.ts](https://github.com/gnanam1990/kiteshop/blob/bb427e5444b2310cf6bc686be4d1ae4a86a1f2e2/packages/api/src/lib/verify-payment.ts) · [auth.ts](https://github.com/gnanam1990/kiteshop/blob/bb427e5444b2310cf6bc686be4d1ae4a86a1f2e2/packages/api/src/lib/auth.ts)

### orderrescue

Pinned baseline `e1ccbc1db905f6995d289c306bf7b861dcd8cc87` (public). Order recovery is a useful state-machine reference. The Binance implementation requires a new adapter for a paid service merchant.

[verify-chain.ts](https://github.com/gnanam1990/orderrescue/blob/e1ccbc1db905f6995d289c306bf7b861dcd8cc87/apps/server/src/cli/verify-chain.ts) · [api.ts](https://github.com/gnanam1990/orderrescue/blob/e1ccbc1db905f6995d289c306bf7b861dcd8cc87/apps/server/src/api.ts)

### paypal-refundproof

Pinned baseline `e375f9e378299aa0c1648f9390461a0a0df68567` (public). Use approval and evidence handling. Other merchants need their own authority, settlement confirmation and refund implementation.

[approvals.ts](https://github.com/gnanam1990/paypal-refundproof/blob/e375f9e378299aa0c1648f9390461a0a0df68567/src/services/approvals.ts) · [evidence.ts](https://github.com/gnanam1990/paypal-refundproof/blob/e375f9e378299aa0c1648f9390461a0a0df68567/src/services/evidence.ts)

## Project lineage

Hackathon Atlas surfaced [Recibo](https://ethglobal.com/showcase/recibo-5xkrv) as adjacent work. The user-approved project boundary is: Recover paid digital exports from one participating seller with an order/status lookup and an authorized fulfillment store. Preserve exactly one financial disposition per paid unit. Model redelivery entitlements, incomplete evidence and explicit refund approval. Pilot single-item orders and full refunds.

## External dependency

Receipt alone cannot prove delivery. Where merchant status or refund capability is absent, keep the case unresolved for a person. Platform interfaces are documented in [provider notes](KITE-AND-PROVIDERS.md). Market demand, integration behavior, source data access and live payment authority require separate evidence.
