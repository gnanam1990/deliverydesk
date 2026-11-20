import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, seedMerchant, postEvent, api, type TestEnv, type Fixture } from './helpers.ts';
import { one, all } from '../src/db/db.ts';
import type { Payment, Order } from '../src/domain/types.ts';
import { orderPaymentConfirmed, quarantinedPayments } from '../src/domain/payments.ts';

/**
 * M02 · Payment matching (FR-02, INV-02)
 * T-003: a receipt for E7 and 250 USD cents records one payment and collapses
 *        a duplicate callback.
 * T-004: a matching amount on a different invoice is quarantined and cannot
 *        unlock delivery.
 */

let env: TestEnv;
let fx: Fixture;

before(async () => {
  env = await boot();
  fx = seedMerchant(env.db, { id: 'merch-a', externalOrderId: 'E7', amountMinor: 250 });
});

after(async () => env.cleanup());

const receipt = (over: Record<string, unknown> = {}) => ({
  rail: 'local-rail',
  transfer_ref: 'tx-e7-1',
  event_index: 0,
  amount_minor: 250,
  asset: 'usd', // normalized to USD on intake
  invoice_ref: 'inv-merch-a-e7',
  payer_ref: 'buyer-1',
  ...over,
});

test('T-003: verified receipt confirms one payment; duplicate callbacks collapse', async () => {
  const r1 = await postEvent(env.base, fx.merchant, fx.secret, {
    event_id: 'evt-pay-1',
    kind: 'payment.receipt',
    order_external_id: 'E7',
    payload: receipt(),
  });
  assert.equal(r1.status, 202);
  assert.match(String((r1.body as { data: { detail: string } }).data.detail), /^confirmed:/);

  const order = one<Order>(env.db, 'SELECT * FROM orders WHERE id = ?', fx.order.id)!;
  assert.equal(order.state, 'paid');
  const pays = all<Payment>(env.db, 'SELECT * FROM payments WHERE order_id = ?', order.id);
  assert.equal(pays.length, 1);
  assert.equal(pays[0]!.state, 'confirmed');
  assert.equal(pays[0]!.asset, 'USD');
  assert.equal(pays[0]!.amount_minor, 250);
  assert.ok(orderPaymentConfirmed(env.db, order.id));

  // Same callback event id → inbox dedupe.
  const dupSameId = await postEvent(env.base, fx.merchant, fx.secret, {
    event_id: 'evt-pay-1',
    kind: 'payment.receipt',
    order_external_id: 'E7',
    payload: receipt(),
  });
  assert.equal(dupSameId.status, 200);
  assert.equal((dupSameId.body as { data: { status: string } }).data.status, 'duplicate');

  // Different event id, SAME transfer event → collapses on the
  // (rail, transfer_ref, event_index) unique key: still exactly one payment.
  const dupTransfer = await postEvent(env.base, fx.merchant, fx.secret, {
    event_id: 'evt-pay-2',
    kind: 'payment.receipt',
    order_external_id: 'E7',
    payload: receipt(),
  });
  assert.equal(dupTransfer.status, 202);
  assert.match(String((dupTransfer.body as { data: { detail: string } }).data.detail), /duplicate_transfer/);
  assert.equal(all<Payment>(env.db, 'SELECT * FROM payments WHERE order_id = ?', order.id).length, 1);
});

test('T-004: matching amount on a different invoice is quarantined', async () => {
  // Receipt claims E7 with correct amount but a foreign invoice_ref.
  const r = await postEvent(env.base, fx.merchant, fx.secret, {
    event_id: 'evt-pay-wrong-inv',
    kind: 'payment.receipt',
    order_external_id: 'E7',
    payload: receipt({ transfer_ref: 'tx-e7-2', invoice_ref: 'inv-OTHER-999' }),
  });
  assert.equal(r.status, 202);
  assert.match(String((r.body as { data: { detail: string } }).data.detail), /quarantined:invoice_mismatch/);

  const bad = one<Payment>(
    env.db,
    "SELECT * FROM payments WHERE transfer_ref = 'tx-e7-2'",
  )!;
  assert.equal(bad.state, 'mismatch');
  assert.equal(bad.quarantine_reason, 'invoice_mismatch');

  // Quarantined payments appear in the merchant's exception list and cannot
  // count as a confirmed payment for the order.
  const quarantined = quarantinedPayments(env.db, fx.merchant.id);
  assert.ok(quarantined.some((p) => p.transfer_ref === 'tx-e7-2'));

  // Amount mismatch on the correct invoice is also quarantined.
  await postEvent(env.base, fx.merchant, fx.secret, {
    event_id: 'evt-pay-bad-amt',
    kind: 'payment.receipt',
    order_external_id: 'E7',
    payload: receipt({ transfer_ref: 'tx-e7-3', amount_minor: 251 }),
  });
  const badAmt = one<Payment>(env.db, "SELECT * FROM payments WHERE transfer_ref = 'tx-e7-3'")!;
  assert.equal(badAmt.state, 'mismatch');
  assert.equal(badAmt.quarantine_reason, 'amount_mismatch');

  // INV-02: an already-bound transfer event cannot fund a second order.
  const rBound = await postEvent(env.base, fx.merchant, fx.secret, {
    event_id: 'evt-pay-rebind',
    kind: 'payment.receipt',
    order_external_id: 'OTHER-ORDER',
    payload: receipt({ invoice_ref: 'inv-someone-else' }),
  });
  assert.match(String((rBound.body as { data: { detail: string } }).data.detail), /duplicate_transfer/);
});

test('operator inbox shows receipt evidence hashes', async () => {
  const inbox = await api(env.base, 'GET', `/connectors/${fx.merchant.id}/inbox`, {
    token: fx.operatorToken,
  });
  assert.equal(inbox.status, 200);
  const data = (inbox.body as { data: { events: { eventId: string; payloadHash: string }[] } }).data;
  const payEvent = data.events.find((e) => e.eventId === 'evt-pay-1');
  assert.ok(payEvent);
  assert.match(payEvent!.payloadHash, /^[0-9a-f]{64}$/);
});
