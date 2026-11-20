'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import '@/shared/api/client';
import { scanningControllerEventsOptions, scanningControllerStatsOptions } from '@/shared/api/generated/@tanstack/react-query.gen';
import { scanningControllerScan } from '@/shared/api/generated/sdk.gen';
import type { ScanResultDto } from '@/shared/api/generated/types.gen';

export const useScannerEvents = () => useQuery({ ...scanningControllerEventsOptions() });
export const useScanStats = (eventId: string) => useQuery({ ...scanningControllerStatsOptions({ path: { eventId } }), refetchInterval: 3_000 });

export const useScan = (eventId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { readonly code: string; readonly gate: string }): Promise<ScanResultDto> => (await scanningControllerScan({ path: { eventId }, body: input, throwOnError: true })).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: scanningControllerStatsOptions({ path: { eventId } }).queryKey }),
  });
};
