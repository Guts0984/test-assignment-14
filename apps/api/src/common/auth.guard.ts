import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Pool } from 'pg';
import type { Env } from '../config/env.schema.js';
import { ENV, PG_POOL } from '../infra/tokens.js';
import { isSessionActive } from '../modules/auth/domain/sessions.js';
import { verifyAccessToken } from '../modules/auth/domain/tokens.js';
import { AppException } from './app.exception.js';
import { IS_PUBLIC, ROLES_KEY, type AuthedRequest } from './decorators.js';
import { appError } from './result.js';
import type { Role } from '@ticketing/shared';

const unauthenticated = (): AppException => new AppException(appError('UNAUTHENTICATED', 'Authentication required'));

/** Default-deny: every route needs a valid, non-revoked access token unless it is marked @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(ENV) private readonly env: Env,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, targets)) return true;
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (token === '') throw unauthenticated();
    const claims = await verifyAccessToken(this.env.JWT_ACCESS_SECRET, token);
    if (!claims || !(await isSessionActive(this.pool, claims.sid))) throw unauthenticated();
    req.user = { id: claims.sub, role: claims.role, sid: claims.sid };

    const roles = this.reflector.getAllAndOverride<readonly Role[] | undefined>(ROLES_KEY, targets);
    if (roles && !roles.includes(claims.role)) throw new AppException(appError('FORBIDDEN', 'Your role may not use this endpoint'));
    return true;
  }
}
