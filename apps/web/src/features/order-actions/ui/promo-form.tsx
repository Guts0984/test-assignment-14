'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import '@/shared/api/client';
import { ordersControllerListOptions } from '@/shared/api/generated/@tanstack/react-query.gen';
import { ordersControllerApplyPromo, ordersControllerRemovePromo } from '@/shared/api/generated/sdk.gen';
import { toProblem } from '@/shared/api/problem';
import { Alert, Button, TextField } from '@/shared/ui';

export const PromoForm = ({ orderId, promoCode }: { readonly orderId: string; readonly promoCode: string | null }) => {
  const t = useTranslations('order');
  const qc = useQueryClient();
  const form = useForm<{ code: string }>({ defaultValues: { code: '' } });
  const refresh = (): void => void qc.invalidateQueries({ queryKey: ordersControllerListOptions().queryKey });
  const apply = useMutation({
    mutationFn: async (code: string) => (await ordersControllerApplyPromo({ path: { id: orderId }, body: { code }, throwOnError: true })).data,
    onSuccess: refresh,
    onError: (error) => form.setError('code', { type: 'server', message: toProblem(error).code === 'PROMO_INVALID' ? t('promoInvalid') : toProblem(error).message }),
  });
  const remove = useMutation({
    mutationFn: async () => (await ordersControllerRemovePromo({ path: { id: orderId }, throwOnError: true })).data,
    onSuccess: refresh,
  });
  if (promoCode) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <Alert tone="success" className="flex-1">
          {t('promoApplied', { code: promoCode })}
        </Alert>
        <Button variant="ghost" busy={remove.isPending} onClick={() => remove.mutate()}>
          {t('promoRemove')}
        </Button>
      </div>
    );
  }
  return (
    <form noValidate onSubmit={form.handleSubmit((v) => v.code.trim() !== '' && apply.mutate(v.code.trim()))} className="flex items-end gap-2" aria-label={t('promoTitle')}>
      <div className="flex-1">
        <TextField label={t('promoCode')} autoComplete="off" error={form.formState.errors.code?.message} {...form.register('code')} />
      </div>
      <Button type="submit" variant="secondary" busy={apply.isPending}>
        {t('promoApply')}
      </Button>
    </form>
  );
};
