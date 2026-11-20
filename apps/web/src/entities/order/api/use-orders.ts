'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import '@/shared/api/client';
import { ordersControllerGetOptions, ordersControllerHistoryOptions, ordersControllerListOptions } from '@/shared/api/generated/@tanstack/react-query.gen';
import { ordersControllerHold, ordersControllerRelease, ordersControllerRemoveItem } from '@/shared/api/generated/sdk.gen';
import type { HoldDto, OrderDto } from '@/shared/api/generated/types.gen';
import { getSocket } from '@/shared/lib/socket';
import { observeServerTime } from '@/shared/lib/server-clock';
import { useSession } from '@/shared/lib/session';

export const useMyOrders = () => {
  const session = useSession();
  return useQuery({ ...ordersControllerListOptions(), enabled: session.status === 'authenticated' });
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
