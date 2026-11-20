'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import '@/shared/api/client';
import {
  lifecycleControllerProgressOptions, lifecycleControllerStaffOptions, organizerEventsControllerGetOptions, organizerEventsControllerMineOptions, promosControllerListOptions,
  reportsControllerOrganizerOptions,
} from '@/shared/api/generated/@tanstack/react-query.gen';
import {
  lifecycleControllerAssign, lifecycleControllerCancel, lifecycleControllerReschedule, organizerEventsControllerBlock, organizerEventsControllerCreate,
  organizerEventsControllerPublish, promosControllerCreate,
} from '@/shared/api/generated/sdk.gen';
import type { CreateEventDto, CreatePromoDto } from '@/shared/api/generated/types.gen';

export const useMyEvents = () => useQuery({ ...organizerEventsControllerMineOptions() });
export const useManagedEvent = (id: string) => useQuery({ ...organizerEventsControllerGetOptions({ path: { id } }) });
export const useMyPromos = () => useQuery({ ...promosControllerListOptions() });
export const useStaff = (id: string) => useQuery({ ...lifecycleControllerStaffOptions({ path: { id } }) });
export const useOrganizerSales = (eventId?: string) => useQuery({ ...reportsControllerOrganizerOptions({ query: { eventId } }), refetchInterval: 15_000 });
export const useCancellationProgress = (id: string, active: boolean) =>
  useQuery({ ...lifecycleControllerProgressOptions({ path: { id } }), enabled: active, refetchInterval: (q) => (q.state.data && q.state.data.succeeded + q.state.data.failed < q.state.data.total ? 1_000 : 5_000) });

export const useCreateEvent = () => useMutation({ mutationFn: async (body: CreateEventDto) => (await organizerEventsControllerCreate({ body, throwOnError: true })).data });

export const useEventActions = (id: string) => {
  const qc = useQueryClient();
  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: organizerEventsControllerGetOptions({ path: { id } }).queryKey });
    void qc.invalidateQueries({ queryKey: organizerEventsControllerMineOptions().queryKey });
    void qc.invalidateQueries({ queryKey: lifecycleControllerProgressOptions({ path: { id } }).queryKey });
  };
  return {
    publish: useMutation({ mutationFn: async () => (await organizerEventsControllerPublish({ path: { id }, throwOnError: true })).data, onSuccess: refresh }),
    block: useMutation({ mutationFn: async (input: { seatIds: number[]; blocked: boolean }) => (await organizerEventsControllerBlock({ path: { id }, body: input, throwOnError: true })).data, onSuccess: refresh }),
    reschedule: useMutation({ mutationFn: async (startsAt: string) => (await lifecycleControllerReschedule({ path: { id }, body: { startsAt }, throwOnError: true })).data, onSuccess: refresh }),
    cancel: useMutation({ mutationFn: async () => (await lifecycleControllerCancel({ path: { id }, throwOnError: true })).data, onSuccess: refresh }),
    assignScanner: useMutation({
      mutationFn: async (email: string) => (await lifecycleControllerAssign({ path: { id }, body: { email }, throwOnError: true })).data,
      onSuccess: () => void qc.invalidateQueries({ queryKey: lifecycleControllerStaffOptions({ path: { id } }).queryKey }),
    }),
  };
};

export const useCreatePromo = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreatePromoDto) => (await promosControllerCreate({ body, throwOnError: true })).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: promosControllerListOptions().queryKey }),
  });
};
