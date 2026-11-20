import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, seedMerchant, postEvent, api, waitFor, type TestEnv, type Fixture } from './helpers.ts';
import { one, all } from '../src/db/db.ts';
import { sha256, newId } from '../src/ids.ts';
import type { Refund, Retrieval } from '../src/domain/types.ts';
import { enrollMerchant, createBuyer, createOperator } from '../src/domain/merchants.ts';
import { registerOrder } from '../src/domain/orders.ts';
import { createMerchantSim, type MerchantSim } from '../src/simulator/merchant-sim.ts';
import { workerTick } from '../src/worker/runner.ts';
import type { Merchant, Buyer, Order } from '../src/domain/types.ts';

/**
 * M05 · Refund decision and settlement (FR-05, INV-05)
 * T-009: approval for a definitively failed 250-cent order dispatches one
 *        refund and reaches refunded after provider settlement.
 * T-010: simultaneous grant consumption and refund approval yield at most
 *        one actionable disposition.
 */

let env: TestEnv;
let sim: MerchantSim;
let m: Merchant;
let buyer: Buyer;
let buyerToken: string;
let opToken: string;
let supportOnlyToken: string;
let seq = 0;

const ART = Buffer.alloc(3072, 0xcd);
const DIG = sha256(ART);

before(async () => {
  env = await boot();
  sim = await createMerchantSim();
  const enr = enrollMerchant(env.db, {
    id: 'merch-sim',
    name: 'Sim Merchant',
    connectorKind: 'local-emulator',
    statusBaseUrl: sim.base,
    refundBaseUrl: sim.base,
    callbackSecret: 'simsec',
  });
  m = enr.merchant;
  const b = createBuyer(env.db, { merchantId: m.id, externalRef: 'buyer-1' });
  buyer = b.buyer;
  buyerToken = b.token;
  const op = createOperator(env.db, { merchantId: m.id, name: 'ops', roles: ['support', 'finance'] });
  opToken = op.token;
  const so = createOperator(env.db, { merchantId: m.id, name: 'support-only', roles: ['support'] });
  supportOnlyToken = so.token;
});

after(async () => {
  await sim.close();
  await env.cleanup();
});

const secret = 'simsec';

async function makeOrder(opts: { failed?: boolean; ready?: boolean }): Promise<{ order: Order; caseId: string }> {
  seq++;
  const ext = `R${seq}`;
  const { order } = registerOrder(env.db, {
    merchantId: m.id,
    buyerId: buyer.id,
    externalOrderId: ext,
    amountMinor: 250,
    asset: 'USD',
    invoiceRef: `inv-${ext}`,
  });
  await postEvent(env.base, m, secret, {
    event_id: newId('evt'),
    kind: 'payment.receipt',
    order_external_id: ext,
    payload: { rail: 'r', transfer_ref: newId('tx'), event_index: 0, amount_minor: 250, asset: 'USD', invoice_ref: `inv-${ext}` },
  });
  if (opts.ready) {
    await postEvent(env.base, m, secret, {
      event_id: newId('evt'),
      kind: 'fulfillment.status',
      order_external_id: ext,
      payload: { revision: 4, status: 'complete', artifact_digest: DIG, artifact_b64: ART.toString('base64') },
    });
  }
  if (opts.failed) {
    await postEvent(env.base, m, secret, {
      event_id: newId('evt'),
      kind: 'fulfillment.status',
      order_external_id: ext,
      payload: { revision: 2, status: 'failed', note: 'export crashed' },
    });
  }
  const c = await api(env.base, 'POST', `/orders/${order.id}/cases`, {
    token: buyerToken,
    json: { reason: 'export_timeout' },
  });
  return { order, caseId: (c.body as { data: { id: string } }).data.id };
}

test('T-009: approve definitively-failed order → one dispatch → settled → refunded', async () => {
  const { order, caseId } = await makeOrder({ failed: true });

  // Support-only operator cannot approve (approval is a distinct authority).
  const pre = await api(env.base, 'POST', `/cases/${caseId}/refund-proposals`, {
    token: opToken,
    json: { reason: 'fulfillment_unavailable' },
  });
  assert.equal(pre.status, 201);
  const refundId = (pre.body as { data: { id: string } }).data.id;
  const noRole = await api(env.base, 'POST', `/refunds/${refundId}/approve`, { token: supportOnlyToken });
  assert.equal(noRole.status, 401); // authenticateOperator w/ requiredRole -> 401

  const appr = await api(env.base, 'POST', `/refunds/${refundId}/approve`, { token: opToken });
  assert.equal(appr.status, 200);
  assert.equal((appr.body as { data: { state: string } }).data.state, 'authorized');

  // Worker dispatch — exactly one provider call.
  await workerTick(env.db, env.config);
  const dispatched = one<Refund>(env.db, 'SELECT * FROM refunds WHERE id = ?', refundId)!;
  assert.equal(dispatched.state, 'dispatched');
  assert.ok(dispatched.settlement_ref);
  assert.ok(dispatched.dispatched_at);
  assert.equal(sim.refundCalls, 1);
  const caseAfter = await api(env.base, 'GET', `/cases/${caseId}`, { token: buyerToken });
  assert.equal((caseAfter.body as { data: { state: string } }).data.state, 'refund_pending');

  // Provider settles → reconciler reaches refunded (distinct from dispatch).
  sim.settleRefund(dispatched.settlement_ref!);
  await workerTick(env.db, env.config);
  const settled = one<Refund>(env.db, 'SELECT * FROM refunds WHERE id = ?', refundId)!;
  assert.equal(settled.state, 'settled');
  assert.ok(settled.settled_at);
  assert.notEqual(settled.dispatched_at, settled.settled_at);
  const refunded = await api(env.base, 'GET', `/cases/${caseId}`, { token: buyerToken });
  const rd = (refunded.body as { data: { state: string; disposition: string; refund: { state: string } } }).data;
  assert.equal(rd.state, 'refunded');
  assert.equal(rd.refund.state, 'settled');
  assert.equal(all<Refund>(env.db, 'SELECT * FROM refunds WHERE order_id = ?', order.id).length, 1);
  assert.equal(sim.refundCalls, 1);
});

