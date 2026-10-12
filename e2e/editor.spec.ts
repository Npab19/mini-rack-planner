/**
 * M3a end to end, the v0.1 acceptance: the user rebuilds their real KWS Rack v2 (3U at the bottom,
 * 6U above it, both built) with their gear in Recording mode, plans one more 3U, and the shopping
 * list equals the signed-off golden output (fixtures/expected/kws-3-6-plus3-top.shopping.json):
 * 1 × 3U leg plate, 1 × Frame connectors, 36 M5 inserts, 16 M6×8, 24 M6×10, 40 M6 nylocs and 16
 * magnets. Moving the new section to the bottom changes nothing on the list; a second cycle (Got
 * it, Finish build, then another 3U) gives the same numbers again, because Finish build used up the
 * spares. Once with the mouse only, once with the keyboard only.
 *
 * Every test starts from an empty browser profile and seeds data through the UI.
 */
import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import {
  arrowUntilChecked,
  AXE_LOOKS,
  expectGoldenShoppingList,
  expectNoSeriousAxeViolations,
  goldenShoppingLines,
  hasFocus,
  placeWithMouse,
  pressUntilFocused,
  rackPart,
  recordMyRack,
  setSparesToZero,
  showLook,
  SIGNED_OFF,
  useLinkDownloads,
} from './editorHelpers.ts'
import { expect, test } from './fixtures.ts'

const GOLDEN = goldenShoppingLines()

/** The user's gear: where each mount goes (bottom U) and how tall it is. */
const GEAR = [
  { itemId: 'lenovo-tiny-mount-1u', name: 'Lenovo Tiny mount 1U', uStart: 4, heightU: 1 },
  { itemId: 'two-3-5-drive-rack-1u', name: 'Two 3.5-inch drive rack 1U', uStart: 6, heightU: 1 },
  {
    itemId: 'kws-power-supplies-shelf-2u',
    name: 'KWS power supplies shelf 2U',
    uStart: 8,
    heightU: 2,
  },
] as const

test('the golden fixture is the signed-off +3U shopping list', () => {
  expect(Object.fromEntries(GOLDEN.map((line) => [line.key, line.need]))).toEqual(SIGNED_OFF)
})

/** "Set height" in the inspector's Rack tab, growing at the top. */
async function setHeightAtTop(page: Page, heightU: number): Promise<void> {
  const inspector = page.getByTestId('panel-inspector')
  await inspector.getByRole('tab', { name: 'Rack' }).click()
  await inspector.getByTestId('rack-tab-set-height').selectOption(String(heightU))
  await inspector.getByRole('radio', { name: 'At the top' }).click()
  await inspector.getByTestId('rack-tab-apply-height').click()
  await expect(page.getByTestId('editor-toolbar')).toContainText(`· ${heightU}U`)
}

