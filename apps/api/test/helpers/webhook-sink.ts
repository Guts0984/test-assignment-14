import { createServer, type Server } from 'node:http';

export interface ReceivedWebhook {
  readonly at: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
  readonly json: { id: string; type: string; data: Record<string, unknown> };
}

/** A small HTTP endpoint that records every webhook it gets; `failNext` makes the next N deliveries fail. */
export const startWebhookSink = async () => {
  const received: ReceivedWebhook[] = [];
  let failures = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (failures > 0) {
        failures -= 1;
        res.writeHead(500).end();
        return;
      }
      const body = Buffer.concat(chunks).toString('utf8');
      received.push({ at: Date.now(), headers: req.headers, body, json: JSON.parse(body) as ReceivedWebhook['json'] });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    failNext: (n: number) => {
      failures = n;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};
