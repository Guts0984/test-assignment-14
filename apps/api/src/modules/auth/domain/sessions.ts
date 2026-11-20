import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { newOpaqueToken, hashRefreshToken } from './tokens.js';

export interface SessionConfig {
  readonly pepper: string;
  readonly refreshTtlSeconds: number;
}

export interface IssuedRefresh {
  readonly token: string;
  readonly familyId: string;
}

/** Creates a new refresh token, starting a new family (login) or continuing one (rotation). */
export const issueRefreshToken = async (pool: Pool, cfg: SessionConfig, userId: string, familyId: string = randomUUID()): Promise<IssuedRefresh> => {
  const token = newOpaqueToken();
  await pool.query(
    `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
    [userId, familyId, hashRefreshToken(cfg.pepper, token), cfg.refreshTtlSeconds],
  );
  return { token, familyId };
};

export type RotateOutcome =
  | { readonly kind: 'rotated'; readonly userId: string; readonly familyId: string }
  | { readonly kind: 'reused'; readonly familyId: string }
  | { readonly kind: 'invalid' };

/**
 * Rotation with reuse detection. The atomic UPDATE lets exactly one request consume a token; any later (or
 * parallel) presentation of the same token proves it leaked, so the whole family is revoked.
 */
export const rotateRefreshToken = async (pool: Pool, cfg: SessionConfig, token: string): Promise<RotateOutcome> => {
  const hash = hashRefreshToken(cfg.pepper, token);
  const used = await pool.query<{ user_id: string; family_id: string }>(
    `UPDATE refresh_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING user_id, family_id`,
    [hash],
  );
  const row = used.rows[0];
  if (row) return { kind: 'rotated', userId: row.user_id, familyId: row.family_id };
  const known = await pool.query<{ family_id: string; used_at: Date | null; revoked_at: Date | null }>(
    `SELECT family_id, used_at, revoked_at FROM refresh_tokens WHERE token_hash = $1`,
    [hash],
  );
  const seen = known.rows[0];
  if (!seen) return { kind: 'invalid' };
  if (seen.used_at !== null) {
    await revokeFamily(pool, seen.family_id);
    return { kind: 'reused', familyId: seen.family_id };
  }
  return { kind: 'invalid' };
};

export const revokeFamily = async (pool: Pool, familyId: string): Promise<void> => {
  await pool.query(`UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE family_id = $1`, [familyId]);
};

export const revokeByToken = async (pool: Pool, cfg: SessionConfig, token: string): Promise<void> => {
  const res = await pool.query<{ family_id: string }>(`SELECT family_id FROM refresh_tokens WHERE token_hash = $1`, [hashRefreshToken(cfg.pepper, token)]);
  const family = res.rows[0]?.family_id;
  if (family) await revokeFamily(pool, family);
};

/** A session is alive while its family has no revoked token. */
export const isSessionActive = async (pool: Pool, familyId: string): Promise<boolean> => {
  const res = await pool.query(`SELECT 1 FROM refresh_tokens WHERE family_id = $1 AND revoked_at IS NOT NULL LIMIT 1`, [familyId]);
  if (res.rowCount === 1) return false;
  const exists = await pool.query(`SELECT 1 FROM refresh_tokens WHERE family_id = $1 LIMIT 1`, [familyId]);
  return exists.rowCount === 1;
};
