import { defineRouting } from 'next-intl/routing';
import { publicEnv } from '@/config/env';

export const routing = defineRouting({
  locales: ['uk', 'en', 'pl'],
  defaultLocale: publicEnv.NEXT_PUBLIC_DEFAULT_LOCALE,
});
