'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import '@/shared/api/client';
import { refundsControllerFailedOptions, reportsControllerFinanceOptions, reportsControllerJobsOptions, reportsControllerReconciliationOptions } from '@/shared/api/generated/@tanstack/react-query.gen';
import { refundsControllerFinanceRefund, refundsControllerRetry, reportsControllerRestart, reportsControllerRunReconciliation } from '@/shared/api/generated/sdk.gen';
import type { RefundDto } from '@/shared/api/generated/types.gen';

export const useFinanceReport = (from: string | undefined, to: string | undefined) => useQuery({ ...reportsControllerFinanceOptions({ query: { from, to } }) });
export const useReconciliation = () => useQuery({ ...reportsControllerReconciliationOptions() });
export const useJobs = (status: 'failed' | 'stuck' | 'all') => useQuery({ ...reportsControllerJobsOptions({ query: { status } }), refetchInterval: 5_000 });

export const useRunReconciliation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await reportsControllerRunReconciliation({ throwOnError: true })).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: reportsControllerReconciliationOptions().queryKey }),
  });
};

export const useRestartJob = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await reportsControllerRestart({ path: { id }, throwOnError: true })).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: reportsControllerJobsOptions({ query: { status: 'failed' } }).queryKey.slice(0, 1) }),
  });
};

export const useManualRefund = () =>
  useMutation({
    mutationFn: async (input: { readonly orderId: string; readonly reason: string; readonly key: string }): Promise<RefundDto> =>
      (await refundsControllerFinanceRefund({ path: { id: input.orderId }, body: { reason: input.reason }, headers: { 'Idempotency-Key': input.key }, throwOnError: true })).data,
  });

/** Refunds the provider rejected: money still owed to buyers. */
export const useFailedRefunds = () => useQuery({ ...refundsControllerFailedOptions(), refetchInterval: 10_000 });

export const useRetryRefund = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (refundId: string): Promise<RefundDto> => (await refundsControllerRetry({ path: { id: refundId }, throwOnError: true })).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: refundsControllerFailedOptions().queryKey }),
  });
};
