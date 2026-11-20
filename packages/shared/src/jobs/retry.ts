import { RULES } from '../rules/constants.js';

/**
 * Delay before retry number `attempt` (1-based): exponential backoff from the base delay, capped at 5 minutes,
 * with up to 20% jitter. `random` is injected (0 <= random < 1) so the function stays pure.
 */
export const retryDelayMs = (attempt: number, random: number): number => {
  const exponent = Math.min(Math.max(attempt, 1) - 1, 16);
  const raw = Math.min(RULES.jobBackoffBaseMs * 2 ** exponent, 5 * 60_000);
  return Math.round(raw * (1 + 0.2 * random));
};
