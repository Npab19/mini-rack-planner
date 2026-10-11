/**
 * The editor on a phone (the `mobile` project: iPhone-sized viewport, touch): the rack fills the
 * screen, the panels open as sheets from the toolbar, nothing scrolls sideways, and the bill of
 * materials sheet shows the shopping list. Tap-to-place works from the Parts sheet.
 */
import { horizontalOverflow, rackPart, rackPoint } from './editorHelpers.ts'
import { expect, test } from './fixtures.ts'
import type { Page } from '@playwright/test'

async function openSample(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the sample' }).tap()
  await expect(page).toHaveURL(/\/plan\/[^/]+$/)
  await expect(page.getByTestId('rack-svg')).toBeVisible()
}

test('the BOM opens as a sheet with the shopping list, and nothing scrolls sideways', async ({
  page,
}) => {
  await openSample(page)
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
  // Below lg the panels are buttons in the toolbar, not columns.
  await expect(page.getByTestId('panel-palette')).toHaveCount(0)

  await page.getByTestId('toolbar-bom').tap()
  const sheet = page.getByRole('dialog', { name: 'Bill of materials' })
  await expect(sheet).toBeVisible()
  await expect(sheet.getByRole('tab', { name: /^Shopping list/ })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  // The sample's planned 3U section and its drive rack are still to get.
  const plate = sheet.getByTestId('bom-line-print:kws-rack-v2/plate-3u')
  await expect(plate).toBeVisible()
  await expect(plate).toHaveAttribute('data-need', '1')
  await expect(sheet.getByTestId('bom-line-hw:insert-m5x8x7')).toHaveAttribute('data-install', '36')
  await expect(sheet.getByTestId('bom-summary')).toContainText(/^To get: \d+ lines/)
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)

  await sheet.getByRole('button', { name: 'Close' }).tap()
  await expect(sheet).toBeHidden()
})

test('tap to place: Place in the Parts sheet, then tap the rack', async ({ page }) => {
  await openSample(page)
  await page.getByTestId('toolbar-sheet-palette').tap()
  const parts = page.getByRole('dialog', { name: 'Parts' })
  await expect(parts).toBeVisible()
  await parts.getByTestId('palette-place-generic-blank-1u').tap()
  // The sheet makes way for the rack.
  await expect(parts).toBeHidden()
  await expect(page.getByTestId('placing-banner')).toContainText('tap a free spot on the rack')

  const point = await rackPoint(page, 9, 1)
  await page.touchscreen.tap(point.x, point.y)
  await expect(page.getByTestId('placing-banner')).toBeHidden()
  const placed = rackPart(page, 'Blank panel 1U').filter({
    has: page.locator('[data-selection-ring]'),
  })
  await expect(placed).toHaveAttribute('data-u-start', '9')
  await expect(placed).toHaveAttribute('data-have', 'false')

  // The inspector sheet shows the new part.
  await page.getByTestId('toolbar-sheet-inspector').tap()
  const inspector = page.getByRole('dialog', { name: 'Inspector' })
  await expect(inspector.getByRole('heading', { level: 2, name: 'Blank panel 1U' })).toBeVisible()
  await expect(inspector.getByText('U9 · front')).toBeVisible()
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
})
