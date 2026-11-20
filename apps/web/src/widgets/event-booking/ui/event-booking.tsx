'use client';

import { useMutation } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useMemo, useRef, useState } from 'react';
import { RULES } from '@ticketing/shared';
import type { EventDetailDto, OrderDto } from '@/shared/api/generated/types.gen';
import { toProblem, type ApiProblem } from '@/shared/api/problem';
import { Link } from '@/shared/i18n';
import { formatMoney, type AppLocale } from '@/shared/lib/format';
import { useSession } from '@/shared/lib/session';
import { Alert, Button, Card, Spinner, TextField } from '@/shared/ui';
import { QueuePanel, WaitlistPanel } from '@/features/queue-waitlist';
import { useHold, useMyOrders } from '@/entities/order';
import { useLiveSeats } from '@/entities/seatmap';
import { OrderPanel } from './order-panel';
import { SeatPicker } from './seat-picker';

const messageFor = (t: (key: string, values?: Record<string, string | number>) => string, p: ApiProblem): string => {
  switch (p.code) {
    case 'SEAT_UNAVAILABLE': return t('errors.seatUnavailable');
    case 'LIMIT_EXCEEDED': return t('errors.limit');
    case 'QUEUE_REQUIRED': return t('errors.queueRequired');
    case 'EVENT_NOT_ON_SALE': return t('errors.notOnSale');
    case 'UNAUTHENTICATED': return t('errors.loginRequired');
    default: return p.message;
  }
};

/** Choose seats (map or dance floor quantities), hold them for 10 minutes, then pay. Live statuses, queue and waitlist included. */
export const EventBooking = ({ event }: { readonly event: EventDetailDto }) => {
  const t = useTranslations('booking');
  const locale = useLocale() as AppLocale;
  const session = useSession();
  const live = useLiveSeats(event.id);
  const orders = useMyOrders();
  const hold = useHold(event.id);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [qty, setQty] = useState<Readonly<Record<string, number>>>({});
  const [admitted, setAdmitted] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const key = useRef(crypto.randomUUID());

  const active: OrderDto | undefined = orders.data?.items.find((o) => o.eventId === event.id && o.status === 'holding' && (o.holdExpiresAt === null || Date.parse(o.holdExpiresAt) > live.serverNow() - 1_000));
  const awaiting = orders.data?.items.find((o) => o.eventId === event.id && o.status === 'awaiting_payment');
  const inOrder = active?.items.length ?? 0;
  const generalTotal = Object.values(qty).reduce((n, v) => n + v, 0);
  const free = Math.max(0, RULES.maxSeatsPerOrder - inOrder);
  const canSelectMore = selected.size + generalTotal < free;
  const index = live.index;

  const mine = useMemo(() => {
    const set = new Set<number>();
    if (index) for (const item of active?.items ?? []) if (item.seatId !== null) set.add(index.byId.get(item.seatId) ?? -1);
    return set;
  }, [active, index]);

  const labelOf = useCallback(
    (item: OrderDto['items'][number]): string => {
      if (index && item.seatId !== null) {
        const i = index.byId.get(item.seatId);
        if (i !== undefined) return t('seatLabel', { row: index.row[i] ?? '', seat: index.number[i] ?? 0 });
      }
      return t('floorPlace', { zone: live.layout?.zones.find((z) => z.id === item.zoneId)?.name ?? '' });
    },
    [index, live.layout, t],
  );

  const toggle = (i: number): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const submit = useMutation({
    mutationFn: async () => {
      const seatIds = [...selected].map((i) => index?.ids[i] ?? 0);
      const general = Object.entries(qty).filter(([, q]) => q > 0).map(([zoneId, quantity]) => ({ zoneId, quantity }));
      return hold.mutateAsync({ body: { seatIds, general }, key: key.current });
    },
    onSuccess: () => {
      setSelected(new Set());
      setQty({});
      setProblem(null);
      key.current = crypto.randomUUID();
      void live.refresh().catch(() => undefined);
    },
    onError: (error) => {
      const p = toProblem(error);
      setProblem(p);
      key.current = crypto.randomUUID();
      const gone = p.details?.['unavailableSeatIds'];
      if (Array.isArray(gone) && index) setSelected((prev) => new Set([...prev].filter((i) => !gone.includes(index.ids[i]))));
    },
  });

  if (live.loading || !live.layout || !index || !live.state) return <Spinner label={t('loading')} />;
  const soldOut = event.status === 'sold_out' || !event.hasSeats;
  const salesNotStarted = Date.parse(event.salesStartAt) > live.serverNow();
  const generalZones = event.zones.filter((z) => z.kind === 'general');
  const picked = selected.size + generalTotal;
  const needQueue = event.queueActive && !admitted;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-slate-600" aria-live="polite">
          {live.connected ? t('live') : t('polling')}
        </p>
        <SeatPicker layout={live.layout} index={index} state={live.state} serverNow={live.serverNow} selected={selected} mine={mine} canSelectMore={canSelectMore} onToggle={toggle} disabled={soldOut || salesNotStarted || needQueue} />
      </div>
      <aside className="flex flex-col gap-3" aria-label={t('panel')}>
        {salesNotStarted ? <Alert tone="info">{t('salesNotStarted')}</Alert> : null}
        {soldOut ? <WaitlistPanel eventId={event.id} /> : <QueuePanel eventId={event.id} queueActive={event.queueActive} onAdmitted={setAdmitted} autoJoin={!salesNotStarted} />}
        {generalZones.length > 0 ? (
          <Card className="flex flex-col gap-2">
            <h2 className="font-semibold">{t('floor')}</h2>
            {generalZones.map((z) => {
              const available = live.state?.general.get(z.id) ?? z.available;
              return (
                <div key={z.id} className="flex items-end gap-2">
                  <div className="flex-1">
                    <TextField
                      label={`${z.name} · ${formatMoney(z.price ?? 0, locale)} · ${t('available', { count: available })}`}
                      type="number"
                      min={0}
                      max={Math.min(available, free)}
                      value={qty[z.id] ?? 0}
                      disabled={soldOut || salesNotStarted || needQueue}
                      onChange={(e) => setQty((prev) => ({ ...prev, [z.id]: Math.max(0, Math.min(Number(e.target.value) || 0, available, free - selected.size)) }))}
                      data-testid={`floor-qty-${z.name}`}
                    />
                  </div>
                </div>
              );
            })}
          </Card>
        ) : null}
        {!soldOut ? (
          <Card className="flex flex-col gap-2">
            <p className="text-sm" data-testid="selection-summary">
              {t('selected', { count: picked })}
            </p>
            {session.status !== 'authenticated' ? (
              <Alert tone="info">
                {t('loginToHold')} <Link href={`/login?next=/events/${event.id}`} className="underline">{t('login')}</Link>
              </Alert>
            ) : (
              <Button onClick={() => submit.mutate()} busy={submit.isPending} disabled={picked === 0 || needQueue || salesNotStarted} data-testid="hold">
                {active ? t('addToOrder') : t('hold')}
              </Button>
            )}
            {problem ? <Alert tone="error" data-testid="hold-error">{messageFor(t, problem)}</Alert> : null}
          </Card>
        ) : null}
        {active ? <OrderPanel order={active} labelOf={labelOf} /> : null}
        {awaiting ? (
          <Alert tone="warning">
            {t('awaitingPayment')}{' '}
            <Link href={`/orders/${awaiting.id}`} className="underline">
              {t('openOrder')}
            </Link>
          </Alert>
        ) : null}
      </aside>
    </div>
  );
};
