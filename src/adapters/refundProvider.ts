import type { Config } from '../config.ts';
import { assertAllowedOutbound } from '../config.ts';
import type { Merchant } from '../domain/types.ts';

/**
 * Refund provider adapter (FR-05). Dispatch and settlement are distinct
 * provider calls with distinct outcomes. The local pilot targets the
 * labeled `local-emulator` service; a live provider implements the same
 * surface with documented refund/cancel capability only.
 */

export class ProviderTimeout extends Error {
  constructor() {
    super('provider request timed out');
    this.name = 'ProviderTimeout';
  }
}

export class ProviderError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'ProviderError';
    this.statusCode = statusCode;
  }
}

export interface DispatchResult {
  refundRef: string;
  state: string;
}

/**
 * Dispatch a refund. The merchant's idempotency key rides along so a retry
 * cannot double-charge the disposition. A throw means the outcome is
 * UNKNOWN at the provider — callers route to investigation, never assume.
 */
export async function dispatchRefund(
  config: Config,
  merchant: Merchant,
  input: { idempotencyKey: string; orderRef: string; amountMinor: number; asset: string },
): Promise<DispatchResult> {
  if (!merchant.refund_base_url) {
    throw new ProviderError(0, 'merchant has no refund endpoint configured');
  }
  const base = assertAllowedOutbound(config, merchant.refund_base_url);
  const url = new URL('/refunds', base);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        idempotency_key: input.idempotencyKey,
        order_ref: input.orderRef,
        amount_minor: input.amountMinor,
        asset: input.asset,
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (e) {
    if ((e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError') {
      throw new ProviderTimeout();
    }
    throw e;
  }
  if (!res.ok) {
    throw new ProviderError(res.status, `provider returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as Record<string, unknown>;
  return { refundRef: String(body['refund_ref']), state: String(body['state'] ?? 'pending') };
}

export type SettlementStatus = 'settled' | 'pending' | 'failed' | 'unknown';

/** Query provider settlement for a dispatched refund. */
export async function checkSettlement(
  config: Config,
  merchant: Merchant,
  refundRef: string,
): Promise<SettlementStatus> {
  if (!merchant.refund_base_url) return 'unknown';
  const base = assertAllowedOutbound(config, merchant.refund_base_url);
  const url = new URL(`/refunds/${encodeURIComponent(refundRef)}`, base);
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(3000) });
  } catch {
    return 'unknown';
  }
  if (res.status === 404) return 'unknown';
  if (!res.ok) return 'unknown';
  const body = (await res.json()) as Record<string, unknown>;
  const s = String(body['state'] ?? '');
  if (s === 'settled' || s === 'pending' || s === 'failed') return s;
  return 'unknown';
}
