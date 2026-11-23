'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import '@/shared/api/client';
import { ticketsControllerListOptions } from '@/shared/api/generated/@tanstack/react-query.gen';
import { refundsControllerTicketQuote, refundsControllerTicketRefund, ticketsControllerTransfer } from '@/shared/api/generated/sdk.gen';
import type { RefundDto, RefundQuoteDto, TicketDto } from '@/shared/api/generated/types.gen';
import { useSession } from '@/shared/lib/session';

export const useMyTickets = () => {
  const session = useSession();
  return useQuery({ ...ticketsControllerListOptions(), enabled: session.status === 'authenticated' });
};

/** Refund terms for one ticket, as its holder sees them (also after the ticket was transferred to you). */
export const useTicketRefundQuote = (ticketId: string) =>
  useQuery({
    queryKey: ['ticket-refund-quote', ticketId],
    queryFn: async (): Promise<RefundQuoteDto> => (await refundsControllerTicketQuote({ path: { id: ticketId }, throwOnError: true })).data,
  });

/** Returns exactly this ticket; the money goes back to the payment it was bought with. */
export const useTicketRefund = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { readonly ticketId: string; readonly key: string }): Promise<RefundDto> =>
      (await refundsControllerTicketRefund({ path: { id: input.ticketId }, headers: { 'Idempotency-Key': input.key }, throwOnError: true })).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ticketsControllerListOptions().queryKey });
      void qc.invalidateQueries({ queryKey: ['ticket-refund-quote'] });
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
