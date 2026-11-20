import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './common/auth.guard.js';
import type { Env } from './config/env.schema.js';
import { InfraModule } from './infra/infra.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { EventsModule } from './modules/events/events.module.js';
import { HealthController } from './modules/health/health.controller.js';
import { OrdersModule } from './modules/orders/orders.module.js';
import { LifecycleModule } from './modules/lifecycle/lifecycle.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { QueueModule } from './modules/queue/queue.module.js';
import { RealtimeModule } from './modules/realtime/realtime.module.js';
import { RefundsModule } from './modules/refunds/refunds.module.js';
import { ReportsModule } from './modules/reports/reports.module.js';
import { ScanningModule } from './modules/scanning/scanning.module.js';
import { TicketsModule } from './modules/tickets/tickets.module.js';
import { WaitlistModule } from './modules/waitlist/waitlist.module.js';
import { PaymentStubModule } from './modules/payment-stub/payment-stub.module.js';
import { PromosModule } from './modules/promos/promos.module.js';
import { TestkitModule } from './modules/testkit/testkit.module.js';
import { VenuesModule } from './modules/venues/venues.module.js';

@Module({})
export class AppModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [InfraModule.forRoot(env), AuthModule, VenuesModule, EventsModule, OrdersModule, PromosModule, PaymentStubModule, PaymentsModule, RefundsModule, TicketsModule, ScanningModule, LifecycleModule, WaitlistModule, QueueModule, ReportsModule, RealtimeModule, TestkitModule.register(env)],
      controllers: [HealthController],
      providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
    };
  }
}
