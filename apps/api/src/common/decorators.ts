import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { Role } from '@ticketing/shared';

export const IS_PUBLIC = 'isPublic';
export const ROLES_KEY = 'roles';

/** Opts a route out of the default-deny authentication. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);
/** Restricts a route to the given roles (authentication is always required). */
export const Roles = (...roles: readonly Role[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);

export interface AuthUser {
  readonly id: string;
  readonly role: Role;
  readonly sid: string;
}

export interface AuthedRequest extends Request {
  user?: AuthUser;
}

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const user = ctx.switchToHttp().getRequest<AuthedRequest>().user;
  if (!user) throw new Error('CurrentUser used on a route without authentication');
  return user;
});