test.describe('Editor (v0.1)', () => {
  test.beforeEach(async ({ page }) => {
    await useLinkDownloads(page)
  })

  test('mouse only: record my rack, add a 3U, get the golden shopping list, then a second cycle', async ({
    page,
  }) => {
    // (1) Spares off.
    await setSparesToZero(page)
    // (2) Record the 3U + 6U rack as built.
    await recordMyRack(page)
    const inspector = page.getByTestId('panel-inspector')

    // (3) Recording, mouse only: the user's mounts and their devices.
    const [lenovo, driveRack, shelf] = GEAR
    await placeWithMouse(page, lenovo.itemId, lenovo.uStart, lenovo.heightU)
    // The new part is selected: the inspector shows it.
    await expect(inspector.getByRole('heading', { level: 2, name: lenovo.name })).toBeVisible()
    await expect(inspector.getByText('U4 · front')).toBeVisible()
    await inspector.getByRole('button', { name: 'Add device' }).click()
    await inspector.getByTestId('inspector-device-option-lenovo-thinkcentre-m720q-tiny').click()
    await expect(
      inspector
        .getByRole('radiogroup', { name: 'Lenovo ThinkCentre M720q Tiny: in my rack or to get' })
        .getByRole('radio', { name: 'In my rack' }),
    ).toBeChecked()

    await placeWithMouse(page, driveRack.itemId, driveRack.uStart, driveRack.heightU)
    await expect(inspector.getByRole('heading', { level: 2, name: driveRack.name })).toBeVisible()
    for (const slot of ['Left drive', 'Right drive']) {
      const region = inspector.getByRole('region', { name: slot })
      await region.getByRole('button', { name: 'Add device' }).click()
      await region.getByTestId('inspector-device-option-drive-3-5-inch').click()
      await expect(region.getByRole('list', { name: `Devices in ${slot}` })).toContainText(
        'Generic 3.5-inch drive',
      )
    }

    await placeWithMouse(page, shelf.itemId, shelf.uStart, shelf.heightU)
    await expect(inspector.getByRole('heading', { level: 2, name: shelf.name })).toBeVisible()
    for (const part of GEAR) {
      await expect(rackPart(page, part.name)).toHaveAttribute('data-u-start', String(part.uStart))
      await expect(rackPart(page, part.name)).toHaveAttribute('data-have', 'true')
    }
    await expect(rackPart(page, lenovo.name)).toHaveAccessibleName(
      'Lenovo Tiny mount 1U, U4, In my rack, holds Lenovo ThinkCentre M720q Tiny (In my rack)',
    )
    // The Checks panel selects too: the rack rings the part and the inspector shows it.
    await page
      .getByTestId('panel-checks')
      .getByRole('button', { name: /Lenovo Tiny mount 1U has no recorded hole positions/ })
      .click()
    await expect(inspector.getByRole('heading', { level: 2, name: lenovo.name })).toBeVisible()
    await expect(rackPart(page, lenovo.name)).toHaveAttribute('data-selected', 'true')
    await expect(rackPart(page, shelf.name)).not.toHaveAttribute('data-selected', 'true')
    // (9) axe, with a selection.
    await expectNoSeriousAxeViolations(page, 'the editor with a selection')

    await page.getByRole('button', { name: 'Done, start planning' }).click()
    await expect(page.getByRole('region', { name: 'Recording what you have' })).toBeHidden()

    // (4) The Rack tab: 12U at the top adds one new 3U, To get.
    await setHeightAtTop(page, 12)
    const rows = inspector.locator('[data-testid^="stack-row-"]')
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(0)).toHaveAttribute('data-have', 'false')
    await expect(rows.nth(0)).toContainText('3U section')
    await expect(rows.nth(0)).toContainText('U10–U12')
    await expect(rows.nth(1)).toHaveAttribute('data-have', 'true')
    await expect(rows.nth(2)).toHaveAttribute('data-have', 'true')
    // The toolbar's Fit zooms the rack (now 12U) so all of it is in view.
    await page.getByTestId('toolbar-fit').click()
    await expect(page.getByTestId('rack-svg').locator('[data-u-label="12"]')).toBeInViewport()
    await expect(page.getByTestId('rack-svg').locator('[data-u-label="1"]')).toBeInViewport()

    // (5) The shopping list is the golden one.
    await page.getByTestId('toolbar-bom').click()
    const bom = page.getByTestId('bom-panel')
    await expectGoldenShoppingList(bom, GOLDEN)
    // (9) axe, with the BOM open (and a selection).
    await expectNoSeriousAxeViolations(page, 'the editor with the BOM open')

    // (6) The new 3U to the bottom: nothing else to get, everything built moves up 3U.
    const newSection = inspector.locator('[data-testid^="stack-row-"][data-have="false"]')
    await newSection.getByRole('button', { name: /^Move .* down$/ }).click()
    await expect(newSection).toContainText('U4–U6')
    await newSection.getByRole('button', { name: /^Move .* down$/ }).click()
    await expect(newSection).toContainText('U1–U3')
    await expect(newSection).toContainText('bottom')
    await expectGoldenShoppingList(bom, GOLDEN)
    for (const part of GEAR) {
      await expect(rackPart(page, part.name)).toHaveAttribute(
        'data-u-start',
        String(part.uStart + 3),
      )
    }

    // (7) Second cycle: everything bought, then built.
    for (const line of GOLDEN) {
      const gotIt = bom.getByTestId(`bom-got-it-${line.key}`)
      await gotIt.click()
      await expect(gotIt).toBeChecked()
    }
    await expect(bom.getByTestId('bom-summary')).toHaveText('Nothing to get')
    await bom.getByTestId('bom-finish-build').click()
    const finish = page.getByTestId('bom-finish-dialog')
    // Only the new section is still to get (it is Section 1 now, at the bottom).
    await expect(finish.getByRole('region', { name: 'Changes: 1' })).toContainText('Section 1 (3U)')
    await finish.getByTestId('bom-finish-confirm').click()
    await expect(finish).toBeHidden()
    await expect(bom.getByTestId('bom-finished')).toBeVisible()
    await expect(bom.locator('[data-testid^="bom-line-"]')).toHaveCount(0)
    await expect(bom.getByText(/^Nothing to get: everything this plan uses/)).toBeVisible()
    await expect(rows).toHaveCount(3)
    for (let index = 0; index < 3; index += 1) {
      await expect(rows.nth(index)).toHaveAttribute('data-have', 'true')
    }

    // Another 3U on top: the spares were used up, so it is the same list again.
    await setHeightAtTop(page, 15)
    await expect(rows.nth(0)).toHaveAttribute('data-have', 'false')
    await expectGoldenShoppingList(bom, GOLDEN)

    // (8) CSV: UTF-8 BOM first, the insert row as on screen.
    const downloading = page.waitForEvent('download')
    await bom.getByTestId('bom-export-csv').click()
    const download = await downloading
    expect(download.suggestedFilename()).toMatch(/-shopping-list-\d{4}-\d{2}-\d{2}\.csv$/)
    const path = test.info().outputPath(download.suggestedFilename())
    await download.saveAs(path)
    const bytes = readFileSync(path)
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const csv = bytes.toString('utf8')
    expect(csv).toContain('\r\n')
    expect(csv).toMatch(/\r\nHardware to buy,M5 heat-set insert \(M5x8x7\),insert,36,0,50,pcs,/)
  })

  test('keyboard only: record my rack, grow it from the Rack tab, read the shopping list', async ({
    page,
  }) => {
    await setSparesToZero(page)
    await recordMyRack(page)
    // The plan opens on its heading.
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused()
    const palette = page.getByTestId('panel-palette')
    const inspector = page.getByTestId('panel-inspector')
    const search = page.getByTestId('palette-search')

    /** Palette: search, ↓ into the results, Tab to Add at U…, pick the spot with the arrows. */
    async function addAtU(query: string, itemId: string, name: string, spot: string) {
      await expect(search).toBeFocused()
      await page.keyboard.press('ControlOrMeta+A')
      await page.keyboard.type(query)
      await expect(palette.locator('[data-testid^="palette-item-"]').first()).toHaveAttribute(
        'data-testid',
        `palette-item-${itemId}`,
      )
      await page.keyboard.press('ArrowDown')
      await expect(page.getByTestId(`palette-place-${itemId}`)).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(palette.getByRole('button', { name: `Add at U…: ${name}` })).toBeFocused()
      await page.keyboard.press('Enter')
      const dialog = page.getByRole('dialog', { name: `Add ${name} at…` })
      await expect(dialog).toBeVisible()
      await arrowUntilChecked(page, dialog.getByRole('radio', { name: spot, exact: true }))
      await page.keyboard.press('Enter')
      await expect(dialog).toBeHidden()
      // Focus is back where it was; the inspector shows the new part.
      await expect(palette.getByRole('button', { name: `Add at U…: ${name}` })).toBeFocused()
      await expect(inspector.getByRole('heading', { level: 2, name })).toBeVisible()
    }

    /** F6 to the inspector, Tab to a slot's Add device, search and pick with Enter. */
    async function addDevice(slot: string, query: string, deviceOptionId: string) {
      await pressUntilFocused(page, 'F6', inspector, { within: true, max: 8 })
      const region = inspector.getByRole('region', { name: slot })
      await pressUntilFocused(page, 'Tab', region.getByRole('button', { name: 'Add device' }))
      await page.keyboard.press('Enter')
      await expect(region.getByRole('searchbox')).toBeFocused()
      await page.keyboard.type(query)
      await page.keyboard.press('ArrowDown')
      await expect(region.getByTestId(`inspector-device-option-${deviceOptionId}`)).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(region.getByRole('list', { name: `Devices in ${slot}` })).toBeVisible()
    }

    // (3) Tab into the palette; Add at U… for each mount; devices from the inspector.
    await pressUntilFocused(page, 'Tab', search)
    await addAtU('Lenovo Tiny', 'lenovo-tiny-mount-1u', 'Lenovo Tiny mount 1U', 'U4')
    await addDevice('Mini PC', 'M720q', 'lenovo-thinkcentre-m720q-tiny')

    await pressUntilFocused(page, 'F6', search, { max: 8 })
    await addAtU('drive rack', 'two-3-5-drive-rack-1u', 'Two 3.5-inch drive rack 1U', 'U6')
    await addDevice('Left drive', '3.5-inch', 'drive-3-5-inch')
    await addDevice('Right drive', '3.5-inch', 'drive-3-5-inch')

    await pressUntilFocused(page, 'F6', search, { max: 8 })
    await addAtU(
      'power supplies',
      'kws-power-supplies-shelf-2u',
      'KWS power supplies shelf 2U',
      'U8–U9',
    )
    for (const part of GEAR) {
      await expect(rackPart(page, part.name)).toHaveAttribute('data-u-start', String(part.uStart))
      await expect(rackPart(page, part.name)).toHaveAttribute('data-have', 'true')
    }
    await expect(rackPart(page, 'Two 3.5-inch drive rack 1U')).toHaveAccessibleName(
      /holds Generic 3\.5-inch drive \(In my rack\), Generic 3\.5-inch drive \(In my rack\)$/,
    )

    // Done recording: F6 to the toolbar, Tab to the banner's button.
    await pressUntilFocused(page, 'F6', page.getByTestId('editor-toolbar'), {
      within: true,
      max: 8,
    })
    const done = page.getByRole('button', { name: 'Done, start planning' })
    await pressUntilFocused(page, 'Tab', done)
    await page.keyboard.press('Enter')
    await expect(page.getByRole('region', { name: 'Recording what you have' })).toBeHidden()

    // (4) The Rack tab with the keyboard: the tab list, then Set height.
    await pressUntilFocused(page, 'F6', inspector, { within: true, max: 8 })
    const rackTab = inspector.getByRole('tab', { name: 'Rack' })
    await pressUntilFocused(page, 'Shift+Tab', inspector.getByRole('tab', { name: 'Selection' }))
    await page.keyboard.press('ArrowRight')
    await expect(rackTab).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(rackTab).toHaveAttribute('aria-selected', 'true')
    const height = inspector.getByTestId('rack-tab-set-height')
    await pressUntilFocused(page, 'Tab', height)
    await page.keyboard.type('12')
    await expect(height).toHaveValue('12')
    await expect(inspector.getByRole('radio', { name: 'At the top' })).toBeChecked()
    await pressUntilFocused(page, 'Tab', inspector.getByTestId('rack-tab-apply-height'))
    await page.keyboard.press('Enter')
    const rows = inspector.locator('[data-testid^="stack-row-"]')
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(0)).toHaveAttribute('data-have', 'false')
    await expect(rows.nth(0)).toContainText('U10–U12')

    // (5) B opens the bill of materials: the golden shopping list.
    expect(await hasFocus(inspector, true)).toBe(true)
    await page.keyboard.press('b')
    await expectGoldenShoppingList(page.getByTestId('bom-panel'), GOLDEN)
  })

  for (const look of AXE_LOOKS) {
    test(`the sample plan with a selection and the BOM open has no serious axe violations (${look.name})`, async ({
      page,
    }) => {
      await showLook(page, look)
      await page.goto('/')
      await page.getByRole('button', { name: 'Open the sample' }).click()
      await expect(page.getByTestId('rack-svg')).toBeVisible()
      await rackPart(page, 'Two 3.5-inch drive rack 1U').click()
      await expect(
        page
          .getByTestId('panel-inspector')
          .getByRole('heading', { level: 2, name: 'Two 3.5-inch drive rack 1U' }),
      ).toBeVisible()
      await page.getByTestId('toolbar-bom').click()
      await expect(page.getByTestId('bom-panel')).toBeVisible()
      await expectNoSeriousAxeViolations(page, `the editor (${look.name})`)
    })
  }
})
