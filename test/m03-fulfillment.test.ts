import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { boot, seedMerchant, postEvent, api, type TestEnv, type Fixture } from './helpers.ts';
import { one, all } from '../src/db/db.ts';
import { sha256 } from '../src/ids.ts';
import type { Fulfillment, Case } from '../src/domain/types.ts';
import { latestFulfillment } from '../src/domain/fulfillments.ts';
import { enrollMerchant } from '../src/domain/merchants.ts';
import { registerOrder } from '../src/domain/orders.ts';
import { createBuyer } from '../src/domain/merchants.ts';
import { createMerchantSim, type MerchantSim } from '../src/simulator/merchant-sim.ts';
import { workerTick } from '../src/worker/runner.ts';
import { newId } from '../src/ids.ts';
import { now } from '../src/clock.ts';

/**
 * M03 · Asynchronous fulfillment (FR-03, INV-03)
 * T-005: revision 4 plus a readable artifact produces ready, then
 *        version 3 running is ignored.
 * T-006: a completed status with missing bytes remains investigating and
 *        displays its missing evidence.
 */

let env: TestEnv;
let fx: Fixture;
let sim: MerchantSim;

const ARTIFACT = Buffer.concat([Buffer.alloc(1024, 0xdd), Buffer.alloc(1024, 0x42), Buffer.alloc(1024, 0x07)]); // 3KB
const DIGEST = sha256(ARTIFACT);

before(async () => {
  env = await boot();
  fx = seedMerchant(env.db, { id: 'merch-a', externalOrderId: 'E7', amountMinor: 250 });
  sim = await createMerchantSim();
});

after(async () => {
  await sim.close();
  await env.cleanup();
});

const pay = async () =>
  postEvent(env.base, fx.merchant, fx.secret, {
    event_id: newId('evt'),
    kind: 'payment.receipt',
    order_external_id: 'E7',
    payload: {
      rail: 'local-rail',
      transfer_ref: newId('tx'),
      event_index: 0,
      amount_minor: 250,
      asset: 'USD',
      invoice_ref: 'inv-merch-a-e7',
    },
  });

function insertCase(orderId: string): string {
  const id = newId('case');
  env.db
    .prepare(
      `INSERT INTO cases (id, order_id, merchant_id, buyer_id, reason, state, version, opened_by, created_at)
       VALUES (?, ?, ?, ?, 'export_timeout', 'investigating', 1, 'test', ?)`,
    )
    .run(id, orderId, fx.order.merchant_id, fx.order.buyer_id, now());
  return id;
}

test('T-005: rev4 complete + readable artifact → ready; rev3 running ignored', async () => {
  await pay();
  // Worker reports completion at revision 4 with the 3KB export inline.
  const r4 = await postEvent(env.base, fx.merchant, fx.secret, {
    event_id: 'evt-ful-4',
    kind: 'fulfillment.status',
    order_external_id: 'E7',
    payload: {
      revision: 4,
      status: 'complete',
      artifact_digest: DIGEST,
      artifact_b64: ARTIFACT.toString('base64'),
      note: 'export finished',
    },
  });
  assert.equal(r4.status, 202);
  assert.match(String((r4.body as { data: { detail: string } }).data.detail), /ready:rev4/);

  const f = latestFulfillment(env.db, fx.order.id)!;
  assert.equal(f.state, 'ready');
  assert.equal(f.revision, 4);
  assert.equal(f.artifact_digest, DIGEST);

  // Artifact bytes landed in the content-addressed store.
  const art = one<{ byte_length: number }>(
    env.db,
    'SELECT byte_length FROM artifacts WHERE digest = ?',
    DIGEST,
  )!;
  assert.equal(art.byte_length, 3072);

  // Older 'running' event at revision 3 arrives late → ignored, no row.
  const r3 = await postEvent(env.base, fx.merchant, fx.secret, {
    event_id: 'evt-ful-3',
    kind: 'fulfillment.status',
    order_external_id: 'E7',
    payload: { revision: 3, status: 'running' },
  });
  assert.equal(r3.status, 202);
  assert.match(String((r3.body as { data: { detail: string } }).data.detail), /stale_revision:3<=4/);
  const rows = all<Fulfillment>(
    env.db,
    'SELECT * FROM fulfillments WHERE order_id = ? ORDER BY revision',
    fx.order.id,
  );
  assert.equal(rows.length, 1);
  assert.equal(latestFulfillment(env.db, fx.order.id)!.state, 'ready');
});

test('T-006: complete status with missing bytes stays investigating with evidence', async () => {
  const caseId = insertCase(fx.order.id);
  const r = await postEvent(env.base, fx.merchant, fx.secret, {
    event_id: 'evt-ful-missing',
    kind: 'fulfillment.status',
    order_external_id: 'E7',
    payload: {
      revision: 5,
      status: 'complete',
      artifact_digest: 'f'.repeat(64),
      // no artifact_ref, no bytes
    },
  });
  assert.equal(r.status, 202);

  const f = latestFulfillment(env.db, fx.order.id)!;
  assert.equal(f.state, 'unknown');
  assert.match(f.evidence_note ?? '', /artifact_missing/);

  // Case stays investigating — a report is not proof.
  const c = one<Case>(env.db, 'SELECT * FROM cases WHERE id = ?', caseId)!;
  assert.equal(c.state, 'investigating');

  // The missing evidence is exposed on the order read surface.
  const view = await api(env.base, 'GET', `/orders/${fx.order.id}`, { token: fx.buyerToken });
  const fv = (view.body as { data: { fulfillment: { state: string; evidenceNote: string } } }).data.fulfillment;
  assert.equal(fv.state, 'unknown');
  assert.match(fv.evidenceNote, /artifact_missing/);
});

test('poll path: merchant status API recovery fetches artifact and reaches ready', async () => {
  // Second merchant whose status comes from the emulator.
  const { merchant: m2 } = enrollMerchant(env.db, {
    id: 'merch-sim',
    name: 'Simulated Merchant',
    connectorKind: 'local-emulator',
    statusBaseUrl: sim.base,
    callbackSecret: 'sim-secret',
  });
  const { buyer: b2 } = createBuyer(env.db, { merchantId: m2.id, externalRef: 'sim-buyer' });
  const { order: o2 } = registerOrder(env.db, {
    merchantId: m2.id,
    buyerId: b2.id,
    externalOrderId: 'SIM-1',
    amountMinor: 250,
    asset: 'USD',
    invoiceRef: 'inv-sim-1',
  });
  env.db.prepare("UPDATE orders SET state = 'paid' WHERE id = ?").run(o2.id);
  insertCase(o2.id);

  const digest = sim.setArtifact('SIM-1', ARTIFACT);
  sim.setOrder('SIM-1', { revision: 4, status: 'complete' });

  // One worker tick: polls status → artifact.fetch outbox → drains → ready.
  await workerTick(env.db, env.config);
  await workerTick(env.db, env.config);

  const f = latestFulfillment(env.db, o2.id)!;
  assert.equal(f.revision, 4);
  assert.equal(f.state, 'ready');
  assert.equal(f.artifact_digest, digest);
});
