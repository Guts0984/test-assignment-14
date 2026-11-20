import { describe, expect, it } from 'vitest';
import { countSeats, totalCapacity, venueLayoutSchema } from './venue.js';

const good = {
  name: 'Hall',
  city: 'Kyiv',
  zones: [
    { id: 'A', name: 'Stalls', kind: 'seated', rows: [{ label: '1', seats: [{ number: 1, x: 0, y: 0 }, { number: 2, x: 10, y: 0 }] }] },
    { id: 'P', name: 'Pit', kind: 'general', capacity: 500 },
  ],
};

describe('venueLayoutSchema', () => {
  it('accepts a valid layout and counts seats and capacity', () => {
    const r = venueLayoutSchema.safeParse(good);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(countSeats(r.data)).toBe(2);
      expect(totalCapacity(r.data)).toBe(502);
    }
  });
  it.each([
    ['duplicate zone id', { ...good, zones: [good.zones[0], good.zones[0]] }],
    ['unknown field (mass assignment)', { ...good, isAdmin: true }],
    ['zero capacity pit', { ...good, zones: [{ id: 'P', name: 'Pit', kind: 'general', capacity: 0 }] }],
    ['negative coordinate', { ...good, zones: [{ ...good.zones[0], rows: [{ label: '1', seats: [{ number: 1, x: -1, y: 0 }] }] }] }],
    ['NaN coordinate', { ...good, zones: [{ ...good.zones[0], rows: [{ label: '1', seats: [{ number: 1, x: Number.NaN, y: 0 }] }] }] }],
    ['duplicate seat number', { ...good, zones: [{ ...good.zones[0], rows: [{ label: '1', seats: [{ number: 1, x: 0, y: 0 }, { number: 1, x: 5, y: 0 }] }] }] }],
    ['duplicate row label', { ...good, zones: [{ ...good.zones[0], rows: [good.zones[0]?.rows?.[0], good.zones[0]?.rows?.[0]] }] }],
    ['empty zones', { ...good, zones: [] }],
    ['unknown kind', { ...good, zones: [{ id: 'X', name: 'X', kind: 'standing', capacity: 5 }] }],
    ['string name too long', { ...good, name: 'x'.repeat(500) }],
  ])('rejects %s', (_name, payload) => {
    expect(venueLayoutSchema.safeParse(payload).success).toBe(false);
  });
  it('rejects more than 12 000 seats', () => {
    const seats = Array.from({ length: 6_001 }, (_, i) => ({ number: i + 1, x: 1, y: 1 }));
    const big = { ...good, zones: [{ id: 'A', name: 'A', kind: 'seated', rows: [{ label: '1', seats }, { label: '2', seats }] }] };
    expect(venueLayoutSchema.safeParse(big).success).toBe(false);
  });
  it('does not pollute prototypes through __proto__ keys', () => {
    const payload = JSON.parse('{"name":"H","city":"K","zones":[{"id":"P","name":"P","kind":"general","capacity":5}],"__proto__":{"polluted":1}}');
    expect(venueLayoutSchema.safeParse(payload).success).toBe(false);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});
