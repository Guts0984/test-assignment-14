import { Body, Controller, HttpCode, Inject, Module, Post, type DynamicModule } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import type { Pool } from 'pg';
import { z } from 'zod';
import { Public } from '../../common/decorators.js';
import type { Env } from '../../config/env.schema.js';
import { PG_POOL } from '../../infra/tokens.js';

class ClockDto extends createZodDto(z.object({ offsetMs: z.number().int().min(-10 * 365 * 86_400_000).max(10 * 365 * 86_400_000) }).strict()) {}

/** Test-only control surface. It exists only when TEST_CLOCK_ENABLED=true; production never registers it. */
@ApiExcludeController()
@Public()
@Controller('_test')
class TestkitController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Post('clock')
  @HttpCode(200)
  async setClock(@Body() body: ClockDto): Promise<{ readonly offsetMs: number }> {
    await this.pool.query('UPDATE test_clock SET offset_ms = $1', [body.offsetMs]);
    return { offsetMs: body.offsetMs };
  }
}

@Module({})
export class TestkitModule {
  static register(env: Env): DynamicModule {
    return { module: TestkitModule, controllers: env.TEST_CLOCK_ENABLED ? [TestkitController] : [], providers: [] };
  }
}
