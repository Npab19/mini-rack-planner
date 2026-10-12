/**
 * Hardware on hand on a 360 px phone (the `mobile` project: touch): the page is reached from the
 * Menu, nothing scrolls sideways, counts are typed and stepped with taps, and the shopping list's
 * on-hand field works inside the bill of materials sheet.
 */
import { horizontalOverflow } from './editorHelpers.ts'
import { expect, test } from './fixtures.ts'

const INSERT = 'hw:insert-m5x8x7'
const INSERT_NAME = 'M5 heat-set insert (M5x8x7)'

test.use({ viewport: { width: 360, height: 780 } })

test('On hand fits a 360 px screen and takes counts with touch', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Menu' }).tap()
  await page.getByRole('dialog', { name: 'Menu' }).getByRole('link', { name: 'On hand' }).tap()
  await expect(page.getByRole('heading', { level: 1, name: 'Hardware on hand' })).toBeVisible()
  const only = page.getByRole('switch', { name: 'Only what I have' })
  await expect(only).not.toHaveAttribute('aria-disabled', 'true')
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)

  const field = page.getByRole('textbox', { name: `On hand: ${INSERT_NAME}` })
  await field.scrollIntoViewIfNeeded()
  await field.tap()
  await field.fill('20')
  await field.press('Enter')
  await page.getByRole('button', { name: `Add 1: ${INSERT_NAME}` }).tap()
  await expect(field).toHaveValue('21')
  await expect(page.getByTestId('on-hand-totals')).toHaveText('1 kind, 21 pieces')
  await only.tap()
  await expect(page.locator('[data-testid^="on-hand-row-hw:"]')).toHaveCount(1)
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)

  // The sample's shopping list, in its sheet: 40 − 21 = 19 to get; the field works there too.
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the sample' }).tap()
  await expect(page.getByTestId('rack-svg')).toBeVisible()
  await page.getByTestId('toolbar-bom').tap()
  const sheet = page.getByRole('dialog', { name: 'Bill of materials' })
  const line = sheet.getByTestId(`bom-line-${INSERT}`)
  await expect(line).toHaveAttribute('data-need', '19')
  await sheet.getByTestId(`bom-on-hand-${INSERT}`).tap()
  const inline = page.getByTestId(`bom-on-hand-qty-${INSERT}`)
  await expect(inline).toBeVisible()
  await inline.fill('40')
  await inline.press('Enter')
  await expect(line).toHaveAttribute('data-need', '0')
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
})
