export interface TierDraft {
  readonly name: string;
  /** Price in UAH as typed by the organizer (comma or dot). */
  readonly price: string;
}

export interface PricingPayload {
  readonly tiers: { name: string; price: number }[];
  readonly assignments: { tierIndex: number; zoneIds: string[]; seatIds: number[] }[];
}

export const uahToKopecks = (text: string): number | null => {
  const n = Number(text.trim().replace(',', '.'));
  return text.trim() !== '' && Number.isFinite(n) && n >= 1 ? Math.round(n * 100) : null;
};

export interface ZoneInfo {
  readonly id: string;
  readonly kind: 'seated' | 'general';
}

/**
 * Turns the organizer's selections on the map into the api payload. A zone whose seats all got the same tier is sent
 * as one zone entry instead of thousands of seat ids; mixed zones list their seats.
 */
export const buildPricing = (
  tiers: readonly TierDraft[],
  seatTier: ReadonlyMap<number, number>,
  seatsByZone: ReadonlyMap<string, readonly number[]>,
  zones: readonly ZoneInfo[],
  generalTier: ReadonlyMap<string, number>,
): PricingPayload | null => {
  const priced = tiers.map((t) => ({ name: t.name.trim(), price: uahToKopecks(t.price) }));
  if (priced.some((t) => t.name === '' || t.price === null)) return null;
  const byTier = new Map<number, { zoneIds: string[]; seatIds: number[] }>();
  const bucket = (tier: number) => {
    const b = byTier.get(tier) ?? { zoneIds: [], seatIds: [] };
    byTier.set(tier, b);
    return b;
  };
  for (const zone of zones) {
    if (zone.kind === 'general') {
      const tier = generalTier.get(zone.id);
      if (tier === undefined) return null;
      bucket(tier).zoneIds.push(zone.id);
      continue;
    }
    const seats = seatsByZone.get(zone.id) ?? [];
    const assigned = seats.map((s) => seatTier.get(s));
    if (assigned.some((a) => a === undefined)) return null;
    const first = assigned[0];
    if (first !== undefined && assigned.every((a) => a === first)) bucket(first).zoneIds.push(zone.id);
    else seats.forEach((s, i) => bucket(assigned[i] ?? 0).seatIds.push(s));
  }
  return {
    tiers: priced.map((t) => ({ name: t.name, price: t.price ?? 0 })),
    assignments: [...byTier.entries()].map(([tierIndex, v]) => ({ tierIndex, zoneIds: v.zoneIds, seatIds: v.seatIds })),
  };
};
