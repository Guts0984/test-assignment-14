import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { idempotencyKeySchema } from '@ticketing/shared';
import { ApiErrors } from '../../common/api-errors.decorator.js';
import { AppException, unwrap } from '../../common/app.exception.js';
import { CurrentUser, Roles, type AuthUser } from '../../common/decorators.js';
import { appError } from '../../common/result.js';
import { ApplyPromoDto, HoldDto, OrderDto, OrderHistoryDto, OrderListDto } from './dto/order.dto.js';
import { OrdersService } from './orders.service.js';

const requireKey = (raw: string | undefined): string => {
  const parsed = idempotencyKeySchema.safeParse(raw);
  if (!parsed.success) throw new AppException(appError('IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (8-128 URL-safe characters)'));
  return parsed.data;
};

const notFound = (): AppException => new AppException(appError('NOT_FOUND', 'Order not found'));

@ApiTags('orders')
@ApiBearerAuth()
@ApiErrors()
@Roles('buyer')
@Controller()
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post('events/:eventId/holds')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOkResponse({ type: OrderDto })
  async hold(@CurrentUser() user: AuthUser, @Param('eventId', ParseUUIDPipe) eventId: string, @Body() body: HoldDto, @Headers('idempotency-key') key: string | undefined): Promise<OrderDto> {
    return unwrap(await this.orders.hold({ userId: user.id, eventId, seatIds: body.seatIds, general: body.general }, requireKey(key)));
  }

  @Get('orders')
  @ApiOkResponse({ type: OrderListDto })
  async list(@CurrentUser() user: AuthUser): Promise<OrderListDto> {
    return { items: [...(await this.orders.list(user.id))] };
  }

  @Get('orders/:id')
  @ApiOkResponse({ type: OrderDto })
  async get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<OrderDto> {
    return (await this.orders.get(id, user.id)) ?? Promise.reject(notFound());
  }

  @Get('orders/:id/history')
  @ApiOkResponse({ type: OrderHistoryDto })
  async history(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<OrderHistoryDto> {
    if (!(await this.orders.get(id, user.id))) throw notFound();
    return { items: [...(await this.orders.history(id, user.id))] };
  }

  @Delete('orders/:id/items/:itemId')
  @ApiOkResponse({ type: OrderDto })
  async removeItem(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('itemId', ParseUUIDPipe) itemId: string): Promise<OrderDto> {
    return unwrap(await this.orders.removeItem(id, itemId, user.id));
  }

  @Post('orders/:id/release')
  @HttpCode(200)
  @ApiOkResponse({ type: OrderDto })
  async release(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<OrderDto> {
    return unwrap(await this.orders.release(id, user.id));
  }

  @Post('orders/:id/promo')
  @HttpCode(200)
  @ApiOkResponse({ type: OrderDto })
  async applyPromo(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: ApplyPromoDto): Promise<OrderDto> {
    return unwrap(await this.orders.applyPromo(id, user.id, body.code));
  }

  @Delete('orders/:id/promo')
  @ApiOkResponse({ type: OrderDto })
  async removePromo(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<OrderDto> {
    return unwrap(await this.orders.removePromo(id, user.id));
  }
}
