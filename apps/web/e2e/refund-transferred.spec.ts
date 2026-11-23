import { expect, test } from '@playwright/test';
import { BASE, createEvent, registerBuyer } from './support/api';
import { loginUi, pickSeat } from './support/ui';

test('a ticket received by transfer can be returned by its new holder, and the buyer sees the refund arrive', async ({ browser }) => {
  const { eventId } = await createEvent({ seats: 10 });
  const [buyer, friend] = await Promise.all([registerBuyer(), registerBuyer()]);
  const bctx = await browser.newContext();
  const page = await bctx.newPage();
  await loginUi(page, BASE, buyer.email, buyer.password);
  await page.goto(`${BASE}/en/events/${eventId}`);
  await pickSeat(page, '1', '1');
  await page.getByRole('button', { name: /Hold for/ }).click();
  await expect(async () => {
    await page.getByTestId('checkout').click();
    await page.waitForURL(/\/stub\/pay\//, { timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Success' }).click();
  await page.waitForURL(/\/orders\//);
  const orderUrl = page.url();

  await page.goto(`${BASE}/en/tickets`);
  await page.getByTestId('transfer-open').first().click();
  await page.getByRole('textbox', { name: 'Recipient email' }).fill(friend.email);
  await page.getByTestId('transfer-submit').click();
  await expect(page.getByTestId('ticket')).toHaveCount(0, { timeout: 30_000 });

  const fctx = await browser.newContext();
  const fpage = await fctx.newPage();
  await loginUi(fpage, BASE, friend.email, friend.password);
  await fpage.goto(`${BASE}/en/tickets`);
  await fpage.getByTestId('refund-open').first().click();
  await expect(fpage.getByTestId('refund-box')).toContainText('You will get back');
  await fpage.getByTestId('refund-confirm').click();
  await expect(fpage.getByTestId('ticket').first()).toContainText('Refunded', { timeout: 30_000 });

  // The money goes back to the buyer's payment: their order shows the refund reaching the card.
  await page.goto(orderUrl);
  await expect(page.getByTestId('refund-state').first()).toHaveAttribute('data-status', 'succeeded', { timeout: 60_000 });
  await Promise.all([bctx.close(), fctx.close()]);
});
