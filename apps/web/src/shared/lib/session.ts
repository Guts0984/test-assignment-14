import { closeSocket } from './socket';
import { useSyncExternalStore } from 'react';

export type Role = 'buyer' | 'organizer' | 'scanner' | 'finance';

export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: Role;
}

export type Session =
  | { readonly status: 'loading' }
  | { readonly status: 'anonymous' }
  | { readonly status: 'authenticated'; readonly accessToken: string; readonly user: SessionUser };

let session: Session = { status: 'loading' };
const listeners = new Set<() => void>();

const publish = (next: Session): void => {
  session = next;
  listeners.forEach((l) => l());
};

export const getSession = (): Session => session;
const STORE_KEY = 'ticketing-session';

const store = (value: { readonly accessToken: string; readonly user: SessionUser } | null): void => {
  try {
    if (value) sessionStorage.setItem(STORE_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(STORE_KEY);
  } catch {
    // storage blocked: the session then simply lives in memory and a reload refreshes it
  }
};

/** Expiry (ms) of a JWT access token, or 0 when it cannot be read. */
const expiryOf = (token: string): number => {
  try {
    const payload = JSON.parse(atob((token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
};

export const setSession = (accessToken: string, user: SessionUser): void => {
  store({ accessToken, user });
  publish({ status: 'authenticated', accessToken, user });
};
export const clearSession = (): void => {
  closeSocket(); // a signed-out tab must not keep a live, authenticated socket
  store(null);
  publish({ status: 'anonymous' });
};

/**
 * Takes the session of this tab over a reload while its access token is still good, so a page load does not rotate the
 * refresh token (a navigation that cuts such a refresh short would lose the new cookie and look like token theft).
 */
export const restoreSession = (): boolean => {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw) as { accessToken?: unknown; user?: SessionUser };
    if (typeof saved.accessToken !== 'string' || !saved.user || expiryOf(saved.accessToken) < Date.now() + 60_000) return false;
    publish({ status: 'authenticated', accessToken: saved.accessToken, user: saved.user });
    return true;
  } catch {
    return false;
  }
};

export const useSession = (): Session =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSession,
    () => ({ status: 'loading' }) as Session,
  );

export const accessToken = (): string | null => (session.status === 'authenticated' ? session.accessToken : null);
