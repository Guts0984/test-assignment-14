'use client';

import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { venueLayoutSchema } from '@ticketing/shared';
import { toProblem } from '@/shared/api/problem';
import { Link } from '@/shared/i18n';
import { formatDateTime, type AppLocale } from '@/shared/lib/format';
import { useSession } from '@/shared/lib/session';
import { Alert, Badge, Button, Card, Spinner, TextAreaField } from '@/shared/ui';
import { useLocale } from 'next-intl';
import { EventStatusBadge, useMyEvents } from '@/entities/event';
import { useMyVenues, useUploadVenue } from '@/entities/venue';

const SAMPLE = JSON.stringify({ name: 'My hall', city: 'Kyiv', zones: [{ id: 'A', name: 'Stalls', kind: 'seated', rows: [{ label: '1', seats: [{ number: 1, x: 0, y: 0 }, { number: 2, x: 12, y: 0 }, { number: 3, x: 24, y: 0 }] }] }, { id: 'F', name: 'Dance floor', kind: 'general', capacity: 200 }] }, null, 2);

const VenueUpload = () => {
  const t = useTranslations('organizer');
  const upload = useUploadVenue();
  const [text, setText] = useState(SAMPLE);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const submit = (): void => {
    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setError(t('invalidJson'));
      return;
    }
    const checked = venueLayoutSchema.safeParse(parsed);
    if (!checked.success) {
      setError(checked.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      return;
    }
    upload.mutate(checked.data as never, { onError: (e) => setError(toProblem(e).message) });
  };
  return (
    <Card className="flex flex-col gap-2">
      <h2 className="font-semibold">{t('uploadVenue')}</h2>
      <TextAreaField label={t('venueJson')} rows={8} value={text} onChange={(e) => setText(e.target.value)} error={error ?? undefined} data-testid="venue-json" />
      <input ref={file} type="file" accept="application/json,.json" aria-label={t('venueFile')} className="text-sm" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()); }} />
      <Button onClick={submit} busy={upload.isPending} data-testid="venue-upload">
        {t('upload')}
      </Button>
      {upload.isSuccess ? <Alert tone="success">{t('uploaded')}</Alert> : null}
    </Card>
  );
};

export const OrganizerHome = () => {
  const t = useTranslations('organizer');
  const locale = useLocale() as AppLocale;
  const session = useSession();
  const venues = useMyVenues();
  const events = useMyEvents();
  if (session.status === 'anonymous') return <Alert tone="info"><Link href="/login?next=/organizer" className="underline">{t('loginRequired')}</Link></Alert>;
  if (session.status === 'loading') return <Spinner label={t('loading')} />;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <Link href="/organizer/events/new" className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white" data-testid="new-event">
          {t('newEvent')}
        </Link>
      </div>
      <section aria-label={t('events')} className="flex flex-col gap-2">
        <h2 className="font-semibold">{t('events')}</h2>
        <ul className="flex flex-col gap-2" data-testid="my-events">
          {events.data?.items.map((e) => (
            <li key={e.id}>
              <Card className="flex flex-wrap items-center justify-between gap-2">
                <Link href={`/organizer/events/${e.id}`} className="font-medium text-indigo-700 underline">
                  {e.title}
                </Link>
                <span className="text-sm text-slate-600">{formatDateTime(e.startsAt, locale)}</span>
                <Badge>{e.status}</Badge>
                <EventStatusBadge status={e.status} hasSeats={e.hasSeats} />
              </Card>
            </li>
          ))}
        </ul>
      </section>
      <section aria-label={t('venues')} className="flex flex-col gap-2">
        <h2 className="font-semibold">{t('venues')}</h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {venues.data?.items.map((v) => (
            <li key={v.id}>
              <Card>
                <p className="font-medium">{v.name}</p>
                <p className="text-sm text-slate-600">
                  {v.city} · {t('capacity', { count: v.capacity })}
                </p>
              </Card>
            </li>
          ))}
        </ul>
        <VenueUpload />
      </section>
      <Link href="/organizer/promos" className="text-indigo-700 underline">
        {t('promos')}
      </Link>
    </div>
  );
};
