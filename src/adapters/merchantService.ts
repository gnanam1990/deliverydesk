import type { Config } from '../config.ts';
import { assertAllowedOutbound } from '../config.ts';
import type { Merchant } from '../domain/types.ts';

/**
 * Merchant status adapter (FR-03). The adapter contract is deliberately
 * narrow — quote/execute live on the merchant side of the boundary; here we
 * only inspect status and fetch artifacts. Outbound targets are restricted to
 * configured, allowlisted hosts (SECURITY.md). The local pilot points this at
 * the labeled `local-emulator` merchant service; a live adapter implements
 * the same surface against the provider's documented endpoints.
 */
export interface MerchantStatusReport {
  /** Monotonic merchant revision for this order. */
  revision: number;
  /** Merchant-side status word: queued | running | complete | failed. */
  status: string;
  /** Provider-stable event reference for this report. */
  event_id: string;
  artifact_digest?: string;
  artifact_url?: string;
  note?: string;
}

export async function fetchStatus(
  config: Config,
  merchant: Merchant,
  externalOrderId: string,
): Promise<MerchantStatusReport | null> {
  if (!merchant.status_base_url) return null;
  const base = assertAllowedOutbound(config, merchant.status_base_url);
  const url = new URL(`/status/${encodeURIComponent(externalOrderId)}`, base);
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`merchant status lookup failed: HTTP ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  if (typeof body['revision'] !== 'number' || typeof body['status'] !== 'string') {
    throw new Error('merchant status response malformed');
  }
  return {
    revision: body['revision'],
    status: body['status'],
    event_id: String(body['event_id'] ?? `poll:${body['revision']}`),
    artifact_digest: typeof body['artifact_digest'] === 'string' ? body['artifact_digest'] : undefined,
    artifact_url: typeof body['artifact_url'] === 'string' ? body['artifact_url'] : undefined,
    note: typeof body['note'] === 'string' ? body['note'] : undefined,
  };
}

/** Fetch an artifact the merchant reported, bounded and allowlisted. */
export async function fetchArtifactBytes(
  config: Config,
  merchant: Merchant,
  artifactUrl: string,
): Promise<Uint8Array> {
  const url = assertAllowedOutbound(config, artifactUrl);
  if (merchant.status_base_url) {
    const allowedBase = new URL(merchant.status_base_url);
    if (url.hostname !== allowedBase.hostname) {
      throw new Error(`artifact host ${url.hostname} not under merchant status origin`);
    }
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`artifact fetch failed: HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > config.maxArtifactBytes) {
    throw new Error('fetched artifact exceeds size bound');
  }
  return buf;
}
