import { createZodDto } from 'nestjs-zod';
import { createPromoRequestSchema, promoListSchema, promoSchema } from '@ticketing/shared';

export class CreatePromoDto extends createZodDto(createPromoRequestSchema) {}
export class PromoDto extends createZodDto(promoSchema) {}
export class PromoListDto extends createZodDto(promoListSchema) {}
