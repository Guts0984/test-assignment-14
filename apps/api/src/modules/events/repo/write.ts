import type { Pool, PoolClient } from 'pg';
import { withTx } from '@ticketing/platform';
import { canTransition, EVENT_TRANSITIONS } from '@ticketing/shared';
import { appError, err, ok, type Result } from '../../../common/result.js';
import { planPricing, type PricingInput, type PricingPlan } from '../domain/pricing-plan.js';

export interface EventDraftInput {
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly startsAt: string;
  readonly salesStartAt: string;
  readonly perPersonLimit: number;
  readonly pricing: PricingInput;
}

interface VenueRow {
  id: string;
  city: string;
  capacity: number;
}

const loadVenueShape = async (tx: PoolClient, venueId: string) => {
  const zones = await tx.query<{ id: string; kind: 'seated' | 'general' }>(`SELECT id, kind FROM zones WHERE venue_id = $1`, [venueId]);
  const seats = await tx.query<{ id: string; zone_id: string }>(`SELECT id, zone_id FROM seats WHERE venue_id = $1`, [venueId]);
  return { zones: zones.rows, seats: seats.rows.map((s) => ({ id: Number(s.id), zoneId: s.zone_id })) };
};

/** (Re)creates tiers, zone rows and one event_seats row per seat for a draft event. */
const checkPricing = async (tx: PoolClient, venueId: string, pricing: PricingInput): Promise<Result<PricingPlan>> =>
  planPricing(pricing, await loadVenueShape(tx, venueId));

const writePricing = async (tx: PoolClient, eventId: string, venueId: string, pricing: PricingInput, plan: { readonly value: PricingPlan }): Promise<void> => {
  await tx.query(`DELETE FROM event_seats WHERE event_id = $1`, [eventId]);
  await tx.query(`DELETE FROM event_zones WHERE event_id = $1`, [eventId]);
  await tx.query(`DELETE FROM price_tiers WHERE event_id = $1`, [eventId]);

  const tierIds: string[] = [];
  for (const [i, tier] of pricing.tiers.entries()) {
    const r = await tx.query<{ id: string }>(`INSERT INTO price_tiers (event_id, name, price, sort) VALUES ($1, $2, $3, $4) RETURNING id`, [eventId, tier.name, tier.price, i]);
    tierIds.push(r.rows[0]?.id ?? '');
  }
  const tierFor = (idx: number | undefined): string | null => (idx === undefined ? null : (tierIds[idx] ?? null));

  const zoneRows = await tx.query<{ id: string; capacity: number }>(`SELECT id, capacity FROM zones WHERE venue_id = $1`, [venueId]);
  for (const z of zoneRows.rows) {
    await tx.query(`INSERT INTO event_zones (event_id, zone_id, tier_id, capacity) VALUES ($1, $2, $3, $4)`, [eventId, z.id, tierFor(plan.value.zoneTier.get(z.id)), z.capacity]);
  }
  const overrideSeats = [...plan.value.seatTier.keys()];
  const overrideTiers = overrideSeats.map((s) => tierFor(plan.value.seatTier.get(s)));
  await tx.query(
    `INSERT INTO event_seats (event_id, seat_id, zone_id, tier_id)
     SELECT $1, s.id, s.zone_id, COALESCE(o.tier_id, ez.tier_id)
     FROM seats s
     JOIN event_zones ez ON ez.event_id = $1 AND ez.zone_id = s.zone_id
     LEFT JOIN unnest($2::bigint[], $3::uuid[]) AS o(seat_id, tier_id) ON o.seat_id = s.id
     WHERE s.venue_id = $4`,
    [eventId, overrideSeats, overrideTiers, venueId],
  );
  await tx.query(
    `UPDATE events SET min_price = (SELECT MIN(price) FROM price_tiers WHERE event_id = $1), max_price = (SELECT MAX(price) FROM price_tiers WHERE event_id = $1) WHERE id = $1`,
    [eventId],
  );
};

