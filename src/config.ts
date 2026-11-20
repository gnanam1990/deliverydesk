import path from 'node:path';

export type Config = {
  /** HTTP port for the app server. */
  port: number;
  /** SQLite database file. Use ':memory:' only in tests. */
  dbPath: string;
  /** Directory for content-addressed artifact storage. */
  artifactDir: string;
  /** Access grant time-to-live in milliseconds. */
  grantTtlMs: number;
  /** Worker poll interval in milliseconds. */
  workerPollMs: number;
  /** Allowed outbound hosts for merchant/refund adapters (host:port). */
  allowedOutboundHosts: string[];
  /** Max bytes accepted for inbound JSON bodies and stored artifacts. */
  maxBodyBytes: number;
  maxArtifactBytes: number;
  /** Signature freshness window for connector callbacks, ms. */
  callbackSkewMs: number;
};

const dataDir = process.env.DD_DATA_DIR ?? path.resolve(process.cwd(), 'data');

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const allowed = (process.env.DD_ALLOWED_HOSTS ?? '127.0.0.1,localhost')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    port: Number(process.env.DD_PORT ?? 8080),
    dbPath: process.env.DD_DB ?? path.join(dataDir, 'deliverydesk.sqlite'),
    artifactDir: process.env.DD_ARTIFACT_DIR ?? path.join(dataDir, 'artifacts'),
    grantTtlMs: Number(process.env.DD_GRANT_TTL_MS ?? 15 * 60 * 1000),
    workerPollMs: Number(process.env.DD_WORKER_POLL_MS ?? 2000),
    allowedOutboundHosts: allowed,
    maxBodyBytes: Number(process.env.DD_MAX_BODY_BYTES ?? 1_048_576),
    maxArtifactBytes: Number(process.env.DD_MAX_ARTIFACT_BYTES ?? 32 * 1024 * 1024),
    callbackSkewMs: Number(process.env.DD_CALLBACK_SKEW_MS ?? 5 * 60 * 1000),
    ...overrides,
  };
}

/** Restrict outbound adapter targets to configured schemes and hosts (SECURITY.md). */
export function assertAllowedOutbound(cfg: Config, target: string): URL {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new Error(`adapter target is not a URL: ${target}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`adapter target scheme not allowed: ${url.protocol}`);
  }
  const hostPort = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  const ok = cfg.allowedOutboundHosts.some(
    (h) => h === url.hostname || h === hostPort,
  );
  if (!ok) {
    throw new Error(`adapter target host not allowed: ${hostPort}`);
  }
  return url;
}
