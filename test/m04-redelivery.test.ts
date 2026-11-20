import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, seedMerchant, postEvent, api, waitFor, type TestEnv, type Fixture } from './helpers.ts';
import { one, all } from '../src/db/db.ts';
import { sha256 } from '../src/ids.ts';
import type { Retrieval, Payment, Refund } from '../src/domain/types.ts';
import { retrievalBlocksRefund } from '../src/domain/cases.ts';
import { createBuyer } from '../src/domain/merchants.ts';
import { createHash } from 'node:crypto';

/**
 * M04 · Case intake and redelivery (FR-04, INV-04)
 * T-007: a reopened UI retrieves the original E7 export with zero
 *        additional paid calls.
 * T-008: a copied grant used by buyer B is denied; a partial stream never
 *        closes the case as delivered; no refund dispatch while a retrieval
 *        is pending or ambiguous.
 */

let env: TestEnv;
let fx: Fixture;

const ARTIFACT = Buffer.alloc(3072, 0xab);
const DIGEST = sha256(ARTIFACT);

before(async () => {
  env = await boot();
  fx = seedMerchant(env.db, { id: 'merch-a', externalOrderId: 'E7', amountMinor: 250 });
  // Verified payment.
  await postEvent(env.base, fx.merchant, fx.secret, {
    event_id: 'evt-m4-pay',
    kind: 'payment.receipt',
    order_external_id: 'E7',
    payload: {
      rail: 'local-rail',
      transfer_ref: 'tx-m4-1',
      event_index: 0,
      amount_minor: 250,
      asset: 'USD',
      invoice_ref: 'inv-merch-a-e7',
    },
  });
  // Merchant worker reports completion at revision 4.
  await postEvent(env.base, fx.merchant, fx.secret, {
    event_id: 'evt-m4-ful',
    kind: 'fulfillment.status',
    order_external_id: 'E7',
    payload: {
      revision: 4,
      status: 'complete',
      artifact_digest: DIGEST,
      artifact_b64: ARTIFACT.toString('base64'),
    },
  });
});

after(async () => env.cleanup());

const caseOpen = async () =>
  api(env.base, 'POST', `/orders/${fx.order.id}/cases`, {
    token: fx.buyerToken,
    json: { reason: 'export_timeout' },
    idempotencyKey: 'open-e7',
  });

test('T-007: reopened flow retrieves original export — zero additional paid calls', async () => {
  // Buyer opens a case after the browser timeout.
  const c1 = await caseOpen();
  assert.equal(c1.status, 201);
  const case1 = (c1.body as { data: { id: string; state: string } }).data;
  assert.equal(case1.state, 'available');

  // The buyer "reopens the UI": an idempotent retry returns the stored
  // operation reference (same case, same status).
  const c2 = await caseOpen();
  assert.equal((c2.body as { data: { id: string } }).data.id, case1.id);
  // A non-idempotent repeat open deduplicates on the active case.
  const c3 = await api(env.base, 'POST', `/orders/${fx.order.id}/cases`, {
    token: fx.buyerToken,
    json: { reason: 'export_timeout' },
  });
  assert.equal(c3.status, 200);
  assert.equal((c3.body as { data: { id: string } }).data.id, case1.id);

  // Redelivery issues a short-lived grant to the original digest.
  const g = await api(env.base, 'POST', `/cases/${case1.id}/redelivery`, {
    token: fx.buyerToken,
    idempotencyKey: 'redeliver-e7-1',
  });
  assert.equal(g.status, 201);
  const grant = (g.body as { data: { grantId: string; artifactDigest: string } }).data;
  assert.equal(grant.artifactDigest, DIGEST);

  // Download through the fenced retrieval.
  const res = await fetch(`${env.base}/grants/${grant.grantId}/artifact`, {
    headers: { authorization: `Bearer ${fx.buyerToken}` },
  });
  assert.equal(res.status, 200);
  const retrievalId = res.headers.get('x-retrieval-id')!;
  assert.ok(retrievalId);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.length, 3072);
  assert.equal(createHash('sha256').update(buf).digest('hex'), DIGEST);

  // Retrieval is awaiting the authenticated digest receipt.
  const ret = await waitFor(
    () => {
      const r = one<Retrieval>(env.db, 'SELECT * FROM retrievals WHERE id = ?', retrievalId);
      return r && r.state === 'awaiting_receipt' ? r : undefined;
    },
    { label: 'stream finish' },
  );
  assert.equal(ret.bytes_transferred, 3072);

  // Buyer posts the digest receipt → case closes delivered.
  const receipt = await api(env.base, 'POST', `/retrievals/${retrievalId}/receipt`, {
    token: fx.buyerToken,
    json: { digest: DIGEST },
  });
  assert.equal(receipt.status, 200);
  const closed = (receipt.body as { data: { case: { state: string; disposition: string } } }).data;
  assert.equal(closed.case.state, 'delivered');
  assert.equal(closed.case.disposition, 'delivered');

  // INV-04: exactly one payment, zero refunds — no new purchase occurred.
  const pays = all<Payment>(env.db, 'SELECT * FROM payments WHERE order_id = ?', fx.order.id);
  assert.equal(pays.length, 1);
  assert.equal(all<Refund>(env.db, 'SELECT * FROM refunds WHERE order_id = ?', fx.order.id).length, 0);

  // The timeline discloses the evidence for closure (INV-06).
  const view = await api(env.base, 'GET', `/cases/${case1.id}`, { token: fx.buyerToken });
  const timeline = (view.body as { data: { timeline: { kind: string }[] } }).data.timeline;
  const kinds = timeline.map((e) => e.kind);
  assert.ok(kinds.includes('case.opened'));
  assert.ok(kinds.includes('fulfillment.ready'));
  assert.ok(kinds.includes('grant.issued'));
  assert.ok(kinds.includes('case.delivered'));
  // Grant tokens never appear in the timeline.
  assert.ok(!JSON.stringify(timeline).includes(grant.grantId));
});