const validDates = (startsAt: string, salesStartAt: string): Result<true> => {
  const starts = Date.parse(startsAt);
  const sales = Date.parse(salesStartAt);
  if (Number.isNaN(starts) || Number.isNaN(sales)) return err(appError('VALIDATION_FAILED', 'invalid date'));
  if (sales > starts) return err(appError('VALIDATION_FAILED', 'sales must start before the event', { field: 'salesStartAt' }));
  return ok(true);
};

export const createEvent = async (pool: Pool, organizerId: string, venueId: string, input: EventDraftInput): Promise<Result<{ readonly id: string }>> => {
  const dates = validDates(input.startsAt, input.salesStartAt);
  if (!dates.ok) return dates;
  return withTx(pool, async (tx) => {
    const venue = (await tx.query<VenueRow>(`SELECT id, city, capacity FROM venues WHERE id = $1 AND organizer_id = $2`, [venueId, organizerId])).rows[0];
    if (!venue) return err(appError('NOT_FOUND', 'Venue not found'));
    const plan = await checkPricing(tx, venueId, input.pricing);
    if (!plan.ok) return plan;
    const created = await tx.query<{ id: string }>(
      `INSERT INTO events (organizer_id, venue_id, title, description, city, category, starts_at, sales_start_at, per_person_limit, capacity)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9, $10) RETURNING id`,
      [organizerId, venueId, input.title, input.description, venue.city, input.category, input.startsAt, input.salesStartAt, input.perPersonLimit, venue.capacity],
    );
    const id = created.rows[0]?.id ?? '';
    await writePricing(tx, id, venueId, input.pricing, plan);
    return ok({ id });
  });
};

export interface EventPatch {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly category?: string | undefined;
  readonly startsAt?: string | undefined;
  readonly salesStartAt?: string | undefined;
  readonly perPersonLimit?: number | undefined;
  readonly pricing?: PricingInput | undefined;
}

/** Drafts can be edited freely; once published only the per-person limit and description can change. */
export const updateEvent = async (pool: Pool, organizerId: string, eventId: string, patch: EventPatch): Promise<Result<true>> =>
  withTx(pool, async (tx) => {
    const ev = (await tx.query<{ status: string; venue_id: string; starts_at: Date; sales_start_at: Date }>(
      `SELECT status, venue_id, starts_at, sales_start_at FROM events WHERE id = $1 AND organizer_id = $2 FOR UPDATE`,
      [eventId, organizerId],
    )).rows[0];
    if (!ev) return err(appError('NOT_FOUND', 'Event not found'));
    const isDraft = ev.status === 'draft';
    const structural = patch.title !== undefined || patch.category !== undefined || patch.startsAt !== undefined || patch.salesStartAt !== undefined || patch.pricing !== undefined;
    if (!isDraft && structural) return err(appError('CONFLICT', 'Only the description and the per-person limit can change after publication'));
    if (!isDraft && !['on_sale', 'sold_out', 'rescheduled'].includes(ev.status)) return err(appError('CONFLICT', 'Event can no longer be edited'));
    const startsAt = patch.startsAt ?? ev.starts_at.toISOString();
    const salesStartAt = patch.salesStartAt ?? ev.sales_start_at.toISOString();
    const dates = validDates(startsAt, salesStartAt);
    if (!dates.ok) return dates;
    const plan = patch.pricing ? await checkPricing(tx, ev.venue_id, patch.pricing) : null;
    if (plan && !plan.ok) return plan;
    await tx.query(
      `UPDATE events SET title = COALESCE($2, title), description = COALESCE($3, description), category = COALESCE($4, category),
                         starts_at = $5::timestamptz, sales_start_at = $6::timestamptz, per_person_limit = COALESCE($7, per_person_limit) WHERE id = $1`,
      [eventId, patch.title ?? null, patch.description ?? null, patch.category ?? null, startsAt, salesStartAt, patch.perPersonLimit ?? null],
    );
    if (patch.pricing && plan?.ok) await writePricing(tx, eventId, ev.venue_id, patch.pricing, plan);
    return ok(true);
  });

