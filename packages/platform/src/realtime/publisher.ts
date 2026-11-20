import { Emitter } from '@socket.io/redis-emitter';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';

export interface SeatChange {
  readonly seq: number;
  readonly seatId: number | null;
  readonly zoneId: string | null;
  readonly status: string;
  readonly heldUntil: number | null;
  readonly available: number | null;
}

export const eventRoom = (eventId: string): string => `event:${eventId}`;
export const adminRoom = (eventId: string): string => `admin:${eventId}`;
export const userRoom = (userId: string): string => `user:${userId}`;
export const sessionRoom = (sessionId: string): string => `session:${sessionId}`;

export const loadChanges = async (pool: Pool, eventId: string, afterSeq: number, limit: number): Promise<readonly SeatChange[]> => {
  const res = await pool.query<{ seq: string; seat_id: string | null; zone_id: string | null; status: string; held_until: Date | null; available: number | null }>(
    `SELECT seq, seat_id, zone_id, status, held_until, available FROM seat_events WHERE event_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
    [eventId, afterSeq, limit],
  );
  return res.rows.map((r) => ({ seq: Number(r.seq), seatId: r.seat_id === null ? null : Number(r.seat_id), zoneId: r.zone_id, status: r.status, heldUntil: r.held_until?.getTime() ?? null, available: r.available }));
};

/**
 * Pushes events to browsers connected to any api copy through the Socket.IO Redis adapter (the emitter speaks the same
 * protocol, so the worker can publish too). Seat changes come from the ordered `seat_events` table; a Redis cursor only
 * avoids re-sending, and losing it merely repeats recent events (clients ignore sequence numbers they already have).
 */
export const createRealtimePublisher = (deps: { readonly redis: Redis; readonly pool: Pool; readonly debounceMs?: number }) => {
  // The emitter fires publishes without awaiting them; a closing connection would turn them into unhandled rejections.
  const quiet = { publish: (channel: string, message: string | Buffer): Promise<number> => deps.redis.publish(channel, message).catch(() => 0) };
  const emitter = new Emitter(quiet as unknown as ConstructorParameters<typeof Emitter>[0]);
  const pending = new Set<string>();
  const cursorKey = (eventId: string): string => `rt:cursor:${eventId}`;

  const flush = async (eventId: string): Promise<void> => {
    let cursor = Number(await deps.redis.get(cursorKey(eventId)).catch(() => null));
    if (!Number.isFinite(cursor) || cursor <= 0) {
      const head = (await deps.pool.query<{ seat_seq: string }>(`SELECT seat_seq FROM events WHERE id = $1`, [eventId])).rows[0]?.seat_seq;
      cursor = Math.max(0, Number(head ?? 0) - 200);
    }
    const changes = await loadChanges(deps.pool, eventId, cursor, 2_000);
    if (changes.length === 0) return;
    emitter.to(eventRoom(eventId)).emit('seat.changes', { eventId, changes });
    await deps.redis.set(cursorKey(eventId), String(changes[changes.length - 1]?.seq ?? cursor), 'EX', 3_600).catch(() => undefined);
  };

  return Object.freeze({
    /** Call after committing anything that wrote seat events. Coalesces bursts into one broadcast per event. */
    seatsChanged: (eventId: string): void => {
      if (pending.has(eventId)) return;
      pending.add(eventId);
      setTimeout(() => {
        pending.delete(eventId);
        void flush(eventId).catch(() => undefined);
      }, deps.debounceMs ?? 15);
    },
    /** Closes every open socket of a signed-out session, on whichever api copy holds it. */
    dropSession: (sessionId: string): void => {
      emitter.in(sessionRoom(sessionId)).disconnectSockets(true);
    },
    toUser: (userId: string, event: string, payload: unknown): void => {
      emitter.to(userRoom(userId)).emit(event, payload);
    },
    toEventAdmins: (eventId: string, event: string, payload: unknown): void => {
      emitter.to(adminRoom(eventId)).emit(event, payload);
    },
  });
};

export type RealtimePublisher = ReturnType<typeof createRealtimePublisher>;
