import { Agent, request as httpRequest, type IncomingHttpHeaders } from 'node:http';

export interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly text: string;
  readonly json: unknown;
  readonly ms: number;
}

export interface ClientOptions {
  readonly baseUrl: string;
  /** Real source address (127.0.0.N): every client in a test can be a different "IP". */
  readonly sourceIp?: string;
  readonly token?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface RequestOptions {
  readonly body?: unknown;
  /** Raw body string, sent as is (malformed JSON, huge payloads, ...). */
  readonly rawBody?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly token?: string | null;
  readonly timeoutMs?: number;
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/** Real HTTP requests with a chosen source IP. No mocks: this talks to the listening server over TCP. */
export const client = (options: ClientOptions) => {
  const url = new URL(options.baseUrl);
  const agent = new Agent({ keepAlive: false, localAddress: options.sourceIp });

  const request = (method: string, path: string, opts: RequestOptions = {}): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const started = performance.now();
      const query = opts.query
        ? `?${new URLSearchParams(Object.entries(opts.query).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]]))).toString()}`
        : '';
      const payload = opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
      const token = opts.token === undefined ? options.token : (opts.token ?? undefined);
      const headers: Record<string, string> = {
        ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...options.headers,
        ...opts.headers,
      };
      const req = httpRequest({ agent, host: url.hostname, port: url.port, method, path: `${path}${query}`, headers, timeout: opts.timeoutMs ?? 30_000 }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: parseJson(text), ms: performance.now() - started });
        });
      });
      req.on('timeout', () => req.destroy(new Error('request timed out')));
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });

  return Object.freeze({
    request,
    get: (path: string, opts?: RequestOptions) => request('GET', path, opts),
    post: (path: string, body?: unknown, opts?: RequestOptions) => request('POST', path, { ...opts, body }),
    patch: (path: string, body?: unknown, opts?: RequestOptions) => request('PATCH', path, { ...opts, body }),
    delete: (path: string, opts?: RequestOptions) => request('DELETE', path, opts),
    close: () => agent.destroy(),
  });
};

export type Client = ReturnType<typeof client>;
