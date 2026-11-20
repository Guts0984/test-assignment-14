export type ChaosMode = 'normal' | 'duplicate' | 'delayed' | 'out_of_order' | 'lost';

const MODES: readonly ChaosMode[] = ['normal', 'duplicate', 'delayed', 'out_of_order', 'lost'];

/** Chaos is deterministic: a shared counter cycles through every failure mode, so each one is exercised regularly. */
export const chaosModeFor = (counter: number): ChaosMode => MODES[((counter % MODES.length) + MODES.length) % MODES.length] ?? 'normal';

export interface Delivery {
  readonly kind: 'primary' | 'duplicate' | 'stale_failed';
  readonly delayMs: number;
}

/**
 * What the provider does with the webhook of one successful operation.
 *  - duplicate: the same event twice;
 *  - delayed: arrives up to `maxDelayMs` late;
 *  - out_of_order: a stale `failed` event is delivered after the `succeeded` one;
 *  - lost: never sent (only reconciliation can find it).
 */
export const planDeliveries = (mode: ChaosMode, maxDelayMs: number, random: number): readonly Delivery[] => {
  switch (mode) {
    case 'normal':
      return [{ kind: 'primary', delayMs: 0 }];
    case 'duplicate':
      return [{ kind: 'primary', delayMs: 0 }, { kind: 'duplicate', delayMs: Math.floor(random * 500) }];
    case 'delayed':
      return [{ kind: 'primary', delayMs: Math.floor(random * maxDelayMs) }];
    case 'out_of_order':
      return [{ kind: 'primary', delayMs: 0 }, { kind: 'stale_failed', delayMs: 300 + Math.floor(random * 700) }];
    case 'lost':
      return [];
  }
};

/** In chaos mode every tenth request is answered with 503. */
export const isUnavailableRequest = (requestCounter: number): boolean => requestCounter % 10 === 0;
