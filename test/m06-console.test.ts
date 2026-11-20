import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, postEvent, api, waitFor, type TestEnv } from './helpers.ts';
import { one } from '../src/db/db.ts';
import { sha256, newId } from '../src/ids.ts';
import { enrollMerchant, createBuyer, createOperator } from '../src/domain/merchants.ts';
import { registerOrder } from '../src/domain/orders.ts';
import { createMerchantSim, type MerchantSim } from '../src/simulator/merchant-sim.ts';
import { workerTick } from '../src/worker/runner.ts';
import type { Merchant, Buyer, Order, Refund, Retrieval, Payment } from '../src/domain/types.ts';

/**
 * M06 · Support console and buyer timeline (FR-06, INV-06)
 * T-011: the operator timeline shows payment, export and authenticated
 *        delivery in order and links provider receipt evidence.
 * T-012: a provider timeout renders pending investigation, never refunded.
 */

let env: TestEnv;
let sim: MerchantSim;
let m: Merchant;
let buyer: Buyer;
let buyerToken: string;
let opToken: string;
let seq = 0;

const ART = Buffer.alloc(3072, 0xef);
const DIG = sha256(ART);
const secret = 'simsec';
const htmlHeaders = { accept: 'text/html' };

before(async () => {
  env = await boot({ providerTimeoutMs: 80, caseStaleMs: 50 });
  sim = await createMerchantSim();
  const enr = enrollMerchant(env.db, {
    id: 'merch-ui',
    name: 'UI Merchant',
    connectorKind: 'local-emulator',
    statusBaseUrl: sim.base,
    refundBaseUrl: sim.base,
    callbackSecret: secret,
  });
  m = enr.merchant;
  const b = createBuyer(env.db, { merchantId: m.id, externalRef: 'buyer-a' });
  buyer = b.buyer;
  buyerToken = b.token;
  opToken = createOperator(env.db, { merchantId: m.id, name: 'ops', roles: ['support', 'finance'] }).token;
});

after(async () => {
  await sim.close();
  await env.cleanup();
});

async function orderAndCase(kind: 'ready' | 'failed' | 'open'): Promise<{ order: Order; caseId: string }> {
  seq++;
  const ext = `UI${seq}`;
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
    payload: { rail: 'r', transfer_ref: `tr-${ext}`, event_index: 0, amount_minor: 250, asset: 'USD', invoice_ref: `inv-${ext}` },
  });
  if (kind !== 'open') {
    await postEvent(env.base, m, secret, {
      event_id: newId('evt'),
      kind: 'fulfillment.status',
      order_external_id: ext,
      payload: kind === 'ready'
        ? { revision: 4, status: 'complete', artifact_digest: DIG, artifact_b64: ART.toString('base64') }
        : { revision: 4, status: 'failed', note: 'export unavailable' },
    });
  }
  const c = await api(env.base, 'POST', `/orders/${order.id}/cases`, { token: buyerToken, json: {} });
  return { order, caseId: (c.body as { data: { id: string } }).data.id };
}

