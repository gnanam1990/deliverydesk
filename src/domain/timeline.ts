import type { Db } from '../db/db.ts';
import { all } from '../db/db.ts';
import { now } from '../clock.ts';
import type { ActorKind, CaseEvent } from './types.ts';

/**
 * Append-only case timeline (INV-06: closure discloses its evidence). Never
 * stores bearer tokens or secrets — callers pass redacted detail objects.
 */
export function appendCaseEvent(
  db: Db,
  caseId: string,
  actorKind: ActorKind,
  actorId: string,
  kind: string,
  detail: Record<string, unknown> = {},
): void {
  db.prepare(
    `INSERT INTO case_events (case_id, actor_kind, actor_id, kind, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(caseId, actorKind, actorId, kind, JSON.stringify(detail), now());
}

export function caseTimeline(db: Db, caseId: string): CaseEvent[] {
  return all<CaseEvent>(
    db,
    'SELECT * FROM case_events WHERE case_id = ? ORDER BY seq',
    caseId,
  );
}
