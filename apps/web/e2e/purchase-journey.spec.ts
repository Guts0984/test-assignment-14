import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { BASE, createEvent, post, registerBuyer } from './support/api';
import { loginUi, pickSeat } from './support/ui';

test('seats -> promo -> stub payment -> ticket -> transfer -> the scanner accepts the new code and rejects the old one', async ({ browser }) => {
  const { eventId, organizerToken } = await createEvent({ seats: 10 });
  const promo = `E2E${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
  expect((await post('/api/promos', { code: promo, kind: 'percent', value: 10, usageLimit: 5, eventId }, organizerToken)).status).toBe(201);
  const scannerEmail = 'scanner1@example.test';
  expect((await post(`/api/organizer/events/${eventId}/staff`, { email: scannerEmail }, organizerToken)).status).toBeLessThan(300);

  const [sender, receiver] = await Promise.all([registerBuyer(), registerBuyer()]);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await loginUi(page, BASE, sender.email, sender.password);
  await page.goto(`${BASE}/en/events/${eventId}`);
  await pickSeat(page, '1', '1');
  await page.getByRole('button', { name: /Hold for/ }).click();
  await expect(page.getByTestId('order-panel')).toBeVisible();

  const total = page.getByTestId('order-totals').first();
  const before = await total.innerText();
  await page.getByRole('textbox', { name: 'Promo code' }).fill(promo);
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByTestId('order-totals').first()).not.toHaveText(before);

  // The stub fails every 10th request on purpose; a real buyer simply presses Pay again.
  await expect(async () => {
    await page.getByTestId('checkout').click();
    await page.waitForURL(/\/stub\/pay\//, { timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Success' }).click();
  await page.waitForURL((u) => !u.pathname.includes('/stub/'), { timeout: 15_000 }); // back in the shop: the payment is settled
  await page.goto(`${BASE}/en/tickets`);
  const qr = page.getByTestId('ticket-qr').first();
  await expect(qr).toBeVisible({ timeout: 60_000 });
  const oldCode = (await qr.getAttribute('data-code')) ?? '';
  expect(oldCode.length).toBeGreaterThan(10);

  await page.getByTestId('transfer-open').first().click();
  await page.getByRole('textbox', { name: 'Recipient email' }).fill(receiver.email);
  await page.getByTestId('transfer-submit').click();
  await expect(page.getByTestId('ticket')).toHaveCount(0, { timeout: 30_000 });

  const rctx = await browser.newContext();
  const rpage = await rctx.newPage();
  await loginUi(rpage, BASE, receiver.email, receiver.password);
  await rpage.goto(`${BASE}/en/tickets`);
  const newQr = rpage.getByTestId('ticket-qr').first();
  await expect(newQr).toBeVisible({ timeout: 30_000 });
  const newCode = (await newQr.getAttribute('data-code')) ?? '';
  expect(newCode).not.toBe(oldCode);

  const sctx = await browser.newContext();
  const spage = await sctx.newPage();
  await loginUi(spage, BASE, scannerEmail, process.env['SEED_USER_PASSWORD'] ?? '');
  await spage.goto(`${BASE}/en/scanner/${eventId}`);
  // The result box keeps the previous answer until the next one arrives, so wait for the expected one explicitly.
  const scan = async (code: string, expected: { result: string; reason: string }): Promise<void> => {
    await spage.getByTestId('scan-code').fill(code);
    await spage.getByTestId('scan-submit').click();
    const r = spage.getByTestId('scan-result');
    await expect(r).toHaveAttribute('data-result', expected.result);
    await expect(r).toHaveAttribute('data-reason', expected.reason);
  };
  await scan(oldCode, { result: 'deny', reason: 'transferred' });
  await scan(newCode, { result: 'allow', reason: 'ok' });
  await scan(newCode, { result: 'deny', reason: 'already_entered' });
  await Promise.all([ctx.close(), rctx.close(), sctx.close()]);
});
