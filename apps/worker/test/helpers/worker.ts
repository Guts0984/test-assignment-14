import { hostReachableRedisUrl, hostReachableUrl, type TestDb } from '@ticketing/testkit';
import { startWorker, type RunningWorker, type WorkerConfig } from '../../src/start-worker.js';

export interface TestWorkerOptions {
  readonly db: TestDb;
  readonly providerUrl: string;
  readonly smtpPort?: number;
  readonly prefix: string;
  readonly id: string;
  readonly refundRps?: number;
  readonly tuning?: WorkerConfig['tuning'];
  readonly queueMaxSelecting?: number;
}

export const startTestWorker = (o: TestWorkerOptions): RunningWorker =>
  startWorker({
    databaseUrl: hostReachableUrl(o.db.url),
    dbPoolMax: 6,
    redisUrl: hostReachableRedisUrl(process.env['REDIS_URL'] ?? 'redis://localhost:6379'),
    redisPrefix: o.prefix,
    qrSecret: process.env['QR_SIGNING_SECRET'] ?? 'x'.repeat(40),
    publicUrl: 'http://localhost:8080',
    providerUrl: o.providerUrl,
    providerApiKey: process.env['STUB_API_KEY'] ?? 'x'.repeat(40),
    smtp: { host: '127.0.0.1', port: o.smtpPort ?? 1, from: 'tickets@example.test' },
    instanceId: o.id,
    concurrency: 5,
    refundRps: o.refundRps ?? 15,
    rehydrateIntervalMs: 500,
    reconcileIntervalMs: 3_600_000,
    queueActivateAt: 500,
    queueMaxSelecting: o.queueMaxSelecting ?? 200,
    tuning: { leaseMs: 3_000, lockDurationMs: 3_000, stalledIntervalMs: 1_000, retryDelay: () => 150, admissionMs: 200, sweepMs: 500, ...o.tuning },
  });
