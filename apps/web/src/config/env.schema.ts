import { z } from 'zod';

/** Server-only variables. Never exposed to the browser. */
export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  WEB_PORT: z.coerce.number().int().positive().default(3000),
  API_INTERNAL_URL: z.string().url().default('http://nginx'),
});

/** Variables inlined into the browser bundle. Validated separately. */
export const publicEnvSchema = z.object({
  /** Origin of the api; empty = same origin (behind nginx, or through the dev rewrite). */
  NEXT_PUBLIC_API_BASE: z.string().default(''),
  NEXT_PUBLIC_WS_URL: z.string().min(1).default('/'),
  NEXT_PUBLIC_DEFAULT_LOCALE: z.enum(['uk', 'en', 'pl']).default('uk'),
});

export type ServerEnv = Readonly<z.infer<typeof serverEnvSchema>>;
export type PublicEnv = Readonly<z.infer<typeof publicEnvSchema>>;

export type EnvResult<T> =
  | { readonly ok: true; readonly env: T }
  | { readonly ok: false; readonly errors: readonly string[] };

type Source = Readonly<Record<string, string | undefined>>;

const parse = <S extends z.ZodTypeAny>(schema: S, source: Source): EnvResult<Readonly<z.infer<S>>> => {
  const parsed = schema.safeParse(source);
  if (parsed.success) return { ok: true, env: Object.freeze(parsed.data) };
  return {
    ok: false,
    errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
  };
};

export const loadServerEnv = (source: Source): EnvResult<ServerEnv> => parse(serverEnvSchema, source);
export const loadPublicEnv = (source: Source): EnvResult<PublicEnv> => parse(publicEnvSchema, source);
