import { loadConfig } from '../config.ts';
import { openDb } from '../db/db.ts';
import { enrollMerchant, createBuyer, createOperator } from '../domain/merchants.ts';
import { registerOrder } from '../domain/orders.ts';
import { recordReceipt } from '../domain/payments.ts';
import { applyStatus } from '../domain/fulfillments.ts';
import { sha256 } from '../ids.ts';

/**
 * Deterministic local acceptance fixture (environment=local-emulator).
 * Seeds merchant order E7, a 250 USD-cent confirmed payment and fulfillment
 * revision 4 with a verified 3 KB artifact. Run `npm run simulator` for the
 * matching merchant/refund boundary, then `npm start`.
 */

const config = loadConfig();
const db = openDb(config.dbPath);
const ctx = { db, config };

const simBase = process.env.DD_SIM_BASE ?? 'http://127.0.0.1:8099';
const merchantId = process.env.DD_DEMO_MERCHANT ?? 'pilot';
const callbackSecret = process.env.DD_DEMO_CALLBACK_SECRET ?? 'local-demo-secret';
const artifact = Buffer.alloc(3072, 0x44);
const digest = sha256(artifact);

const { merchant } = enrollMerchant(db, {
  id: merchantId,
  name: 'DeliveryDesk Pilot',
  connectorKind: 'local-emulator',
  statusBaseUrl: simBase,
  refundBaseUrl: simBase,
  callbackSecret,
});
const { buyer: buyerA, token: buyerAToken } = createBuyer(db, {
  merchantId: merchant.id,
  externalRef: 'buyer-a',
  displayName: 'Buyer A',
  token: process.env.DD_DEMO_BUYER_A_TOKEN ?? 'demo-buyer-a',
});
const { buyer: buyerB, token: buyerBToken } = createBuyer(db, {
  merchantId: merchant.id,
  externalRef: 'buyer-b',
  displayName: 'Buyer B',
  token: process.env.DD_DEMO_BUYER_B_TOKEN ?? 'demo-buyer-b',
});
const { token: operatorToken } = createOperator(db, {
  merchantId: merchant.id,
  name: 'support',
  roles: ['support', 'finance'],
  token: process.env.DD_DEMO_OPERATOR_TOKEN ?? 'demo-operator',
});
const { order } = registerOrder(db, {
  merchantId: merchant.id,
  buyerId: buyerA.id,
  externalOrderId: 'E7',
  amountMinor: 250,
  asset: 'USD',
  invoiceRef: 'inv-pilot-e7',
  description: 'Reference paid digital export',
});

const receiptResult = recordReceipt(ctx, merchant, {
  event_id: 'seed-pay-E7',
  kind: 'payment.receipt',
  order_external_id: 'E7',
  payload: {
    rail: 'local-rail',
    transfer_ref: 'seed-transfer-E7',
    event_index: 0,
    amount_minor: 250,
    asset: 'USD',
    invoice_ref: 'inv-pilot-e7',
  },
});
const fulfillmentResult = applyStatus(ctx, merchant, 'E7', {
  revision: 4,
  status: 'complete',
  artifact_digest: digest,
  artifact_b64: artifact.toString('base64'),
  note: 'seeded local-emulator artifact',
}, 'seed-ful-E7-r4');

db.close();
console.log(JSON.stringify({
  ok: true,
  environment: 'local-emulator',
  merchantId: merchant.id,
  order: { id: order.id, externalOrderId: order.external_order_id, amountMinor: order.amount_minor, asset: order.asset },
  artifact: { bytes: artifact.byteLength, digest },
  results: { receipt: receiptResult, fulfillment: fulfillmentResult },
  credentials: {
    buyerA: buyerAToken || process.env.DD_DEMO_BUYER_A_TOKEN || 'demo-buyer-a',
    buyerB: buyerBToken || process.env.DD_DEMO_BUYER_B_TOKEN || 'demo-buyer-b',
    operator: operatorToken || process.env.DD_DEMO_OPERATOR_TOKEN || 'demo-operator',
  },
  routes: {
    login: '/login',
    buyer: '/buyer',
    console: '/console',
  },
}, null, 2));