export const publishEvent = async (pool: Pool, organizerId: string, eventId: string): Promise<Result<true>> =>
  withTx(pool, async (tx) => {
    const ev = (await tx.query<{ status: 'draft'; starts_at: Date }>(`SELECT status, starts_at FROM events WHERE id = $1 AND organizer_id = $2 FOR UPDATE`, [eventId, organizerId])).rows[0];
    if (!ev) return err(appError('NOT_FOUND', 'Event not found'));
    if (!canTransition(EVENT_TRANSITIONS, ev.status, 'on_sale', 'organizer')) return err(appError('CONFLICT', `An event in status "${ev.status}" cannot be published`));
    if (ev.starts_at.getTime() <= Date.now()) return err(appError('UNPROCESSABLE', 'The event date is in the past'));
    const unpriced = await tx.query(`SELECT 1 FROM event_seats WHERE event_id = $1 AND tier_id IS NULL LIMIT 1`, [eventId]);
    const noZones = await tx.query(`SELECT 1 FROM event_zones WHERE event_id = $1 AND tier_id IS NULL AND NOT EXISTS (SELECT 1 FROM event_seats s WHERE s.event_id = $1 AND s.zone_id = event_zones.zone_id) LIMIT 1`, [eventId]);
    if (unpriced.rowCount === 1 || noZones.rowCount === 1) return err(appError('UNPROCESSABLE', 'Every seat and zone needs a price before publishing'));
    await tx.query(`UPDATE events SET status = 'on_sale' WHERE id = $1`, [eventId]);
    return ok(true);
  });

/** Blocks (or releases) seats that are not for sale. Only free seats can be blocked, only blocked ones unblocked. */
export const setBlocked = async (pool: Pool, organizerId: string, eventId: string, seatIds: readonly number[], blocked: boolean): Promise<Result<{ readonly changed: number }>> =>
  withTx(pool, async (tx) => {
    const ev = (await tx.query<{ status: string }>(`SELECT status FROM events WHERE id = $1 AND organizer_id = $2 FOR UPDATE`, [eventId, organizerId])).rows[0];
    if (!ev) return err(appError('NOT_FOUND', 'Event not found'));
    if (!['draft', 'on_sale', 'sold_out', 'rescheduled'].includes(ev.status)) return err(appError('CONFLICT', 'Seats of this event can no longer be changed'));
    const ids = [...new Set(seatIds)].sort((a, b) => a - b);
    await tx.query(`SELECT 1 FROM event_seats WHERE event_id = $1 AND seat_id = ANY($2::bigint[]) ORDER BY seat_id FOR UPDATE`, [eventId, ids]);
    const from = blocked ? `(status = 'free' OR (status = 'held' AND hold_expires_at <= app_now()))` : `status = 'blocked'`;
    const res = await tx.query<{ seat_id: string }>(
      `UPDATE event_seats SET status = $3::seat_status, hold_order_id = NULL, hold_expires_at = NULL
       WHERE event_id = $1 AND seat_id = ANY($2::bigint[]) AND ${from} RETURNING seat_id`,
      [eventId, ids, blocked ? 'blocked' : 'free'],
    );
    if (res.rowCount !== ids.length) return err(appError('CONFLICT', blocked ? 'Only free seats can be blocked' : 'Only blocked seats can be released', { requested: ids.length, changed: res.rowCount ?? 0 }));
    await tx.query(`UPDATE events SET blocked_count = (SELECT COUNT(*) FROM event_seats WHERE event_id = $1 AND status = 'blocked') WHERE id = $1`, [eventId]);
    await tx.query(`SELECT emit_seat_events($1, $2::bigint[], $3, NULL)`, [eventId, res.rows.map((r) => Number(r.seat_id)).sort((a, b) => a - b), blocked ? 'blocked' : 'free']);
    return ok({ changed: res.rowCount });
  });
