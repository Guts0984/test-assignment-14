import type { Pool } from 'pg';
import type { Limiter, ProviderClient, RealtimePublisher, TaskRow, VirtualQueue } from '@ticketing/platform';
import type { Mailer } from '../email/mailer.js';

export interface HandlerDeps {
  readonly pool: Pool;
  readonly provider: ProviderClient;
  readonly limiter: Limiter;
  readonly rt: RealtimePublisher;
  readonly mailer: Mailer;
  readonly queue: VirtualQueue;
  readonly qrSecret: string;
  readonly publicUrl: string;
  readonly refundRps: number;
}

export const payloadString = (task: TaskRow, key: string): string => {
  const v = task.payload[key];
  if (typeof v !== 'string') throw new Error(`task ${task.dedupeKey} is missing "${key}"`);
  return v;
};
