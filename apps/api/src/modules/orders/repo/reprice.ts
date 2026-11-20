import type { PoolClient } from 'pg';
import { priceOrder, type Promo } from '@ticketing/shared';

/**
 * Recomputes discounts, fees and totals of an order from its items and promo. All pricing rules live in
 * `packages/shared`; this only reads, calls them and writes the result.
 */
export const repriceOrder = async (tx: PoolClient, orderId: string): Promise<void> => {
  const items = await tx.query<{ id: string; price: number }>(`SELECT id, price FROM order_items WHERE order_id = $1 ORDER BY id`, [orderId]);
  const promoRow = (await tx.query<{ kind: 'percent' | 'fixed'; value: number }>(
    `SELECT p.kind, p.value FROM orders o JOIN promo_codes p ON p.id = o.promo_id WHERE o.id = $1 AND o.promo_held`,
    [orderId],
  )).rows[0];
  const promo: Promo | null = promoRow ? (promoRow.kind === 'percent' ? { kind: 'percent', percent: promoRow.value } : { kind: 'fixed', amount: promoRow.value }) : null;
  const totals = priceOrder(items.rows.map((i) => i.price), promo);
  if (items.rows.length > 0) {
    await tx.query(
      `UPDATE order_items AS i SET discount = d.discount, fee = d.fee FROM unnest($2::uuid[], $3::int[], $4::int[]) AS d(id, discount, fee) WHERE i.id = d.id AND i.order_id = $1`,
      [orderId, items.rows.map((i) => i.id), totals.items.map((i) => i.discount), totals.items.map((i) => i.fee)],
    );
  }
  await tx.query(`UPDATE orders SET subtotal = $2, discount = $3, fee = $4, total = $5 WHERE id = $1`, [orderId, totals.subtotal, totals.discount, totals.fee, totals.total]);
};
