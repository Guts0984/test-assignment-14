import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { constantTimeEquals, hashRefreshToken, newOpaqueToken, signAccessToken, verifyAccessToken } from './tokens.js';

const secret = 'unit-test-secret-0123456789-0123456789';

describe('access tokens', () => {
  it('round-trips the claims', async () => {
    const token = await signAccessToken(secret, 60, { sub: 'u1', role: 'organizer', sid: 's1' });
    expect(await verifyAccessToken(secret, token)).toEqual({ sub: 'u1', role: 'organizer', sid: 's1' });
  });
  it('rejects a different secret, a different algorithm and expired tokens', async () => {
    const good = await signAccessToken(secret, 60, { sub: 'u1', role: 'buyer', sid: 's1' });
    expect(await verifyAccessToken('another-secret-0123456789-0123456789!', good)).toBeNull();
    const hs512 = await new SignJWT({ role: 'buyer', sid: 's', typ: 'access' }).setProtectedHeader({ alg: 'HS512' }).setSubject('u').setIssuer('ticketing').setAudience('ticketing-api').setIssuedAt().setExpirationTime('1m').sign(new TextEncoder().encode(secret));
    expect(await verifyAccessToken(secret, hs512)).toBeNull();
    const expired = await signAccessToken(secret, -10, { sub: 'u1', role: 'buyer', sid: 's1' });
    expect(await verifyAccessToken(secret, expired)).toBeNull();
  });
  it('rejects tokens with a foreign issuer or audience', async () => {
    const make = (iss: string, aud: string) => new SignJWT({ role: 'buyer', sid: 's', typ: 'access' }).setProtectedHeader({ alg: 'HS256' }).setSubject('u').setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime('1m').sign(new TextEncoder().encode(secret));
    expect(await verifyAccessToken(secret, await make('evil', 'ticketing-api'))).toBeNull();
    expect(await verifyAccessToken(secret, await make('ticketing', 'other-api'))).toBeNull();
  });
});

describe('refresh tokens', () => {
  it('are random, long and hashed with a pepper', () => {
    const a = newOpaqueToken();
    expect(a).not.toBe(newOpaqueToken());
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(hashRefreshToken('pepper-1', a)).not.toBe(hashRefreshToken('pepper-2', a));
    expect(hashRefreshToken('pepper-1', a)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('constantTimeEquals compares without early exit and handles different lengths', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
    expect(constantTimeEquals('abc', 'abcd')).toBe(false);
  });
});
