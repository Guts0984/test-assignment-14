import type { Pool } from 'pg';
import { failExhausted, listDueTasks } from './repo.js';

export interface RehydrateDeps {
  readonly pool: Pool;
  readonly enqueue: (dedupeKey: string, runAt: Date, delayMs: number) => Promise<void>;
  /** Tasks due within this horizon are put into the executor (delayed jobs). */
  readonly horizonMs: number;
  readonly batchSize?: number;
}

/**
 * Rebuilds the executor's view from Postgres: everything pending or abandoned goes back into BullMQ.
 * Safe to run any number of times and from any number of workers (jobs are deduplicated, claims are exclusive).
 */
export const rehydrate = async (deps: RehydrateDeps): Promise<number> => {
  await failExhausted(deps.pool);
  const due = await listDueTasks(deps.pool, deps.horizonMs, deps.batchSize ?? 1_000);
  for (const task of due) await deps.enqueue(task.dedupeKey, task.runAt, task.delayMs);
  return due.length;
};

export interface RehydratorOptions extends RehydrateDeps {
  readonly intervalMs: number;
  readonly onError?: (error: unknown) => void;
}

/** Runs `rehydrate` now and then every `intervalMs`. Returns a stop function. */
export const startRehydrator = (options: RehydratorOptions): (() => void) => {
  let stopped = false;
  let running = false;
  const tick = (): void => {
    if (stopped || running) return;
    running = true;
    rehydrate(options)
      .catch((error: unknown) => options.onError?.(error))
      .finally(() => {
        running = false;
      });
  };
  tick();
  const timer = setInterval(tick, options.intervalMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
};
