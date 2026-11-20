import type { DatabaseSync } from 'node:sqlite';

/**
 * Versioned migrations. Migration N is applied when PRAGMA user_version < N.
 * 001 carries the greenfield domain schema (see TDD.md "Domain schema").
 */
export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: '001_initial_domain',
    sql: `
CREATE TABLE merchants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  connector_kind TEXT NOT NULL,
  callback_secret TEXT NOT NULL,
  status_base_url TEXT,
  refund_base_url TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE buyers (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  external_ref TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (merchant_id, external_ref)
);

CREATE TABLE operators (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  name TEXT NOT NULL,
  roles TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  buyer_id TEXT NOT NULL REFERENCES buyers(id),
  external_order_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  asset TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  invoice_ref TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  UNIQUE (merchant_id, external_order_id)
);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  order_id TEXT REFERENCES orders(id),
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  rail TEXT NOT NULL,
  transfer_ref TEXT NOT NULL,
  event_index INTEGER NOT NULL DEFAULT 0,
  amount_minor INTEGER NOT NULL,
  asset TEXT NOT NULL,
  invoice_ref TEXT NOT NULL,
  receipt_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  quarantine_reason TEXT,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  UNIQUE (rail, transfer_ref, event_index)
);

CREATE TABLE fulfillments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  revision INTEGER NOT NULL,
  state TEXT NOT NULL,
  reported_status TEXT NOT NULL,
  artifact_digest TEXT,
  artifact_ref TEXT,
  evidence_note TEXT,
  source_event_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (order_id, revision)
);

CREATE TABLE artifacts (
  digest TEXT PRIMARY KEY,
  byte_length INTEGER NOT NULL,
  stored_at TEXT NOT NULL
);

CREATE TABLE cases (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  buyer_id TEXT NOT NULL REFERENCES buyers(id),
  reason TEXT NOT NULL,
  state TEXT NOT NULL,
  disposition TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  owner_operator_id TEXT REFERENCES operators(id),
  opened_by TEXT NOT NULL,
  evidence_note TEXT,
  created_at TEXT NOT NULL,
  closed_at TEXT
);
-- One active (non-terminal) case per order.
CREATE UNIQUE INDEX cases_active_order ON cases (order_id)
  WHERE state NOT IN ('delivered', 'refunded', 'closed');

CREATE TABLE case_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL REFERENCES cases(id),
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX case_events_case ON case_events (case_id, seq);

CREATE TABLE access_grants (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  subject_id TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX access_grants_case ON access_grants (case_id);
CREATE INDEX access_grants_order ON access_grants (order_id);

CREATE TABLE retrievals (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  grant_id TEXT NOT NULL REFERENCES access_grants(id),
  buyer_id TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  state TEXT NOT NULL,
  bytes_transferred INTEGER NOT NULL DEFAULT 0,
  client_digest TEXT,
  started_at TEXT NOT NULL,
  stream_finished_at TEXT,
  completed_at TEXT
);
-- At most one non-terminal (pending/ambiguous) retrieval per order.
CREATE UNIQUE INDEX retrievals_active_order ON retrievals (order_id)
  WHERE state IN ('claimed', 'streaming', 'awaiting_receipt', 'interrupted');

CREATE TABLE refunds (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  case_id TEXT NOT NULL REFERENCES cases(id),
  amount_minor INTEGER NOT NULL,
  asset TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL,
  settlement_ref TEXT,
  proposed_by TEXT NOT NULL,
  approved_by TEXT,
  decline_reason TEXT,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  dispatched_at TEXT,
  settled_at TEXT
);

CREATE TABLE inbox_events (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  event_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  result TEXT,
  UNIQUE (merchant_id, event_id)
);

CREATE TABLE outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE review_items (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  order_id TEXT REFERENCES orders(id),
  case_id TEXT REFERENCES cases(id),
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT
);

CREATE TABLE idempotency_keys (
  key TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  response TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (key, actor_key, endpoint)
);

CREATE INDEX orders_merchant ON orders (merchant_id);
CREATE INDEX orders_buyer ON orders (buyer_id);
CREATE INDEX payments_order ON payments (order_id);
CREATE INDEX fulfillments_order ON fulfillments (order_id);
CREATE INDEX inbox_pending ON inbox_events (merchant_id) WHERE processed_at IS NULL;
CREATE INDEX outbox_pending ON outbox (state, next_attempt_at);
`,
  },
];

export function currentVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}

export function migrate(db: DatabaseSync): number[] {
  const applied: number[] = [];
  const v = currentVersion(db);
  for (const m of MIGRATIONS) {
    if (m.version > v) {
      db.exec('BEGIN');
      try {
        db.exec(m.sql);
        db.exec(`PRAGMA user_version = ${m.version}`);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      applied.push(m.version);
    }
  }
  return applied;
}
