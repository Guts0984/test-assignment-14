import { loadPublicEnv, loadServerEnv } from './env.schema.js';

const server = loadServerEnv(process.env);
const pub = loadPublicEnv(process.env);

if (!server.ok || !pub.ok) {
  const errors = [...(server.ok ? [] : server.errors), ...(pub.ok ? [] : pub.errors)];
  process.stderr.write(`Invalid environment:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
  process.exit(1);
}

/** The only place in the web app that reads process.env. */
export const serverEnv = server.env;
export const publicEnv = pub.env;
