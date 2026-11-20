import { createZodDto } from 'nestjs-zod';
import { loginRequestSchema, meSchema, refreshRequestSchema, registerRequestSchema, tokenPairSchema } from '@ticketing/shared';

export class RegisterDto extends createZodDto(registerRequestSchema) {}
export class LoginDto extends createZodDto(loginRequestSchema) {}
export class RefreshDto extends createZodDto(refreshRequestSchema) {}
export class TokenPairDto extends createZodDto(tokenPairSchema) {}
export class MeDto extends createZodDto(meSchema) {}
