import type { Pool } from 'pg';
import { retryDelayMs } from '@ticketing/shared';
import { abortTask, claimTask, completeTask, extendLease, failTask, rescheduleTask, type TaskRow } from './repo.js';

/** Handlers return nothing when finished, or `{ again }` to be run again after that many ms (batch progress). */
export type HandlerResult = void | { readonly again: number };
export type TaskHandler = (task: TaskRow) => Promise<HandlerResult>;

export type RunOutcome = 'done' | 'skipped' | 'retry' | 'failed' | 'again' | 'lost';

export interface RunnerDeps {
  readonly pool: Pool;
  readonly handlers: Readonly<Record<string, TaskHandler>>;
  /** Lease owner label, unique per process. */
  readonly owner: string;
  readonly leaseMs: number;
  /** Called after a retry/again was scheduled in Postgres, so the executor can wake up early. Best effort. */
  readonly wake?: (dedupeKey: string, runAt: Date, delayMs: number) => Promise<void>;
  readonly random?: () => number;
  /** Backoff policy; defaults to the shared exponential backoff. Tests inject a tiny one. */
  readonly retryDelay?: (attempt: number, random: number) => number;
  readonly onError?: (message: string, task: TaskRow) => void;
}

/**
 * Executes one task safely: claim in Postgres (at most one runner at a time), keep the lease alive while the
 * handler runs, then record the result. Duplicate or late executor messages are harmless: the claim fails.
 */
export const createTaskRunner = (deps: RunnerDeps) => {
  const random = deps.random ?? Math.random;

  const run = async (dedupeKey: string): Promise<RunOutcome> => {
    const task = await claimTask(deps.pool, dedupeKey, deps.owner, deps.leaseMs);
    if (!task) return 'skipped';

    const handler = deps.handlers[task.kind];
    if (!handler) {
      await abortTask(deps.pool, task.id, deps.owner, `no handler for task kind "${task.kind}"`);
      deps.onError?.(`no handler for task kind "${task.kind}"`, task);
      return 'failed';
    }

    const heartbeat = setInterval(() => {
      void extendLease(deps.pool, task.id, deps.owner, deps.leaseMs).catch(() => undefined);
    }, Math.max(100, Math.floor(deps.leaseMs / 3)));

    try {
      const result = await handler(task);
      if (result && typeof result === 'object') {
        const ok = await rescheduleTask(deps.pool, task.id, deps.owner, result.again);
        if (ok) await deps.wake?.(task.dedupeKey, new Date(Date.now() + result.again), result.again).catch(() => undefined);
        return ok ? 'again' : 'lost';
      }
      return (await completeTask(deps.pool, task.id, deps.owner)) ? 'done' : 'lost';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.onError?.(message, task);
      const delay = (deps.retryDelay ?? retryDelayMs)(task.attempts, random());
      const outcome = await failTask(deps.pool, task.id, deps.owner, message, delay);
      if (outcome === 'retry') await deps.wake?.(task.dedupeKey, new Date(Date.now() + delay), delay).catch(() => undefined);
      return outcome === 'retry' ? 'retry' : outcome === 'failed' ? 'failed' : 'lost';
    } finally {
      clearInterval(heartbeat);
    }
  };

  return Object.freeze({ run });
};

export type TaskRunner = ReturnType<typeof createTaskRunner>;
