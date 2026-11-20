import { Controller, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { idempotencyKeySchema } from '@ticketing/shared';
import { ApiErrors } from '../../common/api-errors.decorator.js';
import { AppException, unwrap } from '../../common/app.exception.js';
import { CurrentUser, Public, Roles, type AuthUser } from '../../common/decorators.js';
import { CheckoutResponseDto, WebhookResultDto } from '../../common/flows.dto.js';
import { appError } from '../../common/result.js';
import { PaymentsService } from './payments.service.js';

@ApiTags('payments')
@ApiErrors()
@Controller()
export class PaymentsController {
  constructor(@Inject(PaymentsService) private readonly payments: PaymentsService) {}

  @Roles('buyer')
  @ApiBearerAuth()
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @Post('orders/:id/checkout')
  @HttpCode(200)
  @ApiOkResponse({ type: CheckoutResponseDto })
  async checkout(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Headers('idempotency-key') raw: string | undefined): Promise<CheckoutResponseDto> {
    const key = idempotencyKeySchema.safeParse(raw);
    if (!key.success) throw new AppException(appError('IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (8-128 URL-safe characters)'));
    return unwrap(await this.payments.checkout(id, user.id, key.data));
  }

  /** Called by the payment provider. Authenticated by the HMAC signature, not by a user token. */
  @Public()
  @Post('webhooks/payments')
  @HttpCode(200)
  @ApiOkResponse({ type: WebhookResultDto })
  async webhook(@Req() req: Request & { rawBody?: Buffer }, @Headers('x-stub-signature') signature: string | undefined): Promise<WebhookResultDto> {
    const outcome = unwrap(await this.payments.receiveWebhook(req.rawBody?.toString('utf8') ?? '', signature));
    return { outcome };
  }
}
