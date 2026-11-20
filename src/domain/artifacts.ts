import { createReadStream, existsSync, mkdirSync, renameSync, writeFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Db } from '../db/db.ts';
import { one } from '../db/db.ts';
import { sha256 } from '../ids.ts';
import { now } from '../clock.ts';
import type { Config } from '../config.ts';

/**
 * Content-addressed artifact storage (TDD: object storage for large evidence,
 * opaque references in the database). Files live at {dir}/{sha256}; the
 * artifacts table records size for observability. Bytes are verified against
 * the declared digest on store and again before redelivery (INV-03).
 */
export function storeArtifact(
  db: Db,
  config: Config,
  bytes: Uint8Array,
): { digest: string; byteLength: number } {
  if (bytes.byteLength > config.maxArtifactBytes) {
    throw new Error(`artifact exceeds ${config.maxArtifactBytes} bytes`);
  }
  const digest = sha256(bytes);
  const dir = config.artifactDir;
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, digest);
  if (!existsSync(target)) {
    const tmp = path.join(dir, `.tmp-${digest}-${process.pid}`);
    writeFileSync(tmp, bytes);
    renameSync(tmp, target);
  }
  db.prepare(
    'INSERT INTO artifacts (digest, byte_length, stored_at) VALUES (?, ?, ?) ON CONFLICT(digest) DO NOTHING',
  ).run(digest, bytes.byteLength, now());
  return { digest, byteLength: bytes.byteLength };
}

export function artifactPath(config: Config, digest: string): string {
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error('invalid artifact digest');
  }
  return path.join(config.artifactDir, digest);
}

export function hasArtifact(config: Config, digest: string): boolean {
  try {
    const p = artifactPath(config, digest);
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Read bytes and verify they still hash to the digest (integrity on read). */
export async function readArtifact(config: Config, digest: string): Promise<Uint8Array> {
  const bytes = new Uint8Array(await readFile(artifactPath(config, digest)));
  if (sha256(bytes) !== digest) {
    throw new Error(`artifact ${digest.slice(0, 12)} failed integrity check on read`);
  }
  return bytes;
}

/** Stream for HTTP responses; caller verified digest beforehand. */
export function artifactStream(config: Config, digest: string) {
  return createReadStream(artifactPath(config, digest));
}

export function artifactMeta(db: Db, digest: string): { digest: string; byte_length: number } | undefined {
  return one<{ digest: string; byte_length: number }>(
    db,
    'SELECT digest, byte_length FROM artifacts WHERE digest = ?',
    digest,
  );
}
