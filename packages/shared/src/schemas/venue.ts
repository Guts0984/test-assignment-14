import { z } from 'zod';
import { RULES } from '../rules/constants.js';

const coord = z.number().finite().min(0).max(100_000);
const label = z.string().trim().min(1).max(40);

export const venueSeatSchema = z.object({ number: z.number().int().min(1).max(100_000), x: coord, y: coord }).strict();

export const venueRowSchema = z.object({ label, seats: z.array(venueSeatSchema).min(1).max(RULES.maxVenueSeats) }).strict();

const seatedZone = z
  .object({
    id: z.string().trim().min(1).max(40),
    name: label,
    kind: z.literal('seated'),
    rows: z.array(venueRowSchema).min(1).max(1_000),
  })
  .strict();

const generalZone = z
  .object({
    id: z.string().trim().min(1).max(40),
    name: label,
    kind: z.literal('general'),
    capacity: z.number().int().min(1).max(1_000_000),
    x: coord.optional(),
    y: coord.optional(),
    width: coord.optional(),
    height: coord.optional(),
  })
  .strict();

export const venueZoneSchema = z.discriminatedUnion('kind', [seatedZone, generalZone]);

export type VenueLayout = z.infer<typeof venueLayoutSchema>;
export type VenueZone = z.infer<typeof venueZoneSchema>;

export const venueLayoutSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    city: z.string().trim().min(1).max(80),
    zones: z.array(venueZoneSchema).min(1).max(RULES.maxVenueZones),
  })
  .strict()
  .superRefine((venue, ctx) => {
    const zoneIds = new Set<string>();
    venue.zones.forEach((zone, zi) => {
      if (zoneIds.has(zone.id)) ctx.addIssue({ code: 'custom', path: ['zones', zi, 'id'], message: 'duplicate zone id' });
      zoneIds.add(zone.id);
      if (zone.kind !== 'seated') return;
      const rowLabels = new Set<string>();
      zone.rows.forEach((row, ri) => {
        if (rowLabels.has(row.label)) ctx.addIssue({ code: 'custom', path: ['zones', zi, 'rows', ri, 'label'], message: 'duplicate row label' });
        rowLabels.add(row.label);
        const numbers = new Set<number>();
        row.seats.forEach((seat, si) => {
          if (numbers.has(seat.number)) ctx.addIssue({ code: 'custom', path: ['zones', zi, 'rows', ri, 'seats', si, 'number'], message: 'duplicate seat number in row' });
          numbers.add(seat.number);
        });
      });
    });
    if (countSeats(venue) > RULES.maxVenueSeats) {
      ctx.addIssue({ code: 'custom', path: ['zones'], message: `more than ${RULES.maxVenueSeats} seats` });
    }
  });

/** Seats of seated zones only. */
export const countSeats = (venue: { readonly zones: readonly VenueZone[] }): number =>
  venue.zones.reduce((sum, zone) => (zone.kind === 'seated' ? sum + zone.rows.reduce((s, r) => s + r.seats.length, 0) : sum), 0);

/** Seats plus general-admission capacity. */
export const totalCapacity = (venue: { readonly zones: readonly VenueZone[] }): number =>
  venue.zones.reduce((sum, zone) => sum + (zone.kind === 'general' ? zone.capacity : 0), countSeats(venue));
