import { RULES } from '../rules/constants.js';
import type { Kopecks } from '../money/money.js';

export type Promo =
  | { readonly kind: 'percent'; readonly percent: number }
  | { readonly kind: 'fixed'; readonly amount: Kopecks };

export interface PricedItem {
  readonly price: Kopecks;
  readonly discount: Kopecks;
  readonly fee: Kopecks;
}

export interface OrderTotals {
  readonly items: readonly PricedItem[];
  readonly subtotal: Kopecks;
  readonly discount: Kopecks;
  readonly fee: Kopecks;
  readonly total: Kopecks;
}

/** Buyer-paid service fee for one ticket: 5% of the list price, at least 20 UAH. Half-up rounding. */
export const serviceFee = (price: Kopecks): Kopecks =>
  Math.max(RULES.serviceFeeMinKopecks, Math.floor((price * RULES.serviceFeePercent + 50) / 100));

/** Total promo discount for a subtotal. Percent rounds half-up; fixed is capped at the subtotal. */
export const promoDiscountTotal = (subtotal: Kopecks, promo: Promo | null): Kopecks => {
  if (promo === null) return 0;
  if (promo.kind === 'percent') return Math.floor((subtotal * promo.percent + 50) / 100);
  return Math.min(promo.amount, subtotal);
};

/** Splits `total` proportionally to `weights` using the largest-remainder method; the parts always sum to `total`. */
export const allocateProportionally = (total: Kopecks, weights: readonly number[]): readonly number[] => {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0 || total === 0) return weights.map(() => 0);
  const bigTotal = BigInt(total);
  const bigSum = BigInt(sum);
  const parts = weights.map((w, index) => {
    const product = bigTotal * BigInt(w);
    return { index, base: product / bigSum, rest: product % bigSum };
  });
  const distributed = parts.reduce((a, p) => a + p.base, 0n);
  let leftover = Number(bigTotal - distributed);
  const order = [...parts].sort((a, b) => (a.rest === b.rest ? a.index - b.index : a.rest > b.rest ? -1 : 1));
  const extra = new Map<number, number>();
  for (const p of order) {
    if (leftover <= 0) break;
    extra.set(p.index, 1);
    leftover -= 1;
  }
  return parts.map((p) => Number(p.base) + (extra.get(p.index) ?? 0));
};

/** Prices an order: promo reduces ticket prices only, the service fee is computed on the list price. */
export const priceOrder = (prices: readonly Kopecks[], promo: Promo | null): OrderTotals => {
  const subtotal = prices.reduce((a, b) => a + b, 0);
  const discount = promoDiscountTotal(subtotal, promo);
  const discounts = allocateProportionally(discount, prices);
  const items = prices.map((price, i): PricedItem => ({ price, discount: discounts[i] ?? 0, fee: serviceFee(price) }));
  const fee = items.reduce((a, i) => a + i.fee, 0);
  return { items, subtotal, discount, fee, total: subtotal - discount + fee };
};

/** Platform commission: 8% of net ticket sales, rounded down so the organizer keeps the remainder. */
export const commissionFor = (net: Kopecks): Kopecks => Math.floor((net * RULES.commissionPercent) / 100);

export interface PayoutAmounts {
  readonly net: Kopecks;
  readonly commission: Kopecks;
  readonly payout: Kopecks;
}

/** Payout = sales - refunds - commission. */
export const payoutAmounts = (sales: Kopecks, refunds: Kopecks): PayoutAmounts => {
  const net = sales - refunds;
  const commission = commissionFor(net);
  return { net, commission, payout: net - commission };
};
