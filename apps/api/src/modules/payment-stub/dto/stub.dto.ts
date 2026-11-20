import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export class CreateStubPaymentDto extends createZodDto(
  z.object({ amount: z.number().int().min(100).max(100_000_000), orderRef: z.string().min(1).max(64), returnUrl: z.string().max(500).optional() }).strict(),
) {}

export class CreateStubRefundDto extends createZodDto(
  z.object({ paymentId: z.string().regex(/^pay_[0-9a-f]{24}$/), amount: z.number().int().min(1).max(100_000_000), reference: z.string().min(1).max(64).optional() }).strict(),
) {}
