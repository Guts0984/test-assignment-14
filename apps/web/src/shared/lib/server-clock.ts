/**
 * The hold timer must follow the SERVER clock: a browser whose clock is minutes off still shows the right time.
 * Every api response carries `serverTime`; the offset (server - client) is remembered and applied to `Date.now()`.
 */
let offsetMs = 0;

export const observeServerTime = (serverIso: string, receivedAtMs: number = Date.now()): void => {
  const server = Date.parse(serverIso);
  if (!Number.isNaN(server)) offsetMs = server - receivedAtMs;
};

export const serverNow = (clientNowMs: number = Date.now()): number => clientNowMs + offsetMs;

/** Milliseconds left until `expiresIso`, measured on the server's clock. */
export const remainingMs = (expiresIso: string, clientNowMs: number = Date.now()): number => Date.parse(expiresIso) - serverNow(clientNowMs);

export const resetServerClock = (): void => {
  offsetMs = 0;
};
