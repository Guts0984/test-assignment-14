import { describe, expect, it } from 'vitest';
import { buildPricing, uahToKopecks } from './pricing';

const tiers = [{ name: 'Standard', price: '1000' }, { name: 'VIP', price: '2500,50' }];
const zones = [{ id: 'A', kind: 'seated' as const }, { id: 'F', kind: 'general' as const }];

describe('pricing payload', () => {
  it('converts typed UAH to kopecks and rejects junk', () => {
    expect(uahToKopecks('1000')).toBe(100_000);
    expect(uahToKopecks('2500,50')).toBe(250_050);
    expect(uahToKopecks('')).toBeNull();
    expect(uahToKopecks('abc')).toBeNull();
    expect(uahToKopecks('0')).toBeNull();
  });
  it('sends a uniformly priced zone as one entry', () => {
    const payload = buildPricing(tiers, new Map([[1, 0], [2, 0]]), new Map([['A', [1, 2]]]), zones, new Map([['F', 1]]));
    expect(payload).toEqual({
      tiers: [{ name: 'Standard', price: 100_000 }, { name: 'VIP', price: 250_050 }],
      assignments: [{ tierIndex: 0, zoneIds: ['A'], seatIds: [] }, { tierIndex: 1, zoneIds: ['F'], seatIds: [] }],
    });
  });
  it('lists the seats of a zone that has mixed prices', () => {
    const payload = buildPricing(tiers, new Map([[1, 0], [2, 1], [3, 0]]), new Map([['A', [1, 2, 3]]]), zones, new Map([['F', 0]]));
    expect(payload?.assignments).toContainEqual({ tierIndex: 0, zoneIds: ['F'], seatIds: [1, 3] });
    expect(payload?.assignments).toContainEqual({ tierIndex: 1, zoneIds: [], seatIds: [2] });
  });
  it('refuses an unpriced seat, an unpriced dance floor and an incomplete tier', () => {
    expect(buildPricing(tiers, new Map([[1, 0]]), new Map([['A', [1, 2]]]), zones, new Map([['F', 0]]))).toBeNull();
    expect(buildPricing(tiers, new Map([[1, 0], [2, 0]]), new Map([['A', [1, 2]]]), zones, new Map())).toBeNull();
    expect(buildPricing([{ name: '', price: '10' }], new Map(), new Map(), [], new Map())).toBeNull();
  });
});
