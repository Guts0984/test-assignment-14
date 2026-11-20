import { describe, expect, it } from 'vitest';
import { quoteRefund } from './policy.js';

const DAY = 86_400_000;
const START = 1_800_000_000_000;
const base = { paidPrice: 100_000, paidFee: 5_000, startsAtMs: START, eventCancelled: false, rescheduledAtMs: null } as const;
const at = (leadMs: number) => quoteRefund({ ...base, nowMs: START - leadMs });

describe('quoteRefund time thresholds', () => {
  it('more than 7 days: full price without fee', () => {
    expect(at(7 * DAY + 1)).toEqual({ ok: true, kind: 'full', price: 100_000, fee: 0 });
    expect(at(30 * DAY)).toMatchObject({ kind: 'full' });
  });
  it('exactly 7 days is already the 50% tier', () => {
    expect(at(7 * DAY)).toEqual({ ok: true, kind: 'half', price: 50_000, fee: 0 });
  });
  it('2..7 days: 50%', () => {
    expect(at(2 * DAY)).toMatchObject({ kind: 'half', price: 50_000 });
    expect(at(4 * DAY)).toMatchObject({ kind: 'half' });
  });
  it('less than 2 days: not allowed (1 ms under the boundary)', () => {
    expect(at(2 * DAY - 1)).toEqual({ ok: false, reason: 'event_started_or_too_late' });
    expect(at(1)).toMatchObject({ ok: false });
  });
  it('event already started: not allowed', () => {
    expect(at(0)).toMatchObject({ ok: false });
    expect(at(-DAY)).toMatchObject({ ok: false });
  });
  it('50% of an odd amount rounds up for the buyer', () => {
    expect(quoteRefund({ ...base, paidPrice: 10_001, nowMs: START - 3 * DAY })).toMatchObject({ price: 5_001 });
  });
  it('uses what was actually paid (after promo)', () => {
    expect(quoteRefund({ ...base, paidPrice: 0, nowMs: START - 30 * DAY })).toMatchObject({ ok: true, price: 0 });
  });
});

describe('quoteRefund special cases', () => {
  it('cancelled event refunds 100% including fee, at any time', () => {
    expect(quoteRefund({ ...base, eventCancelled: true, nowMs: START - 1 })).toEqual({ ok: true, kind: 'event_cancelled', price: 100_000, fee: 5_000 });
    expect(quoteRefund({ ...base, eventCancelled: true, nowMs: START + DAY })).toMatchObject({ ok: true });
  });
  it('rescheduled: full price for 14 days regardless of lead time', () => {
    const rescheduledAtMs = START - 20 * DAY;
    const quote = (now: number) => quoteRefund({ ...base, rescheduledAtMs, nowMs: now });
    expect(quote(rescheduledAtMs + 14 * DAY)).toEqual({ ok: true, kind: 'rescheduled', price: 100_000, fee: 0 }); // 6 days left, still full
    expect(quote(rescheduledAtMs + 14 * DAY + 1)).toMatchObject({ ok: true, kind: 'half' }); // window over
    const late = START - DAY; // rescheduled one day before the event: full refund until the start
    expect(quoteRefund({ ...base, rescheduledAtMs: late, nowMs: START - 1000 })).toMatchObject({ ok: true, kind: 'rescheduled' });
  });
  it('after the window the normal tiers apply again', () => {
    const rescheduledAtMs = START - 60 * DAY;
    expect(quoteRefund({ ...base, rescheduledAtMs, nowMs: START - 20 * DAY })).toMatchObject({ kind: 'full' });
    expect(quoteRefund({ ...base, rescheduledAtMs, nowMs: START - 3 * DAY })).toMatchObject({ kind: 'half' });
  });
  it('reschedule window never allows a refund after the event started', () => {
    expect(quoteRefund({ ...base, rescheduledAtMs: START - DAY, nowMs: START })).toMatchObject({ ok: false });
  });
});
