import { io, type Socket } from 'socket.io-client';
import { publicEnv } from '@/config/env';

let current: { readonly token: string; readonly socket: Socket } | null = null;

/** One authenticated socket per access token; a new token (refresh) replaces it. */
export const getSocket = (token: string): Socket => {
  if (current?.token === token) return current.socket;
  current?.socket.disconnect();
  const base = publicEnv.NEXT_PUBLIC_WS_URL === '/' ? undefined : publicEnv.NEXT_PUBLIC_WS_URL;
  const socket = io(base, { auth: { token }, transports: ['websocket'], reconnectionDelay: 500, reconnectionDelayMax: 5_000 });
  current = { token, socket };
  return socket;
};

export const closeSocket = (): void => {
  current?.socket.disconnect();
  current = null;
};
