export interface ProviderPayment {
  readonly id: string;
  readonly status: 'pending' | 'succeeded' | 'failed';
  readonly amount: number;
  readonly orderRef: string;
  readonly paymentUrl?: string;
  readonly refunded?: number;
  readonly seq?: number;
}

export interface ProviderRefund {
  readonly id: string;
  readonly status: 'pending' | 'succeeded' | 'failed';
  readonly amount: number;
  readonly paymentId: string;
}

export type ProviderFailure =
  | { readonly kind: 'rate_limited'; readonly retryAfterMs: number }
  | { readonly kind: 'unavailable'; readonly message: string }
  | { readonly kind: 'rejected'; readonly status: number; readonly message: string };

export type ProviderResult<T> = { readonly ok: true; readonly value: T } | ({ readonly ok: false } & ProviderFailure);

export interface ProviderClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/**
 * HTTP client of the payment provider. Every failure is a value: `rate_limited` (429, with Retry-After),
 * `unavailable` (5xx, timeouts, network) and `rejected` (other 4xx). Callers decide how to retry; because every
 * create call carries an Idempotency-Key, retrying can never charge or refund twice.
 */
export const createProviderClient = (options: ProviderClientOptions) => {
  const doFetch = options.fetchImpl ?? fetch;
  const base = options.baseUrl.replace(/\/$/, '');

  const call = async <T>(method: 'GET' | 'POST', path: string, body?: unknown, idempotencyKey?: string): Promise<ProviderResult<T>> => {
    try {
      const res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
      });
      const text = await res.text();
      if (res.status === 429) return { ok: false, kind: 'rate_limited', retryAfterMs: Math.max(1, Number(res.headers.get('retry-after') ?? 1)) * 1_000 };
      if (res.status >= 500) return { ok: false, kind: 'unavailable', message: `provider answered ${res.status}` };
      if (res.status >= 400) return { ok: false, kind: 'rejected', status: res.status, message: text.slice(0, 300) };
      return { ok: true, value: JSON.parse(text) as T };
    } catch (error) {
      return { ok: false, kind: 'unavailable', message: error instanceof Error ? error.message : String(error) };
    }
  };

  return Object.freeze({
    createPayment: (input: { amount: number; orderRef: string; returnUrl: string; key: string }) =>
      call<ProviderPayment>('POST', '/v1/payments', { amount: input.amount, orderRef: input.orderRef, returnUrl: input.returnUrl }, input.key),
    getPayment: (id: string) => call<ProviderPayment>('GET', `/v1/payments/${encodeURIComponent(id)}`),
    createRefund: (input: { paymentId: string; amount: number; reference: string; key: string }) =>
      call<ProviderRefund>('POST', '/v1/refunds', { paymentId: input.paymentId, amount: input.amount, reference: input.reference }, input.key),
    getRefund: (id: string) => call<ProviderRefund>('GET', `/v1/refunds/${encodeURIComponent(id)}`),
  });
};

export type ProviderClient = ReturnType<typeof createProviderClient>;
