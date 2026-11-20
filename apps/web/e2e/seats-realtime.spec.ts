import { expect, test } from '@playwright/test';
import { API_1, API_2, createEvent, registerBuyer } from './support/api';
import { loginUi, pickSeat } from './support/ui';

test('a seat held in one browser turns unavailable in another, on a different api copy, without reload', async ({ browser }) => {
  const { eventId } = await createEvent({ seats: 20 });
  const [a, b] = await Promise.all([registerBuyer(), registerBuyer()]);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pa = await ctxA.newPage();
  const pb = await ctxB.newPage();
  await loginUi(pa, API_1, a.email, a.password);
  await loginUi(pb, API_2, b.email, b.password);
  await pa.goto(`${API_1}/en/events/${eventId}`);
  await pb.goto(`${API_2}/en/events/${eventId}`);
  await expect(pb.getByTestId('seat-canvas')).toBeVisible();

  await pickSeat(pa, '1', '1');
  await pa.getByRole('button', { name: /Hold for/ }).click();
  await expect(pa.getByTestId('order-panel')).toBeVisible();

  // B never reloads: the realtime event crosses the Redis adapter from api-1 to api-2.
  await pb.getByTestId('jump-row').fill('1');
  await pb.getByTestId('jump-seat').fill('1');
  await pb.getByTestId('jump-go').click();
  await pb.getByTestId('seat-canvas').focus();
  // Moving the cursor announces the seat's current state; poll until the realtime event has arrived.
  await expect(async () => {
    await pb.keyboard.press('ArrowRight');
    await pb.keyboard.press('ArrowLeft');
    await expect(pb.getByTestId('seat-announcer')).toContainText(/row 1, seat 1.*held/i, { timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await expect(pb.getByTestId('selection-summary')).not.toContainText(/1 ticket/);
  await ctxA.close();
  await ctxB.close();
});
