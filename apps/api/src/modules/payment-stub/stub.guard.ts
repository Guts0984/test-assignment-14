import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { Pool } from 'pg';
import type { Limiter } from '@ticketing/platform';
import { AppException } from '../../common/app.exception.js';
import { appError } from '../../common/result.js';
import { constantTimeEquals } from '../auth/domain/tokens.js';
import type { Env } from '../../config/env.schema.js';
import { ENV, PG_POOL, STUB_LIMITER } from '../../infra/tokens.js';
import { isUnavailableRequest } from './domain/chaos.js';
import { getChaos, nextRequestNumber } from './domain/stub-repo.js';

/**
 * Behaves like a real provider's edge: at most 20 requests per second across all api copies (excess gets 429),
 * every tenth request fails with 503 in chaos mode, and the API (`/stub/v1`) needs the shop's API key.
 * If the limiter store is unavailable the stub fails closed (503) instead of letting the limit slip.
 */
@Injectable()
export class StubGuard implements CanActivate {
  constructor(
    @Inject(STUB_LIMITER) private readonly limiter: Limiter,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.limiterKey = `stub:rps:${new URL(env.DATABASE_URL).pathname}`;
  }

  /** One budget per database (= per deployment): both api copies share it. */
  private readonly limiterKey: string;

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const decision = await this.limiter.slidingWindow(this.limiterKey, this.env.STUB_RPS_LIMIT, 1_000);
    if (decision.degraded) throw new AppException(appError('PROVIDER_UNAVAILABLE', 'Provider is temporarily unavailable'));
    if (!decision.allowed) {
      throw new AppException(appError('RATE_LIMITED', 'Provider rate limit exceeded', { retryAfterSeconds: Math.max(1, Math.ceil(decision.retryAfterMs / 1_000)) }));
    }
    if (await getChaos(this.pool, this.env.STUB_CHAOS)) {
      if (isUnavailableRequest(await nextRequestNumber(this.pool))) throw new AppException(appError('PROVIDER_UNAVAILABLE', 'Provider is temporarily unavailable'));
    }
    if (req.path.startsWith('/stub/v1/')) {
      const header = req.headers.authorization;
      const key = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      if (!constantTimeEquals(key, this.env.STUB_API_KEY)) throw new AppException(appError('UNAUTHENTICATED', 'Invalid API key'));
    }
    return true;
  }
}