test('T-010: grant consumption vs refund approval → one actionable disposition', async () => {
  // Ready artifact + in-flight retrieval, then merchant reports failure.
  const { order, caseId } = await makeOrder({ ready: true });
  const g = await api(env.base, 'POST', `/cases/${caseId}/redelivery`, { token: buyerToken });
  const grant = (g.body as { data: { grantId: string } }).data;
  const dl = await fetch(`${env.base}/grants/${grant.grantId}/artifact`, {
    headers: { authorization: `Bearer ${buyerToken}`, connection: 'close' },
  });
  const retId = dl.headers.get('x-retrieval-id')!;
  await dl.arrayBuffer();
  await waitFor(() => {
    const r = one<Retrieval>(env.db, 'SELECT * FROM retrievals WHERE id = ?', retId);
    return r?.state === 'awaiting_receipt' ? r : undefined;
  });

  // Late 'failed' report makes the order nominally refund-eligible.
  await postEvent(env.base, m, secret, {
    event_id: newId('evt'),
    kind: 'fulfillment.status',
    order_external_id: order.external_order_id,
    payload: { revision: 5, status: 'failed', note: 'late failure report' },
  });
  const prop = await api(env.base, 'POST', `/cases/${caseId}/refund-proposals`, {
    token: opToken,
    json: {},
  });
  assert.equal(prop.status, 201);
  const refundId = (prop.body as { data: { id: string } }).data.id;
  const appr = await api(env.base, 'POST', `/refunds/${refundId}/approve`, { token: opToken });
  assert.equal(appr.status, 200);

  // While the retrieval is pending, dispatch must not reach the provider.
  const callsBefore = sim.refundCalls;
  await workerTick(env.db, env.config);
  assert.equal(sim.refundCalls, callsBefore);

  // Buyer receipt lands first → delivered; the refund is declined, never dispatched.
  const rc = await api(env.base, 'POST', `/retrievals/${retId}/receipt`, {
    token: buyerToken,
    json: { digest: DIG },
  });
  assert.equal(rc.status, 200);
  await workerTick(env.db, env.config);
  await workerTick(env.db, env.config);
  const r = one<Refund>(env.db, 'SELECT * FROM refunds WHERE id = ?', refundId)!;
  assert.equal(r.state, 'declined');
  const c = await api(env.base, 'GET', `/cases/${caseId}`, { token: buyerToken });
  assert.equal((c.body as { data: { state: string } }).data.state, 'delivered');
  assert.equal(sim.refundCalls, callsBefore); // zero provider calls on this order
});

test('blocked dispatch proceeds only after the ambiguous retrieval is reconciled', async () => {
  const { order, caseId } = await makeOrder({ ready: true });
  const g = await api(env.base, 'POST', `/cases/${caseId}/redelivery`, { token: buyerToken });
  const grant = (g.body as { data: { grantId: string } }).data;
  const dl = await fetch(`${env.base}/grants/${grant.grantId}/artifact`, {
    headers: { authorization: `Bearer ${buyerToken}`, connection: 'close' },
  });
  const retId = dl.headers.get('x-retrieval-id')!;
  const reader = dl.body!.getReader();
  await reader.read();
  await reader.cancel();
  await waitFor(() => {
    const r = one<Retrieval>(env.db, 'SELECT * FROM retrievals WHERE id = ?', retId);
    return r?.state === 'interrupted' ? r : undefined;
  });
  await postEvent(env.base, m, secret, {
    event_id: newId('evt'),
    kind: 'fulfillment.status',
    order_external_id: order.external_order_id,
    payload: { revision: 6, status: 'failed' },
  });
  const prop = await api(env.base, 'POST', `/cases/${caseId}/refund-proposals`, { token: opToken, json: {} });
  const refundId = (prop.body as { data: { id: string } }).data.id;
  await api(env.base, 'POST', `/refunds/${refundId}/approve`, { token: opToken });

  const callsBefore = sim.refundCalls;
  await workerTick(env.db, env.config);
  assert.equal(sim.refundCalls, callsBefore); // still blocked — ambiguous

  // Operator reconciles the ambiguity → dispatch proceeds, settles.
  const ab = await api(env.base, 'POST', `/retrievals/${retId}/abandon`, { token: opToken });
  assert.equal((ab.body as { data: { retrievalState: string } }).data.retrievalState, 'abandoned');
  await workerTick(env.db, env.config);
  const dispatched = one<Refund>(env.db, 'SELECT * FROM refunds WHERE id = ?', refundId)!;
  assert.equal(dispatched.state, 'dispatched');
  assert.equal(sim.refundCalls, callsBefore + 1);
  sim.settleRefund(dispatched.settlement_ref!);
  await workerTick(env.db, env.config);
  assert.equal(one<Refund>(env.db, 'SELECT * FROM refunds WHERE id = ?', refundId)!.state, 'settled');
});
