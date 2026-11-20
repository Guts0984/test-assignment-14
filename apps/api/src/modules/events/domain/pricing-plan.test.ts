import { describe, expect, it } from 'vitest';
import { planPricing } from './pricing-plan.js';

const venue = {
  zones: [{ id: 'z-seated', kind: 'seated' as const }, { id: 'z-floor', kind: 'general' as const }],
  seats: [{ id: 1, zoneId: 'z-seated' }, { id: 2, zoneId: 'z-seated' }, { id: 3, zoneId: 'z-seated' }],
};
const tiers = [{ name: 'Std', price: 1000 }, { name: 'VIP', price: 5000 }];

describe('planPricing', () => {
  it('prices zones and lets selected seats override their zone', () => {
    const r = planPricing({ tiers, assignments: [{ tierIndex: 0, zoneIds: ['z-seated', 'z-floor'], seatIds: [] }, { tierIndex: 1, zoneIds: [], seatIds: [2] }] }, venue);
    expect(r.ok && r.value.seatTier.get(2)).toBe(1);
    expect(r.ok && r.value.zoneTier.get('z-seated')).toBe(0);
  });
  it('accepts per-seat pricing without a zone price when every seat is covered', () => {
    const r = planPricing({ tiers, assignments: [{ tierIndex: 0, zoneIds: ['z-floor'], seatIds: [1, 2, 3] }] }, venue);
    expect(r.ok).toBe(true);
  });
  it.each([
    ['an unpriced seat', { tiers, assignments: [{ tierIndex: 0, zoneIds: ['z-floor'], seatIds: [1, 2] }] }],
    ['an unpriced general zone', { tiers, assignments: [{ tierIndex: 0, zoneIds: ['z-seated'], seatIds: [] }] }],
    ['a zone of another hall', { tiers, assignments: [{ tierIndex: 0, zoneIds: ['z-seated', 'z-floor', 'z-alien'], seatIds: [] }] }],
    ['a seat of another hall', { tiers, assignments: [{ tierIndex: 0, zoneIds: ['z-seated', 'z-floor'], seatIds: [99] }] }],
    ['a tier that does not exist', { tiers, assignments: [{ tierIndex: 5, zoneIds: ['z-seated', 'z-floor'], seatIds: [] }] }],
    ['two prices for one zone', { tiers, assignments: [{ tierIndex: 0, zoneIds: ['z-seated', 'z-floor'], seatIds: [] }, { tierIndex: 1, zoneIds: ['z-seated'], seatIds: [] }] }],
    ['two prices for one seat', { tiers, assignments: [{ tierIndex: 0, zoneIds: ['z-seated', 'z-floor'], seatIds: [1] }, { tierIndex: 1, zoneIds: [], seatIds: [1] }] }],
  ])('rejects %s', (_name, input) => {
    expect(planPricing(input, venue).ok).toBe(false);
  });
});
