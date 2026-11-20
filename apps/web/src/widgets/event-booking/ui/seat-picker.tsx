'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { SeatLayoutDto } from '@/shared/api/generated/types.gen';
import { formatMoney, type AppLocale } from '@/shared/lib/format';
import { Button, TextField } from '@/shared/ui';
import { SeatCanvas, STATUS, effectiveStatus, type SeatIndex, type SeatState } from '@/entities/seatmap';
import { tierColor } from '../model/palette';

export interface SeatPickerProps {
  readonly layout: SeatLayoutDto;
  readonly index: SeatIndex;
  readonly state: SeatState;
  readonly serverNow: () => number;
  readonly selected: ReadonlySet<number>;
  readonly mine: ReadonlySet<number>;
  readonly canSelectMore: boolean;
  readonly onToggle: (seatIndex: number) => void;
  readonly disabled: boolean;
}

/** The map, a legend with prices, and a "go to row / seat" box for keyboard and screen-reader users. */
export const SeatPicker = (props: SeatPickerProps) => {
  const { layout, index, state, serverNow, selected, mine } = props;
  const t = useTranslations('seatmap');
  const locale = useLocale() as AppLocale;
  const [cursor, setCursor] = useState(-1);
  const [row, setRow] = useState('');
  const [seat, setSeat] = useState('');
  const version = useRef(0);
  version.current += 1;
  const tierColors = useMemo(() => layout.tiers.map((_, i) => tierColor(i)), [layout.tiers]);

  const statusOf = useCallback((i: number): number => effectiveStatus(state, i, index.ids[i] ?? 0, serverNow()), [state, index, serverNow]);

  const describe = (i: number): string => {
    const zone = layout.zones[index.zone[i] ?? 0]?.name ?? '';
    const price = layout.tiers[index.tier[i] ?? 0]?.price ?? 0;
    const st = mine.has(i) ? 'mine' : selected.has(i) ? 'selected' : (['free', 'held', 'sold', 'blocked'] as const)[statusOf(i)] ?? 'free';
    return t('seatLabel', { zone, row: index.row[i] ?? '', seat: index.number[i] ?? 0, price: formatMoney(price, locale), status: t(`status.${st}`) });
  };

  const jump = (): void => {
    for (let i = 0; i < index.count; i += 1) {
      if (index.row[i] === row.trim() && String(index.number[i]) === seat.trim()) {
        setCursor(i);
        return;
      }
    }
  };

  const onToggle = (i: number): void => {
    const st = statusOf(i);
    if (props.disabled || mine.has(i) || (st !== STATUS.free && !selected.has(i))) return;
    if (!selected.has(i) && !props.canSelectMore) return;
    props.onToggle(i);
  };

  return (
    <div className="flex flex-col gap-3">
      <SeatCanvas
        index={index}
        statusOf={statusOf}
        selected={selected}
        mine={mine}
        tierColors={tierColors}
        onToggle={onToggle}
        describe={describe}
        ariaLabel={t('mapLabel')}
        instructions={t('instructions')}
        version={state.seq * 1000 + (Math.floor(serverNow() / 1000) % 1000)}
        cursor={cursor}
        onCursor={setCursor}
      />
      <ul className="flex flex-wrap gap-3 text-xs" aria-label={t('legend')}>
        {layout.tiers.map((tier, i) => (
          <li key={`${tier.name}-${i}`} className="flex items-center gap-1">
            <span className="inline-block size-3 rounded-sm" style={{ background: tierColor(i) }} aria-hidden />
            {tier.name}: {formatMoney(tier.price, locale)}
          </li>
        ))}
        {(['held', 'sold', 'blocked', 'selected', 'mine'] as const).map((s) => (
          <li key={s} className="flex items-center gap-1">
            <span className={`inline-block size-3 rounded-sm ${s === 'held' ? 'bg-amber-500' : s === 'sold' ? 'bg-slate-400' : s === 'blocked' ? 'bg-slate-700' : s === 'selected' ? 'bg-green-600' : 'bg-indigo-600'}`} aria-hidden />
            {t(`status.${s}`)}
          </li>
        ))}
      </ul>
      <form
        className="flex items-end gap-2"
        aria-label={t('jumpTitle')}
        onSubmit={(e) => {
          e.preventDefault();
          jump();
        }}
      >
        <TextField label={t('row')} value={row} onChange={(e) => setRow(e.target.value)} className="w-24" data-testid="jump-row" />
        <TextField label={t('seat')} value={seat} onChange={(e) => setSeat(e.target.value)} className="w-24" data-testid="jump-seat" />
        <Button type="submit" variant="secondary" data-testid="jump-go">
          {t('jump')}
        </Button>
      </form>
    </div>
  );
};
