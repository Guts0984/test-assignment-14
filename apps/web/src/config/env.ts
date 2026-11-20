import { loadPublicEnv, loadServerEnv } from './env.schema';

const server = loadServerEnv(process.env);
// Spelled out: only literal `process.env.NEXT_PUBLIC_*` references are inlined into the browser bundle.
const pub = loadPublicEnv({
  NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE,
  NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL,
  NEXT_PUBLIC_DEFAULT_LOCALE: process.env.NEXT_PUBLIC_DEFAULT_LOCALE,
});

if (!server.ok || !pub.ok) {
  const errors = [...(server.ok ? [] : server.errors), ...(pub.ok ? [] : pub.errors)];
  // Failing at import time stops the build / the server with a readable message (also safe in the edge runtime).
  throw new Error(`Invalid environment:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
}

/** The only place in the web app that reads process.env. */
export const serverEnv = server.env;
export const publicEnv = pub.env;
