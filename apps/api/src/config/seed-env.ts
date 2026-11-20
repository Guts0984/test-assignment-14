import { loadSeedEnv } from './seed-env.schema.js';

const result = loadSeedEnv(process.env);

if (!result.ok) {
  process.stderr.write(`Invalid seed environment:\n${result.errors.map((e) => `  - ${e}`).join('\n')}\n`);
  process.exit(1);
}

/** Environment of the one-shot seed job (the only other reader of process.env besides env.ts). */
export const seedEnv = result.env;
