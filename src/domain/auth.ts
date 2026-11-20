import type { Db } from '../db/db.ts';
import { one } from '../db/db.ts';
import { hmacSha256, safeEqual, sha256 } from '../ids.ts';
import type { Actor, Buyer, Merchant, Operator } from './types.ts';
import { unauthorized } from './errors.ts';

export function actorKey(actor: Actor): string {
  return `${actor.kind}:${actor.id}`;
}

/** Authenticate a buyer by bearer token. Tokens are stored only as sha256. */
export function authenticateBuyer(db: Db, token: string): { actor: Actor; buyer: Buyer } {
  const buyer = one<Buyer>(
    db,
    'SELECT * FROM buyers WHERE token_hash = ?',
    sha256(token),
  );
  if (!buyer) throw unauthorized('unknown buyer token');
  return {
    actor: { kind: 'buyer', id: buyer.id, merchantId: buyer.merchant_id },
    buyer,
  };
}

/** Authenticate a merchant operator; optionally require a role. */
export function authenticateOperator(
  db: Db,
  token: string,
  requiredRole?: string,
): { actor: Actor; operator: Operator } {
  const op = one<Operator>(
    db,
    'SELECT * FROM operators WHERE token_hash = ? AND revoked_at IS NULL',
    sha256(token),
  );
  if (!op) throw unauthorized('unknown operator token');
  const roles: string[] = JSON.parse(op.roles);
  if (requiredRole && !roles.includes(requiredRole)) {
    throw unauthorized(`operator lacks role '${requiredRole}'`);
  }
  return {
    actor: { kind: 'operator', id: op.id, merchantId: op.merchant_id, roles },
    operator: op,
  };
}

export type ConnectorSignature = { timestampMs: number; signature: string };

/**
 * Parse `X-DeliveryDesk-Signature: t=<ms>,v1=<hex>`. Returns null on any
 * malformed input — the caller treats parse failure as failed authentication.
 */
export function parseSignatureHeader(header: string | undefined): ConnectorSignature | null {
  if (!header) return null;
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts['t']);
  const sig = parts['v1'];
  if (!Number.isFinite(t) || !sig || !/^[0-9a-f]{64}$/.test(sig)) return null;
  return { timestampMs: t, signature: sig };
}

/**
 * Verify a connector callback. HMAC-SHA256 over `${t}.${rawBody}` with the
 * merchant's callback secret, plus a freshness window for replay protection.
 * Returns false — never throws — so failed auth short-circuits before any
 * state change (SECURITY.md).
 */
export function verifyConnectorSignature(
  merchant: Merchant,
  rawBody: string,
  sig: ConnectorSignature | null,
  skewMs: number,
  nowMsValue: number,
): boolean {
  if (!sig) return false;
  if (Math.abs(nowMsValue - sig.timestampMs) > skewMs) return false;
  const expected = hmacSha256(merchant.callback_secret, `${sig.timestampMs}.${rawBody}`);
  return safeEqual(expected, sig.signature);
}

export function signCallback(secret: string, body: string, timestampMs = Date.now()): string {
  return `t=${timestampMs},v1=${hmacSha256(secret, `${timestampMs}.${body}`)}`;
}
