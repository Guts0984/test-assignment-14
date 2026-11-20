'use client';

import { useSearchParams } from 'next/navigation';

/** The current query string; never null (Next types it as nullable outside of a request context). */
export const useQueryParams = (): URLSearchParams => new URLSearchParams(useSearchParams()?.toString() ?? '');
