import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildOpenApiDocument, createApp } from '../bootstrap.js';
import { env } from '../config/env.js';

/** Writes apps/api/openapi.json, the single source of the generated web client. Needs no database or Redis. */
const app = await createApp(env);
await app.init();
const document = buildOpenApiDocument(app);
writeFileSync(resolve(process.cwd(), 'openapi.json'), `${JSON.stringify(document, null, 2)}\n`);
await app.close();
process.exit(0);
