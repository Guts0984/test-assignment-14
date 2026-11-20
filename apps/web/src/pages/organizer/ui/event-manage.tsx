'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { createPromoRequestSchema, staffRequestSchema } from '@ticketing/shared';
import { toProblem } from '@/shared/api/problem';
import { Link } from '@/shared/i18n';
import { formatDateTime, formatMoney, type AppLocale } from '@/shared/lib/format';
import { useSession } from '@/shared/lib/session';
import { Alert, BarChart, Button, Card, SelectField, Spinner, TextField } from '@/shared/ui';
import { EventStatusBadge, useCreatePromo, useEventActions, useManagedEvent, useMyPromos, useOrganizerSales, useStaff } from '@/entities/event';
import { SeatCanvas, STATUS, effectiveStatus, useLiveSeats } from '@/entities/seatmap';
import { CancellationProgress } from '@/widgets/cancellation-progress';

const Sales = ({ eventId }: { readonly eventId: string }) => {
  const t = useTranslations('organizer');
  const locale = useLocale() as AppLocale;
  const sales = useOrganizerSales(eventId);
  const s = sales.data;
  if (!s) return <Spinner label={t('loading')} />;
  const event = s.events[0];
  return (
    <Card className="flex flex-col gap-3" data-testid="sales">
      <h2 className="font-semibold">{t('sales')}</h2>
      <p className="text-sm" data-testid="fill">
        {event ? t('fill', { sold: event.sold, capacity: event.capacity, percent: event.fillPercent }) : null}
      </p>
      <BarChart data={s.byHour.map((h) => ({ label: formatDateTime(h.hour, locale), value: h.gross }))} label={t('salesByHour')} format={(v) => formatMoney(v, locale)} />
      <table className="text-sm">
        <caption className="sr-only">{t('salesByZone')}</caption>
        <thead>
          <tr>
            <th className="text-left">{t('zone')}</th>
            <th className="text-right">{t('tickets')}</th>
            <th className="text-right">{t('gross')}</th>
          </tr>
        </thead>
        <tbody>
          {s.byZone.map((z) => (
            <tr key={z.zoneId}>
              <td>{z.zoneName}</td>
              <td className="text-right">{z.tickets}</td>
              <td className="text-right">{formatMoney(z.gross, locale)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-sm" data-testid="funnel">
        {t('funnel', { joined: s.funnel.joinedQueue, admitted: s.funnel.admitted, paid: s.funnel.paid })}
      </p>
    </Card>
  );
};

const promoFormSchema = z.object({ code: z.string().trim().min(3).max(40), kind: z.enum(['percent', 'fixed']), value: z.coerce.number().min(1), usageLimit: z.coerce.number().int().min(1) });

export const PromoCreate = ({ eventId }: { readonly eventId: string | null }) => {
  const t = useTranslations('organizer');
  const create = useCreatePromo();
  const form = useForm<z.infer<typeof promoFormSchema>>({ resolver: zodResolver(promoFormSchema), defaultValues: { code: '', kind: 'percent', value: 10, usageLimit: 100 } });
  const e = form.formState.errors;
  return (
    <form
      noValidate
      aria-label={t('newPromo')}
      className="grid gap-2 sm:grid-cols-4"
      onSubmit={form.handleSubmit((v) => {
        const body = createPromoRequestSchema.safeParse({ code: v.code, kind: v.kind, value: v.kind === 'fixed' ? Math.round(v.value * 100) : Math.round(v.value), usageLimit: v.usageLimit, eventId });
        if (!body.success) return form.setError('value', { message: body.error.issues[0]?.message ?? 'invalid' });
        create.mutate(body.data as never, { onError: (err) => form.setError('code', { type: 'server', message: toProblem(err).message }), onSuccess: () => form.reset() });
      })}
    >
      <TextField label={t('promoCode')} error={e.code?.message ? t('invalidCode') : undefined} {...form.register('code')} data-testid="promo-code" />
      <SelectField label={t('promoKind')} {...form.register('kind')}>
        <option value="percent">{t('percent')}</option>
        <option value="fixed">{t('fixed')}</option>
      </SelectField>
      <TextField label={t('promoValue')} type="number" step="any" error={e.value ? t('invalidNumber') : undefined} {...form.register('value')} data-testid="promo-value" />
      <TextField label={t('promoLimit')} type="number" error={e.usageLimit ? t('invalidNumber') : undefined} {...form.register('usageLimit')} data-testid="promo-limit" />
      <div className="sm:col-span-4">
        <Button type="submit" busy={create.isPending} data-testid="promo-create">
          {t('createPromo')}
        </Button>
        {create.isSuccess ? <span className="ml-3 text-sm text-emerald-700">{t('promoCreated')}</span> : null}
      </div>
    </form>
  );
};

export const PromoList = () => {
  const promos = useMyPromos();
  return (
    <ul className="flex flex-col gap-1 text-sm" data-testid="promo-list">
      {promos.data?.items.map((p) => (
        <li key={p.id}>
          <code>{p.code}</code> — {p.kind === 'percent' ? `${p.value}%` : p.value / 100} · {p.usedCount}/{p.usageLimit}
        </li>
      ))}
    </ul>
  );
};

const staffSchema = staffRequestSchema;

export const EventManage = ({ id }: { readonly id: string }) => {
  const t = useTranslations('organizer');
  const locale = useLocale() as AppLocale;
  const session = useSession();
  const event = useManagedEvent(id);
  const actions = useEventActions(id);
  const staff = useStaff(id);
  const live = useLiveSeats(id, { organizer: true });
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [cursor, setCursor] = useState(-1);
  const [newDate, setNewDate] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [scanner, setScanner] = useState('');
  const index = live.index;
  const tierColors = useMemo(() => ['#0ea5e9', '#a855f7', '#ec4899', '#14b8a6', '#f97316', '#84cc16'], []);
  void staffSchema;

  if (session.status === 'anonymous') return <Alert tone="info"><Link href={`/login?next=/organizer/events/${id}`} className="underline">{t('loginRequired')}</Link></Alert>;
  if (event.isLoading) return <Spinner label={t('loading')} />;
  if (!event.data) return <Alert tone="error">{t('notFound')}</Alert>;
  const e = event.data;
  const cancelled = e.status === 'cancelled';
  const blockable = !['cancelled', 'finished', 'paid_out'].includes(e.status);
  const selectedIds = index ? [...selected].map((i) => index.ids[i] ?? 0) : [];

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold" data-testid="manage-title">{e.title}</h1>
        <span data-testid="manage-status" className="rounded bg-slate-100 px-2 py-0.5 text-sm">{e.status}</span>
        <EventStatusBadge status={e.status} hasSeats={e.hasSeats} />
        <span className="text-sm text-slate-600">{formatDateTime(e.startsAt, locale)}</span>
        <Link href={`/events/${id}`} className="text-sm text-indigo-700 underline">{t('publicPage')}</Link>
      </header>
      <div className="flex flex-wrap gap-2">
        {e.status === 'draft' ? <Button onClick={() => actions.publish.mutate()} busy={actions.publish.isPending} data-testid="publish">{t('publish')}</Button> : null}
        {actions.publish.error ? <Alert tone="error">{toProblem(actions.publish.error).message}</Alert> : null}
      </div>

      {index && live.state && live.layout ? (
        <section aria-label={t('seatMap')} className="flex flex-col gap-2">
          <h2 className="font-semibold">{t('blockSeats')}</h2>
          <SeatCanvas
            index={index}
            statusOf={(i) => effectiveStatus(live.state ?? { seq: 0, status: new Uint8Array(), heldUntil: new Map(), general: new Map() }, i, index.ids[i] ?? 0, live.serverNow())}
            selected={selected}
            mine={new Set()}
            tierColors={tierColors}
            onToggle={(i) => setSelected((p) => { const n = new Set(p); if (n.has(i)) n.delete(i); else n.add(i); return n; })}
            onToggleMany={(list) => setSelected((p) => new Set([...p, ...list]))}
            describe={(i) => `${index.row[i]}-${index.number[i]} (${['free', 'held', 'sold', 'blocked'][live.state?.status[i] ?? 0]})`}
            ariaLabel={t('seatMap')}
            instructions={t('mapHelp')}
            version={(live.state?.seq ?? 0) * 1000 + selected.size}
            cursor={cursor}
            onCursor={setCursor}
          />
          <div className="flex gap-2">
            <Button variant="secondary" disabled={!blockable || selected.size === 0} busy={actions.block.isPending} onClick={() => actions.block.mutate({ seatIds: selectedIds, blocked: true }, { onSuccess: () => setSelected(new Set()) })} data-testid="block">
              {t('block', { count: selected.size })}
            </Button>
            <Button variant="secondary" disabled={!blockable || selected.size === 0} busy={actions.block.isPending} onClick={() => actions.block.mutate({ seatIds: selectedIds, blocked: false }, { onSuccess: () => setSelected(new Set()) })}>
              {t('unblock', { count: selected.size })}
            </Button>
          </div>
          {actions.block.error ? <Alert tone="error">{toProblem(actions.block.error).message}</Alert> : null}
          <p className="text-sm text-slate-600">{t('blockedNow', { count: [...(live.state?.status ?? [])].filter((s) => s === STATUS.blocked).length })}</p>
        </section>
      ) : null}

      {cancelled ? <CancellationProgress eventId={id} /> : null}
      {!cancelled ? <Sales eventId={id} /> : null}

      {!cancelled && e.status !== 'draft' ? (
        <Card className="flex flex-col gap-2">
          <h2 className="font-semibold">{t('reschedule')}</h2>
          <form
            className="flex items-end gap-2"
            onSubmit={(ev) => {
              ev.preventDefault();
              if (newDate) actions.reschedule.mutate(new Date(newDate).toISOString());
            }}
          >
            <TextField label={t('newDate')} type="datetime-local" value={newDate} onChange={(x) => setNewDate(x.target.value)} data-testid="reschedule-date" />
            <Button type="submit" variant="secondary" busy={actions.reschedule.isPending} data-testid="reschedule">{t('rescheduleDo')}</Button>
          </form>
          {actions.reschedule.error ? <Alert tone="error">{toProblem(actions.reschedule.error).message}</Alert> : null}
          {actions.reschedule.isSuccess ? <Alert tone="success">{t('rescheduled')}</Alert> : null}
        </Card>
      ) : null}

      <Card className="flex flex-col gap-2">
        <h2 className="font-semibold">{t('scanners')}</h2>
        <ul className="text-sm" data-testid="staff-list">{staff.data?.items.map((s) => <li key={s.userId}>{s.displayName} ({s.email})</li>)}</ul>
        <form className="flex items-end gap-2" onSubmit={(ev) => { ev.preventDefault(); if (scanner) actions.assignScanner.mutate(scanner, { onSuccess: () => setScanner('') }); }}>
          <TextField label={t('scannerEmail')} type="email" value={scanner} onChange={(x) => setScanner(x.target.value)} data-testid="staff-email" />
          <Button type="submit" variant="secondary" busy={actions.assignScanner.isPending} data-testid="staff-add">{t('assign')}</Button>
        </form>
        {actions.assignScanner.error ? <Alert tone="error">{toProblem(actions.assignScanner.error).message}</Alert> : null}
      </Card>

      <Card className="flex flex-col gap-2">
        <h2 className="font-semibold">{t('promos')}</h2>
        <PromoCreate eventId={id} />
        <PromoList />
      </Card>

      {!cancelled && e.status !== 'finished' && e.status !== 'paid_out' ? (
        <Card className="flex flex-col gap-2 border-red-200">
          <h2 className="font-semibold text-red-800">{t('cancelEvent')}</h2>
          <p className="text-sm">{t('cancelWarning')}</p>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={confirmCancel} onChange={(x) => setConfirmCancel(x.target.checked)} data-testid="cancel-confirm" />
            {t('cancelConfirm')}
          </label>
          <div>
            <Button variant="danger" disabled={!confirmCancel} busy={actions.cancel.isPending} onClick={() => actions.cancel.mutate()} data-testid="cancel-event">
              {t('cancelDo')}
            </Button>
          </div>
          {actions.cancel.error ? <Alert tone="error">{toProblem(actions.cancel.error).message}</Alert> : null}
        </Card>
      ) : null}
    </div>
  );
};