test('T-008: copied grant denied; partial stream blocks; resume delivers', async () => {
  // Fresh order+case for buyer A on a second order.
  const { registerOrder } = await import('../src/domain/orders.ts');
  const { order: o2 } = registerOrder(env.db, {
    merchantId: fx.merchant.id,
    buyerId: fx.buyer.id,
    externalOrderId: 'E8',
    amountMinor: 250,
    asset: 'USD',
    invoiceRef: 'inv-merch-a-e8',
  });
  await postEvent(env.base, fx.merchant, fx.secret, {
    event_id: 'evt-m4-pay-e8',
    kind: 'payment.receipt',
    order_external_id: 'E8',
    payload: {
      rail: 'local-rail',
      transfer_ref: 'tx-m4-2',
      event_index: 0,
      amount_minor: 250,
      asset: 'USD',
      invoice_ref: 'inv-merch-a-e8',
    },
  });
  await postEvent(env.base, fx.merchant, fx.secret, {
    event_id: 'evt-m4-ful-e8',
    kind: 'fulfillment.status',
    order_external_id: 'E8',
    payload: {
      revision: 2,
      status: 'complete',
      artifact_digest: DIGEST,
      artifact_b64: ARTIFACT.toString('base64'),
    },
  });
  const cRes = await api(env.base, 'POST', `/orders/${o2.id}/cases`, {
    token: fx.buyerToken,
    json: { reason: 'export_timeout' },
  });
  const caseId = (cRes.body as { data: { id: string } }).data.id;
  const gRes = await api(env.base, 'POST', `/cases/${caseId}/redelivery`, { token: fx.buyerToken });
  const grant = (gRes.body as { data: { grantId: string } }).data;

  // (a) Buyer B presents the copied grant → denied before any claim row.
  const { buyer: buyerB, token: buyerBToken } = createBuyer(env.db, {
    merchantId: fx.merchant.id,
    externalRef: 'buyer-B',
  });
  const stolen = await fetch(`${env.base}/grants/${grant.grantId}/artifact`, {
    headers: { authorization: `Bearer ${buyerBToken}` },
  });
  assert.equal(stolen.status, 403);
  await stolen.arrayBuffer().catch(() => {});
  const rets = all<Retrieval>(env.db, 'SELECT * FROM retrievals WHERE order_id = ?', o2.id);
  assert.equal(rets.length, 0);
  void buyerB;

  // (b) Partial stream: buyer A aborts mid-download → interrupted, not delivered.
  const res = await fetch(`${env.base}/grants/${grant.grantId}/artifact`, {
    headers: { authorization: `Bearer ${fx.buyerToken}`, connection: 'close' },
  });
  assert.equal(res.status, 200);
  const retId = res.headers.get('x-retrieval-id')!;
  const reader = res.body!.getReader();
  await reader.read(); // first 512-byte chunk
  await reader.cancel();
  const interrupted = await waitFor(
    () => {
      const r = one<Retrieval>(env.db, 'SELECT * FROM retrievals WHERE id = ?', retId);
      return r && r.state === 'interrupted' ? r : undefined;
    },
    { label: 'interrupted retrieval' },
  );
  assert.ok(interrupted.bytes_transferred < 3072);
  const caseNow = await api(env.base, 'GET', `/cases/${caseId}`, { token: fx.buyerToken });
  assert.notEqual((caseNow.body as { data: { state: string } }).data.state, 'delivered');

  // (c) While the retrieval is ambiguous, it blocks refund dispatch (the
  // serialized-disposition guard the refund module consults).
  assert.ok(retrievalBlocksRefund(env.db, o2.id));

  // (d) Same buyer resumes under the same fenced retrieval → completes.
  const res2 = await fetch(`${env.base}/grants/${grant.grantId}/artifact`, {
    headers: { authorization: `Bearer ${fx.buyerToken}`, connection: 'close' },
  });
  assert.equal(res2.status, 200);
  const buf2 = Buffer.from(await res2.arrayBuffer());
  assert.equal(buf2.length, 3072);
  assert.equal(createHash('sha256').update(buf2).digest('hex'), DIGEST);
  await waitFor(
    () => {
      const r = one<Retrieval>(env.db, 'SELECT * FROM retrievals WHERE id = ?', retId);
      return r && r.state === 'awaiting_receipt' ? r : undefined;
    },
    { label: 'resumed stream finish' },
  );

  // Explicit buyer acknowledgment closes it delivered.
  const ack = await api(env.base, 'POST', `/cases/${caseId}/acknowledge`, { token: fx.buyerToken });
  assert.equal(ack.status, 200);
  assert.equal((ack.body as { data: { state: string } }).data.state, 'delivered');
});
