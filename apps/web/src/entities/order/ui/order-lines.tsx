'use client';

import { useLocale, useTranslations } from 'next-intl';
import type { OrderDto } from '@/shared/api/generated/types.gen';
import { formatCountdown, formatMoney, type AppLocale } from '@/shared/lib/format';
import { Badge } from '@/shared/ui';
import { useHoldRemaining } from '../model/timer';

export const OrderStatusBadge = ({ status }: { readonly status: string }) => {
  const t = useTranslations('order.status');
  return <Badge tone={status === 'paid' ? 'good' : status === 'expired' || status === 'refunded' ? 'bad' : 'warn'}>{t(status)}</Badge>;
};

export const HoldTimer = ({ expiresAt }: { readonly expiresAt: string | null }) => {
  const t = useTranslations('order');
  const left = useHoldRemaining(expiresAt);
  if (left === null) return null;
  return (
    <p role="timer" aria-live="off" data-testid="hold-timer" className={left < 60_000 ? 'font-semibold text-red-700' : 'font-semibold'}>
      {left > 0 ? t('timeLeft', { time: formatCountdown(left) }) : t('holdExpired')}
    </p>
  );
};

export const OrderTotals = ({ order }: { readonly order: OrderDto }) => {
  const t = useTranslations('order');
  const locale = useLocale() as AppLocale;
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm" data-testid="order-totals">
      <dt>{t('subtotal')}</dt>
      <dd>{formatMoney(order.subtotal, locale)}</dd>
      {order.discount > 0 ? (
        <>
          <dt>{t('discount', { code: order.promoCode ?? '' })}</dt>
          <dd>−{formatMoney(order.discount, locale)}</dd>
        </>
      ) : null}
      <dt>{t('serviceFee')}</dt>
      <dd>{formatMoney(order.fee, locale)}</dd>
      <dt className="font-semibold">{t('total')}</dt>
      <dd className="font-semibold" data-testid="order-total">
        {formatMoney(order.total, locale)}
      </dd>
    </dl>
  );
};
