'use client';

import { useQuery } from '@tanstack/react-query';
import '@/shared/api/client';
import { eventsControllerGetOptions, eventsControllerSearchOptions } from '@/shared/api/generated/@tanstack/react-query.gen';
import type { EventFilters } from '../model/search-params';
import { toApiQuery } from '../model/search-params';

export const useEventSearch = (filters: EventFilters) => useQuery({ ...eventsControllerSearchOptions({ query: toApiQuery(filters) }), placeholderData: (prev) => prev });

export const useEventDetail = (id: string) => useQuery({ ...eventsControllerGetOptions({ path: { id } }), refetchInterval: 15_000 });
