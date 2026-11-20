import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { boot, postEvent, api, waitFor, type TestEnv } from './helpers.ts';
import { all, one, openDb } from '../src/db/db.ts';
import { sha256, newId } from '../src/ids.ts';
import { enrollMerchant, createBuyer, createOperator } from '../src/domain/merchants.ts';
import { registerOrder } from '../src/domain/orders.ts';
import { createMerchantSim, type MerchantSim } from '../src/simulator/merchant-sim.ts';
import { workerTick } from '../src/worker/runner.ts';
import { buildApp, listen } from '../src/http/wiring.ts';
import type { Merchant, Buyer, Order, Refund, Retrieval, AccessGrant, Fulfillment, Payment, ReviewItem, InboxEvent } from '../src/domain/types.ts';

/**
 * M07 · Connector reconciliation and field trial (FR-07, INV-07)
 * T-013: suppressed webhook → worker status lookup recovers rev4 → after a
 *        process restart the same artifact/entitlement identities deliver D.
 * T-014: late ready after settled refund opens review and issues no grant.
 */

let env: TestEnv;
let sim: MerchantSim;
let m: Merchant;
let buyer: Buyer;
let buyerToken: string;
let opToken: string;
let seq = 0;

const ART = Buffer.alloc(3072, 0x77);
const DIG = sha256(ART);
const secret = 'simsec';

before(async () => {
  env = await boot();
  sim = await createMerchantSim();
  const enr = enrollMerchant(env.db, {
    id: 'merch-recon',
    name: 'Recon Merchant',
    connectorKind: 'local-emulator',
    statusBaseUrl: sim.base,
    refundBaseUrl: sim.base,
    callbackSecret: secret,
  });
  m = enr.merchant;
  const b = createBuyer(env.db, { merchantId: m.id, externalRef: 'buyer-recon' });
  buyer = b.buyer;
  buyerToken = b.token;
  opToken = createOperator(env.db, { merchantId: m.id, name: 'ops', roles: ['support', 'finance'] }).token;
});

after(async () => {
  await sim.close();
  await env.cleanup();
});

async function orderPaidCase(ext: string): Promise<{ order: Order; caseId: string; paymentEventId: string }> {
  const { order } = registerOrder(env.db, {
    merchantId: m.id,
    buyerId: buyer.id,
    externalOrderId: ext,
    amountMinor: 250,
    asset: 'USD',
    invoiceRef: `inv-${ext}`,
  });
  const eventId = `evt-pay-${ext}`;
  await postEvent(env.base, m, secret, {
    event_id: eventId,
    kind: 'payment.receipt',
    order_external_id: ext,
    payload: { rail: 'r', transfer_ref: `tr-${ext}`, event_index: 0, amount_minor: 250, asset: 'USD', invoice_ref: `inv-${ext}` },
  });
  const c = await api(env.base, 'POST', `/orders/${order.id}/cases`, { token: buyerToken, json: {} });
  return { order, caseId: (c.body as { data: { id: string } }).data.id, paymentEventId: eventId };
}

async function restartApp(): Promise<void> {
  await new Promise<void>((resolve) => env.server.close(() => resolve()));
  env.db.close();
  env.db = openDb(env.config.dbPath);
  const app = buildApp(env.db, env.config);
  env.server = await listen(app, 0);
  env.base = `http://127.0.0.1:${(env.server.address() as AddressInfo).port}`;
}

