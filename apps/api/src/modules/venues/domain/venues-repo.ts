import type { PrismaClient } from '@prisma/client';
import type { Pool } from 'pg';
import { totalCapacity, type VenueLayout, type VenueResponse } from '@ticketing/shared';

export type VenueView = VenueResponse;

/** Stores a validated layout: venue, zones and every seat in one transaction (Prisma, batched inserts). */
export const createVenue = async (prisma: PrismaClient, organizerId: string, layout: VenueLayout): Promise<VenueView> => {
  const created = await prisma.$transaction(async (tx) => {
    const venue = await tx.venues.create({ data: { organizer_id: organizerId, name: layout.name, city: layout.city, capacity: totalCapacity(layout) } });
    const zones = [];
    for (const [index, zone] of layout.zones.entries()) {
      const capacity = zone.kind === 'general' ? zone.capacity : zone.rows.reduce((n, r) => n + r.seats.length, 0);
      const row = await tx.zones.create({
        data: { venue_id: venue.id, key: zone.id, name: zone.name, kind: zone.kind, capacity, sort: index, geometry: zone.kind === 'general' ? { x: zone.x ?? null, y: zone.y ?? null, width: zone.width ?? null, height: zone.height ?? null } : undefined },
      });
      zones.push(row);
      if (zone.kind === 'seated') {
        const seats = zone.rows.flatMap((r) => r.seats.map((s) => ({ venue_id: venue.id, zone_id: row.id, row_label: r.label, number: s.number, x: s.x, y: s.y })));
        for (let i = 0; i < seats.length; i += 5_000) await tx.seats.createMany({ data: seats.slice(i, i + 5_000) });
      }
    }
    return { venue, zones };
  }, { timeout: 60_000 });
  return {
    id: created.venue.id,
    name: created.venue.name,
    city: created.venue.city,
    capacity: created.venue.capacity,
    zones: created.zones.map((z) => ({ id: z.id, key: z.key, name: z.name, kind: z.kind, capacity: z.capacity })),
  };
};

export const listVenues = async (pool: Pool, organizerId: string): Promise<readonly VenueView[]> => {
  const res = await pool.query<{ id: string; name: string; city: string; capacity: number; zones: VenueView['zones'] }>(
    `SELECT v.id, v.name, v.city, v.capacity,
            COALESCE((SELECT json_agg(json_build_object('id', z.id, 'key', z.key, 'name', z.name, 'kind', z.kind, 'capacity', z.capacity) ORDER BY z.sort) FROM zones z WHERE z.venue_id = v.id), '[]') AS zones
     FROM venues v WHERE v.organizer_id = $1 ORDER BY v.created_at DESC`,
    [organizerId],
  );
  return res.rows;
};

export const getVenue = async (pool: Pool, organizerId: string, venueId: string): Promise<VenueView | null> => {
  const all = await pool.query<{ id: string }>(`SELECT id FROM venues WHERE id = $1 AND organizer_id = $2`, [venueId, organizerId]);
  if (all.rowCount === 0) return null;
  return (await listVenues(pool, organizerId)).find((v) => v.id === venueId) ?? null;
};

export interface Geometry {
  readonly venueId: string;
  readonly zones: VenueView['zones'];
  readonly seats: { id: number[]; zone: number[]; row: string[]; number: number[]; x: number[]; y: number[] };
}

export const getGeometry = async (pool: Pool, organizerId: string, venueId: string): Promise<Geometry | null> => {
  const venue = await getVenue(pool, organizerId, venueId);
  if (!venue) return null;
  const res = await pool.query<{ id: string; zone_id: string; row_label: string; number: number; x: number; y: number }>(
    `SELECT id, zone_id, row_label, number, x, y FROM seats WHERE venue_id = $1 ORDER BY id`,
    [venueId],
  );
  const zoneIndex = new Map(venue.zones.map((z, i) => [z.id, i]));
  return {
    venueId,
    zones: venue.zones,
    seats: {
      id: res.rows.map((r) => Number(r.id)),
      zone: res.rows.map((r) => zoneIndex.get(r.zone_id) ?? -1),
      row: res.rows.map((r) => r.row_label),
      number: res.rows.map((r) => r.number),
      x: res.rows.map((r) => r.x),
      y: res.rows.map((r) => r.y),
    },
  };
};
