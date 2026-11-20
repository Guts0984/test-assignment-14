import { Module, type DynamicModule } from '@nestjs/common';
import type { Env } from './config/env.schema.js';
import { WORKER_ENV, WorkerService } from './worker.service.js';

@Module({})
export class WorkerModule {
  static forRoot(env: Env): DynamicModule {
    return { module: WorkerModule, providers: [{ provide: WORKER_ENV, useValue: env }, WorkerService] };
  }
}
