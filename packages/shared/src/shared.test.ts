import { describe, expect, it } from 'vitest';
import { ERROR_CODES, RULES, addKopecks, errorResponseSchema, isKopecks } from './index.js';

describe('shared skeleton', () => {
  it('rules match the assignment', () => {
    expect(RULES.holdTtlMs).toBe(600_000);
    expect(RULES.serviceFeeMinKopecks).toBe(2000);
    expect(RULES.stubRpsLimit).toBe(20);
    expect(Object.isFrozen(RULES)).toBe(true);
  });

  it('error body requires a known code', () => {
    const ok = { error: { code: ERROR_CODES[0], message: 'x', requestId: 'r' } };
    expect(errorResponseSchema.safeParse(ok).success).toBe(true);
    expect(errorResponseSchema.safeParse({ error: { ...ok.error, code: 'NOPE' } }).success).toBe(false);
  });

  it('money rejects floats and overflow', () => {
    expect(isKopecks(10.5)).toBe(false);
    expect(isKopecks(Number.NaN)).toBe(false);
    expect(isKopecks(2 ** 53)).toBe(false);
    expect(() => addKopecks(Number.MAX_SAFE_INTEGER, 1)).toThrow(RangeError);
    expect(addKopecks(1, 2)).toBe(3);
  });
});
