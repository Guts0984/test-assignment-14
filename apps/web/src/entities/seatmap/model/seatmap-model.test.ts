import { describe, expect, it } from 'vitest';
import { buildSeatIndex, hitTest, moveCursor } from './seat-index';
import { applyChanges, effectiveStatus, fromSnapshot, type SeatChange } from './seat-state';

const grid = (rows: number, cols: number) => {
  const ids: number[] = [];
  const x: number[] = [];
  const y: number[] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      ids.push(100 + r * cols + c);
      x.push(c * 12);
      y.push(r * 14);
    }
  }
  return { seats: { id: ids, x, y, zone: ids.map(() => 0), tier: ids.map(() => 0), row: ids.map(() => '1'), number: ids.map((_, i) => i + 1) } };
};

const snapshot = (n: number) => ({ eventId: 'e', seq: 5, serverTime: '2027-01-01T00:00:00Z', status: Array.from({ length: n }, () => 0), heldUntil: [] as [number, number][], general: [] });
const change = (seq: number, seatId: number, status: string, heldUntil: number | null = null): SeatChange => ({ seq, seatId, zoneId: null, status, heldUntil, available: null });

describe('seat index', () => {
  const index = buildSeatIndex(grid(10, 10));
  it('finds the seat under a point and nothing in empty space', () => {
    expect(hitTest(index, 12, 14, 5)).toBe(11);
    expect(hitTest(index, 500, 500, 5)).toBe(-1);
  });
  it('keyboard moves go to the neighbour in that direction and stop at the edge', () => {
    expect(moveCursor(index, 11, 'right')).toBe(12);
    expect(moveCursor(index, 11, 'left')).toBe(10);
    expect(moveCursor(index, 11, 'down')).toBe(21);
    expect(moveCursor(index, 11, 'up')).toBe(1);
    expect(moveCursor(index, 0, 'left')).toBe(0);
    expect(moveCursor(index, 99, 'down')).toBe(99);
  });
  it('handles 10 000 seats quickly', () => {
    const big = buildSeatIndex(grid(100, 100));
    const started = performance.now();
    for (let i = 0; i < 1_000; i += 1) hitTest(big, (i % 100) * 12, Math.floor(i / 10) * 14, 5);
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe('live state reducer', () => {
  const index = buildSeatIndex(grid(2, 3));
  const base = fromSnapshot(snapshot(6));

  it('applies changes in sequence order even when they arrive shuffled', () => {
    const next = applyChanges(index, base, [change(8, 101, 'free'), change(7, 101, 'held', 99), change(6, 102, 'sold')]);
    expect(next.status[1]).toBe(0); // 7 held, then 8 free
    expect(next.status[2]).toBe(2);
    expect(next.seq).toBe(8);
  });
  it('ignores stale and repeated events (never shows an outdated status)', () => {
    const live = applyChanges(index, base, [change(9, 100, 'held', 5)]);
    const again = applyChanges(index, live, [change(9, 100, 'free'), change(6, 100, 'free'), change(5, 100, 'sold')]);
    expect(again).toBe(live);
    expect(again.status[0]).toBe(1);
  });
  it('a reconnect catch-up that overlaps the live stream converges to the same state', () => {
    const live = applyChanges(index, base, [change(6, 100, 'held', 1), change(7, 103, 'sold')]);
    const caught = applyChanges(index, live, [change(6, 100, 'held', 1), change(7, 103, 'sold'), change(8, 104, 'blocked')]);
    expect(caught.status[3]).toBe(2);
    expect(caught.status[4]).toBe(3);
    expect(caught.seq).toBe(8);
  });
  it('an expired hold counts as free by the server clock', () => {
    const held = applyChanges(index, base, [change(6, 100, 'held', 1_000)]);
    expect(effectiveStatus(held, 0, 100, 999)).toBe(1);
    expect(effectiveStatus(held, 0, 100, 1_000)).toBe(0);
  });
  it('tracks dance-floor availability and ignores unknown seats', () => {
    const next = applyChanges(index, base, [{ seq: 6, seatId: null, zoneId: 'zone-1', status: 'zone', heldUntil: null, available: 17 }, change(7, 9_999, 'sold')]);
    expect(next.general.get('zone-1')).toBe(17);
    expect(next.status.every((s) => s === 0)).toBe(true);
  });
});
