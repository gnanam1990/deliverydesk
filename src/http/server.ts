import http from 'node:http';
import type { Db } from '../db/db.ts';
import type { Config } from '../config.ts';
import { HttpError } from '../domain/errors.ts';
import type { Actor, Merchant } from '../domain/types.ts';
import { getMerchant } from '../domain/merchants.ts';
import { authenticateBuyer, authenticateOperator, parseSignatureHeader, verifyConnectorSignature } from '../domain/auth.ts';
import { Router } from './router.ts';
import { notFound as nf, unauthorized } from '../domain/errors.ts';

export interface HandlerResult {
  status: number;
  json?: unknown;
  headers?: Record<string, string>;
  /** Raw byte body (artifact streams). */
  bytes?: Uint8Array | AsyncIterable<Uint8Array>;
  contentType?: string;
  /** Called after streaming: complete=false on client abort/mid-stream error. */
  onStreamEnd?: (complete: boolean, bytesWritten: number) => void;
}

export interface Ctx {
  db: Db;
  config: Config;
  params: Record<string, string>;
  query: URLSearchParams;
  rawBody: string;
  body: unknown;
  headers: http.IncomingHttpHeaders;
  actor: Actor | null;
  connectorMerchant: Merchant | null;
  idempotencyKey: string | undefined;
  req: http.IncomingMessage;
}

type AuthMode =
  | { kind: 'none' }
  | { kind: 'buyer' }
  | { kind: 'operator'; role?: string }
  | { kind: 'connector'; merchantParam: string };

export interface RouteDef {
  auth: AuthMode;
  handler: (ctx: Ctx) => Promise<HandlerResult> | HandlerResult;
}

function bearerFrom(req: http.IncomingMessage): string | null {
  const h = req.headers['authorization'];
  if (h?.startsWith('Bearer ')) return h.slice(7).trim();
  const cookie = req.headers['cookie'];
  if (cookie) {
    for (const part of cookie.split(';')) {
      const [k, v] = part.split('=').map((s) => s.trim());
      if (k === 'dd_actor' && v) return decodeURIComponent(v);
    }
  }
  return null;
}

/** Strip an optional `buyer:`/`operator:` kind prefix from a credential. */
function bareToken(t: string): string {
  for (const p of ['buyer:', 'operator:']) {
    if (t.startsWith(p)) return t.slice(p.length);
  }
  return t;
}

export class App {
  readonly router = new Router<RouteDef>();
  readonly db: Db;
  readonly config: Config;

  constructor(db: Db, config: Config) {
    this.db = db;
    this.config = config;
  }

  route(method: string, pattern: string, def: RouteDef): void {
    this.router.add(method, pattern, def);
  }

  private resolveAuth(req: http.IncomingMessage, def: RouteDef, params: Record<string, string>): { actor: Actor | null; merchant: Merchant | null } {
    const mode = def.auth;
    if (mode.kind === 'none') return { actor: null, merchant: null };
    if (mode.kind === 'connector') {
      const merchant = getMerchant(this.db, params[mode.merchantParam]!);
      return { actor: { kind: 'connector', id: `connector:${merchant.id}`, merchantId: merchant.id }, merchant };
    }
    const token = bearerFrom(req);
    if (!token) throw unauthorized();
    const bare = bareToken(token);
    if (mode.kind === 'buyer') {
      return { actor: authenticateBuyer(this.db, bare).actor, merchant: null };
    }
    return { actor: authenticateOperator(this.db, bare, mode.role).actor, merchant: null };
  }

  server(): http.Server {
    return http.createServer(async (req, res) => {
      try {
        await this.handle(req, res);
      } catch (e) {
        this.writeError(res, e);
      }
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const found = this.router.match(req.method ?? 'GET', url.pathname);
    if (!found) throw nf();
    if (!found.value) throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    const def = found.value;

    const rawBody = await this.readBody(req);
    let body: unknown = null;
    if (rawBody && (req.headers['content-type'] ?? '').includes('json')) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        throw new HttpError(400, 'bad_json', 'request body is not valid JSON');
      }
    }

    const { actor, merchant } = this.resolveAuth(req, def, found.match.params);

    // Connector callbacks: verify signature over the raw body BEFORE touching
    // domain state (T-002: forged callback fails before any case change).
    if (def.auth.kind === 'connector') {
      const sig = parseSignatureHeader(req.headers['x-deliverydesk-signature'] as string | undefined);
      const ok = verifyConnectorSignature(
        merchant!,
        rawBody,
        sig,
        this.config.callbackSkewMs,
        Date.now(),
      );
      if (!ok) throw unauthorized('callback signature verification failed');
    }

    const ctx: Ctx = {
      db: this.db,
      config: this.config,
      params: found.match.params,
      query: url.searchParams,
      rawBody,
      body,
      headers: req.headers,
      actor,
      connectorMerchant: merchant,
      idempotencyKey: (req.headers['idempotency-key'] as string | undefined) ?? undefined,
      req,
    };

    const result = await def.handler(ctx);
    await this.writeResult(res, result);
  }

  private async readBody(req: http.IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > this.config.maxBodyBytes) {
        throw new HttpError(413, 'body_too_large', 'request body exceeds limit');
      }
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private async writeResult(res: http.ServerResponse, r: HandlerResult): Promise<void> {
    const headers: Record<string, string> = { ...(r.headers ?? {}) };
    if (r.bytes !== undefined) {
      headers['content-type'] = r.contentType ?? 'application/octet-stream';
      res.writeHead(r.status, headers);
      if (r.bytes instanceof Uint8Array) {
        res.end(r.bytes);
        r.onStreamEnd?.(true, r.bytes.byteLength);
        return;
      }
      let written = 0;
      let settled = false;
      res.on('close', () => {
        if (!settled) {
          settled = true;
          r.onStreamEnd?.(false, written);
        }
      });
      try {
        for await (const chunk of r.bytes) {
          if (res.destroyed || !res.writable) break;
          res.write(chunk);
          written += chunk.length;
          // Let pending socket events (client abort) land between chunks.
          await new Promise((res2) => setImmediate(res2));
        }
        if (settled) return;
        settled = true;
        if (!res.destroyed) {
          res.end();
          r.onStreamEnd?.(true, written);
        } else {
          r.onStreamEnd?.(false, written);
        }
      } catch {
        if (!settled) {
          settled = true;
          try {
            res.end();
          } catch {
            /* socket gone */
          }
          r.onStreamEnd?.(false, written);
        }
      }
      return;
    }
    headers['content-type'] = 'application/json; charset=utf-8';
    res.writeHead(r.status, headers);
    res.end(JSON.stringify({ ok: true, data: r.json ?? null }));
  }

  private writeError(res: http.ServerResponse, e: unknown): void {
    const err =
      e instanceof HttpError
        ? e
        : new HttpError(500, 'internal', (e as Error)?.message ?? 'internal error');
    if (!(e instanceof HttpError)) {
      // Never leak internals beyond the message; log server-side without secrets.
      console.error(`[deliverydesk] unhandled error: ${(e as Error)?.stack ?? e}`);
    }
    res.writeHead(err.status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        ok: false,
        error: { code: err.code, message: err.message, details: err.details ?? null },
      }),
    );
  }
}
