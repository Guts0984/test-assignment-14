import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import type { Env } from '../../config/env.schema.js';
import { ENV, PG_POOL } from '../../infra/tokens.js';
import { isAssigned, scanStats, scanTicket, scannerEvents } from './domain/scan.js';

@Injectable()
export class ScanningService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(ENV) private readonly env: Env,
  ) {}

  assigned = (eventId: string, userId: string) => isAssigned(this.pool, eventId, userId);
  scan = (eventId: string, scannerId: string, code: string, gate: string) => scanTicket(this.pool, this.env.QR_SIGNING_SECRET, { eventId, scannerId, code, gate });
  stats = (eventId: string) => scanStats(this.pool, eventId);
  events = (userId: string) => scannerEvents(this.pool, userId);
}
