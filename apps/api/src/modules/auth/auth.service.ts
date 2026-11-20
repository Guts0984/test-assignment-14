import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { Limiter } from '@ticketing/platform';
import type { Env } from '../../config/env.schema.js';
import { ENV, LIMITER, PG_POOL } from '../../infra/tokens.js';
import { appError, err, type Result } from '../../common/result.js';
import { findUser, login, logout, refresh, registerBuyer, type AuthConfig, type TokenPair, type UserView } from './domain/auth-flow.js';

@Injectable()
export class AuthService {
  private readonly cfg: AuthConfig;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(LIMITER) private readonly limiter: Limiter,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.cfg = { accessSecret: env.JWT_ACCESS_SECRET, accessTtlSeconds: env.ACCESS_TTL_SECONDS, pepper: env.JWT_REFRESH_PEPPER, refreshTtlSeconds: env.REFRESH_TTL_SECONDS };
  }

  register = (input: { email: string; password: string; displayName: string }): Promise<Result<TokenPair>> => registerBuyer(this.pool, this.cfg, input);

  /**
   * Login throttling: per client IP, and per (account, IP). There is deliberately no per-account lock, so an
   * attacker on another address cannot lock the real owner out. Fails open (documented) when Redis is down.
   */
  async login(ip: string, email: string, password: string): Promise<Result<TokenPair>> {
    const windowMs = this.env.LOGIN_THROTTLE_WINDOW_SECONDS * 1000;
    const accountKey = createHash('sha256').update(email).digest('hex').slice(0, 16);
    const byIp = await this.limiter.fixedWindow(`login:ip:${ip}`, this.env.LOGIN_THROTTLE_IP_MAX, windowMs);
    const byAccount = await this.limiter.fixedWindow(`login:acct:${accountKey}:${ip}`, this.env.LOGIN_THROTTLE_ACCOUNT_IP_MAX, windowMs);
    if (!byIp.allowed || !byAccount.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil(Math.max(byIp.retryAfterMs, byAccount.retryAfterMs) / 1000));
      return err(appError('RATE_LIMITED', 'Too many login attempts, try again later', { retryAfterSeconds }));
    }
    return login(this.pool, this.cfg, email, password);
  }

  refresh = (token: string): Promise<Result<TokenPair>> => refresh(this.pool, this.cfg, token);
  logout = (token: string): Promise<void> => logout(this.pool, this.cfg, token);
  me = (id: string): Promise<UserView | null> => findUser(this.pool, id);
}
