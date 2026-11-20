'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import '@/shared/api/client';
import { venuesControllerGeometryOptions, venuesControllerListOptions } from '@/shared/api/generated/@tanstack/react-query.gen';
import { venuesControllerCreate } from '@/shared/api/generated/sdk.gen';
import type { VenueDto, VenueLayoutDto } from '@/shared/api/generated/types.gen';

export const useMyVenues = () => useQuery({ ...venuesControllerListOptions() });
export const useVenueGeometry = (id: string | null) => useQuery({ ...venuesControllerGeometryOptions({ path: { id: id ?? '' } }), enabled: id !== null && id !== '' });

export const useUploadVenue = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (layout: VenueLayoutDto): Promise<VenueDto> => (await venuesControllerCreate({ body: layout, throwOnError: true })).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: venuesControllerListOptions().queryKey }),
  });
};
