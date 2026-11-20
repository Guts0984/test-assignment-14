import { appError, err, ok, type Result } from '../../../common/result.js';

export interface PricingInput {
  readonly tiers: readonly { readonly name: string; readonly price: number }[];
  readonly assignments: readonly { readonly tierIndex: number; readonly zoneIds: readonly string[]; readonly seatIds: readonly number[] }[];
}

export interface VenueShape {
  readonly zones: readonly { readonly id: string; readonly kind: 'seated' | 'general' }[];
  readonly seats: readonly { readonly id: number; readonly zoneId: string }[];
}

export interface PricingPlan {
  /** Tier index per zone (general zones need one; seated zones use it as the default for their seats). */
  readonly zoneTier: ReadonlyMap<string, number>;
  /** Tier index per individually selected seat (overrides the zone tier). */
  readonly seatTier: ReadonlyMap<number, number>;
}

/**
 * Turns the organizer's selection on the map into a complete plan: every zone and every seat must end up with a
 * tier, referenced ids must belong to the venue, and one seat or zone cannot be given two different prices.
 */
export const planPricing = (input: PricingInput, venue: VenueShape): Result<PricingPlan> => {
  const zoneIds = new Set(venue.zones.map((z) => z.id));
  const seatZone = new Map(venue.seats.map((s) => [s.id, s.zoneId]));
  const zoneTier = new Map<string, number>();
  const seatTier = new Map<number, number>();

  for (const a of input.assignments) {
    if (a.tierIndex >= input.tiers.length) return err(appError('VALIDATION_FAILED', `tierIndex ${a.tierIndex} does not exist`));
    for (const zoneId of a.zoneIds) {
      if (!zoneIds.has(zoneId)) return err(appError('VALIDATION_FAILED', 'zone does not belong to the venue', { zoneId }));
      if (zoneTier.has(zoneId) && zoneTier.get(zoneId) !== a.tierIndex) return err(appError('VALIDATION_FAILED', 'zone is assigned two different tiers', { zoneId }));
      zoneTier.set(zoneId, a.tierIndex);
    }
    for (const seatId of a.seatIds) {
      if (!seatZone.has(seatId)) return err(appError('VALIDATION_FAILED', 'seat does not belong to the venue', { seatId }));
      if (seatTier.has(seatId) && seatTier.get(seatId) !== a.tierIndex) return err(appError('VALIDATION_FAILED', 'seat is assigned two different tiers', { seatId }));
      seatTier.set(seatId, a.tierIndex);
    }
  }

  for (const zone of venue.zones) {
    if (zone.kind === 'general' && !zoneTier.has(zone.id)) return err(appError('VALIDATION_FAILED', 'every general-admission zone needs a price', { zoneId: zone.id }));
  }
  const unpriced = venue.seats.filter((s) => !seatTier.has(s.id) && !zoneTier.has(s.zoneId));
  if (unpriced.length > 0) return err(appError('VALIDATION_FAILED', `${unpriced.length} seats have no price`, { firstSeatId: unpriced[0]?.id ?? 0 }));
  return ok({ zoneTier, seatTier });
};
