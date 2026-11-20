import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { sha256 } from '../ids.ts';

/**
 * LOCAL BOUNDARY EMULATOR — explicitly labeled `local-emulator`.
 *
 * Stands in for the pilot merchant's order/status API, artifact host and
 * refund provider while live integrations are unavailable (KITE-AND-
 * PROVIDERS: external behavior is recorded as emulated, never claimed live).
 * It is a real HTTP service, so DeliveryDesk's adapters exercise genuine
 * network boundaries; fault knobs give deterministic fault injection.
 */

export interface SimOrderState {
  revision: number;
  status: 'queued' | 'running' | 'complete' | 'failed';
  note?: string;
}

export interface SimRefund {
  refund_ref: string;
  order_ref: string;
  idempotency_key: string;
  amount_minor: number;
  asset: string;
  state: 'pending' | 'settled' | 'failed';
}

export interface SimFaults {
  /** Refund dispatch hangs past the client timeout (request still lands). */
  refundTimeout: boolean;
  /** Refund dispatch records then returns HTTP 500 (split response). */
  refundAmbiguous: boolean;
  /** Status lookups return HTTP 500. */
  statusUnavailable: boolean;
}

export interface MerchantSim {
  server: http.Server;
  base: string;
  port: number;
  orders: Map<string, SimOrderState>;
  artifacts: Map<string, Uint8Array>;
  refunds: Map<string, SimRefund>;
  faults: SimFaults;
  setOrder(externalId: string, s: SimOrderState): void;
  setArtifact(externalId: string, bytes: Uint8Array): string;
  settleRefund(ref: string): void;
  refundCalls: number;
  close(): Promise<void>;
}

export async function createMerchantSim(opts: { port?: number } = {}): Promise<MerchantSim> {
  const orders = new Map<string, SimOrderState>();
  const artifacts = new Map<string, Uint8Array>();
  const orderArtifacts = new Map<string, string>();
  const refunds = new Map<string, SimRefund>();
  const faults: SimFaults = { refundTimeout: false, refundAmbiguous: false, statusUnavailable: false };
  let refundCalls = 0;
  let refundSeq = 0;

  const sim: MerchantSim = {
    server: null as unknown as http.Server,
    base: '',
    port: 0,
    orders,
    artifacts,
    refunds,
    faults,
    refundCalls: 0,
    setOrder(externalId, s) {
      orders.set(externalId, s);
    },
    setArtifact(externalId, bytes) {
      const digest = sha256(bytes);
      artifacts.set(digest, bytes);
      orderArtifacts.set(externalId, digest);
      return digest;
    },
    settleRefund(ref) {
      const r = refunds.get(ref);
      if (r) r.state = 'settled';
    },
    async close() {
      await new Promise<void>((res) => sim.server.close(() => res()));
    },
  };

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
    });

  sim.server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://sim');
    const path = url.pathname;

    if (req.method === 'GET' && path.startsWith('/status/')) {
      if (faults.statusUnavailable) return json(res, 500, { error: 'simulated status outage' });
      const orderId = decodeURIComponent(path.slice('/status/'.length));
      const s = orders.get(orderId);
      if (!s) return json(res, 404, { error: 'unknown order' });
      const digest = orderArtifacts.get(orderId);
      return json(res, 200, {
        revision: s.revision,
        status: s.status,
        event_id: `sim-${orderId}-r${s.revision}`,
        artifact_digest: s.status === 'complete' ? digest : undefined,
        artifact_url:
          s.status === 'complete' && digest ? `${sim.base}/artifacts/${digest}` : undefined,
        note: s.note,
      });
    }

    if (req.method === 'GET' && path.startsWith('/artifacts/')) {
      const digest = path.slice('/artifacts/'.length);
      const bytes = artifacts.get(digest);
      if (!bytes) return json(res, 404, { error: 'unknown artifact' });
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(bytes);
      return;
    }

    if (req.method === 'POST' && path === '/refunds') {
      refundCalls++;
      sim.refundCalls = refundCalls;
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      const idem = String(body['idempotency_key'] ?? '');
      // Idempotent refund dispatch: same key → same refund_ref.
      for (const r of refunds.values()) {
        if (r.idempotency_key === idem && idem) {
          return json(res, 200, { refund_ref: r.refund_ref, state: r.state, deduplicated: true });
        }
      }
      refundSeq++;
      const ref: SimRefund = {
        refund_ref: `simrf_${refundSeq}`,
        order_ref: String(body['order_ref'] ?? ''),
        idempotency_key: idem,
        amount_minor: Number(body['amount_minor'] ?? 0),
        asset: String(body['asset'] ?? 'USD'),
        state: 'pending',
      };
      refunds.set(ref.refund_ref, ref);
      if (faults.refundTimeout) {
        // Record then hang: the client's timeout sees an ambiguous dispatch.
        await new Promise((r2) => setTimeout(r2, 30_000));
        return json(res, 200, { refund_ref: ref.refund_ref, state: ref.state });
      }
      if (faults.refundAmbiguous) {
        // Recorded, then a split failure response.
        return json(res, 500, { error: 'simulated split response' });
      }
      return json(res, 200, { refund_ref: ref.refund_ref, state: ref.state });
    }

    if (req.method === 'GET' && path.startsWith('/refunds/')) {
      const ref = refunds.get(path.slice('/refunds/'.length));
      if (!ref) return json(res, 404, { error: 'unknown refund' });
      return json(res, 200, ref);
    }

    return json(res, 404, { error: 'unknown sim route' });
  });

  await new Promise<void>((resolve) => {
    sim.server.listen(opts.port ?? 0, '127.0.0.1', () => resolve());
  });
  const { port } = sim.server.address() as AddressInfo;
  sim.port = port;
  sim.base = `http://127.0.0.1:${port}`;
  return sim;
}

// Standalone entry: `npm run simulator` — a pilot-local merchant service.
if (import.meta.url === `file://${process.argv[1]}`) {
  const sim = await createMerchantSim({ port: Number(process.env.SIM_PORT ?? 8099) });
  console.log(`[local-emulator] merchant sim on ${sim.base}`);
  sim.setOrder('E7', { revision: 4, status: 'complete' });
}
