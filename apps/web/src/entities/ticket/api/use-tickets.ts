'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import '@/shared/api/client';
import { ticketsControllerListOptions } from '@/shared/api/generated/@tanstack/react-query.gen';
import { refundsControllerQuote, refundsControllerRefund, ticketsControllerTransfer } from '@/shared/api/generated/sdk.gen';
import type { RefundDto, RefundQuoteDto, TicketDto } from '@/shared/api/generated/types.gen';
import { useSession } from '@/shared/lib/session';

export const useMyTickets = () => {
  const session = useSession();
  return useQuery({ ...ticketsControllerListOptions(), enabled: session.status === 'authenticated' });
};

export const useRefundQuote = (orderId: string | null) =>
  useQuery({
    queryKey: ['refund-quote', orderId],
    queryFn: async (): Promise<RefundQuoteDto> => (await refundsControllerQuote({ path: { id: orderId ?? '' }, throwOnError: true })).data,
    enabled: orderId !== null,
  });

export const useRefund = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { readonly orderId: string; readonly itemIds: string[] | undefined; readonly key: string }): Promise<RefundDto> =>
      (await refundsControllerRefund({ path: { id: input.orderId }, body: { itemIds: input.itemIds }, headers: { 'Idempotency-Key': input.key }, throwOnError: true })).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ticketsControllerListOptions().queryKey });
      void qc.invalidateQueries({ queryKey: ['refund-quote'] });
    },
  });
};

export const useTransfer = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { readonly ticketId: string; readonly email: string; readonly key: string }): Promise<TicketDto> =>
      (await ticketsControllerTransfer({ path: { id: input.ticketId }, body: { email: input.email }, headers: { 'Idempotency-Key': input.key }, throwOnError: true })).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ticketsControllerListOptions().queryKey }),
  });
};
