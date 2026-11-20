import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { Role } from '@ticketing/shared';

const ISSUER = 'ticketing';
const AUDIENCE = 'ticketing-api';

export interface AccessClaims {
  readonly sub: string;
  readonly role: Role;
  /** Session id = refresh token family; revoking the family ends the session. */
  readonly sid: string;
}

const keyOf = (secret: string): Uint8Array => new TextEncoder().encode(secret);

export const signAccessToken = (secret: string, ttlSeconds: number, claims: AccessClaims): Promise<string> =>
  new SignJWT({ role: claims.role, sid: claims.sid, typ: 'access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(keyOf(secret));

const ROLES: readonly Role[] = ['buyer', 'organizer', 'scanner', 'finance'];

/** Pinned to HS256 (alg none / other algorithms are rejected); returns null for anything invalid. */
export const verifyAccessToken = async (secret: string, token: string): Promise<AccessClaims | null> => {
  try {
    const { payload } = await jwtVerify(token, keyOf(secret), { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE, requiredClaims: ['sub', 'exp', 'iat'] });
    const role = payload['role'];
    const sid = payload['sid'];
    if (payload['typ'] !== 'access' || typeof payload.sub !== 'string' || typeof sid !== 'string') return null;
    if (typeof role !== 'string' || !ROLES.includes(role as Role)) return null;
    return { sub: payload.sub, role: role as Role, sid };
  } catch {
    return null;
  }
};

export const newOpaqueToken = (): string => randomBytes(32).toString('base64url');

export const hashRefreshToken = (pepper: string, token: string): string => createHmac('sha256', pepper).update(token).digest('hex');

export const constantTimeEquals = (a: string, b: string): boolean => {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};
