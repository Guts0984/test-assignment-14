import { hash } from '@node-rs/argon2';
import { Pool } from 'pg';
import { seedEnv } from '../config/seed-env.js';
import { paramsFor } from './params.js';
import { runSeed } from './run-seed.js';

const main = async (): Promise<void> => {
  if (!seedEnv.SEED_ON_START) {
    process.stdout.write('seed: SEED_ON_START=false, skipping\n');
    return;
  }
  const pool = new Pool({ connectionString: seedEnv.DATABASE_URL, max: 2 });
  try {
    const passwordHash = await hash(seedEnv.SEED_USER_PASSWORD);
    const result = await runSeed(pool, paramsFor(seedEnv.SEED_SCALE), passwordHash, (line) => process.stdout.write(`${line}\n`));
    process.stdout.write(result.skipped ? 'seed: already applied, nothing to do\n' : `seed: done, ${result.tickets} tickets in ${result.millis} ms\n`);
  } finally {
    await pool.end();
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`seed failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
