'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import '@/shared/api/client';
import { ordersControllerGetOptions, ordersControllerHistoryOptions, ordersControllerListOptions, refundsControllerListOptions } from '@/shared/api/generated/@tanstack/react-query.gen';
import { ordersControllerHold, ordersControllerRelease, ordersControllerRemoveItem } from '@/shared/api/generated/sdk.gen';
import type { HoldDto, OrderDto } from '@/shared/api/generated/types.gen';
import { getSocket } from '@/shared/lib/socket';
import { observeServerTime } from '@/shared/lib/server-clock';
import { useSession } from '@/shared/lib/session';

/** The list follows the server: any `order.updated` for this user (expiry, payment, refund) refreshes it. */
export const useMyOrders = () => {
  const session = useSession();
  const qc = useQueryClient();
  const query = useQuery({ ...ordersControllerListOptions(), enabled: session.status === 'authenticated' });
  const token = session.status === 'authenticated' ? session.accessToken : null;
  useEffect(() => {
    if (!token) return;
    const socket = getSocket(token);
    const onUpdate = (): void => void qc.invalidateQueries({ queryKey: ordersControllerListOptions().queryKey });
    socket.on('order.updated', onUpdate);
    return () => void socket.off('order.updated', onUpdate);
  }, [token, qc]);
  return query;
};

export const useOrder = (id: string) => {
  const session = useSession();
  const qc = useQueryClient();
  const query = useQuery({
    ...ordersControllerGetOptions({ path: { id } }),
    enabled: session.status === 'authenticated',
    refetchInterval: (q) => (q.state.data && ['holding', 'awaiting_payment'].includes(q.state.data.status) ? 3_000 : false),
  });
  useEffect(() => {
    if (query.data) observeServerTime(query.data.serverTime);
  }, [query.data]);
  const token = session.status === 'authenticated' ? session.accessToken : null;
  useEffect(() => {
    if (!token) return;
    const socket = getSocket(token);
    const onUpdate = (m: { orderId?: string }): void => {
      if (!m.orderId || m.orderId === id) void qc.invalidateQueries({ queryKey: ordersControllerGetOptions({ path: { id } }).queryKey });
    };
    socket.on('order.updated', onUpdate);
    return () => void socket.off('order.updated', onUpdate);
  }, [token, id, qc]);
  return query;
};

export const useOrderHistory = (id: string) => useQuery({ ...ordersControllerHistoryOptions({ path: { id } }) });

/** Refunds of the order with their real state at the payment provider; polled while money is still on its way. */
export const useOrderRefunds = (id: string) =>
  useQuery({
    ...refundsControllerListOptions({ path: { id } }),
    refetchInterval: (q) => (q.state.data?.items.some((r) => r.status === 'requested' || r.status === 'pending') ? 3_000 : false),
  });

/** Holds seats / places; the Idempotency-Key makes a double click or a retry harmless. */
export const useHold = (eventId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { readonly body: HoldDto; readonly key: string }): Promise<OrderDto> => {
      const res = await ordersControllerHold({ path: { eventId }, body: input.body, headers: { 'Idempotency-Key': input.key }, throwOnError: true });
      return res.data;
    },
    onSuccess: (order) => {
      observeServerTime(order.serverTime);
      void qc.invalidateQueries({ queryKey: ordersControllerListOptions().queryKey });
    },
  });
};

export const useRemoveItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { readonly orderId: string; readonly itemId: string }): Promise<OrderDto> => (await ordersControllerRemoveItem({ path: { id: input.orderId, itemId: input.itemId }, throwOnError: true })).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ordersControllerListOptions().queryKey }),
  });
};

export const useReleaseOrder = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (orderId: string): Promise<OrderDto> => (await ordersControllerRelease({ path: { id: orderId }, throwOnError: true })).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ordersControllerListOptions().queryKey }),
  });
};
