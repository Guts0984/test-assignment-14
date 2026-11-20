'use client';

import { useLocale, useTranslations } from 'next-intl';
import { formatDateTime, formatMoney, type AppLocale } from '@/shared/lib/format';
import { Alert, Spinner } from '@/shared/ui';
import { EventStatusBadge, useEventDetail } from '@/entities/event';
import { EventBooking } from '@/widgets/event-booking';

export const EventPage = ({ id }: { readonly id: string }) => {
  const t = useTranslations('event');
  const locale = useLocale() as AppLocale;
  const q = useEventDetail(id);
  if (q.isLoading) return <Spinner label={t('loading')} />;
  if (q.isError || !q.data) return <Alert tone="error">{t('notFound')}</Alert>;
  const e = q.data;
  const bookable = ['on_sale', 'sold_out', 'rescheduled'].includes(e.status);
  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold" data-testid="event-title">
            {e.title}
          </h1>
          <EventStatusBadge status={e.status} hasSeats={e.hasSeats} />
        </div>
        <p className="text-slate-700" data-testid="event-when">
          {formatDateTime(e.startsAt, locale)} · {e.city} · {e.venueName}
        </p>
        {e.rescheduledAt ? <Alert tone="warning">{t('rescheduledNote')}</Alert> : null}
        {e.description ? <p className="mt-2 max-w-3xl whitespace-pre-line text-slate-800">{e.description}</p> : null}
        <p className="text-sm text-slate-600">
          {t('limit', { count: e.perPersonLimit })} · {e.minPrice !== null ? t('from', { price: formatMoney(e.minPrice, locale) }) : null}
        </p>
      </header>
      {e.status === 'cancelled' ? <Alert tone="error">{t('cancelledNote')}</Alert> : null}
      {bookable ? <EventBooking event={e} /> : null}
    </div>
  );
};
