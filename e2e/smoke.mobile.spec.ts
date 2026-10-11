import { expect, test } from './fixtures.ts'

// Runs in the `mobile` project only (iPhone-sized viewport, touch, Chromium).
test('the shell works with touch on a phone-sized screen', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'Your racks' })).toBeVisible()
  await page.getByRole('link', { name: 'About' }).tap()
  await expect(page.getByRole('heading', { level: 1, name: 'About' })).toBeVisible()
})
