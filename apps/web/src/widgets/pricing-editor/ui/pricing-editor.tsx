'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import type { VenueGeometryDto } from '@/shared/api/generated/types.gen';
import { Alert, Button, Card, SelectField, TextField } from '@/shared/ui';
import { SeatCanvas, buildSeatIndex } from '@/entities/seatmap';
import { buildPricing, type PricingPayload, type TierDraft } from '../model/pricing';

const COLORS = ['#0ea5e9', '#a855f7', '#ec4899', '#14b8a6', '#f97316', '#84cc16'];

/**
 * Prices are assigned by selecting seats on the map (click, keyboard, or Shift + drag for a rectangle) and choosing a
 * tier; whole zones and the dance floor have shortcuts. `onPayload` receives the finished payload, or null while
 * something is still unpriced.
 */
export const PricingEditor = ({ geometry, onPayload }: { readonly geometry: VenueGeometryDto; readonly onPayload: (payload: PricingPayload | null) => void }) => {
  const t = useTranslations('pricing');
  const [tiers, setTiers] = useState<readonly TierDraft[]>([{ name: 'Standard', price: '1000' }]);
  const [seatTier, setSeatTier] = useState<ReadonlyMap<number, number>>(new Map());
  const [generalTier, setGeneralTier] = useState<ReadonlyMap<string, number>>(new Map());
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [cursor, setCursor] = useState(-1);

  const base = useMemo(() => buildSeatIndex({ seats: { ...geometry.seats, tier: geometry.seats.id.map(() => -1) } }), [geometry]);
  const index = useMemo(() => ({ ...base, tier: Int16Array.from(geometry.seats.id.map((id) => seatTier.get(id) ?? -1)) }), [base, geometry, seatTier]);
  const seatsByZone = useMemo(() => {
    const m = new Map<string, number[]>();
    geometry.seats.id.forEach((id, i) => {
      const zone = geometry.zones[geometry.seats.zone[i] ?? 0];
      if (zone) m.set(zone.id, [...(m.get(zone.id) ?? []), id]);
    });
    return m;
  }, [geometry]);
  const unpriced = geometry.seats.id.filter((id) => !seatTier.has(id)).length;

  useEffect(() => {
    onPayload(buildPricing(tiers, seatTier, seatsByZone, geometry.zones, generalTier));
  }, [tiers, seatTier, seatsByZone, geometry.zones, generalTier, onPayload]);

  const assign = (tier: number): void => {
    setSeatTier((prev) => {
      const next = new Map(prev);
      selected.forEach((i) => next.set(index.ids[i] ?? 0, tier));
      return next;
    });
    setSelected(new Set());
  };
  const assignZone = (zoneId: string, tier: number): void =>
    setSeatTier((prev) => {
      const next = new Map(prev);
      (seatsByZone.get(zoneId) ?? []).forEach((id) => next.set(id, tier));
      return next;
    });
  const toggle = (i: number): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <SeatCanvas
        index={index}
        statusOf={() => 0}
        selected={selected}
        mine={new Set()}
        tierColors={COLORS}
        onToggle={toggle}
        onToggleMany={(list) => setSelected((prev) => new Set([...prev, ...list]))}
        describe={(i) => `${index.row[i]}-${index.number[i]}`}
        ariaLabel={t('mapLabel')}
        instructions={t('instructions')}
        version={selected.size + seatTier.size}
        cursor={cursor}
        onCursor={setCursor}
      />
      <div className="flex flex-col gap-3">
        <Card className="flex flex-col gap-2">
          <h3 className="font-semibold">{t('tiers')}</h3>
          {tiers.map((tier, i) => (
            <div key={i} className="flex items-end gap-2">
              <span className="mb-3 inline-block size-3 rounded-sm" style={{ background: COLORS[i % COLORS.length] }} aria-hidden />
              <TextField label={t('tierName')} value={tier.name} onChange={(e) => setTiers((p) => p.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} data-testid={`tier-name-${i}`} />
              <TextField label={t('tierPrice')} inputMode="decimal" value={tier.price} onChange={(e) => setTiers((p) => p.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} className="w-24" data-testid={`tier-price-${i}`} />
              <Button variant="secondary" disabled={selected.size === 0} onClick={() => assign(i)} data-testid={`assign-${i}`}>
                {t('assign', { count: selected.size })}
              </Button>
            </div>
          ))}
          {tiers.length < 6 ? (
            <Button variant="ghost" onClick={() => setTiers((p) => [...p, { name: '', price: '' }])}>
              {t('addTier')}
            </Button>
          ) : null}
        </Card>
        <Card className="flex flex-col gap-2">
          <h3 className="font-semibold">{t('zones')}</h3>
          {geometry.zones.map((z) =>
            z.kind === 'general' ? (
              <SelectField key={z.id} label={`${z.name} (${z.capacity})`} value={generalTier.get(z.id) ?? ''} onChange={(e) => setGeneralTier((p) => new Map(p).set(z.id, Number(e.target.value)))} data-testid={`floor-tier-${z.key}`}>
                <option value="" disabled>
                  {t('chooseTier')}
                </option>
                {tiers.map((tier, i) => (
                  <option key={i} value={i}>
                    {tier.name || `#${i + 1}`}
                  </option>
                ))}
              </SelectField>
            ) : (
              <div key={z.id} className="flex items-center justify-between gap-2 text-sm">
                <span>
                  {z.name} ({z.capacity})
                </span>
                <div className="flex gap-1">
                  {tiers.map((tier, i) => (
                    <Button key={i} variant="secondary" onClick={() => assignZone(z.id, i)} data-testid={`zone-${z.key}-tier-${i}`}>
                      {tier.name || `#${i + 1}`}
                    </Button>
                  ))}
                </div>
              </div>
            ),
          )}
        </Card>
        <Alert tone={unpriced === 0 ? 'success' : 'info'} data-testid="unpriced">
          {t('unpriced', { count: unpriced })}
        </Alert>
      </div>
    </div>
  );
};
