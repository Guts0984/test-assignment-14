/** `.env` points at the compose hostname `postgres`; from the host the same server is on localhost. */
export const hostReachableUrl = (url: string): string => {
  const parsed = new URL(url);
  if (parsed.hostname === 'postgres') {
    parsed.hostname = 'localhost';
    parsed.port = process.env['POSTGRES_PUBLISH_PORT'] ?? '5432'; // the host port compose publishes (see .env)
  }
  return parsed.toString();
};

export const withDatabase = (url: string, database: string): string => {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
};

export const TEMPLATE_DB = 'tickets_test_template';
