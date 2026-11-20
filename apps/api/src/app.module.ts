import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './common/auth.guard.js';
import type { Env } from './config/env.schema.js';
import { InfraModule } from './infra/infra.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { EventsModule } from './modules/events/events.module.js';
import { HealthController } from './modules/health/health.controller.js';
import { OrdersModule } from './modules/orders/orders.module.js';
import { PromosModule } from './modules/promos/promos.module.js';
import { TestkitModule } from './modules/testkit/testkit.module.js';
import { VenuesModule } from './modules/venues/venues.module.js';

@Module({})
export class AppModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [InfraModule.forRoot(env), AuthModule, VenuesModule, EventsModule, OrdersModule, PromosModule, TestkitModule.register(env)],
      controllers: [HealthController],
      providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
    };
  }
}
