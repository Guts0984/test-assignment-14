import { env } from './config/env.js';
import { createApp } from './bootstrap.js';

const app = await createApp(env);
await app.listen(env.API_PORT, '0.0.0.0');
