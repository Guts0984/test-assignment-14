'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/shared/i18n';
import { formatDateTime, formatMoney, type AppLocale } from '@/shared/lib/format';
import { useSession } from '@/shared/lib/session';
import { Alert, Card, Spinner } from '@/shared/ui';
import { CheckoutButton } from '@/features/order-actions';
import { HoldTimer, OrderStatusBadge, RefundStateBadge, OrderTotals, useOrder, useOrderHistory, useOrderRefunds } from '@/entities/order';

export const OrderPage = ({ id }: { readonly id: string }) => {
  const t = useTranslations('order');
  const locale = useLocale() as AppLocale;
  const session = useSession();
  const order = useOrder(id);
  const history = useOrderHistory(id);
  const refunds = useOrderRefunds(id);
  const refundsSettled = (refunds.data?.items ?? []).every((r) => r.status === 'succeeded');
  if (session.status === 'anonymous') return <Alert tone="info"><Link href={`/login?next=/orders/${id}`} className="underline">{t('loginRequired')}</Link></Alert>;
  if (order.isLoading || session.status === 'loading') return <Spinner label={t('loading')} />;
  if (order.isError || !order.data) return <Alert tone="error">{t('notFound')}</Alert>;
  const o = order.data;
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <OrderStatusBadge status={o.status} />
              <RefundStateBadge state={o.refundState} />
      </div>
      {o.status === 'awaiting_payment' ? (
        <Alert tone="info" data-testid="awaiting">
          {t('awaitingPayment')} <HoldTimer expiresAt={o.holdExpiresAt} />
        </Alert>
      ) : null}
      {o.status === 'paid' || o.status === 'partially_refunded' ? (
        <Alert tone="success" data-testid="paid-banner">
          {t('paidBanner')} <Link href="/tickets" className="underline">{t('goToTickets')}</Link>
        </Alert>
      ) : null}
      {o.status === 'expired' ? <Alert tone="error">{t('expiredBanner')}</Alert> : null}
      {o.status === 'refunded' && refundsSettled ? <Alert tone="warning">{t('refundedBanner')}</Alert> : null}
      {refunds.data && refunds.data.items.length > 0 ? (
        <section aria-label={t('refunds')} data-testid="refunds">
          <h2 className="mb-2 font-semibold">{t('refunds')}</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {refunds.data.items.map((r) => (
              <li key={r.id} data-testid="refund-state" data-status={r.status} className={r.status === 'failed' ? 'text-red-700' : undefined}>
                {t(`refundState.${r.status}`, { amount: formatMoney(r.amount, locale) })}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <Card className="flex flex-col gap-3">
        <ul className="flex flex-col gap-1 text-sm">
          {o.items.map((i) => (
            <li key={i.id} className="flex justify-between">
              <span>{i.seatId !== null ? t('seat', { id: i.seatId }) : t('floorPlace')}</span>
              <span>{formatMoney(i.price - i.discount, locale)}</span>
            </li>
          ))}
        </ul>
        <OrderTotals order={o} />
        {o.status === 'awaiting_payment' ? <CheckoutButton orderId={o.id} /> : null}
      </Card>
      <section aria-label={t('history')}>
        <h2 className="mb-2 font-semibold">{t('history')}</h2>
        <ol className="flex flex-col gap-1 text-sm" data-testid="history">
          {history.data?.items.map((h, i) => (
            <li key={i}>
              {formatDateTime(h.at, locale)} — {t(`historyType.${h.type}`)} <span className="text-slate-500">({h.actorRole})</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
};