test('T-013: suppressed webhook recovered by status lookup and survives restart/replay', async () => {
  const { order, caseId, paymentEventId } = await orderPaidCase('RECON1');
  sim.setArtifact('RECON1', ART);
  sim.setOrder('RECON1', { revision: 4, status: 'complete' });

  // Webhook was suppressed: the worker status lookup is the only path.
  await workerTick(env.db, env.config);
  await workerTick(env.db, env.config);
  const ready = one<Fulfillment>(
    env.db,
    "SELECT * FROM fulfillments WHERE order_id = ? AND revision = 4 AND state = 'ready'",
    order.id,
  )!;
  assert.equal(ready.artifact_digest, DIG);
  assert.equal(ready.source_event_id, 'sim-RECON1-r4');

  // Replays collapse: same event id and same transfer identity cannot charge again.
  const sameEvent = await postEvent(env.base, m, secret, {
    event_id: paymentEventId,
    kind: 'payment.receipt',
    order_external_id: 'RECON1',
    payload: { rail: 'r', transfer_ref: 'tr-RECON1', event_index: 0, amount_minor: 250, asset: 'USD', invoice_ref: 'inv-RECON1' },
  });
  assert.equal((sameEvent.body as { data: { status: string } }).data.status, 'duplicate');
  const sameTransfer = await postEvent(env.base, m, secret, {
    event_id: 'evt-pay-recon1-copy',
    kind: 'payment.receipt',
    order_external_id: 'RECON1',
    payload: { rail: 'r', transfer_ref: 'tr-RECON1', event_index: 0, amount_minor: 250, asset: 'USD', invoice_ref: 'inv-RECON1' },
  });
  assert.equal((sameTransfer.body as { data: { detail: string } }).data.detail, 'duplicate_transfer:confirmed');
  assert.equal(all<Payment>(env.db, "SELECT * FROM payments WHERE order_id = ? AND state = 'confirmed'", order.id).length, 1);

  const digestBefore = one<Fulfillment>(env.db, 'SELECT * FROM fulfillments WHERE id = ?', ready.id)!.artifact_digest;
  const paymentsBefore = all<Payment>(env.db, 'SELECT * FROM payments WHERE order_id = ?', order.id).map((p) => p.id);
  await restartApp();

  // Late/reordered revision 3 cannot reopen or replace the recovered rev4.
  const stale = await postEvent(env.base, m, secret, {
    event_id: 'evt-recon1-r3-late',
    kind: 'fulfillment.status',
    order_external_id: 'RECON1',
    payload: { revision: 3, status: 'running' },
  });
  assert.match((stale.body as { data: { detail: string } }).data.detail, /stale_revision/);

  const grant = await api(env.base, 'POST', `/cases/${caseId}/redelivery`, { token: buyerToken });
  assert.equal(grant.status, 201);
  const grantId = (grant.body as { data: { grantId: string } }).data.grantId;
  const dl = await fetch(`${env.base}/grants/${grantId}/artifact`, {
    headers: { authorization: `Bearer ${buyerToken}`, connection: 'close' },
  });
  const retrievalId = dl.headers.get('x-retrieval-id')!;
  const bytes = Buffer.from(await dl.arrayBuffer());
  assert.equal(sha256(bytes), DIG);
  await waitFor(() => {
    const r = one<Retrieval>(env.db, 'SELECT * FROM retrievals WHERE id = ?', retrievalId);
    return r?.state === 'awaiting_receipt' ? r : undefined;
  });
  const done = await api(env.base, 'POST', `/retrievals/${retrievalId}/receipt`, { token: buyerToken, json: { digest: DIG } });
  assert.equal(done.status, 200);

  assert.equal(one<Fulfillment>(env.db, 'SELECT * FROM fulfillments WHERE id = ?', ready.id)!.artifact_digest, digestBefore);
  assert.deepEqual(all<Payment>(env.db, 'SELECT * FROM payments WHERE order_id = ?', order.id).map((p) => p.id), paymentsBefore);
  assert.equal(all<InboxEvent>(env.db, 'SELECT * FROM inbox_events WHERE merchant_id = ? AND processed_at IS NULL', m.id).length, 0);
});

test('T-014: late ready after settled refund opens review and issues no grant', async () => {
  seq++;
  const ext = `RECON-R${seq}`;
  const { order, caseId } = await orderPaidCase(ext);
  await postEvent(env.base, m, secret, {
    event_id: `evt-${ext}-failed`,
    kind: 'fulfillment.status',
    order_external_id: ext,
    payload: { revision: 1, status: 'failed', note: 'export unavailable' },
  });
  const proposal = await api(env.base, 'POST', `/cases/${caseId}/refund-proposals`, { token: opToken, json: {} });
  const refundId = (proposal.body as { data: { id: string } }).data.id;
  await api(env.base, 'POST', `/refunds/${refundId}/approve`, { token: opToken });
  await workerTick(env.db, env.config);
  const dispatched = one<Refund>(env.db, 'SELECT * FROM refunds WHERE id = ?', refundId)!;
  sim.settleRefund(dispatched.settlement_ref!);
  await workerTick(env.db, env.config);
  assert.equal(one<Refund>(env.db, 'SELECT * FROM refunds WHERE id = ?', refundId)!.state, 'settled');

  const late = await postEvent(env.base, m, secret, {
    event_id: `evt-${ext}-late-ready`,
    kind: 'fulfillment.status',
    order_external_id: ext,
    payload: { revision: 2, status: 'complete', artifact_digest: DIG, artifact_b64: ART.toString('base64') },
  });
  assert.match((late.body as { data: { detail: string } }).data.detail, /ready:rev2/);

  const review = one<ReviewItem>(
    env.db,
    "SELECT * FROM review_items WHERE order_id = ? AND kind = 'late_ready_after_refund' AND state = 'open'",
    order.id,
  )!;
  assert.equal(review.case_id, caseId);
  const denied = await api(env.base, 'POST', `/cases/${caseId}/redelivery`, { token: buyerToken });
  assert.equal(denied.status, 409);
  assert.equal(all<AccessGrant>(env.db, 'SELECT * FROM access_grants WHERE order_id = ?', order.id).length, 0);
  const kase = await api(env.base, 'GET', `/cases/${caseId}`, { token: buyerToken });
  assert.equal((kase.body as { data: { state: string } }).data.state, 'refunded');

  const metrics = await api(env.base, 'GET', '/console/metrics', { token: opToken });
  const data = (metrics.body as { data: { uniqueResolvedOrders: number; secondCharges: number; duplicateTransferAttempts: number; timeToRetrieval: { count: number }; falseClosures: number; lateReadyReviewItems: number } }).data;
  assert.ok(data.uniqueResolvedOrders >= 2);
  assert.equal(data.secondCharges, 0);
  assert.ok(data.duplicateTransferAttempts >= 1);
  assert.ok(data.timeToRetrieval.count >= 1);
  assert.equal(data.falseClosures, 0);
  assert.ok(data.lateReadyReviewItems >= 1);
});
