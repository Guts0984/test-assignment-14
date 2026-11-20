import { createZodDto } from 'nestjs-zod';
import { applyPromoRequestSchema, holdRequestSchema, orderHistorySchema, orderListSchema, orderSchema } from '@ticketing/shared';

export class HoldDto extends createZodDto(holdRequestSchema) {}
export class ApplyPromoDto extends createZodDto(applyPromoRequestSchema) {}
export class OrderDto extends createZodDto(orderSchema) {}
export class OrderListDto extends createZodDto(orderListSchema) {}
export class OrderHistoryDto extends createZodDto(orderHistorySchema) {}
