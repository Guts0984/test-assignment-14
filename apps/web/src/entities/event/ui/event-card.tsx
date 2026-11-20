'use client';

import { useLocale, useTranslations } from 'next-intl';
import type { EventSearchResponseDto } from '@/shared/api/generated/types.gen';
import { Link } from '@/shared/i18n';
import { formatDateTime, formatMoney, type AppLocale } from '@/shared/lib/format';
import { Badge, Card } from '@/shared/ui';

export const EventStatusBadge = ({ status, hasSeats }: { readonly status: string; readonly hasSeats: boolean }) => {
  const t = useTranslations('event.status');
  if (status === 'sold_out' || !hasSeats) return <Badge tone="bad">{t('sold_out')}</Badge>;
  if (status === 'rescheduled') return <Badge tone="warn">{t('rescheduled')}</Badge>;
  if (status === 'cancelled') return <Badge tone="bad">{t('cancelled')}</Badge>;
  return <Badge tone="good">{t('on_sale')}</Badge>;
};

export const EventCard = ({ event }: { readonly event: EventSearchResponseDto['items'][number] }) => {
  const t = useTranslations('event');
  const locale = useLocale() as AppLocale;
  return (
    <Card className="flex flex-col gap-2" data-testid="event-card">
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-lg font-semibold">
          <Link href={`/events/${event.id}`} className="hover:underline">
            {event.title}
          </Link>
        </h2>
        <EventStatusBadge status={event.status} hasSeats={event.hasSeats} />
      </div>
      <p className="text-sm text-slate-600">
        {formatDateTime(event.startsAt, locale)} · {event.city} · {event.venueName}
      </p>
      <p className="text-sm">
        {event.minPrice === null ? null : event.minPrice === event.maxPrice ? t('price', { price: formatMoney(event.minPrice, locale) }) : t('priceRange', { from: formatMoney(event.minPrice, locale), to: formatMoney(event.maxPrice ?? event.minPrice, locale) })}
      </p>
    </Card>
  );
};
