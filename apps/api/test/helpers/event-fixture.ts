import type { Pool } from 'pg';
import type { Client } from '../attacker/index.js';
import type { TestUser } from './session.js';

export const idem = (): string => `k-${crypto.randomUUID()}`;

export interface HallSpec {
  readonly seats: number;
  readonly floor?: number;
}

export interface ApiEvent {
  readonly eventId: string;
  readonly venueId: string;
  readonly seatIds: readonly number[];
  readonly floorZoneId: string | null;
  readonly seatedZoneId: string;
}

const layoutOf = (spec: HallSpec) => ({
  name: 'Test hall',
  city: 'Kyiv',
  zones: [
    { id: 'A', name: 'Stalls', kind: 'seated', rows: Array.from({ length: Math.ceil(spec.seats / 10) }, (_, r) => ({ label: String(r + 1), seats: Array.from({ length: Math.min(10, spec.seats - r * 10) }, (_, n) => ({ number: n + 1, x: n * 10, y: r * 10 })) })) },
    ...(spec.floor ? [{ id: 'F', name: 'Floor', kind: 'general', capacity: spec.floor }] : []),
  ],
});

/** Creates a hall and a published, on-sale event entirely through the public API (what an organizer would do). */
export const createOnSaleEvent = async (api: Client, pool: Pool, organizer: TestUser, spec: HallSpec, over: { perPersonLimit?: number; price?: number } = {}): Promise<ApiEvent> => {
  const venue = await api.post('/api/venues', layoutOf(spec), { token: organizer.token });
  if (venue.status !== 201) throw new Error(`venue upload failed: ${venue.text}`);
  const venueJson = venue.json as { id: string; zones: { id: string; key: string; kind: string }[] };
  const seated = venueJson.zones.find((z) => z.key === 'A');
  const floor = venueJson.zones.find((z) => z.key === 'F');
  if (!seated) throw new Error('no seated zone');
  const soon = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const created = await api.post(
    '/api/organizer/events',
    {
      venueId: venueJson.id,
      title: `Concert ${crypto.randomUUID().slice(0, 8)}`,
      category: 'rock',
      startsAt: soon,
      salesStartAt: new Date(Date.now() - 86_400_000).toISOString(),
      ...(over.perPersonLimit ? { perPersonLimit: over.perPersonLimit } : {}),
      pricing: { tiers: [{ name: 'Standard', price: over.price ?? 100_000 }], assignments: [{ tierIndex: 0, zoneIds: [seated.id, ...(floor ? [floor.id] : [])] }] },
    },
    { token: organizer.token },
  );
  if (created.status !== 201) throw new Error(`event create failed: ${created.text}`);
  const eventId = (created.json as { id: string }).id;
  const published = await api.post(`/api/organizer/events/${eventId}/publish`, {}, { token: organizer.token });
  if (published.status !== 200) throw new Error(`publish failed: ${published.text}`);
  const seatRows = await pool.query(`SELECT seat_id FROM event_seats WHERE event_id = $1 ORDER BY seat_id`, [eventId]);
  return { eventId, venueId: venueJson.id, seatIds: seatRows.rows.map((r: { seat_id: string }) => Number(r.seat_id)), floorZoneId: floor?.id ?? null, seatedZoneId: seated.id };
};
