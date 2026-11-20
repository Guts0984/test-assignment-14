import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { env } from './config/env.js';
import { WorkerModule } from './worker.module.js';

const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(env), { logger: ['error', 'warn', 'log'] });
app.enableShutdownHooks();
