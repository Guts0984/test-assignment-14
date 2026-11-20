/** Business rule constants shared by api, worker and web. Durations in milliseconds. */
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const RULES = Object.freeze({
  holdTtlMs: 10 * MINUTE_MS,
  maxSeatsPerOrder: 6,
  defaultTicketsPerPerson: 6,
  queueActivateAt: 500,
  queueMaxSelecting: 200,
  queueStartSelectionMs: 5 * MINUTE_MS,
  waitlistOfferTtlMs: 30 * MINUTE_MS,
  serviceFeePercent: 5,
  serviceFeeMinKopecks: 2_000,
  commissionPercent: 8,
  refundFullAboveMs: 7 * DAY_MS,
  refundHalfAboveMs: 2 * DAY_MS,
  refundHalfPercent: 50,
  rescheduleRefundWindowMs: 14 * DAY_MS,
  transferCutoffMs: HOUR_MS,
  payoutDelayMs: 3 * DAY_MS,
  stubRpsLimit: 20,
  maxPriceKopecks: 10_000_000,
  maxPerPersonLimit: 50,
  maxVenueSeats: 12_000,
  maxVenueZones: 200,
  jobMaxAttempts: 8,
  jobBackoffBaseMs: 2_000,
} as const);

export type Rules = typeof RULES;
