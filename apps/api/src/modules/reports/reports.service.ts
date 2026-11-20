import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { reconcileProvider, type ProviderClient } from '@ticketing/platform';
import { PG_POOL, PROVIDER } from '../../infra/tokens.js';
import { financeReport, listJobs, organizerSales, reconciliation, resolvePeriod, restartJob } from './domain/reports.js';

@Injectable()
export class ReportsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(PROVIDER) private readonly provider: ProviderClient,
  ) {}

  async organizer(organizerId: string, from: string | undefined, to: string | undefined, eventId: string | undefined) {
    return organizerSales(this.pool, organizerId, await resolvePeriod(this.pool, from, to), eventId);
  }

  async finance(from: string | undefined, to: string | undefined) {
    return financeReport(this.pool, await resolvePeriod(this.pool, from, to));
  }

  reconcile = () => reconciliation(this.pool);
  async runReconciliation(): Promise<number> {
    return (await reconcileProvider(this.pool, this.provider, { olderThanMs: 60_000, limit: 50 })).length;
  }

  jobs = (status: 'failed' | 'stuck' | 'all') => listJobs(this.pool, status);
  restart = (id: string) => restartJob(this.pool, id);
}
