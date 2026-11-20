import { expect, test } from '@playwright/test';
import { API_1, API_2, createEvent, registerBuyer, setClockOffset } from './support/api';
import { loginUi, pickSeat } from './support/ui';

// The server clock is shared by the whole stack, so this file must not run next to other specs.
test.describe.configure({ mode: 'serial' });

test.setTimeout(180_000);
test('an expired hold frees the seat for both browsers, on both api copies', async ({ browser }) => {
  const { eventId } = await createEvent({ seats: 10 });
  const [a, b] = await Promise.all([registerBuyer(), registerBuyer()]);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pa = await ctxA.newPage();
  const pb = await ctxB.newPage();
  await loginUi(pa, API_1, a.email, a.password);
  await loginUi(pb, API_2, b.email, b.password);
  await pa.goto(`${API_1}/en/events/${eventId}`);
  await pb.goto(`${API_2}/en/events/${eventId}`);

  await pickSeat(pa, '1', '1');
  await pa.getByRole('button', { name: /Hold for/ }).click();
  await expect(pa.getByTestId('hold-timer')).toBeVisible();

  const announces = async (page: typeof pb, state: RegExp, timeout = 20_000): Promise<void> => {
    await page.getByTestId('jump-row').fill('1');
    await page.getByTestId('jump-seat').fill('1');
    await page.getByTestId('jump-go').click();
    await page.getByTestId('seat-canvas').focus();
    await expect(async () => {
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowLeft');
      await expect(page.getByTestId('seat-announcer')).toContainText(state, { timeout: 1_000 });
    }).toPass({ timeout });
  };
  await announces(pb, /row 1, seat 1.*held/i);

  try {
    await setClockOffset(11 * 60_000);
    // Nobody reloads: the worker's expiry sweep (every 20 s) frees the seat and the realtime event reaches both copies.
    await announces(pb, /row 1, seat 1.*free/i, 60_000);
    await announces(pa, /row 1, seat 1.*free/i, 60_000);
  } finally {
    await setClockOffset(0);
    await ctxA.close();
    await ctxB.close();
  }
});
