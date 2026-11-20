import { z } from 'zod';

const int = (def: number) => z.coerce.number().int().nonnegative().default(def);
const secret = z.string().min(32, 'must be at least 32 characters');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().url(),
  DB_POOL_MAX: int(20),
  REDIS_URL: z.string().url().default('redis://redis:6379'),
  API_PUBLIC_URL: z.string().url().default('http://localhost:8080'),
  API_INTERNAL_URL: z.string().url().default('http://nginx'),
  QR_SIGNING_SECRET: secret,
  PAYMENT_PROVIDER_URL: z.string().url().default('http://nginx/stub'),
  STUB_API_KEY: secret,
  WORKER_INSTANCE_ID: z.string().min(1).default('worker-1'),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(10),
  WORKER_REFUND_RPS: z.coerce.number().int().positive().max(19).default(15),
  REHYDRATE_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  SMTP_HOST: z.string().min(1).default('mailstub'),
  SMTP_PORT: int(1025),
  MAIL_FROM: z.string().min(3).default('tickets@example.test'),
});

export type Env = Readonly<z.infer<typeof envSchema>>;

export type EnvResult =
  | { readonly ok: true; readonly env: Env }
  | { readonly ok: false; readonly errors: readonly string[] };

export const loadEnv = (source: Readonly<Record<string, string | undefined>>): EnvResult => {
  const parsed = envSchema.safeParse(source);
  if (parsed.success) return { ok: true, env: Object.freeze(parsed.data) };
  return {
    ok: false,
    errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
  };
};
