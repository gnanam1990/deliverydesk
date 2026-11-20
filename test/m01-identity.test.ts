import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, seedMerchant, api, postEvent, type TestEnv, type Fixture } from './helpers.ts';
import { one } from '../src/db/db.ts';
import type { InboxEvent } from '../src/domain/types.ts';

/**
 * M01 · Merchant enrollment and order identity (FR-01, INV-01)
 * T-001: two merchants both own order E7; buyers see only their own record.
 * T-002: a forged callback for E7 fails authentication before any case change.
 */

let env: TestEnv;
let a: Fixture;
let b: Fixture;

before(async () => {
  env = await boot();
  a = seedMerchant(env.db, { id: 'merch-a', externalOrderId: 'E7', amountMinor: 250 });
  b = seedMerchant(env.db, {
    id: 'merch-b',
    externalOrderId: 'E7',
    amountMinor: 900,
    buyerRef: 'buyer-2',
  });
});

after(async () => env.cleanup());

test('T-001: two merchants own E7 independently; buyer lookup is tenant-scoped', async () => {
  // INV-01: same external id, different merchants → two distinct canonical orders.
  assert.notEqual(a.order.id, b.order.id);
  assert.equal(a.order.external_order_id, 'E7');
  assert.equal(b.order.external_order_id, 'E7');

  // Buyer A sees only its own record through the lookup.
  const la = await api(env.base, 'GET', `/orders/lookup?merchant_id=${a.merchant.id}&external_id=E7`, {
    token: a.buyerToken,
  });
  assert.equal(la.status, 200);
  const laData = (la.body as { data: Record<string, unknown> }).data;
  assert.equal(laData['id'], a.order.id);
  assert.equal(laData['amountMinor'], 250);

  // Buyer A reading merchant B's order id is denied — not merely absent.
  const cross = await api(env.base, 'GET', `/orders/${b.order.id}`, { token: a.buyerToken });
  assert.equal(cross.status, 403);

  // Buyer A has no record under merchant B at all.
  const lb = await api(env.base, 'GET', `/orders/lookup?merchant_id=${b.merchant.id}&external_id=E7`, {
    token: a.buyerToken,
  });
  assert.equal(lb.status, 403);

  // Idempotent re-registration inside merchant A returns the same row.
  const { registerOrder } = await import('../src/domain/orders.ts');
  const again = registerOrder(env.db, {
    merchantId: a.merchant.id,
    buyerId: a.buyer.id,
    externalOrderId: 'E7',
    amountMinor: 250,
    asset: 'USD',
    invoiceRef: a.order.invoice_ref,
  });
  assert.equal(again.created, false);
  assert.equal(again.order.id, a.order.id);

  // Conflicting re-registration inside the same merchant is rejected.
  assert.throws(
    () =>
      registerOrder(env.db, {
        merchantId: a.merchant.id,
        buyerId: a.buyer.id,
        externalOrderId: 'E7',
        amountMinor: 251,
        asset: 'USD',
        invoiceRef: a.order.invoice_ref,
      }),
    /different attributes/,
  );
});

test('T-002: forged callback for E7 fails authentication before any state change', async () => {
  const beforeEvents = one<{ n: number }>(
    env.db,
    'SELECT COUNT(*) AS n FROM inbox_events WHERE merchant_id = ?',
    a.merchant.id,
  )!.n;
  const beforePayments = one<{ n: number }>(env.db, 'SELECT COUNT(*) AS n FROM payments')!.n;
  const beforeCases = one<{ n: number }>(env.db, 'SELECT COUNT(*) AS n FROM cases')!.n;

  // Forged: valid shape, wrong secret.
  const forged = await postEvent(
    env.base,
    a.merchant,
    'wrong-secret',
    {
      event_id: 'evt-forged-1',
      kind: 'payment.receipt',
      order_external_id: 'E7',
      payload: { transfer_ref: 'tx-forged', amount_minor: 250, asset: 'USD', invoice_ref: a.order.invoice_ref },
    },
  );
  assert.equal(forged.status, 401);

  // Missing signature header entirely.
  const unsigned = await api(env.base, 'POST', `/connectors/${a.merchant.id}/events`, {
    json: { event_id: 'evt-unsigned', kind: 'payment.receipt', payload: {} },
  });
  assert.equal(unsigned.status, 401);

  // Expired timestamp → replay window rejection.
  const { hmacSha256 } = await import('../src/ids.ts');
  const stale = Math.floor(Date.now() - 10 * 60 * 1000);
  const staleBody = JSON.stringify({ event_id: 'evt-stale', kind: 'x', payload: {} });
  const staleRes = await api(env.base, 'POST', `/connectors/${a.merchant.id}/events`, {
    json: JSON.parse(staleBody),
    headers: {
      'x-deliverydesk-signature': `t=${stale},v1=${hmacSha256(a.secret, `${stale}.${staleBody}`)}`,
    },
  });
  assert.equal(staleRes.status, 401);

  // Nothing persisted: no inbox row, no payment, no case.
  const afterEvents = one<{ n: number }>(
    env.db,
    'SELECT COUNT(*) AS n FROM inbox_events WHERE merchant_id = ?',
    a.merchant.id,
  )!.n;
  assert.equal(afterEvents, beforeEvents);
  assert.equal(one<{ n: number }>(env.db, 'SELECT COUNT(*) AS n FROM payments')!.n, beforePayments);
  assert.equal(one<{ n: number }>(env.db, 'SELECT COUNT(*) AS n FROM cases')!.n, beforeCases);

  // An unknown event kind with a VALID signature is recorded but unhandled —
  // proving auth passed yet no domain mutation occurred.
  const ok = await postEvent(env.base, a.merchant, a.secret, {
    event_id: 'evt-unknown-kind',
    kind: 'merchant.ping',
    payload: { note: 'liveness' },
  });
  assert.equal(ok.status, 202);
  const stored = one<InboxEvent>(
    env.db,
    'SELECT * FROM inbox_events WHERE merchant_id = ? AND event_id = ?',
    a.merchant.id,
    'evt-unknown-kind',
  );
  assert.ok(stored);
  assert.equal(stored!.processed_at, null);
});
