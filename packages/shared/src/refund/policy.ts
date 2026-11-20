import { RULES } from '../rules/constants.js';
import type { Kopecks } from '../money/money.js';

export type RefundKind = 'event_cancelled' | 'rescheduled' | 'full' | 'half';
export type RefundDenial = 'event_started_or_too_late' | 'ticket_not_refundable';

export interface RefundInput {
  /** What the buyer actually paid for this ticket (price after promo). */
  readonly paidPrice: Kopecks;
  readonly paidFee: Kopecks;
  readonly nowMs: number;
  readonly startsAtMs: number;
  readonly eventCancelled: boolean;
  /** Set when the event was rescheduled; starts the 14 day window. */
  readonly rescheduledAtMs: number | null;
}

export type RefundQuote =
  | { readonly ok: true; readonly kind: RefundKind; readonly price: Kopecks; readonly fee: Kopecks }
  | { readonly ok: false; readonly reason: RefundDenial };

/**
 * Refund rules:
 *  - event cancelled: 100% including the service fee;
 *  - rescheduled, within 14 days of the reschedule (and before the event starts): full price;
 *  - more than 7 days before start: price without fee;
 *  - 2..7 days (inclusive): 50% of the price, rounded up in the buyer's favour;
 *  - less than 2 days: not allowed.
 */
export const quoteRefund = (input: RefundInput): RefundQuote => {
  if (input.eventCancelled) {
    return { ok: true, kind: 'event_cancelled', price: input.paidPrice, fee: input.paidFee };
  }
  const lead = input.startsAtMs - input.nowMs;
  if (lead <= 0) return { ok: false, reason: 'event_started_or_too_late' };
  const inRescheduleWindow =
    input.rescheduledAtMs !== null &&
    input.nowMs >= input.rescheduledAtMs &&
    input.nowMs - input.rescheduledAtMs <= RULES.rescheduleRefundWindowMs;
  if (inRescheduleWindow) return { ok: true, kind: 'rescheduled', price: input.paidPrice, fee: 0 };
  if (lead > RULES.refundFullAboveMs) return { ok: true, kind: 'full', price: input.paidPrice, fee: 0 };
  if (lead >= RULES.refundHalfAboveMs) {
    return { ok: true, kind: 'half', price: Math.ceil((input.paidPrice * RULES.refundHalfPercent) / 100), fee: 0 };
  }
  return { ok: false, reason: 'event_started_or_too_late' };
};