test('T-011: console timeline orders payment → export → authenticated delivery and links receipt', async () => {
  const { order, caseId } = await orderAndCase('ready');
  const grantRes = await api(env.base, 'POST', `/cases/${caseId}/redelivery`, { token: buyerToken });
  const grantId = (grantRes.body as { data: { grantId: string } }).data.grantId;
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
  const receipt = await api(env.base, 'POST', `/retrievals/${retrievalId}/receipt`, {
    token: buyerToken,
    json: { digest: DIG },
  });
  assert.equal(receipt.status, 200);

  const consolePage = await api(env.base, 'GET', `/console/cases/${caseId}`, {
    token: opToken,
    headers: htmlHeaders,
  });
  assert.equal(consolePage.status, 200);
  assert.match((consolePage.headers as unknown as Headers).get('content-type') ?? '', /text\/html/);
  const raw = consolePage.raw;
  const paymentAt = raw.indexOf('Payment confirmed');
  const exportAt = raw.indexOf('Export ready');
  const retrievedAt = raw.indexOf('Artifact retrieved');
  const deliveredAt = raw.indexOf('Delivery acknowledged');
  assert.ok(paymentAt >= 0 && paymentAt < exportAt, `payment before export: ${paymentAt}, ${exportAt}`);
  assert.ok(exportAt < retrievedAt, `export before retrieval: ${exportAt}, ${retrievedAt}`);
  assert.ok(retrievedAt < deliveredAt, `retrieval before acknowledgement: ${retrievedAt}, ${deliveredAt}`);
  const payment = one<Payment>(env.db, 'SELECT * FROM payments WHERE order_id = ?', order.id)!;
  assert.match(raw, new RegExp(`/console/payments/${payment.id}/receipt`));

  const receiptEvidence = await api(env.base, 'GET', `/console/payments/${payment.id}/receipt`, { token: opToken });
  assert.equal(receiptEvidence.status, 200);
  assert.equal((receiptEvidence.body as { data: { transferRef: string } }).data.transferRef, `tr-${order.external_order_id}`);

  const buyerPage = await api(env.base, 'GET', `/cases/${caseId}`, { token: buyerToken, headers: htmlHeaders });
  assert.equal(buyerPage.status, 200);
  assert.ok(buyerPage.raw.includes('Delivery acknowledged'));
  assert.ok(!buyerPage.raw.includes('/console/payments/'));
  const buyerReceiptAttempt = await api(env.base, 'GET', `/console/payments/${payment.id}/receipt`, { token: buyerToken });
  assert.equal(buyerReceiptAttempt.status, 401);
});

test('operator ownership and stale filters stay durable', async () => {
  const { caseId } = await orderAndCase('open');
  const claim = await api(env.base, 'POST', `/cases/${caseId}/claim`, { token: opToken });
  assert.equal(claim.status, 200);
  env.db.prepare('UPDATE cases SET created_at = ? WHERE id = ?').run(
    new Date(Date.now() - 10_000).toISOString(),
    caseId,
  );
  const mine = await api(env.base, 'GET', '/console/cases?mine=1', { token: opToken });
  assert.equal(mine.status, 200);
  assert.deepEqual((mine.body as { data: { id: string }[] }).data.map((c) => c.id), [caseId]);
  const stale = await api(env.base, 'GET', '/console/cases?stale=1', { token: opToken });
  assert.equal(stale.status, 200);
  assert.deepEqual((stale.body as { data: { id: string }[] }).data.map((c) => c.id), [caseId]);
  const page = await api(env.base, 'GET', '/console?stale=1', { token: opToken, headers: htmlHeaders });
  assert.equal(page.status, 200);
  assert.ok(page.raw.includes('Stale'));
});

test('T-012: refund provider timeout renders pending investigation, not refunded', async () => {
  const { caseId } = await orderAndCase('failed');
  sim.faults.refundTimeout = true;
  const proposal = await api(env.base, 'POST', `/cases/${caseId}/refund-proposals`, { token: opToken, json: {} });
  const refundId = (proposal.body as { data: { id: string } }).data.id;
  const approve = await api(env.base, 'POST', `/refunds/${refundId}/approve`, { token: opToken });
  assert.equal(approve.status, 200);
  await workerTick(env.db, env.config);
  const refund = one<Refund>(env.db, 'SELECT * FROM refunds WHERE id = ?', refundId)!;
  assert.equal(refund.state, 'settlement_investigation');
  assert.equal(refund.settled_at, null);

  const page = await api(env.base, 'GET', `/console/cases/${caseId}`, { token: opToken, headers: htmlHeaders });
  assert.equal(page.status, 200);
  assert.ok(page.raw.includes('Pending investigation'));
  assert.ok(page.raw.includes('provider dispatch outcome is unknown'));
  assert.ok(!page.raw.includes('Refund settled'));
  assert.ok(!page.raw.includes('refunded'));

  const buyerPage = await api(env.base, 'GET', `/cases/${caseId}`, { token: buyerToken, headers: htmlHeaders });
  assert.ok(buyerPage.raw.includes('Pending investigation'));
  assert.ok(!buyerPage.raw.includes('Refund settled'));
});
