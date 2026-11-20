import type { Db } from '../db/db.ts';
import type { Config } from '../config.ts';

/** M03 implements the merchant status adapter + revision tracking. */
export async function pollMerchantStatuses(_db: Db, _config: Config): Promise<number> {
  return 0;
}
