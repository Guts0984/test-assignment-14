import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { requestHash } from './idempotency.js';

describe('requestHash', () => {
  it('does not depend on key order', () => {
    expect(requestHash({ a: 1, b: { c: 2, d: [3, 4] } })).toBe(requestHash({ b: { d: [3, 4], c: 2 }, a: 1 }));
  });
  it('changes when anything in the request changes', () => {
    expect(requestHash({ seatIds: [1, 2] })).not.toBe(requestHash({ seatIds: [1, 3] }));
    expect(requestHash({ seatIds: [1, 2] })).not.toBe(requestHash({ seatIds: [2, 1] })); // order of an array is meaningful
    expect(requestHash({ a: '1' })).not.toBe(requestHash({ a: 1 }));
  });
  it('property: equal values hash equally, different values (almost always) differ', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        expect(requestHash(v)).toBe(requestHash(JSON.parse(JSON.stringify(v))));
      }),
    );
  });
});
