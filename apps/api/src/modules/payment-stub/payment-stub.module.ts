import { Module } from '@nestjs/common';
import { PaymentStubController } from './stub.controller.js';
import { StubDispatcher } from './stub-dispatcher.service.js';
import { StubGuard } from './stub.guard.js';

@Module({ controllers: [PaymentStubController], providers: [StubGuard, StubDispatcher] })
export class PaymentStubModule {}
