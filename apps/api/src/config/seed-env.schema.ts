import { z } from 'zod';

export const seedEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  SEED_ON_START: z.enum(['true', 'false']).transform((v) => v === 'true').default('true'),
  SEED_SCALE: z.enum(['full', 'small']).default('full'),
  SEED_USER_PASSWORD: z.string().min(8, 'must be at least 8 characters'),
});

export type SeedEnv = Readonly<z.infer<typeof seedEnvSchema>>;

export type SeedEnvResult =
  | { readonly ok: true; readonly env: SeedEnv }
  | { readonly ok: false; readonly errors: readonly string[] };

export const loadSeedEnv = (source: Readonly<Record<string, string | undefined>>): SeedEnvResult => {
  const parsed = seedEnvSchema.safeParse(source);
  if (parsed.success) return { ok: true, env: Object.freeze(parsed.data) };
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
};
