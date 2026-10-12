/**
 * M3b equipment-first on a 360 px phone (the `mobile` project, narrowed to the smallest width the
 * app supports): the Equipment to fit sheet, "Needs a mount?" and "Fit it for me" all fit the
 * screen without sideways scrolling, and Fit it for me places what is waiting.
 */
import type { Page } from '@playwright/test'
import { horizontalOverflow, rackPart } from './editorHelpers.ts'
import { expect, test } from './fixtures.ts'

test.use({ viewport: { width: 360, height: 740 } })

async function openSample(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the sample' }).tap()
  await expect(page).toHaveURL(/\/plan\/[^/]+$/)
  await expect(page.getByTestId('rack-svg')).toBeVisible()
}

/** Opens the Equipment to fit sheet and adds a catalog device with its search. */
async function addToTray(page: Page, query: string): Promise<void> {
  const sheet = page.getByRole('dialog', { name: 'Equipment to fit' })
  if (!(await sheet.isVisible())) await page.getByTestId('toolbar-sheet-equipment').tap()
  await expect(sheet).toBeVisible()
  await sheet.getByRole('searchbox', { name: 'Add a device' }).fill(query)
  await sheet.getByRole('list', { name: 'Matching devices' }).getByRole('button').first().tap()
}

test('Needs a mount? fits a phone screen', async ({ page }) => {
  await openSample(page)
  await addToTray(page, 'DS224+')
  const sheet = page.getByRole('dialog', { name: 'Equipment to fit' })
  const row = sheet
    .getByRole('list', { name: 'Devices waiting to be placed' })
    .getByRole('listitem')
    .filter({ hasText: 'Synology DiskStation DS224+' })
  await row.getByRole('button', { name: 'Needs a mount?' }).tap()
  const helper = page.getByRole('dialog', { name: 'Needs a mount?' })
  await expect(helper).toBeVisible()
  await expect(helper.getByRole('button', { name: /^Copy settings for / }).first()).toBeVisible()
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
  const box = await helper.boundingBox()
  expect(box?.width ?? 0).toBeLessThanOrEqual(360)
  await helper.getByRole('button', { name: 'Cancel' }).tap()
  await expect(helper).toBeHidden()
})

test('Fit it for me places what waits in the tray, on a phone', async ({ page }) => {
  await openSample(page)
  await addToTray(page, 'MS-01')
  await addToTray(page, 'Raspberry Pi 5')
  const sheet = page.getByRole('dialog', { name: 'Equipment to fit' })
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
  await sheet.getByTestId('equipment-fit').tap()
  await expect(sheet.getByTestId('equipment-fit-result')).toContainText('Placed all 2 devices')
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
  await sheet.getByRole('button', { name: 'Close' }).tap()
  await expect(sheet).toBeHidden()
  await expect(rackPart(page, 'Minisforum MS-01 / MS-A2 enclosure 2U')).toHaveAccessibleName(
    /holds Minisforum MS-01 \(To get\)$/,
  )
})
