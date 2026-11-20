import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig, type Config } from '../src/config.ts';
import { openDb, type Db } from '../src/db/db.ts';
import { buildApp, listen } from '../src/http/wiring.ts';
import { signCallback } from '../src/domain/auth.ts';
import {
  enrollMerchant,
  createBuyer,
  createOperator,
} from '../src/domain/merchants.ts';
import { registerOrder } from '../src/domain/orders.ts';
import type { Buyer, Merchant, Operator, Order } from '../src/domain/types.ts';

export interface TestEnv {
  dir: string;
  db: Db;
  config: Config;
  server: http.Server;
  base: string;
  cleanup: () => Promise<void>;
}

/** Boot a real app on an ephemeral port with a temp sqlite file + artifact dir. */
export async function boot(overrides: Partial<Config> = {}): Promise<TestEnv> {
  const dir = mkdtempSync(path.join(tmpdir(), 'dd-test-'));
  const config = loadConfig({
    port: 0,
    dbPath: path.join(dir, 'test.sqlite'),
    artifactDir: path.join(dir, 'artifacts'),
    grantTtlMs: 60_000,
    callbackSkewMs: 5 * 60 * 1000,
    ...overrides,
  });
  const db = openDb(config.dbPath);
  const app = buildApp(db, config);
  const server = await listen(app, 0);
  const { port } = server.address() as AddressInfo;
  return {
    dir,
    db,
    config,
    server,
    base: `http://127.0.0.1:${port}`,
    cleanup: async () => {
      server.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Boot domain layer only — no HTTP. */
export function bootDb(overrides: Partial<Config> = {}): { db: Db; config: Config; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'dd-test-'));
  const config = loadConfig({
    port: 0,
    dbPath: path.join(dir, 'test.sqlite'),
    artifactDir: path.join(dir, 'artifacts'),
    ...overrides,
  });
  const db = openDb(config.dbPath);
  return {
    db,
    config,
    dir,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface Fixture {
  merchant: Merchant;
  secret: string;
  buyer: Buyer;
  buyerToken: string;
  operator: Operator;
  operatorToken: string;
  order: Order;
}

export function seedMerchant(
  db: Db,
  opts: { id?: string; externalOrderId?: string; amountMinor?: number; buyerRef?: string } = {},
): Fixture {
  const id = opts.id ?? 'merch-a';
  const { merchant, connectorSecret } = enrollMerchant(db, {
    id,
    name: `Merchant ${id}`,
    connectorKind: 'local-emulator',
  });
  const { buyer, token: buyerToken } = createBuyer(db, {
    merchantId: merchant.id,
    externalRef: opts.buyerRef ?? 'buyer-1',
    displayName: 'Buyer One',
  });
  const { operator, token: operatorToken } = createOperator(db, {
    merchantId: merchant.id,
    name: 'ops',
    roles: ['support', 'finance'],
  });
  const { order } = registerOrder(db, {
    merchantId: merchant.id,
    buyerId: buyer.id,
    externalOrderId: opts.externalOrderId ?? 'E7',
    amountMinor: opts.amountMinor ?? 250,
    asset: 'USD',
    invoiceRef: `inv-${id}-e7`,
  });
  return { merchant, secret: connectorSecret, buyer, buyerToken, operator, operatorToken, order };
}

export interface ApiResult {
  status: number;
  body: Record<string, unknown> | null;
  headers: http.IncomingHttpHeaders;
  raw: string;
}

export async function api(
  base: string,
  method: string,
  pathName: string,
  opts: {
    token?: string;
    json?: unknown;
    headers?: Record<string, string>;
    signSecret?: string;
    idempotencyKey?: string;
  } = {},
): Promise<ApiResult> {
  const bodyStr = opts.json !== undefined ? JSON.stringify(opts.json) : '';
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.json !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
  if (opts.signSecret !== undefined) {
    headers['x-deliverydesk-signature'] = signCallback(opts.signSecret, bodyStr);
  }
  const res = await fetch(`${base}${pathName}`, {
    method,
    headers,
    body: opts.json !== undefined ? bodyStr : undefined,
  });
  const raw = await res.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(raw);
  } catch {
    /* non-json */
  }
  return { status: res.status, body, headers: res.headers as unknown as http.IncomingHttpHeaders, raw };
}

/** Signed connector event POST. */
export function postEvent(
  base: string,
  merchant: Merchant,
  secret: string,
  event: { event_id: string; kind: string; order_external_id?: string; payload?: Record<string, unknown> },
  opts: { secret?: string } = {},
): Promise<ApiResult> {
  return api(base, 'POST', `/connectors/${merchant.id}/events`, {
    json: { ...event, payload: event.payload ?? {} },
    signSecret: opts.secret ?? secret,
  });
}

export function bearer(t: string): { authorization: string } {
  return { authorization: `Bearer ${t}` };
}

/** Poll a condition — stream completion and worker ticks are async. */
export async function waitFor<T>(
  fn: () => T | undefined | null | false,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 3000);
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 25));
  }
  throw new Error(`waitFor timed out: ${opts.label ?? 'condition'}`);
}
