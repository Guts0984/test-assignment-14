import type { SeatLayoutDto } from '@/shared/api/generated/types.gen';

export interface SeatIndex {
  readonly count: number;
  readonly ids: readonly number[];
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly zone: Int16Array;
  readonly tier: Int16Array;
  readonly row: readonly string[];
  readonly number: Int32Array;
  readonly byId: ReadonlyMap<number, number>;
  readonly bounds: { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number };
  readonly cell: number;
  readonly grid: ReadonlyMap<number, readonly number[]>;
}

const key = (cx: number, cy: number): number => cx * 100_003 + cy;

/** Typed columns plus a uniform grid: hit tests and keyboard moves touch a handful of seats, not all 10 000. */
export const buildSeatIndex = (layout: Pick<SeatLayoutDto, 'seats'>, cell = 24): SeatIndex => {
  const { id, x, y, zone, tier, row, number } = layout.seats;
  const count = id.length;
  const xs = Float32Array.from(x);
  const ys = Float32Array.from(y);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grid = new Map<number, number[]>();
  for (let i = 0; i < count; i += 1) {
    const sx = xs[i] ?? 0;
    const sy = ys[i] ?? 0;
    minX = Math.min(minX, sx);
    minY = Math.min(minY, sy);
    maxX = Math.max(maxX, sx);
    maxY = Math.max(maxY, sy);
    const k = key(Math.floor(sx / cell), Math.floor(sy / cell));
    const bucket = grid.get(k);
    if (bucket) bucket.push(i);
    else grid.set(k, [i]);
  }
  return {
    count,
    ids: id,
    x: xs,
    y: ys,
    zone: Int16Array.from(zone),
    tier: Int16Array.from(tier),
    row,
    number: Int32Array.from(number),
    byId: new Map(id.map((seatId, i) => [seatId, i])),
    bounds: count === 0 ? { minX: 0, minY: 0, maxX: 1, maxY: 1 } : { minX, minY, maxX, maxY },
    cell,
    grid,
  };
};

const around = (index: SeatIndex, px: number, py: number, rings: number): number[] => {
  const cx = Math.floor(px / index.cell);
  const cy = Math.floor(py / index.cell);
  const found: number[] = [];
  for (let dx = -rings; dx <= rings; dx += 1) {
    for (let dy = -rings; dy <= rings; dy += 1) found.push(...(index.grid.get(key(cx + dx, cy + dy)) ?? []));
  }
  return found;
};

/** The seat under a point in layout coordinates (within `radius`), or -1. */
export const hitTest = (index: SeatIndex, px: number, py: number, radius: number): number => {
  let best = -1;
  let bestD = radius * radius;
  for (const i of around(index, px, py, Math.ceil(radius / index.cell))) {
    const dx = (index.x[i] ?? 0) - px;
    const dy = (index.y[i] ?? 0) - py;
    const d = dx * dx + dy * dy;
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
};

export type Direction = 'left' | 'right' | 'up' | 'down';

/** Next seat in a direction for keyboard navigation: nearest seat inside a 45 degree cone, widening the search ring by ring. */
export const moveCursor = (index: SeatIndex, from: number, direction: Direction): number => {
  if (index.count === 0) return -1;
  if (from < 0) return 0;
  const fx = index.x[from] ?? 0;
  const fy = index.y[from] ?? 0;
  for (let rings = 1; rings <= 40; rings += 1) {
    let best = -1;
    let bestScore = Infinity;
    for (const i of around(index, fx, fy, rings)) {
      if (i === from) continue;
      const dx = (index.x[i] ?? 0) - fx;
      const dy = (index.y[i] ?? 0) - fy;
      const along = direction === 'right' ? dx : direction === 'left' ? -dx : direction === 'down' ? dy : -dy;
      const across = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx);
      if (along <= 0.01 || across > along * 1.2 + 4) continue;
      const score = along * along + across * across * 3;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best >= 0) return best;
  }
  return from;
};
