import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { allocateProportionally, commissionFor, payoutAmounts, priceOrder, promoDiscountTotal, serviceFee } from './pricing.js';

const price = fc.integer({ min: 100, max: 10_000_000 });

describe('serviceFee', () => {
  it('is 5% but never below 20 UAH', () => {
    expect(serviceFee(100_000)).toBe(5_000); // 1000 UAH -> 50 UAH
    expect(serviceFee(40_000)).toBe(2_000); // exactly 20 UAH
    expect(serviceFee(39_999)).toBe(2_000);
    expect(serviceFee(100)).toBe(2_000);
  });
  it('rounds half up at the boundary', () => {
    expect(serviceFee(40_010)).toBe(2_001); // 2000.5 -> 2001
    expect(serviceFee(40_009)).toBe(2_000); // 2000.45 -> 2000
  });
  it('property: >= minimum and within 1 kopeck of 5%', () => {
    fc.assert(
      fc.property(price, (p) => {
        const fee = serviceFee(p);
        expect(fee).toBeGreaterThanOrEqual(2_000);
        expect(fee).toBeGreaterThanOrEqual(Math.floor((p * 5) / 100));
        expect(Number.isInteger(fee)).toBe(true);
      }),
    );
  });
});

describe('promo discount', () => {
  it('percent rounds half up and fixed is capped', () => {
    expect(promoDiscountTotal(10_005, { kind: 'percent', percent: 10 })).toBe(1_001);
    expect(promoDiscountTotal(5_000, { kind: 'fixed', amount: 9_000 })).toBe(5_000);
    expect(promoDiscountTotal(5_000, null)).toBe(0);
  });
});

describe('allocateProportionally', () => {
  it('property: parts sum to the total and never exceed their weight', () => {
    fc.assert(
      fc.property(fc.array(price, { minLength: 1, maxLength: 6 }), fc.double({ min: 0, max: 1, noNaN: true }), (weights, ratio) => {
        const sum = weights.reduce((a, b) => a + b, 0);
        const total = Math.floor(sum * ratio);
        const parts = allocateProportionally(total, weights);
        expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
        parts.forEach((part, i) => {
          expect(part).toBeGreaterThanOrEqual(0);
          expect(part).toBeLessThanOrEqual(weights[i] ?? 0);
        });
      }),
    );
  });
  it('is deterministic for equal remainders', () => {
    expect(allocateProportionally(1, [100, 100, 100])).toEqual([1, 0, 0]);
  });
  it('handles zero total and zero weights', () => {
    expect(allocateProportionally(0, [5, 5])).toEqual([0, 0]);
    expect(allocateProportionally(5, [0, 0])).toEqual([0, 0]);
  });
});

describe('priceOrder', () => {
  it('promo never touches the service fee', () => {
    const noPromo = priceOrder([100_000, 100_000], null);
    const withPromo = priceOrder([100_000, 100_000], { kind: 'percent', percent: 50 });
    expect(withPromo.fee).toBe(noPromo.fee);
    expect(withPromo.discount).toBe(100_000);
    expect(withPromo.total).toBe(noPromo.total - 100_000);
  });
  it('property: total = subtotal - discount + fee and items agree', () => {
    fc.assert(
      fc.property(
        fc.array(price, { minLength: 1, maxLength: 6 }),
        fc.oneof(
          fc.constant(null),
          fc.record({ kind: fc.constant('percent' as const), percent: fc.integer({ min: 1, max: 100 }) }),
          fc.record({ kind: fc.constant('fixed' as const), amount: fc.integer({ min: 1, max: 100_000_000 }) }),
        ),
        (prices, promo) => {
          const o = priceOrder(prices, promo);
          expect(o.total).toBe(o.subtotal - o.discount + o.fee);
          expect(o.items.reduce((a, i) => a + i.discount, 0)).toBe(o.discount);
          expect(o.items.reduce((a, i) => a + i.fee, 0)).toBe(o.fee);
          o.items.forEach((i) => expect(i.discount).toBeLessThanOrEqual(i.price));
        },
      ),
    );
  });
});

describe('commission and payout', () => {
  it('commission is 8% rounded down (organizer favour)', () => {
    expect(commissionFor(1_000_000)).toBe(80_000);
    expect(commissionFor(1_249)).toBe(99); // 99.92 -> 99
  });
  it('property: payout = sales - refunds - commission, never negative', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000_000 }), fc.double({ min: 0, max: 1, noNaN: true }), (sales, r) => {
        const refunds = Math.floor(sales * r);
        const p = payoutAmounts(sales, refunds);
        expect(p.payout).toBe(sales - refunds - p.commission);
        expect(p.payout).toBeGreaterThanOrEqual(0);
        expect(p.commission * 100).toBeLessThanOrEqual(p.net * 8);
      }),
    );
  });
});
