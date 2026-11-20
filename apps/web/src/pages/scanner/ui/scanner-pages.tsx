'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/shared/i18n';
import { formatDateTime, type AppLocale } from '@/shared/lib/format';
import { useSession } from '@/shared/lib/session';
import { Alert, Card, Spinner } from '@/shared/ui';
import { ScanConsole } from '@/features/scan-ticket';
import { useScannerEvents } from '@/entities/scan';

export const ScannerHome = () => {
  const t = useTranslations('scanner');
  const locale = useLocale() as AppLocale;
  const session = useSession();
  const events = useScannerEvents();
  if (session.status === 'anonymous') return <Alert tone="info"><Link href="/login?next=/scanner" className="underline">{t('loginRequired')}</Link></Alert>;
  if (events.isLoading) return <Spinner label={t('loading')} />;
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      {events.data?.items.length === 0 ? <Alert tone="info">{t('noEvents')}</Alert> : null}
      <ul className="flex flex-col gap-2">
        {events.data?.items.map((e) => (
          <li key={e.id}>
            <Card className="flex items-center justify-between">
              <Link href={`/scanner/${e.id}`} className="font-medium text-indigo-700 underline" data-testid="scanner-event">
                {e.title}
              </Link>
              <span className="text-sm text-slate-600">{formatDateTime(e.startsAt, locale)}</span>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
};

export const ScannerEvent = ({ id }: { readonly id: string }) => {
  const t = useTranslations('scanner');
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{t('entrance')}</h1>
      <ScanConsole eventId={id} />
    </div>
  );
};
