import { createHash, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('base64url')}`;
}

/** Opaque bearer/grant token — 32 bytes, unguessable. Never logged. */
export function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacSha256(secret: string, data: string | Uint8Array): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
