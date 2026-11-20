import { expect, test } from '@playwright/test';
import { createEvent, login, post, registerBuyer, BASE } from './support/api';
import { loginUi } from './support/ui';

// Needs the stack started with a queue limit of 1 (`pnpm e2e:queue`); with the real thresholds the queue never wakes up.
test.skip(process.env['E2E_QUEUE_LIMIT'] !== '1', 'run with E2E_QUEUE_LIMIT=1 against a stack started with limit 1');

test('@queue with a limit of 1 the second buyer waits, keeps the place on reload, and is let in after the first leaves', async ({ page }) => {
  const { eventId } = await createEvent({ seats: 10 });
  const [first, second] = await Promise.all([registerBuyer(), registerBuyer()]);
  const firstToken = (await login(first.email, first.password)).token;
  const joined = await post<{ status: string }>(`/api/events/${eventId}/queue`, {}, firstToken);
  expect(joined.json.status).toBe('admitted');

  await loginUi(page, BASE, second.email, second.password);
  const secondToken = (await login(second.email, second.password)).token;
  expect((await post<{ status: string }>(`/api/events/${eventId}/queue`, {}, secondToken)).json.status).toBe('waiting');
  await page.goto(`${BASE}/en/events/${eventId}`);
  await expect(page.getByTestId('queue-position')).toContainText('1');
  await page.reload();
  await expect(page.getByTestId('queue-position')).toContainText('1');

  const left = await fetch(`${BASE}/api/events/${eventId}/queue`, { method: 'DELETE', headers: { authorization: `Bearer ${firstToken}` } });
  expect(left.status).toBeLessThan(300);
  await expect(page.getByTestId('queue-admitted')).toBeVisible({ timeout: 30_000 });
});
