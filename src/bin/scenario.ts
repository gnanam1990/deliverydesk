import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sha256 } from '../ids.ts';

/**
 * Reference acceptance journey over the normal HTTP entry points.
 * Expected setup: `npm run simulator`, `npm run seed`, `npm start`.
 * Output is redacted local-emulator evidence; no live provider is called.
 */

const base = process.env.DD_BASE ?? 'http://127.0.0.1:8080';
const merchantId = process.env.DD_DEMO_MERCHANT ?? 'pilot';
const buyerA = process.env.DD_DEMO_BUYER_A_TOKEN ?? 'demo-buyer-a';
const buyerB = process.env.DD_DEMO_BUYER_B_TOKEN ?? 'demo-buyer-b';
const operator = process.env.DD_DEMO_OPERATOR_TOKEN ?? 'demo-operator';
const outPath = process.env.DD_EVIDENCE_OUT ?? 'build-progress/deliverydesk/evidence/acceptance-local.json';

async function call(method: string, pathName: string, opts: { token?: string; json?: unknown; accept?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.json !== undefined) headers['content-type'] = 'application/json';
  if (opts.accept) headers.accept = opts.accept;
  const res = await fetch(`${base}${pathName}`, {
    method,
    headers,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
  });
  const text = await res.text();
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, headers: res.headers, body };
}

const orderLookup = await call(
  'GET',
  `/orders/lookup?merchant_id=${encodeURIComponent(merchantId)}&external_id=E7`,
  { token: buyerA },
);
if (orderLookup.status !== 200) throw new Error(`order lookup failed: ${orderLookup.status}`);
const order = (orderLookup.body as { data: { id: string; payment: { state: string } | null; fulfillment: { revision: number; state: string; artifactDigest: string | null } | null; refund?: { state: string } | null } }).data;
if (order.payment?.state !== 'confirmed') throw new Error('seeded E7 payment is not confirmed');
if (order.fulfillment?.revision !== 4 || order.fulfillment.state !== 'ready') {
  throw new Error('seeded E7 fulfillment is not ready at revision 4');
}

const deniedLookup = await call('GET', `/orders/${order.id}`, { token: buyerB });
const opened = await call('POST', `/orders/${order.id}/cases`, { token: buyerA, json: { reason: 'export_timeout' } });
if (![200, 201].includes(opened.status)) throw new Error(`case open failed: ${opened.status}`);
const kase = (opened.body as { data: { id: string } }).data;

const grant = await call('POST', `/cases/${kase.id}/redelivery`, { token: buyerA });
if (grant.status !== 201) throw new Error(`redelivery failed: ${grant.status}`);
const grantId = (grant.body as { data: { grantId: string; artifactDigest: string } }).data;
const copiedGrantDenied = await fetch(`${base}/grants/${grantId.grantId}/artifact`, {
  headers: { authorization: `Bearer ${buyerB}` },
});

const download = await fetch(`${base}/grants/${grantId.grantId}/artifact`, {
  headers: { authorization: `Bearer ${buyerA}` },
});
const retrievalId = download.headers.get('x-retrieval-id');
const artifact = Buffer.from(await download.arrayBuffer());
const digest = sha256(artifact);
if (!retrievalId || download.status !== 200) throw new Error('artifact retrieval failed');
const receipt = await call('POST', `/retrievals/${retrievalId}/receipt`, { token: buyerA, json: { digest } });
const finalCase = await call('GET', `/cases/${kase.id}`, { token: buyerA });
const operatorCase = await call('GET', `/console/cases/${kase.id}`, { token: operator });
const buyerHtml = await call('GET', `/cases/${kase.id}`, { token: buyerA, accept: 'text/html' });
const metrics = await call('GET', '/console/metrics', { token: operator });

const evidence = {
  environment: 'local-emulator',
  entryPoint: base,
  input: { merchantId, externalOrderId: 'E7', amountMinor: 250, asset: 'USD', artifactBytes: artifact.byteLength },
  observed: {
    orderLookupStatus: orderLookup.status,
    paymentState: order.payment.state,
    fulfillmentRevision: order.fulfillment.revision,
    fulfillmentState: order.fulfillment.state,
    seededArtifactDigest: order.fulfillment.artifactDigest,
    crossBuyerLookupStatus: deniedLookup.status,
    caseId: kase.id,
    caseOpenStatus: opened.status,
    copiedGrantStatus: copiedGrantDenied.status,
    artifactBytes: artifact.byteLength,
    artifactDigest: digest,
    expectedDigest: grantId.artifactDigest,
    receiptStatus: receipt.status,
    finalCaseState: (finalCase.body as { data: { state: string } }).data.state,
    operatorCaseState: (operatorCase.body as { data: { state: string } }).data.state,
    operatorRefundState: (operatorCase.body as { data: { refund: { state: string } | null } }).data.refund?.state ?? null,
    buyerTimelineContainsDelivery: String(buyerHtml.body).includes('Delivery acknowledged'),
    metrics: (metrics.body as { data: unknown }).data,
  },
  redactions: ['buyer/operator bearer tokens', 'grant bearer token', 'provider secrets'],
};
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
