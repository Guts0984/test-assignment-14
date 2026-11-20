import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../../infra/tokens.js';
import { appError, err, ok, type Result } from '../../common/result.js';

export interface PromoView {
  readonly id: string;
  readonly code: string;
  readonly kind: 'percent' | 'fixed';
  readonly value: number;
  readonly usageLimit: number;
  readonly usedCount: number;
  readonly eventId: string | null;
}

interface PromoRow {
  id: string;
  code: string;
  kind: 'percent' | 'fixed';
  value: number;
  usage_limit: number;
  used_count: number;
  event_id: string | null;
}

const toView = (r: PromoRow): PromoView => ({ id: r.id, code: r.code, kind: r.kind, value: r.value, usageLimit: r.usage_limit, usedCount: r.used_count, eventId: r.event_id });

@Injectable()
export class PromosService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async create(organizerId: string, input: { code: string; kind: 'percent' | 'fixed'; value: number; usageLimit: number; eventId: string | null }): Promise<Result<PromoView>> {
    if (input.eventId) {
      const own = await this.pool.query(`SELECT 1 FROM events WHERE id = $1 AND organizer_id = $2`, [input.eventId, organizerId]);
      if (own.rowCount === 0) return err(appError('NOT_FOUND', 'Event not found'));
    }
    const res = await this.pool.query<PromoRow>(
      `INSERT INTO promo_codes (organizer_id, event_id, code, kind, value, usage_limit) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (code) DO NOTHING RETURNING *`,
      [organizerId, input.eventId, input.code, input.kind, input.value, input.usageLimit],
    );
    const row = res.rows[0];
    return row ? ok(toView(row)) : err(appError('CONFLICT', 'A promo code with this name already exists'));
  }

  async list(organizerId: string): Promise<readonly PromoView[]> {
    const res = await this.pool.query<PromoRow>(`SELECT * FROM promo_codes WHERE organizer_id = $1 ORDER BY created_at DESC LIMIT 500`, [organizerId]);
    return res.rows.map(toView);
  }
}
