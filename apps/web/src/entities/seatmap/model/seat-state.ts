import type { SeatStateDto } from '@/shared/api/generated/types.gen';
import type { SeatIndex } from './seat-index';

export const STATUS = { free: 0, held: 1, sold: 2, blocked: 3 } as const;
const BY_NAME: Readonly<Record<string, number>> = STATUS;

export interface SeatChange {
  readonly seq: number;
  readonly seatId: number | null;
  readonly zoneId: string | null;
  readonly status: string;
  readonly heldUntil: number | null;
  readonly available: number | null;
}

export interface SeatState {
  readonly seq: number;
  readonly status: Uint8Array;
  readonly heldUntil: ReadonlyMap<number, number>;
  readonly general: ReadonlyMap<string, number>;
}

export const fromSnapshot = (snapshot: SeatStateDto): SeatState => ({
  seq: snapshot.seq,
  status: Uint8Array.from(snapshot.status),
  heldUntil: new Map(snapshot.heldUntil.map(([id, until]) => [id, until] as [number, number])),
  general: new Map(snapshot.general.map((g) => [g.zoneId, g.available] as [string, number])),
});

/**
 * Applies live changes. Anything at or below the sequence already held is stale and ignored, so an out-of-order or
 * repeated delivery (reconnect catch-up overlapping the live stream) can never show an outdated status. Changes are
 * applied in sequence order whatever the order they arrived in.
 */
export const applyChanges = (index: SeatIndex, state: SeatState, changes: readonly SeatChange[]): SeatState => {
  const fresh = changes.filter((c) => c.seq > state.seq).sort((a, b) => a.seq - b.seq);
  if (fresh.length === 0) return state;
  const status = Uint8Array.from(state.status);
  const heldUntil = new Map(state.heldUntil);
  const general = new Map(state.general);
  for (const c of fresh) {
    if (c.seatId !== null) {
      const i = index.byId.get(c.seatId);
      if (i === undefined) continue;
      status[i] = BY_NAME[c.status] ?? 0;
      if (c.status === 'held' && c.heldUntil !== null) heldUntil.set(c.seatId, c.heldUntil);
      else heldUntil.delete(c.seatId);
    } else if (c.zoneId !== null && c.available !== null) {
      general.set(c.zoneId, c.available);
    }
  }
  return { seq: fresh[fresh.length - 1]?.seq ?? state.seq, status, heldUntil, general };
};

/** A hold whose expiry passed (by the server clock) is free again, even before any event says so. */
export const effectiveStatus = (state: SeatState, seatIndex: number, seatId: number, serverNowMs: number): number => {
  const s = state.status[seatIndex] ?? 0;
  if (s !== STATUS.held) return s;
  const until = state.heldUntil.get(seatId);
  return until !== undefined && until <= serverNowMs ? STATUS.free : s;
};
