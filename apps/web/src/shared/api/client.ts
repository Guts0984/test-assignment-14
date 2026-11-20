import { publicEnv } from '@/config/env';
import { client } from './generated/client.gen';
import { clearSession, accessToken, setSession, type SessionUser } from '@/shared/lib/session';
import { observeServerTime } from '@/shared/lib/server-clock';

interface TokenPair {
  readonly accessToken: string;
  readonly user: SessionUser;
}

let refreshing: Promise<boolean> | null = null;

/** One refresh at a time, whatever number of requests failed with 401 meanwhile. */
export const refreshSession = (): Promise<boolean> => {
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${publicEnv.NEXT_PUBLIC_API_BASE}/api/auth/refresh`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (!res.ok) {
        clearSession();
        return false;
      }
      const pair = (await res.json()) as TokenPair;
      setSession(pair.accessToken, pair.user);
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
};

const isAuthCall = (url: string): boolean => url.includes('/api/auth/');

/** fetch with the bearer token; a 401 triggers one refresh and one retry. */
const authedFetch = async (input: Request): Promise<Response> => {
  const attempt = (token: string | null, req: Request): Promise<Response> => {
    const next = new Request(req);
    if (token) next.headers.set('authorization', `Bearer ${token}`);
    return fetch(next, { credentials: 'include' });
  };
  const retry = input.clone();
  const res = await attempt(accessToken(), input);
  if (res.status === 401 && !isAuthCall(input.url) && (await refreshSession())) return attempt(accessToken(), retry);
  return res;
};

client.setConfig({ baseUrl: publicEnv.NEXT_PUBLIC_API_BASE, fetch: authedFetch });
client.interceptors.response.use((response) => {
  const server = response.headers.get('date');
  if (server) observeServerTime(new Date(server).toISOString());
  return response;
});

export { client };
