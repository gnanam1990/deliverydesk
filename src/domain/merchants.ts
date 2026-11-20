import type { Db } from '../db/db.ts';
import { all, one, tx } from '../db/db.ts';
import { newId, newToken, sha256 } from '../ids.ts';
import { now } from '../clock.ts';
import type { Buyer, Merchant, Operator } from './types.ts';
import { conflict, notFound } from './errors.ts';

export interface EnrolledMerchant {
  merchant: Merchant;
  connectorSecret: string;
}

/**
 * Enroll the participating seller (FR-01). Idempotent on merchant id:
 * re-enrolling the same id with identical config returns the existing row;
 * different config is a conflict.
 */
export function enrollMerchant(
  db: Db,
  input: {
    id: string;
    name: string;
    connectorKind: string;
    statusBaseUrl?: string | null;
    refundBaseUrl?: string | null;
    callbackSecret?: string;
  },
): EnrolledMerchant {
  return tx(db, () => {
    const existing = one<Merchant>(db, 'SELECT * FROM merchants WHERE id = ?', input.id);
    if (existing) {
      const same =
        existing.name === input.name &&
        existing.connector_kind === input.connectorKind &&
        existing.status_base_url === (input.statusBaseUrl ?? null) &&
        existing.refund_base_url === (input.refundBaseUrl ?? null);
      if (!same) throw conflict(`merchant '${input.id}' already enrolled with different config`);
      return { merchant: existing, connectorSecret: existing.callback_secret };
    }
    const secret = input.callbackSecret ?? newToken('ddsec');
    const merchant: Merchant = {
      id: input.id,
      name: input.name,
      connector_kind: input.connectorKind,
      callback_secret: secret,
      status_base_url: input.statusBaseUrl ?? null,
      refund_base_url: input.refundBaseUrl ?? null,
      created_at: now(),
    };
    db.prepare(
      `INSERT INTO merchants (id, name, connector_kind, callback_secret, status_base_url, refund_base_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      merchant.id,
      merchant.name,
      merchant.connector_kind,
      merchant.callback_secret,
      merchant.status_base_url,
      merchant.refund_base_url,
      merchant.created_at,
    );
    return { merchant, connectorSecret: secret };
  });
}

export function getMerchant(db: Db, id: string): Merchant {
  const m = one<Merchant>(db, 'SELECT * FROM merchants WHERE id = ?', id);
  if (!m) throw notFound(`merchant '${id}' not found`);
  return m;
}

export function createBuyer(
  db: Db,
  input: { merchantId: string; externalRef: string; displayName?: string; token?: string },
): { buyer: Buyer; token: string } {
  return tx(db, () => {
    const existing = one<Buyer>(
      db,
      'SELECT * FROM buyers WHERE merchant_id = ? AND external_ref = ?',
      input.merchantId,
      input.externalRef,
    );
    if (existing) return { buyer: existing, token: '' };
    const token = input.token ?? newToken('ddb');
    const buyer: Buyer = {
      id: newId('buy'),
      merchant_id: input.merchantId,
      external_ref: input.externalRef,
      token_hash: sha256(token),
      display_name: input.displayName ?? '',
      created_at: now(),
    };
    db.prepare(
      `INSERT INTO buyers (id, merchant_id, external_ref, token_hash, display_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      buyer.id,
      buyer.merchant_id,
      buyer.external_ref,
      buyer.token_hash,
      buyer.display_name,
      buyer.created_at,
    );
    return { buyer, token };
  });
}

export function createOperator(
  db: Db,
  input: { merchantId: string; name: string; roles: string[]; token?: string },
): { operator: Operator; token: string } {
  return tx(db, () => {
    const existing = one<Operator>(
      db,
      'SELECT * FROM operators WHERE merchant_id = ? AND name = ?',
      input.merchantId,
      input.name,
    );
    if (existing) return { operator: existing, token: '' };
    const token = input.token ?? newToken('ddo');
    const operator: Operator = {
      id: newId('op'),
      merchant_id: input.merchantId,
      name: input.name,
      roles: JSON.stringify(input.roles),
      token_hash: sha256(token),
      revoked_at: null,
      created_at: now(),
    };
    db.prepare(
      `INSERT INTO operators (id, merchant_id, name, roles, token_hash, revoked_at, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      operator.id,
      operator.merchant_id,
      operator.name,
      operator.roles,
      operator.token_hash,
      operator.created_at,
    );
    return { operator, token };
  });
}

export function listBuyers(db: Db, merchantId: string): Buyer[] {
  return all<Buyer>(db, 'SELECT * FROM buyers WHERE merchant_id = ?', merchantId);
}
