import { createHash } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { TaskRunner } from './runner.js';

export const TASK_QUEUE_NAME = 'tasks';

interface JobData {
  readonly key: string;
}

/** Job ids contain the due time, so a retry of the same task is a new job; the same (task, due time) is deduplicated. */
const jobIdFor = (dedupeKey: string, runAt: Date): string =>
  `${createHash('sha1').update(dedupeKey).digest('hex')}-${runAt.getTime()}`;

export interface TaskQueueOptions {
  readonly connection: Redis;
  readonly prefix?: string;
}

/**
 * Producer side: BullMQ is only the executor. Every call is a hint; the truth (what must run, when) is the
 * `tasks` table, and the rehydrator re-enqueues whatever Redis forgot.
 */
export const createTaskQueue = (options: TaskQueueOptions) => {
  const queue = new Queue<JobData>(TASK_QUEUE_NAME, { connection: options.connection, prefix: options.prefix });

  const enqueue = async (dedupeKey: string, runAt: Date, delayMs: number): Promise<void> => {
    const id = jobIdFor(dedupeKey, runAt);
    await queue.add('run', { key: dedupeKey }, { jobId: id, delay: Math.max(0, delayMs), removeOnComplete: true, removeOnFail: true, attempts: 1 });
    if (delayMs <= 0) {
      // The job may already exist as a delayed job (the clock moved): make it runnable now.
      const job = await queue.getJob(id);
      if (job && (await job.isDelayed())) await job.promote().catch(() => undefined);
    }
  };

  return Object.freeze({ enqueue, close: () => queue.close() });
};

export type TaskQueue = ReturnType<typeof createTaskQueue>;

export interface TaskWorkerOptions {
  readonly connection: Redis;
  readonly prefix?: string;
  readonly runner: TaskRunner;
  readonly concurrency: number;
  /** How long a job may be silent before another worker takes it over (kill -9 recovery). */
  readonly lockDurationMs?: number;
  readonly stalledIntervalMs?: number;
}

/** Consumer side: for each job message, ask the runner to claim and execute the task. */
export const createTaskWorker = (options: TaskWorkerOptions) => {
  const worker = new Worker<JobData>(TASK_QUEUE_NAME, async (job) => options.runner.run(job.data.key), {
    connection: options.connection,
    prefix: options.prefix,
    concurrency: options.concurrency,
    lockDuration: options.lockDurationMs ?? 30_000,
    stalledInterval: options.stalledIntervalMs ?? 30_000,
    maxStalledCount: 1_000,
  });
  return Object.freeze({ worker, close: () => worker.close() });
};
