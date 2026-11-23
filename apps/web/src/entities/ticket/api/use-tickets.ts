'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import '@/shared/api/client';
import { ticketsControllerListOptions } from '@/shared/api/generated/@tanstack/react-query.gen';
import { refundsControllerTicketQuote, refundsControllerTicketRefund, ticketsControllerTransfer } from '@/shared/api/generated/sdk.gen';
import type { RefundDto, RefundQuoteDto, TicketDto } from '@/shared/api/generated/types.gen';
import { getSocket } from '@/shared/lib/socket';
import { useSession } from '@/shared/lib/session';

/** Tickets appear when the payment is confirmed, which can be after the buyer is back: any `order.updated` refreshes the list. */
export const useMyTickets = () => {
  const session = useSession();
  const qc = useQueryClient();
  const query = useQuery({ ...ticketsControllerListOptions(), enabled: session.status === 'authenticated' });
  const token = session.status === 'authenticated' ? session.accessToken : null;
  useEffect(() => {
    if (!token) return;
    const socket = getSocket(token);
    const onUpdate = (): void => void qc.invalidateQueries({ queryKey: ticketsControllerListOptions().queryKey });
    socket.on('order.updated', onUpdate);
    return () => void socket.off('order.updated', onUpdate);
  }, [token, qc]);
  return query;
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
