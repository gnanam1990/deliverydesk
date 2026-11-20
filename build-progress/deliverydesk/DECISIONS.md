# Decision record

Record the decision date, owner, exact affected module, alternatives, chosen behavior, dependency proof, affected tests, and conditions that would reopen the decision.

---

## D-001 · SQLite in place of proposed PostgreSQL — 2026-11-20 · this session · affects all modules

- Alternatives: (a) PostgreSQL per TDD proposed baseline — rejected: no server is running in this environment and an external DB daemon would break clean-checkout reproduction; (b) `better-sqlite3` — rejected: requires native build; (c) `node:sqlite` (Node 22 built-in `DatabaseSync`) — chosen.
- Chosen behavior: embedded SQLite via `node:sqlite`, WAL mode, `BEGIN IMMEDIATE` write transactions serialize per-order exclusion claims; partial unique indexes enforce "one active case/retrieval per order" invariants at the storage layer.
- Dependency proof: `node -e "require('node:sqlite')"` → `DatabaseSync` present on Node v22.23.1; `pg_isready` → no response at /tmp:5432 (no Postgres).
- Affected tests: none — migration + repository layer keeps the choice behind `src/db/`.
- Reopen condition: deployment against managed Postgres, or `node:sqlite` API drift on Node ≥ 24.

## D-002 · External integrations emulated at a local boundary — 2026-11-20 · this session · affects M02, M03, M05, M07

- Live payment rail / Kite Passport settlement, merchant status API and refund provider are unavailable inside this run (paid/external calls excluded by the operator's instructions; KITE-AND-PROVIDERS.md requires owner authority for paid verification — none granted here).
- Chosen behavior: adapters (`src/adapters/`) define narrow interfaces and talk only to configured, allowlisted hosts; a deterministic local emulator (`src/simulator/`) stands in for merchant export service and refund provider, explicitly labeled `local-emulator`. Every external outcome is distinguishable from live outcomes in evidence.
- Dependency proof: no live credentials, no reachable provider endpoint, no owner payment authority in this run.
- Affected tests: T-003/004, T-009/010, T-013/014 qualify their results `environment=local-emulator`.
- Reopen condition: owner grants authority + credentials for a provider sandbox; then run the same adapter contract against it and re-record evidence.
