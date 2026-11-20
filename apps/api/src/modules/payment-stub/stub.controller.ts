import { Body, Controller, Get, Header, Headers, HttpCode, Inject, Param, Post, Res, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import type { Pool } from 'pg';
import { idempotencyKeySchema } from '@ticketing/shared';
import { AppException, unwrap } from '../../common/app.exception.js';
import { Public } from '../../common/decorators.js';
import { appError } from '../../common/result.js';
import type { Env } from '../../config/env.schema.js';
import { ENV, PG_POOL } from '../../infra/tokens.js';
import { requestHash } from '../orders/domain/idempotency.js';
import { closedPage, paymentPage } from './domain/page.js';
import { createPayment, createRefund, getChaos, getPayment, getRefund, settlePayment } from './domain/stub-repo.js';
import { CreateStubPaymentDto, CreateStubRefundDto } from './dto/stub.dto.js';
import { StubGuard } from './stub.guard.js';

const keyOf = (raw: string | undefined): string => {
  const parsed = idempotencyKeySchema.safeParse(raw);
  if (!parsed.success) throw new AppException(appError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required'));
  return parsed.data;
};

/** The payment provider sandbox. Excluded from the shop's OpenAPI document: it is a separate "external" system. */
@ApiExcludeController()
@Public()
@UseGuards(StubGuard)
@Controller('stub')
export class PaymentStubController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private async cfg() {
    return { chaos: await getChaos(this.pool, this.env.STUB_CHAOS), maxDelayMs: this.env.STUB_CHAOS_MAX_DELAY_MS };
  }

  /** Redirects only back to our own site: no open redirect through the stub. */
  private safeReturn(url: string | undefined): string | null {
    if (!url) return null;
    if (url.startsWith('/') && !url.startsWith('//')) return url;
    return url.startsWith(`${new URL(this.env.API_PUBLIC_URL).origin}/`) ? url : null;
  }

  @Post('v1/payments')
  @HttpCode(200)
  async create(@Body() body: CreateStubPaymentDto, @Headers('idempotency-key') key: string | undefined) {
    const returnUrl = this.safeReturn(body.returnUrl);
    if (body.returnUrl && !returnUrl) throw new AppException(appError('VALIDATION_FAILED', 'returnUrl must point to the shop'));
    const { payment } = unwrap(await createPayment(this.pool, { amount: body.amount, orderRef: body.orderRef, returnUrl, key: keyOf(key), hash: requestHash({ ...body, returnUrl }) }));
    return { id: payment.id, status: payment.status, amount: payment.amount, orderRef: payment.orderRef, paymentUrl: `${this.env.API_PUBLIC_URL}/stub/pay/${payment.id}` };
  }

  @Get('v1/payments/:id')
  async status(@Param('id') id: string) {
    const payment = await getPayment(this.pool, id);
    if (!payment) throw new AppException(appError('NOT_FOUND', 'Payment not found'));
    return { id: payment.id, status: payment.status, amount: payment.amount, refunded: payment.refunded, orderRef: payment.orderRef, seq: payment.seq };
  }

  @Post('v1/refunds')
  @HttpCode(200)
  async refund(@Body() body: CreateStubRefundDto, @Headers('idempotency-key') key: string | undefined) {
    const { refund } = unwrap(await createRefund(this.pool, await this.cfg(), { paymentId: body.paymentId, amount: body.amount, reference: body.reference ?? null, key: keyOf(key), hash: requestHash(body) }));
    return refund;
  }

  @Get('v1/refunds/:id')
  async refundStatus(@Param('id') id: string) {
    const refund = await getRefund(this.pool, id);
    if (!refund) throw new AppException(appError('NOT_FOUND', 'Refund not found'));
    return refund;
  }

  @Get('pay/:id')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'")
  async page(@Param('id') id: string): Promise<string> {
    const payment = await getPayment(this.pool, id);
    if (!payment) throw new AppException(appError('NOT_FOUND', 'Payment not found'));
    return paymentPage(payment);
  }

  @Post('pay/:id/:action')
  @HttpCode(200)
  async decide(@Param('id') id: string, @Param('action') action: string, @Res() res: Response): Promise<void> {
    if (!['success', 'failure', 'close'].includes(action)) throw new AppException(appError('NOT_FOUND', 'Unknown action'));
    const before = await getPayment(this.pool, id);
    if (!before) throw new AppException(appError('NOT_FOUND', 'Payment not found'));
    if (action === 'close') {
      res.type('html').send(closedPage());
      return;
    }
    const after = await settlePayment(this.pool, await this.cfg(), id, action === 'success' ? 'succeeded' : 'failed');
    const target = (await this.returnUrlOf(id)) ?? null;
    if (target) {
      res.redirect(303, `${target}${target.includes('?') ? '&' : '?'}payment=${encodeURIComponent(id)}&status=${after?.status ?? 'pending'}`);
      return;
    }
    res.type('html').send(paymentPage(after ?? before));
  }

  private async returnUrlOf(id: string): Promise<string | null> {
    const res = await this.pool.query<{ return_url: string | null }>(`SELECT return_url FROM stub_payments WHERE id = $1`, [id]);
    return res.rows[0]?.return_url ?? null;
  }
}
