import { expect, test } from './fixtures.ts'

// Runs in the `mobile` project only (iPhone-sized viewport, touch, Chromium).
test('the shell works with touch on a phone-sized screen', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'Your racks' })).toBeVisible()
  // Below the `sm` breakpoint the navigation lives in the Menu sheet.
  await page.getByRole('button', { name: 'Menu' }).tap()
  await page.getByRole('dialog', { name: 'Menu' }).getByRole('link', { name: 'About' }).tap()
  await expect(page.getByRole('heading', { level: 1, name: 'About' })).toBeVisible()
  // The sheet closes once a page is chosen.
  await expect(page.getByRole('dialog', { name: 'Menu' })).toBeHidden()
})

test('the plans page fits a phone screen without sideways scrolling', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 2, name: 'Start your first plan' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Record my rack/ })).toBeVisible()
  const overflow = await page.evaluate(() => {
    const root = (globalThis as unknown as { document: { documentElement: Measurable } }).document
      .documentElement
    return root.scrollWidth - root.clientWidth
  })
  expect(overflow).toBeLessThanOrEqual(0)
})

/** The slice of an element this spec measures (e2e is type-checked without the DOM lib). */
type Measurable = { scrollWidth: number; clientWidth: number }
