import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SMTP_PORT: z.coerce.number().int().min(0).max(65_535).default(1025),
  MAILSTUB_HTTP_PORT: z.coerce.number().int().min(0).max(65_535).default(8025),
});

export type Env = Readonly<z.infer<typeof envSchema>>;

export type EnvResult = { readonly ok: true; readonly env: Env } | { readonly ok: false; readonly errors: readonly string[] };

export const loadEnv = (source: Readonly<Record<string, string | undefined>>): EnvResult => {
  const parsed = envSchema.safeParse(source);
  if (parsed.success) return { ok: true, env: Object.freeze(parsed.data) };
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
};
