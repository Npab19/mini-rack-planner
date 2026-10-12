/**
 * Hardware on hand (#23): a count typed on the On hand page comes off the sample plan's shopping
 * list (the insert line: 36 to install + 4 spare = 40; with 20 on hand 20 are left, bought as a
 * pack of 25), the Why popover subtracts it, a count changed from the shopping list shows on the
 * page, and the page and the in-list field have no serious axe violations in light and dark.
 *
 * Every test starts from an empty browser profile and seeds data through the UI.
 */
import type { Locator, Page } from '@playwright/test'
import { AXE_LOOKS, expectNoSeriousAxeViolations, showLook } from './editorHelpers.ts'
import { expect, test } from './fixtures.ts'

const INSERT = 'hw:insert-m5x8x7'
const INSERT_NAME = 'M5 heat-set insert (M5x8x7)'

/** The On hand page, once the stored counts have arrived (the filter switch is enabled then). */
async function openOnHand(page: Page): Promise<void> {
  await page.goto('/inventory')
  await expect(page.getByRole('heading', { level: 1, name: 'Hardware on hand' })).toBeVisible()
  await expect(onlyWhatIHave(page)).not.toHaveAttribute('aria-disabled', 'true')
}

function onlyWhatIHave(page: Page): Locator {
  return page.getByRole('switch', { name: 'Only what I have' })
}

function insertField(page: Page): Locator {
  return page.getByRole('textbox', { name: `On hand: ${INSERT_NAME}` })
}

/** Creates the sample plan from the empty Plans page and opens its bill of materials. */
async function openSampleBom(page: Page): Promise<Locator> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the sample' }).click()
  await expect(page).toHaveURL(/\/plan\/[^/]+$/)
  await expect(page.getByTestId('rack-svg')).toBeVisible()
  await page.getByTestId('toolbar-bom').click()
  const bom = page.getByTestId('bom-panel')
  await expect(bom.getByRole('tab', { name: /^Shopping list/ })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  return bom
}

test('a count on the On hand page comes off the shopping list, and one set there shows on the page', async ({
  page,
}) => {
  // (1) Nothing on hand yet: every part is listed, with how to start.
  await openOnHand(page)
  await expect(page.getByRole('region', { name: 'Count what you already have' })).toBeVisible()
  await expect(onlyWhatIHave(page)).not.toBeChecked()
  await expect(page.getByTestId('on-hand-totals')).toHaveText('No hardware on hand yet')
  await page.getByRole('searchbox', { name: 'Search hardware' }).fill('M5 heat-set')
  await expect(page.locator('[data-testid^="on-hand-row-hw:"]')).toHaveCount(1)
  await insertField(page).fill('20')
  await insertField(page).press('Enter')
  await expect(page.getByTestId('on-hand-status')).toContainText('Saved')
  await expect(page.getByTestId('on-hand-totals')).toHaveText('1 kind, 20 pieces')
  await expect(page.getByTestId(`on-hand-row-${INSERT}`)).toHaveAttribute('data-qty', '20')

  // (2) The sample's shopping list subtracts it: 40 − 20 = 20 to get, bought as a pack of 25.
  const bom = await openSampleBom(page)
  const line = bom.getByTestId(`bom-line-${INSERT}`)
  await expect(line).toHaveAttribute('data-install', '36')
  await expect(line).toHaveAttribute('data-spare', '4')
  await expect(line).toHaveAttribute('data-need', '20')
  await expect(line).toHaveAttribute('data-buy', '25')
  await expect(line).toContainText('25 (1 pack of 25)')
  const onHand = bom.getByTestId(`bom-on-hand-${INSERT}`)
  await expect(onHand).toHaveText('20')
  await bom.getByRole('button', { name: `Why: ${INSERT_NAME}` }).click()
  await expect(
    page.getByText(
      '20 = 144 in plan − 108 in your rack + 4 extra (10%) − 20 on hand; buy 25 (1 × 25)',
    ),
  ).toBeVisible()
  await page.keyboard.press('Escape')

  // (3) Changed in place: 40 on hand cover the line, which is now ticked as Got it.
  await onHand.click()
  const inline = page.getByTestId(`bom-on-hand-qty-${INSERT}`)
  await expect(inline).toBeFocused()
  await expect(inline).toHaveValue('20')
  await inline.fill('40')
  await inline.press('Enter')
  await expect(line).toHaveAttribute('data-need', '0')
  await expect(line).toHaveAttribute('data-buy', '0')
  await expect(bom.getByTestId(`bom-got-it-${INSERT}`)).toBeChecked()
  await expect(onHand).toHaveText('40')
  // One more with +, as on the page.
  await page.getByRole('button', { name: `Add 1: ${INSERT_NAME}` }).click()
  await expect(onHand).toHaveText('41')
  await page.keyboard.press('Escape')
  await expect(inline).toBeHidden()

  // (4) The page shows it, and now lists only what you have.
  await bom.getByTestId('bom-on-hand-link').click()
  await expect(page.getByRole('heading', { level: 1, name: 'Hardware on hand' })).toBeVisible()
  await expect(onlyWhatIHave(page)).toBeChecked()
  await expect(page.locator('[data-testid^="on-hand-row-hw:"]')).toHaveCount(1)
  await expect(insertField(page)).toHaveValue('41')
  await expect(page.getByTestId('on-hand-totals')).toHaveText('1 kind, 41 pieces')
  // The sample still needs 40 of them: covered.
  await expect(page.getByTestId(`on-hand-plans-${INSERT}`)).toContainText(
    'Sample: KWS 9U → 12U needs 40, covered',
  )
  await expect(page.getByRole('region', { name: 'Count what you already have' })).toHaveCount(0)
})

for (const look of AXE_LOOKS) {
  test(`the On hand page and the shopping list's on-hand field have no serious axe violations (${look.name})`, async ({
    page,
  }) => {
    await showLook(page, look)
    // A saved plan, so parts show what it needs.
    const bom = await openSampleBom(page)
    await bom.getByTestId(`bom-on-hand-${INSERT}`).click()
    await expect(page.getByTestId(`bom-on-hand-qty-${INSERT}`)).toBeFocused()
    await expectNoSeriousAxeViolations(page, `the shopping list's on-hand field (${look.name})`)
    await page.getByTestId(`bom-on-hand-qty-${INSERT}`).fill('20')
    await page.getByTestId(`bom-on-hand-qty-${INSERT}`).press('Enter')
    await expect(bom.getByTestId(`bom-line-${INSERT}`)).toHaveAttribute('data-need', '20')
    await page.keyboard.press('Escape')

    await openOnHand(page)
    await expect(onlyWhatIHave(page)).toBeChecked()
    await expect(page.getByTestId(`on-hand-plans-${INSERT}`)).toContainText('buy 25')
    await expectNoSeriousAxeViolations(page, `the On hand page (${look.name})`)
    // Every part, with what the sample needs, and a typo's message.
    await onlyWhatIHave(page).click()
    await expect(page.locator('[data-testid^="on-hand-row-hw:"]')).not.toHaveCount(1)
    await insertField(page).fill('2.5')
    await insertField(page).press('Enter')
    await expect(page.getByRole('alert').filter({ hasText: 'whole number' })).toBeVisible()
    await expectNoSeriousAxeViolations(page, `every part on the On hand page (${look.name})`)
  })
}
