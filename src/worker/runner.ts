import type { Db } from '../db/db.ts';
import type { Config } from '../config.ts';
import { drainOutbox } from '../domain/outbox.ts';
import { pollMerchantStatuses } from '../domain/fulfillments.ts';
import { reconcileRefunds } from '../domain/refunds.ts';
import { reconcileInbox } from '../domain/reconcile.ts';

export interface WorkerOptions {
  intervalMs?: number;
  /** Run one tick synchronously then return (tests, demo). */
  once?: boolean;
}

/**
 * Supervised background worker. Each tick: dispatch outbox side effects,
 * poll merchant status where webhook delivery is absent, reconcile ambiguous
 * refunds, and re-drive any unprocessed inbox events. Every step is durable —
 * a process restart mid-tick loses nothing already committed.
 */
export async function workerTick(db: Db, config: Config): Promise<Record<string, number>> {
  const outbox = await drainOutbox(db, config);
  const polled = await pollMerchantStatuses(db, config);
  const refunds = await reconcileRefunds(db, config);
  const inbox = reconcileInbox({ db, config });
  return { outbox, polled, refunds, inbox };
}

export function startWorker(
  db: Db,
  config: Config,
  opts: WorkerOptions = {},
): () => void {
  const intervalMs = opts.intervalMs ?? 2000;
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await workerTick(db, config);
    } catch (e) {
      console.error(`[worker] tick error: ${(e as Error).message}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
