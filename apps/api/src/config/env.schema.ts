import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const int = (def: number) => z.coerce.number().int().nonnegative().default(def);
const secret = z.string().min(32, 'must be at least 32 characters');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().url(),
  DB_POOL_MAX: int(20),
  REDIS_URL: z.string().url().default('redis://redis:6379'),
  API_PORT: int(3001),
  API_INSTANCE_ID: z.string().min(1).default('api-1'),
  API_PUBLIC_URL: z.string().url().default('http://localhost:8080'),
  API_INTERNAL_URL: z.string().url().default('http://nginx'),
  CORS_ORIGINS: z.string().default('http://localhost:8080'),
  TRUSTED_PROXY_CIDRS: z.string().default('172.16.0.0/12,127.0.0.1/32'),
  BODY_LIMIT_BYTES: int(262_144),
  VENUE_UPLOAD_LIMIT_BYTES: int(2_097_152),
  JWT_ACCESS_SECRET: secret,
  JWT_REFRESH_PEPPER: secret,
  ACCESS_TTL_SECONDS: int(900),
  REFRESH_TTL_SECONDS: int(2_592_000),
  QR_SIGNING_SECRET: secret,
  LOGIN_THROTTLE_IP_MAX: int(20),
  LOGIN_THROTTLE_ACCOUNT_IP_MAX: int(5),
  LOGIN_THROTTLE_WINDOW_SECONDS: int(60),
  WS_MAX_MSGS_PER_SEC: int(20),
  TEST_CLOCK_ENABLED: bool.default('false'),
  STUB_WEBHOOK_SECRET: secret,
  STUB_CHAOS: bool.default('false'),
  STUB_RPS_LIMIT: int(20),
  STUB_CHAOS_MAX_DELAY_MS: int(60_000),
  STUB_API_KEY: secret,
  STUB_DISPATCH_INTERVAL_MS: z.coerce.number().int().min(50).default(300),
  PAYMENT_WEBHOOK_URL: z.string().url().default('http://nginx/api/webhooks/payments'),
  PAYMENT_PROVIDER_URL: z.string().url().default('http://nginx/stub'),
});

export type Env = Readonly<z.infer<typeof envSchema>>;

export type EnvResult =
  | { readonly ok: true; readonly env: Env }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Pure parser: easy to test, never exits. */
export const loadEnv = (source: Readonly<Record<string, string | undefined>>): EnvResult => {
  const parsed = envSchema.safeParse(source);
  if (parsed.success) return { ok: true, env: Object.freeze(parsed.data) };
  return {
    ok: false,
    errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
  };
};
