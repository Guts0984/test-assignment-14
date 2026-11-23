import { afterEach, describe, expect, it } from 'vitest';
import { clearSession, getSession, restoreSession, setSession, type SessionUser } from './session';

const user: SessionUser = { id: 'u1', email: 'a@b.c', displayName: 'A', role: 'buyer' };
const jwt = (expSeconds: number): string => `h.${btoa(JSON.stringify({ exp: expSeconds })).replace(/=/g, '')}.s`;
const inSeconds = (n: number): number => Math.floor(Date.now() / 1000) + n;

/** Simulates a page reload: the in-memory session is lost, sessionStorage stays. */
const reload = (): void => {
  const saved = sessionStorage.getItem('ticketing-session');
  clearSession();
  if (saved) sessionStorage.setItem('ticketing-session', saved);
};

describe('session restore on reload', () => {
  afterEach(() => {
    clearSession();
  });

  it('keeps a session whose access token is still good, without a refresh', () => {
    setSession(jwt(inSeconds(600)), user);
    reload();
    expect(getSession().status).toBe('anonymous');
    expect(restoreSession()).toBe(true);
    expect(getSession().status).toBe('authenticated');
  });

  it('does not take over a token that is about to expire or has expired', () => {
    setSession(jwt(inSeconds(20)), user);
    reload();
    expect(restoreSession()).toBe(false);
    setSession(jwt(inSeconds(-5)), user);
    reload();
    expect(restoreSession()).toBe(false);
  });

  it('forgets everything on logout', () => {
    setSession(jwt(inSeconds(600)), user);
    clearSession();
    expect(restoreSession()).toBe(false);
  });

  it('ignores garbage in storage', () => {
    sessionStorage.setItem('ticketing-session', '{not json');
    expect(restoreSession()).toBe(false);
    sessionStorage.setItem('ticketing-session', JSON.stringify({ accessToken: 5 }));
    expect(restoreSession()).toBe(false);
  });
});
