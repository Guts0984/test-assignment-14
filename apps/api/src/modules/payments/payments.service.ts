import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { processProviderEvent, providerEventSchema, type ProviderClient, type RealtimePublisher, type WebhookOutcome } from '@ticketing/platform';
import type { Env } from '../../config/env.schema.js';
import { ENV, PG_POOL, PROVIDER, RT_PUBLISHER } from '../../infra/tokens.js';
import { appError, err, ok, type Result } from '../../common/result.js';
import { verifyWebhook } from '../payment-stub/domain/signature.js';
import { checkout } from './domain/checkout.js';

@Injectable()
export class PaymentsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(PROVIDER) private readonly provider: ProviderClient,
    @Inject(RT_PUBLISHER) private readonly rt: RealtimePublisher,
    @Inject(ENV) private readonly env: Env,
  ) {}

  checkout = (orderId: string, userId: string, key: string) => checkout(this.pool, this.provider, { publicUrl: this.env.API_PUBLIC_URL }, { orderId, userId, key });

  /** Verifies the signature over the exact bytes received, then applies the event once. */
  async receiveWebhook(raw: string, signature: string | undefined): Promise<Result<WebhookOutcome>> {
    const check = verifyWebhook(this.env.STUB_WEBHOOK_SECRET, signature, raw, Math.floor(Date.now() / 1_000));
    if (check !== 'ok') return err(appError('UNAUTHENTICATED', 'Invalid webhook signature'));
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return err(appError('VALIDATION_FAILED', 'Webhook body is not valid JSON'));
    }
    const event = providerEventSchema.safeParse(parsedJson);
    if (!event.success) return err(appError('VALIDATION_FAILED', 'Webhook payload is not recognised'));
    const outcome = await processProviderEvent(this.pool, event.data);
    if (outcome === 'applied') await this.announce(event.data.data.paymentId);
    return ok(outcome);
  }

  /** Live updates after the books changed: the buyer's page and everyone looking at the seat map. */
  private async announce(providerPaymentId: string): Promise<void> {
    const row = (await this.pool.query<{ order_id: string; user_id: string; event_id: string; status: string }>(
      `SELECT o.id AS order_id, o.user_id, o.event_id, o.status FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.provider_payment_id = $1`,
      [providerPaymentId],
    )).rows[0];
    if (!row) return;
    this.rt.toUser(row.user_id, 'order.updated', { orderId: row.order_id, status: row.status });
    this.rt.seatsChanged(row.event_id);
  }
}
