'use client';

import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useRef } from 'react';
import '@/shared/api/client';
import { paymentsControllerCheckout } from '@/shared/api/generated/sdk.gen';
import { toProblem } from '@/shared/api/problem';
import { Alert, Button } from '@/shared/ui';

/** Starts payment and sends the buyer to the provider's page. A fresh key per order lets double clicks and retries share one payment. */
export const CheckoutButton = ({ orderId, disabled }: { readonly orderId: string; readonly disabled?: boolean }) => {
  const t = useTranslations('order');
  const key = useRef(`checkout-${orderId}-${crypto.randomUUID()}`);
  const checkout = useMutation({
    mutationFn: async () => (await paymentsControllerCheckout({ path: { id: orderId }, headers: { 'Idempotency-Key': key.current }, throwOnError: true })).data,
    onSuccess: (r) => {
      window.location.href = r.paymentUrl;
    },
  });
  const problem = checkout.error ? toProblem(checkout.error) : null;
  return (
    <div className="flex flex-col gap-2">
      <Button onClick={() => checkout.mutate()} busy={checkout.isPending} disabled={disabled} data-testid="checkout">
        {t('pay')}
      </Button>
      {problem ? <Alert tone="error">{problem.code === 'PROVIDER_UNAVAILABLE' ? t('providerBusy') : problem.code === 'HOLD_EXPIRED' ? t('holdExpired') : problem.message}</Alert> : null}
    </div>
  );
};
