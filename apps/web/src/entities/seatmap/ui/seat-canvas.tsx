'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { hitTest, moveCursor, type SeatIndex } from '../model/seat-index';
import { STATUS } from '../model/seat-state';

export interface SeatCanvasProps {
  readonly index: SeatIndex;
  /** Effective status per seat index (0 free, 1 held, 2 sold, 3 blocked). Called at draw time. */
  readonly statusOf: (seatIndex: number) => number;
  readonly selected: ReadonlySet<number>;
  /** Seats the viewer already holds. */
  readonly mine: ReadonlySet<number>;
  readonly tierColors: readonly string[];
  readonly onToggle: (seatIndex: number) => void;
  /** Called for every seat inside a rubber-band rectangle (Shift + drag), used by the organizer. */
  readonly onToggleMany?: (seatIndexes: readonly number[]) => void;
  readonly describe: (seatIndex: number) => string;
  readonly ariaLabel: string;
  readonly instructions: string;
  /** Changes whenever statuses changed, so the canvas redraws. */
  readonly version: number;
  readonly cursor: number;
  readonly onCursor: (seatIndex: number) => void;
}

const COLORS = { held: '#f59e0b', sold: '#94a3b8', blocked: '#334155', mine: '#4f46e5', selected: '#16a34a', ring: '#0f172a' } as const;

interface View {
  scale: number;
  tx: number;
  ty: number;
}

/**
 * The hall on a canvas: only seats inside the viewport are drawn, so 10 000 seats pan and zoom at full frame rate.
 * Fully usable from the keyboard (arrows move, Enter/Space picks, +/- zoom, 0 resets) with a live-region announcement.
 */
