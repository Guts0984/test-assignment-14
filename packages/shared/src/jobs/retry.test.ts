import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { estimateWaitSeconds } from '../queue/eta.js';
import { retryDelayMs } from './retry.js';

describe('retryDelayMs', () => {
  it('grows exponentially from 2 s and is capped', () => {
    expect(retryDelayMs(1, 0)).toBe(2_000);
    expect(retryDelayMs(2, 0)).toBe(4_000);
    expect(retryDelayMs(3, 0)).toBe(8_000);
    expect(retryDelayMs(30, 0)).toBe(300_000);
  });
  it('property: monotonic in attempt and jitter stays within 20%', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), fc.double({ min: 0, max: 0.999999, noNaN: true }), (attempt, r) => {
        const base = retryDelayMs(attempt, 0);
        const jittered = retryDelayMs(attempt, r);
        expect(jittered).toBeGreaterThanOrEqual(base);
        expect(jittered).toBeLessThanOrEqual(Math.ceil(base * 1.2));
        expect(retryDelayMs(attempt + 1, 0)).toBeGreaterThanOrEqual(base);
      }),
    );
  });
  it('treats a nonsensical attempt as the first one', () => {
    expect(retryDelayMs(0, 0)).toBe(2_000);
    expect(retryDelayMs(-5, 0)).toBe(2_000);
  });
});

describe('estimateWaitSeconds', () => {
  it('is zero at the head of the line', () => {
    expect(estimateWaitSeconds({ position: 1, admittedInWindow: 0, windowSeconds: 300 })).toBe(0);
  });
  it('uses the observed admission rate', () => {
    expect(estimateWaitSeconds({ position: 101, admittedInWindow: 300, windowSeconds: 300 })).toBe(100);
  });
  it('falls back to a sane default when nothing was admitted yet', () => {
    expect(estimateWaitSeconds({ position: 201, admittedInWindow: 0, windowSeconds: 300 })).toBe(600);
  });
  it('property: further back never means a shorter wait', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5_000 }), fc.integer({ min: 0, max: 1_000 }), (position, admitted) => {
        const a = estimateWaitSeconds({ position, admittedInWindow: admitted, windowSeconds: 300 });
        const b = estimateWaitSeconds({ position: position + 1, admittedInWindow: admitted, windowSeconds: 300 });
        expect(b).toBeGreaterThanOrEqual(a);
      }),
    );
  });
});
