import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import type { Pool } from 'pg';
import { z } from 'zod';
import { ApiErrors } from '../../common/api-errors.decorator.js';
import { Public } from '../../common/decorators.js';
import type { Env } from '../../config/env.schema.js';
import { ENV, PG_POOL } from '../../infra/tokens.js';

class HealthDto extends createZodDto(z.object({ status: z.literal('ok'), instance: z.string() })) {}

@ApiTags('health')
@ApiErrors(500)
@Controller('health')
export class HealthController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Public()
  @Get()
  @ApiOkResponse({ type: HealthDto })
  async check(): Promise<HealthDto> {
    await this.pool.query('SELECT 1');
    return { status: 'ok', instance: this.env.API_INSTANCE_ID };
  }
}
