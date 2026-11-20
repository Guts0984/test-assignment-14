import type { Pool } from 'pg';
import type { Role } from '@ticketing/shared';
import { appError, err, ok, type Result } from '../../../common/result.js';
import { hashPassword, verifyPasswordConstantTime } from './password.js';
import { issueRefreshToken, revokeByToken, rotateRefreshToken, type SessionConfig } from './sessions.js';
import { signAccessToken } from './tokens.js';

export interface AuthConfig extends SessionConfig {
  readonly accessSecret: string;
  readonly accessTtlSeconds: number;
}

export interface UserView {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: Role;
}

export interface TokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number;
  readonly user: UserView;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  role: Role;
}

const toView = (u: UserRow): UserView => ({ id: u.id, email: u.email, displayName: u.display_name, role: u.role });

const mintPair = async (pool: Pool, cfg: AuthConfig, user: UserRow, familyId?: string): Promise<TokenPair> => {
  const refresh = await issueRefreshToken(pool, cfg, user.id, familyId);
  const accessToken = await signAccessToken(cfg.accessSecret, cfg.accessTtlSeconds, { sub: user.id, role: user.role, sid: refresh.familyId });
  return { accessToken, refreshToken: refresh.token, expiresInSeconds: cfg.accessTtlSeconds, user: toView(user) };
};

export const registerBuyer = async (
  pool: Pool,
  cfg: AuthConfig,
  input: { readonly email: string; readonly password: string; readonly displayName: string },
): Promise<Result<TokenPair>> => {
  const passwordHash = await hashPassword(input.password);
  const res = await pool.query<UserRow>(
    `INSERT INTO users (email, password_hash, display_name, role) VALUES ($1, $2, $3, 'buyer') ON CONFLICT (email) DO NOTHING RETURNING *`,
    [input.email, passwordHash, input.displayName],
  );
  const user = res.rows[0];
  if (!user) return err(appError('CONFLICT', 'This email is already registered'));
  return ok(await mintPair(pool, cfg, user));
};

/** Identical failure for an unknown account and a wrong password. */
export const login = async (pool: Pool, cfg: AuthConfig, email: string, password: string): Promise<Result<TokenPair>> => {
  const res = await pool.query<UserRow>(`SELECT * FROM users WHERE email = $1`, [email]);
  const user = res.rows[0] ?? null;
  const valid = await verifyPasswordConstantTime(user?.password_hash ?? null, password);
  if (!user || !valid) return err(appError('UNAUTHENTICATED', 'Invalid email or password'));
  return ok(await mintPair(pool, cfg, user));
};

export const refresh = async (pool: Pool, cfg: AuthConfig, token: string): Promise<Result<TokenPair>> => {
  const outcome = await rotateRefreshToken(pool, cfg, token);
  if (outcome.kind === 'reused') return err(appError('TOKEN_REUSE_DETECTED', 'Refresh token was already used; the session was revoked'));
  if (outcome.kind === 'invalid') return err(appError('UNAUTHENTICATED', 'Invalid refresh token'));
  const res = await pool.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [outcome.userId]);
  const user = res.rows[0];
  if (!user) return err(appError('UNAUTHENTICATED', 'Invalid refresh token'));
  return ok(await mintPair(pool, cfg, user, outcome.familyId));
};

export const logout = async (pool: Pool, cfg: AuthConfig, token: string): Promise<string | null> => revokeByToken(pool, cfg, token);

export const findUser = async (pool: Pool, id: string): Promise<UserView | null> => {
  const res = await pool.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [id]);
  const user = res.rows[0];
  return user ? toView(user) : null;
};
