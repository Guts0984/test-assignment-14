import { env } from './config/env.js';
import { startHttp } from './http.js';
import { startSmtp } from './smtp.js';
import { createStore } from './store.js';

const store = createStore();
const smtp = await startSmtp(store, env.SMTP_PORT);
const http = await startHttp(store, env.MAILSTUB_HTTP_PORT);
process.stdout.write(`mail stub: SMTP on ${smtp.port}, inbox on http://0.0.0.0:${http.port}\n`);
