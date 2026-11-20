import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Role } from '@ticketing/shared';
import { insertUsers } from '@ticketing/testkit';
import { signAccessToken } from '../../src/modules/auth/domain/tokens.js';
import type { Env } from '../../src/config/env.schema.js';

export interface TestUser {
  readonly id: string;
  readonly token: string;
  readonly role: Role;
  readonly familyId: string;
}

/** A user with a valid session, minted directly (fast path for scenarios that are not about login). */
export const createUsers = async (pool: Pool, env: Env, count: number, role: Role = 'buyer'): Promise<readonly TestUser[]> => {
  const ids = await insertUsers(pool, count);
  if (role !== 'buyer') await pool.query(`UPDATE users SET role = $2 WHERE id = ANY($1::uuid[])`, [ids, role]);
  const families = ids.map(() => randomUUID());
  await pool.query(
    `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at) SELECT u, f, md5(f::text), now() + interval '1 day' FROM unnest($1::uuid[], $2::uuid[]) AS t(u, f)`,
    [ids, families],
  );
  return Promise.all(ids.map(async (id, i) => ({ id, role, familyId: families[i] ?? '', token: await signAccessToken(env.JWT_ACCESS_SECRET, 900, { sub: id, role, sid: families[i] ?? '' }) })));
};

export const createUser = async (pool: Pool, env: Env, role: Role = 'buyer'): Promise<TestUser> => {
  const [user] = await createUsers(pool, env, 1, role);
  if (!user) throw new Error('user not created');
  return user;
};
