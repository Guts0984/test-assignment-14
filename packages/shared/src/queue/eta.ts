/** Fallback admission speed when no one was admitted recently: the full selecting capacity per 10 minutes. */
const FALLBACK_PER_SECOND = 200 / 600;

export interface EtaInput {
  /** 1-based place in the waiting line. */
  readonly position: number;
  /** People admitted during the observed window. */
  readonly admittedInWindow: number;
  readonly windowSeconds: number;
}

/** Estimated seconds until the person at `position` is admitted. */
export const estimateWaitSeconds = ({ position, admittedInWindow, windowSeconds }: EtaInput): number => {
  if (position <= 1) return 0;
  const observed = windowSeconds > 0 ? admittedInWindow / windowSeconds : 0;
  const rate = observed > 0 ? observed : FALLBACK_PER_SECOND;
  return Math.ceil((position - 1) / rate);
};
