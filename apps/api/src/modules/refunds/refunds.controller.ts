import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { idempotencyKeySchema } from '@ticketing/shared';
import { ApiErrors } from '../../common/api-errors.decorator.js';
import { AppException, unwrap } from '../../common/app.exception.js';
import { CurrentUser, Roles, type AuthUser } from '../../common/decorators.js';
import { FinanceRefundRequestDto, RefundDto, RefundListDto, RefundQuoteDto, RefundRequestDto } from '../../common/flows.dto.js';
import { appError } from '../../common/result.js';
import { RefundsService } from './refunds.service.js';

const keyOf = (raw: string | undefined): string => {
  const key = idempotencyKeySchema.safeParse(raw);
  if (!key.success) throw new AppException(appError('IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (8-128 URL-safe characters)'));
  return key.data;
};
const notFound = (): AppException => new AppException(appError('NOT_FOUND', 'Order not found'));

@ApiTags('refunds')
@ApiBearerAuth()
@ApiErrors()
@Controller()
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Roles('buyer')
  @Get('orders/:id/refund-quote')
  @ApiOkResponse({ type: RefundQuoteDto })
  async quote(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<RefundQuoteDto> {
    return (await this.refunds.quote(id, user.id)) ?? Promise.reject(notFound());
  }

  @Roles('buyer')
  @Get('orders/:id/refunds')
  @ApiOkResponse({ type: RefundListDto })
  async list(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<RefundListDto> {
    const items = await this.refunds.list(id, user.id);
    if (!items) throw notFound();
    return { items: items as unknown as RefundListDto['items'] };
  }

  @Roles('buyer')
  @Post('orders/:id/refund')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOkResponse({ type: RefundDto })
  async refund(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: RefundRequestDto, @Headers('idempotency-key') key: string | undefined): Promise<RefundDto> {
    return unwrap(await this.refunds.refund({ orderId: id, userId: user.id, itemIds: body.itemIds, key: keyOf(key) })) as unknown as RefundDto;
  }

  @Roles('finance')
  @Post('finance/orders/:id/refund')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOkResponse({ type: RefundDto })
  async financeRefund(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: FinanceRefundRequestDto, @Headers('idempotency-key') key: string | undefined): Promise<RefundDto> {
    return unwrap(await this.refunds.financeRefund({ orderId: id, actorId: user.id, reason: body.reason, itemIds: body.itemIds, key: keyOf(key) })) as unknown as RefundDto;
  }
}
