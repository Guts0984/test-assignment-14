'use client';

import { useLocale, useTranslations } from 'next-intl';
import type { OrderDto } from '@/shared/api/generated/types.gen';
import { Link } from '@/shared/i18n';
import { formatMoney, type AppLocale } from '@/shared/lib/format';
import { Button, Card } from '@/shared/ui';
import { CheckoutButton, PromoForm } from '@/features/order-actions';
import { HoldTimer, OrderTotals, useReleaseOrder, useRemoveItem } from '@/entities/order';

/** The held order: timer, tickets with a remove button, promo code, totals and the pay button. */
export const OrderPanel = ({ order, labelOf }: { readonly order: OrderDto; readonly labelOf: (item: OrderDto['items'][number]) => string }) => {
  const t = useTranslations('order');
  const locale = useLocale() as AppLocale;
  const remove = useRemoveItem();
  const release = useReleaseOrder();
  return (
    <Card className="flex flex-col gap-3" data-testid="order-panel">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">{t('yourOrder')}</h2>
        <HoldTimer expiresAt={order.holdExpiresAt} />
      </div>
      <ul className="flex flex-col gap-1 text-sm" aria-label={t('items')}>
        {order.items.map((item) => (
          <li key={item.id} className="flex items-center justify-between gap-2" data-testid="order-item">
            <span>
              {labelOf(item)} · {formatMoney(item.price, locale)}
            </span>
            <Button variant="ghost" busy={remove.isPending && remove.variables?.itemId === item.id} onClick={() => remove.mutate({ orderId: order.id, itemId: item.id })} aria-label={t('removeItem', { item: labelOf(item) })}>
              {t('remove')}
            </Button>
          </li>
        ))}
        {order.items.length === 0 ? <li className="text-slate-600">{t('empty')}</li> : null}
      </ul>
      <PromoForm orderId={order.id} promoCode={order.promoCode} />
      <OrderTotals order={order} />
      <CheckoutButton orderId={order.id} disabled={order.items.length === 0} />
      <div className="flex items-center justify-between text-sm">
        <Button variant="ghost" busy={release.isPending} onClick={() => release.mutate(order.id)}>
          {t('release')}
        </Button>
        <Link href={`/orders/${order.id}`} className="text-indigo-700 underline">
          {t('openOrder')}
        </Link>
      </div>
    </Card>
  );
};
