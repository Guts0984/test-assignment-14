import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { newOpaqueToken, hashRefreshToken, openToken, sealToken } from './tokens.js';

export interface SessionConfig {
  readonly pepper: string;
  readonly refreshTtlSeconds: number;
  /** How long a used token may be presented again and be answered with the token that replaced it (0 = never). */
  readonly replayGraceMs: number;
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
  | { readonly kind: 'rotated'; readonly userId: string; readonly familyId: string; readonly token: string }
  | { readonly kind: 'reused'; readonly familyId: string }
  | { readonly kind: 'invalid' };

/**
 * Rotation with reuse detection. One atomic statement lets exactly one request consume a token and create its successor.
 * A second presentation of the same token within the grace period (the first response got lost on its way to the browser)
 * is answered with that same successor; later, or if the successor was already used, it proves a leak and the family is revoked.
 */
export const rotateRefreshToken = async (pool: Pool, cfg: SessionConfig, token: string): Promise<RotateOutcome> => {
  const hash = hashRefreshToken(cfg.pepper, token);
  const next = newOpaqueToken();
  const used = await pool.query<{ user_id: string; family_id: string }>(
    `WITH used AS (
       UPDATE refresh_tokens SET used_at = now(), successor_enc = $2
       WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING user_id, family_id)
     INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
     SELECT user_id, family_id, $3, now() + make_interval(secs => $4) FROM used RETURNING user_id, family_id`,
    [hash, sealToken(cfg.pepper, next), hashRefreshToken(cfg.pepper, next), cfg.refreshTtlSeconds],
  );
  const row = used.rows[0];
  if (row) return { kind: 'rotated', userId: row.user_id, familyId: row.family_id, token: next };
  const known = await pool.query<{ user_id: string; family_id: string; used_at: Date | null; revoked_at: Date | null; successor_enc: string | null; recent: boolean }>(
    `SELECT user_id, family_id, used_at, revoked_at, successor_enc, (used_at IS NOT NULL AND now() - used_at <= make_interval(secs => $2::float8 / 1000.0)) AS recent
     FROM refresh_tokens WHERE token_hash = $1`,
    [hash, cfg.replayGraceMs],
  );
  const seen = known.rows[0];
  if (!seen || seen.used_at === null) return { kind: 'invalid' };
  if (seen.revoked_at === null && seen.recent && seen.successor_enc) {
    const successor = openToken(cfg.pepper, seen.successor_enc);
    const alive = successor
      ? await pool.query(`SELECT 1 FROM refresh_tokens WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()`, [hashRefreshToken(cfg.pepper, successor)])
      : null;
    if (successor && alive?.rowCount === 1) return { kind: 'rotated', userId: seen.user_id, familyId: seen.family_id, token: successor };
  }
  await revokeFamily(pool, seen.family_id);
  return { kind: 'reused', familyId: seen.family_id };
};

export const revokeFamily = async (pool: Pool, familyId: string): Promise<void> => {
  await pool.query(`UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE family_id = $1`, [familyId]);
};

/** Revokes the session the token belongs to and returns its id (the session id in access tokens), or null for an unknown token. */
export const revokeByToken = async (pool: Pool, cfg: SessionConfig, token: string): Promise<string | null> => {
  const res = await pool.query<{ family_id: string }>(`SELECT family_id FROM refresh_tokens WHERE token_hash = $1`, [hashRefreshToken(cfg.pepper, token)]);
  const family = res.rows[0]?.family_id;
  if (!family) return null;
  await revokeFamily(pool, family);
  return family;
};

/** A session is alive while its family has no revoked token. */
export const isSessionActive = async (pool: Pool, familyId: string): Promise<boolean> => {
  const res = await pool.query(`SELECT 1 FROM refresh_tokens WHERE family_id = $1 AND revoked_at IS NOT NULL LIMIT 1`, [familyId]);
  if (res.rowCount === 1) return false;
  const exists = await pool.query(`SELECT 1 FROM refresh_tokens WHERE family_id = $1 LIMIT 1`, [familyId]);
  return exists.rowCount === 1;
};
