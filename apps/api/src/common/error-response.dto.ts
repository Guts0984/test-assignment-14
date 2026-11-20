import { createZodDto } from 'nestjs-zod';
import { errorResponseSchema } from '@ticketing/shared';

export class ErrorResponseDto extends createZodDto(errorResponseSchema) {}
