import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAwaitingOrder, createTestDb, createWorld, setClockOffset, type TestDb } from '@ticketing/testkit';
import type { RealtimePublisher } from '@ticketing/platform';
import { expirySweep } from '../src/periodic/loops.js';

let tdb: TestDb;
beforeAll(async () => {
  tdb = await createTestDb();
});
afterAll(async () => {
  await setClockOffset(tdb.pool, 0);
  await tdb.drop();
});

const recorder = () => {
  const events: { readonly kind: string; readonly target: string; readonly payload?: unknown }[] = [];
  const rt = {
    seatsChanged: (eventId: string) => void events.push({ kind: 'seats', target: eventId }),
    toUser: (userId: string, name: string, payload: unknown) => void events.push({ kind: name, target: userId, payload }),
  } as unknown as RealtimePublisher;
  return { rt, events };
};

describe('expiry sweep', () => {
  it('frees the seats and tells both the seat-map viewers and the owner of the order', async () => {
    const w = await createWorld(tdb.pool, { seats: 3 });
    const order = await createAwaitingOrder(tdb.pool, w, [0, 1]);
    const early = recorder();
    await expirySweep(tdb.pool, early.rt);
    expect(early.events).toEqual([]); // still within the hold: nothing to do

    await setClockOffset(tdb.pool, 11 * 60_000);
    const late = recorder();
    await expirySweep(tdb.pool, late.rt);
    expect(late.events).toContainEqual({ kind: 'seats', target: w.eventId });
    expect(late.events).toContainEqual({ kind: 'order.updated', target: w.buyerId, payload: { orderId: order.orderId, status: 'expired' } });
    expect((await tdb.pool.query(`SELECT status::text AS s FROM orders WHERE id = $1`, [order.orderId])).rows[0]).toEqual({ s: 'expired' });

    const again = recorder();
    await expirySweep(tdb.pool, again.rt);
    expect(again.events.filter((e) => e.kind === 'order.updated')).toEqual([]); // exactly once
  });
});
