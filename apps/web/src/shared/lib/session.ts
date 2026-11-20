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
export const setSession = (accessToken: string, user: SessionUser): void => publish({ status: 'authenticated', accessToken, user });
export const clearSession = (): void => {
  closeSocket(); // a signed-out tab must not keep a live, authenticated socket
  publish({ status: 'anonymous' });
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
