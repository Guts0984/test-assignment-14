import { loadEnvConfig } from '@next/env';
import createNextIntlPlugin from 'next-intl/plugin';
import type { NextConfig } from 'next';
import { loadServerEnv } from './src/config/env.schema';

// The whole repo shares one .env (copied from .env.example); load it before anything reads the environment.
loadEnvConfig(new URL('../..', import.meta.url).pathname);

const withNextIntl = createNextIntlPlugin('./src/app/i18n/request.ts');

const config: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ['@ticketing/shared'],
  outputFileTracingRoot: new URL('../..', import.meta.url).pathname,
  // In development (no nginx in front) the api and the websocket are reached through the same origin.
  async rewrites() {
    const loaded = loadServerEnv(process.env);
    if (!loaded.ok) throw new Error(loaded.errors.join('; '));
    return loaded.env.NODE_ENV === 'production' ? [] : [{ source: '/api/:path*', destination: `${loaded.env.API_INTERNAL_URL}/api/:path*` }];
  },
};

export default withNextIntl(config);
