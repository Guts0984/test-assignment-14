'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/shared/i18n';
import { formatDateTime, formatMoney, type AppLocale } from '@/shared/lib/format';
import { useSession } from '@/shared/lib/session';
import { Alert, Card, Spinner } from '@/shared/ui';
import { OrderStatusBadge, useMyOrders } from '@/entities/order';

export const OrdersPage = () => {
  const t = useTranslations('order');
  const locale = useLocale() as AppLocale;
  const session = useSession();
  const orders = useMyOrders();
  if (session.status === 'anonymous') return <Alert tone="info"><Link href="/login?next=/orders" className="underline">{t('loginRequired')}</Link></Alert>;
  if (orders.isLoading) return <Spinner label={t('loading')} />;
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{t('myOrders')}</h1>
      {orders.data?.items.length === 0 ? <Alert tone="info">{t('noOrders')}</Alert> : null}
      <ul className="flex flex-col gap-2">
        {orders.data?.items.map((o) => (
          <li key={o.id}>
            <Card className="flex items-center justify-between gap-3">
              <Link href={`/orders/${o.id}`} className="font-medium text-indigo-700 underline">
                {formatDateTime(o.createdAt, locale)}
              </Link>
              <span>{t('ticketCount', { count: o.items.length })}</span>
              <span>{formatMoney(o.total, locale)}</span>
              <OrderStatusBadge status={o.status} />
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
};
