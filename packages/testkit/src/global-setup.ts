import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { TEMPLATE_DB, hostReachableUrl, withDatabase } from './db-url.js';

/** Builds one template database with the real Prisma migrations; every test file clones it. */
export default async function setup(): Promise<void> {
  const adminUrl = hostReachableUrl(process.env['DATABASE_URL'] ?? '');
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  await admin.end();
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: resolve(__dirname, '../../../apps/api'),
    env: { ...process.env, DATABASE_URL: withDatabase(adminUrl, TEMPLATE_DB) },
    stdio: 'pipe',
  });
}
