import { expect, type Page } from '@playwright/test';

export const loginUi = async (page: Page, origin: string, email: string, password: string): Promise<void> => {
  await page.goto(`${origin}/en/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByTestId('current-user')).toBeVisible();
};

/** Picks a seat through the keyboard path of the map (row + seat jump, then Enter), as a screen-reader user would. */
export const pickSeat = async (page: Page, row: string, seat: string): Promise<void> => {
  await page.getByTestId('jump-row').fill(row);
  await page.getByTestId('jump-seat').fill(seat);
  await page.getByTestId('jump-go').click();
  await page.getByTestId('seat-canvas').focus();
  await page.keyboard.press('Enter');
};
