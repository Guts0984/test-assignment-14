import { loadEnv } from './env.schema.js';

const result = loadEnv(process.env);

if (!result.ok) {
  process.stderr.write(`Invalid environment:\n${result.errors.map((e) => `  - ${e}`).join('\n')}\n`);
  process.exit(1);
}

/** The only place in the mail stub that reads process.env. */
export const env = result.env;