export const SeatCanvas = (props: SeatCanvasProps) => {
  const { index } = props;
  const ref = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const view = useRef<View>({ scale: 1, tx: 0, ty: 0 });
  const frame = useRef(0);
  const latest = useRef(props);
  latest.current = props;
  const [announce, setAnnounce] = useState('');

  const draw = useCallback(() => {
    frame.current = 0;
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const p = latest.current;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const { scale, tx, ty } = view.current;
    const size = Math.max(2, 9 * scale);
    const half = size / 2;
    let last = '';
    for (let i = 0; i < p.index.count; i += 1) {
      const sx = (p.index.x[i] ?? 0) * scale + tx;
      const sy = (p.index.y[i] ?? 0) * scale + ty;
      if (sx < -size || sy < -size || sx > w + size || sy > h + size) continue;
      const status = p.statusOf(i);
      const color = p.selected.has(i) ? COLORS.selected : p.mine.has(i) ? COLORS.mine : status === STATUS.held ? COLORS.held : status === STATUS.sold ? COLORS.sold : status === STATUS.blocked ? COLORS.blocked : ((p.index.tier[i] ?? 0) < 0 ? '#cbd5e1' : (p.tierColors[p.index.tier[i] ?? 0] ?? '#0ea5e9'));
      if (color !== last) {
        ctx.fillStyle = color;
        last = color;
      }
      ctx.fillRect(sx - half, sy - half, size - 1, size - 1);
    }
    const c = p.cursor;
    if (c >= 0 && c < p.index.count) {
      ctx.strokeStyle = COLORS.ring;
      ctx.lineWidth = 2;
      ctx.strokeRect((p.index.x[c] ?? 0) * scale + tx - half - 2, (p.index.y[c] ?? 0) * scale + ty - half - 2, size + 3, size + 3);
    }
  }, []);

  const schedule = useCallback(() => {
    if (frame.current === 0) frame.current = requestAnimationFrame(draw);
  }, [draw]);

  const fit = useCallback(() => {
    const el = wrap.current;
    if (!el) return;
    const { minX, minY, maxX, maxY } = index.bounds;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const scale = Math.min((w - 40) / Math.max(1, maxX - minX), (h - 40) / Math.max(1, maxY - minY), 6);
    view.current = { scale, tx: (w - (maxX - minX) * scale) / 2 - minX * scale, ty: (h - (maxY - minY) * scale) / 2 - minY * scale };
    schedule();
  }, [index, schedule]);

  useEffect(() => {
    const el = wrap.current;
    const canvas = ref.current;
    if (!el || !canvas) return;
    const resize = (): void => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(el.clientWidth * dpr);
      canvas.height = Math.floor(el.clientHeight * dpr);
      canvas.style.width = `${el.clientWidth}px`;
      canvas.style.height = `${el.clientHeight}px`;
      schedule();
    };
    const observer = new ResizeObserver(() => {
      resize();
    });
    observer.observe(el);
    resize();
    fit();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame.current);
    };
  }, [fit, schedule]);

  useEffect(schedule, [props.version, props.selected, props.mine, props.cursor, schedule]);

  const toLayout = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = ref.current?.getBoundingClientRect();
    const { scale, tx, ty } = view.current;
    return { x: (clientX - (rect?.left ?? 0) - tx) / scale, y: (clientY - (rect?.top ?? 0) - ty) / scale };
  };

  const drag = useRef<{ startX: number; startY: number; tx: number; ty: number; moved: boolean; band: boolean } | null>(null);

  const zoomAt = (factor: number, cx: number, cy: number): void => {
    const v = view.current;
    const next = Math.min(40, Math.max(0.2, v.scale * factor));
    const k = next / v.scale;
    view.current = { scale: next, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k };
    schedule();
  };

  const setCursor = (i: number): void => {
    props.onCursor(i);
    if (i >= 0) {
      const { scale, tx, ty } = view.current;
      const el = wrap.current;
      const sx = (index.x[i] ?? 0) * scale + tx;
      const sy = (index.y[i] ?? 0) * scale + ty;
      if (el && (sx < 20 || sy < 20 || sx > el.clientWidth - 20 || sy > el.clientHeight - 20)) {
        view.current = { scale, tx: tx + el.clientWidth / 2 - sx, ty: ty + el.clientHeight / 2 - sy };
        schedule();
      }
      setAnnounce(props.describe(i));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const dir = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' } as const;
    const move = dir[e.key as keyof typeof dir];
    if (move) {
      e.preventDefault();
      setCursor(moveCursor(index, props.cursor, move));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (props.cursor >= 0) {
        props.onToggle(props.cursor);
        setAnnounce(props.describe(props.cursor));
      }
    } else if (e.key === '+' || e.key === '=') zoomAt(1.25, (wrap.current?.clientWidth ?? 0) / 2, (wrap.current?.clientHeight ?? 0) / 2);
    else if (e.key === '-') zoomAt(0.8, (wrap.current?.clientWidth ?? 0) / 2, (wrap.current?.clientHeight ?? 0) / 2);
    else if (e.key === '0') fit();
    else if (e.key === 'Home') setCursor(0);
    else if (e.key === 'End') setCursor(index.count - 1);
  };

  return (
    <div ref={wrap} className="relative h-[min(70vh,640px)] min-h-72 w-full overflow-hidden rounded-lg border border-slate-300 bg-white">
      <canvas
        ref={ref}
        data-testid="seat-canvas"
        data-seat-count={index.count}
        tabIndex={0}
        role="application"
        aria-label={props.ariaLabel}
        aria-roledescription="seat map"
        aria-describedby="seat-map-help"
        className="block touch-none cursor-crosshair"
        onKeyDown={onKeyDown}
        onFocus={() => {
          if (props.cursor < 0 && index.count > 0) setCursor(0);
        }}
        onWheel={(e) => {
          const rect = ref.current?.getBoundingClientRect();
          zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - (rect?.left ?? 0), e.clientY - (rect?.top ?? 0));
        }}
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture(e.pointerId);
          drag.current = { startX: e.clientX, startY: e.clientY, tx: view.current.tx, ty: view.current.ty, moved: false, band: e.shiftKey && props.onToggleMany !== undefined };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.startX;
          const dy = e.clientY - d.startY;
          if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
          if (d.moved && !d.band) {
            view.current = { ...view.current, tx: d.tx + dx, ty: d.ty + dy };
            schedule();
          }
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (!d) return;
          if (d.band && d.moved) {
            const a = toLayout(d.startX, d.startY);
            const b = toLayout(e.clientX, e.clientY);
            const inside: number[] = [];
            for (let i = 0; i < index.count; i += 1) {
              const x = index.x[i] ?? 0;
              const y = index.y[i] ?? 0;
              if (x >= Math.min(a.x, b.x) && x <= Math.max(a.x, b.x) && y >= Math.min(a.y, b.y) && y <= Math.max(a.y, b.y)) inside.push(i);
            }
            props.onToggleMany?.(inside);
            return;
          }
          if (d.moved) return;
          const p = toLayout(e.clientX, e.clientY);
          const i = hitTest(index, p.x, p.y, Math.max(5, 7 / view.current.scale));
          if (i >= 0) {
            props.onCursor(i);
            props.onToggle(i);
            setAnnounce(props.describe(i));
          }
        }}
      />
      <p id="seat-map-help" className="sr-only">
        {props.instructions}
      </p>
      <div aria-live="polite" role="status" className="sr-only-live" data-testid="seat-announcer">
        {announce}
      </div>
    </div>
  );
};
