import type { Db } from '../db/db.ts';
import type { Config } from '../config.ts';

/** M05 implements refund dispatch/settlement reconciliation. */
export async function reconcileRefunds(_db: Db, _config: Config): Promise<number> {
  return 0;
}
