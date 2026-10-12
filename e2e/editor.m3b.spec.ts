/**
 * M3b end to end, beyond drag and drop (editor.dnd.spec.ts):
 * - "Fit it for me" grows a KWS 9U plan by 3U and places the three devices waiting in the tray,
 *   as one undo step;
 * - "Needs a mount?" for a large custom device shows the generator parameters and creates a custom
 *   mount sized for it, which is then placed with the device in it;
 * - a custom device made in My parts, placed into a slot, survives export and import as a copy
 *   even after it is deleted from My parts (the plan carries its own copy, `plan.custom`);
 * - axe (light and dark) on the mount chooser, "Needs a mount?", the Add a part dialog and the
 *   My parts page.
 *
 * Every test starts from an empty browser profile and seeds data through the UI.
 */
import type { Locator, Page } from '@playwright/test'
import {
  expectNoSeriousAxeViolations,
  placeWithMouse,
  rackPart,
  rackPoint,
  useLinkDownloads,
} from './editorHelpers.ts'
import { expect, test } from './fixtures.ts'
import { aimAt, centreOf, openSample, paletteRow, pressAndMove } from './rackPointer.ts'

/** Plan a new rack: KWS Rack v2, 3U at the bottom and 6U on top (all To get). */
async function newKws9U(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Plan a new rack' }).click()
  const wizard = page.getByRole('dialog', { name: 'Plan a new rack' })
  await wizard.getByRole('radio', { name: 'KWS Rack v2', exact: true }).click()
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByRole('button', { name: '3U + 6U: 3U at the bottom, 6U on top' }).click()
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByRole('button', { name: 'Create plan' }).click()
  await expect(page).toHaveURL(/\/plan\/[^/]+$/)
  await expect(page.getByTestId('editor-toolbar')).toContainText('KWS Rack v2 · 3U + 6U · 9U')
}

/** Adds a catalog device to Equipment to fit with the tray's own search. */
async function addToTray(page: Page, query: string): Promise<void> {
  const tray = page.getByTestId('panel-equipment')
  await tray.getByRole('searchbox', { name: 'Add a device' }).fill(query)
  await tray.getByRole('list', { name: 'Matching devices' }).getByRole('button').first().click()
}

function trayRows(page: Page): Locator {
  return page
    .getByTestId('panel-equipment')
    .getByRole('list', { name: 'Devices waiting to be placed' })
    .getByRole('listitem')
    .filter({ has: page.getByRole('paragraph') })
}

interface DeviceFields {
  brand: string
  model: string
  kind: string
  widthMm: number
  depthMm: number
  heightMm: number
}

/** Fills the device form of the Add a part dialog (its Details step). */
async function fillDevice(dialog: Locator, device: DeviceFields): Promise<void> {
  await dialog.getByRole('textbox', { name: 'Brand' }).fill(device.brand)
  await dialog.getByRole('textbox', { name: 'Model' }).fill(device.model)
  await dialog
    .getByRole('combobox', { name: 'What kind of device is it?' })
    .selectOption({ label: device.kind })
  await dialog.getByRole('textbox', { name: 'Width' }).fill(String(device.widthMm))
  await dialog.getByRole('textbox', { name: 'Depth' }).fill(String(device.depthMm))
  await dialog.getByRole('textbox', { name: 'Height' }).fill(String(device.heightMm))
}

/** My parts > Add a part > (no link) > A device > details > Save to My parts. */
async function createDeviceInMyParts(page: Page, device: DeviceFields): Promise<void> {
  await page.goto('/library')
  await expect(page.getByRole('heading', { level: 1, name: 'My parts' })).toBeVisible()
  await page.getByRole('button', { name: 'Add a part' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Add a part' })
  await expect(dialog.getByRole('heading', { name: 'Where is it from?' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Next' }).click()
  await dialog.getByRole('radio', { name: 'A device' }).click()
  await dialog.getByRole('button', { name: 'Next' }).click()
  await expect(dialog.getByRole('heading', { name: 'About the device' })).toBeVisible()
  await fillDevice(dialog, device)
  await dialog.getByRole('button', { name: 'Save to My parts' }).click()
  await expect(dialog).toBeHidden()
  const name = `${device.brand} ${device.model}`
  await expect(page.getByRole('article', { name })).toBeVisible()
}

const BIG_BOX: DeviceFields = {
  brand: 'Acme',
  model: 'Big Box 3',
  kind: 'Other',
  widthMm: 200,
  depthMm: 180,
  heightMm: 110,
}

const ZETA_MINI: DeviceFields = {
  brand: 'Zeta',
  model: 'Mini 1',
  kind: 'Mini PC',
  widthMm: 150,
  depthMm: 150,
  heightMm: 35,
}

test.describe('Equipment first', () => {
  test('Fit it for me adds 3U to a KWS 9U plan and places the three devices', async ({ page }) => {
    await newKws9U(page)
    // Two shelves leave U3 and U6–U9 free: room for two 2U enclosures, not three.
    await placeWithMouse(page, 'generic-shelf-2u', 1, 2)
    await placeWithMouse(page, 'generic-shelf-2u', 4, 2)
    for (const device of ['MS-01', 'MS-A2', 'MS-01']) await addToTray(page, device)
    await expect(trayRows(page)).toHaveCount(3)
    const summary = page.getByTestId('equipment-summary')
    await expect(summary).toContainText('→ add')

    await page.getByTestId('equipment-fit').click()
    // The planned 3U + 6U grows to 12U at the top (Set height picks the sections: 6U + 6U).
    await expect(page.getByTestId('editor-toolbar')).toContainText('· 12U')
    await expect(page.getByTestId('equipment-fit-result')).toContainText(
      'Placed all 3 devices and added 3U at the top.',
    )
    const enclosures = page
      .getByTestId('rack-svg')
      .getByRole('button', { name: /^Minisforum MS-01 \/ MS-A2 enclosure 2U, / })
    await expect(enclosures).toHaveCount(3)
    const starts = await enclosures.evaluateAll((nodes) =>
      nodes.map((node) =>
        (node as { getAttribute: (n: string) => string | null }).getAttribute('data-u-start'),
      ),
    )
    expect(starts.toSorted()).toEqual(['10', '6', '8'].toSorted())
    await expect(trayRows(page)).toHaveCount(0)
    // Nothing it placed crosses a joint or overlaps (no checks about them).
    const checks = page.getByTestId('panel-checks')
    await expect(checks).not.toContainText('crosses the joint')
    await expect(checks).not.toContainText('overlaps')

    // One step to undo: the rack is 9U again and the devices wait in the tray.
    await page.getByTestId('toolbar-undo').click()
    await expect(page.getByTestId('editor-toolbar')).toContainText('KWS Rack v2 · 3U + 6U · 9U')
    await expect(enclosures).toHaveCount(0)
    await expect(trayRows(page)).toHaveCount(3)
  })

  test('Needs a mount? sizes a custom mount for a large custom device, which is then placed', async ({
    page,
  }) => {
    await createDeviceInMyParts(page, BIG_BOX)
    await openSample(page)
    const palette = page.getByTestId('panel-palette')
    await palette.getByRole('tab', { name: 'My parts' }).click()
    await palette.getByRole('button', { name: 'Add to Equipment to fit: Acme Big Box 3' }).click()
    const row = trayRows(page).filter({ hasText: 'Acme Big Box 3' })
    await expect(row).toContainText('No mount in the catalog takes it yet.')

    await row.getByRole('button', { name: 'Needs a mount?' }).click()
    const helper = page.getByRole('dialog', { name: 'Needs a mount?' })
    await expect(helper).toBeVisible()
    // Parameters for the parametric generators, as text, sized from the device (+2 mm).
    const merkle = helper
      .getByRole('listitem')
      .filter({ has: page.getByRole('heading', { name: /Fully Parametric Server/ }) })
    await expect(merkle.getByRole('definition').nth(2)).toHaveText('202')
    await expect(merkle.getByRole('definition').nth(3)).toHaveText('112')
    await expect(merkle.getByRole('definition').nth(4)).toHaveText('182')
    await expect(
      helper.getByRole('link', { name: /^Open on MakerWorld : Fully Parametric/ }),
    ).toHaveAttribute('href', /^https:\/\/makerworld\.com\//)

    await helper.getByRole('button', { name: 'Create a custom mount sized for it' }).click()
    await expect(helper).toBeHidden()
    // The mount editor opens filled in: 3U, the device's size + 2 mm inside, its depth.
    const editor = page.getByTestId('add-part-dialog')
    await expect(editor).toBeVisible()
    await expect(
      editor.getByRole('combobox', { name: 'Rack height' }).locator('option:checked'),
    ).toHaveText('3U')
    const inside = editor.getByRole('group', { name: 'The largest device it takes' })
    await expect(inside.getByRole('textbox', { name: 'Width' })).toHaveValue('202')
    await expect(inside.getByRole('textbox', { name: 'Height' })).toHaveValue('112')
    await editor.getByRole('button', { name: 'Save and place' }).click()
    await expect(editor).toBeHidden()

    // Placing starts with the device in the new mount: U5–U7 is free in the sample.
    await expect(page.getByTestId('placing-banner')).toBeVisible()
    const point = await rackPoint(page, 5, 3)
    await page.mouse.move(point.x, point.y)
    const ghost = page.getByTestId('rack-ghost')
    await expect(ghost).toHaveAttribute('data-u-start', '5')
    await expect(ghost).toHaveAttribute('data-ok', 'true')
    await page.mouse.click(point.x, point.y)
    await expect(page.getByTestId('placing-banner')).toBeHidden()
    const mount = rackPart(page, 'Acme Big Box 3 mount')
    await expect(mount).toHaveAttribute('data-u-start', '5')
    await expect(mount).toHaveAttribute('data-u-end', '7')
    await expect(mount).toHaveAccessibleName(/holds Acme Big Box 3 \(To get\)$/)
    await expect(trayRows(page)).toHaveCount(0)
    // The mount is one of My parts too, and this plan carries its own copy.
    await page.getByTestId('panel-palette').getByRole('tab', { name: 'My parts' }).click()
    await expect(page.getByTestId('panel-palette')).toContainText('Acme Big Box 3 mount')
  })
})

/** A plan card's action on the Plans page ("Export as file", "Delete…"). */
async function cardAction(page: Page, planName: string, action: string): Promise<void> {
  const label = `Actions for ${planName}`
  await page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: planName, exact: true }) })
    .getByRole('button', { name: label, exact: true })
    .click()
  await page
    .getByRole('menu', { name: label, exact: true })
    .getByRole('menuitem', { name: action })
    .click()
}

const SAMPLE_NAME = 'Sample: KWS 9U → 12U'

test.describe('Your own parts', () => {
  test('a custom device placed in a slot survives export and import as a copy', async ({
    page,
  }) => {
    await useLinkDownloads(page)
    await createDeviceInMyParts(page, ZETA_MINI)
    await openSample(page)

    // A Shelf 1U at U6, then the device from My parts dropped on its slot.
    const shelfName = await paletteRow(page, 'Mounts & panels', 'Shelf 1U', 'generic-shelf-1u')
    await pressAndMove(page, await centreOf(shelfName), await aimAt(page, 6, 1))
    await page.mouse.up()
    const shelf = rackPart(page, 'Shelf 1U')
    await expect(shelf).toHaveAttribute('data-u-start', '6')
    const palette = page.getByTestId('panel-palette')
    await palette.getByRole('tab', { name: 'My parts' }).click()
    await palette.getByTestId('palette-search').fill('Zeta')
    const row = palette
      .locator('[data-rack-drag-source="palette"]')
      .filter({ hasText: 'Zeta Mini 1' })
    const name = row.locator('p').first()
    await name.scrollIntoViewIfNeeded()
    await pressAndMove(page, await centreOf(name), await aimAt(page, 6, 1))
    await expect(page.getByTestId('rack-slot-ghost')).toHaveAttribute('data-ok', 'true')
    await page.mouse.up()
    await expect(shelf).toHaveAccessibleName(/holds Zeta Mini 1 \(To get\)$/)
    await expect(page.getByTestId('save-state')).toHaveText('Saved')

    // Export the plan, then delete the part from My parts: the plan keeps its own copy.
    await page.getByRole('link', { name: 'Your racks' }).click()
    const downloading = page.waitForEvent('download')
    await cardAction(page, SAMPLE_NAME, 'Export as file')
    const download = await downloading
    const file = test.info().outputPath(download.suggestedFilename())
    await download.saveAs(file)

    await page.goto('/library')
    await page.getByRole('button', { name: 'More actions for Zeta Mini 1' }).click()
    await page.getByRole('menuitem', { name: 'Delete…' }).click()
    const confirm = page.getByRole('dialog', { name: 'Delete “Zeta Mini 1”?' })
    await expect(confirm).toContainText(`${SAMPLE_NAME} (keeps its own copy)`)
    await confirm.getByRole('button', { name: 'Delete part' }).click()
    await expect(confirm).toBeHidden()
    await expect(page.getByRole('article', { name: 'Zeta Mini 1' })).toHaveCount(0)

    // Import as a copy: the copy still knows the device, from the file alone.
    await page.goto('/import')
    await page.locator('input[type="file"]').setInputFiles(file)
    await expect(page.getByRole('heading', { level: 2, name: /^In / })).toBeFocused()
    await page.getByRole('radio', { name: 'Copy' }).click()
    await page.getByRole('button', { name: 'Import as copies' }).click()
    await expect(page.getByText('1 plan added as new plans.')).toBeVisible()
    await page.getByRole('link', { name: 'Back to your racks' }).click()
    await page
      .getByRole('article')
      .filter({ has: page.getByRole('heading', { name: `${SAMPLE_NAME} (copy)`, exact: true }) })
      .getByRole('link')
      .first()
      .click()
    await expect(page.getByTestId('plan-name-input')).toHaveValue(`${SAMPLE_NAME} (copy)`)
    const copied = rackPart(page, 'Shelf 1U')
    await expect(copied).toHaveAttribute('data-u-start', '6')
    await expect(copied).toHaveAccessibleName(/holds Zeta Mini 1 \(To get\)$/)
    await expect(page.getByTestId('panel-checks')).not.toContainText('not in the catalog')
  })
})

test.describe('Accessibility of the M3b dialogs and My parts', () => {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`chooser, Needs a mount?, Add a part and My parts pass axe (${colorScheme})`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme })
      await page.goto('/library')
      await expect(page.getByRole('heading', { level: 1, name: 'My parts' })).toBeVisible()
      await expectNoSeriousAxeViolations(page, 'My parts (empty)')

      await page.getByRole('button', { name: 'Add a part' }).first().click()
      const dialog = page.getByRole('dialog', { name: 'Add a part' })
      await expect(dialog.getByRole('heading', { name: 'Where is it from?' })).toBeVisible()
      await expectNoSeriousAxeViolations(page, 'Add a part (link step)')
      await dialog.getByRole('button', { name: 'Next' }).click()
      await expect(dialog.getByRole('heading', { name: 'What is it?' })).toBeVisible()
      await expectNoSeriousAxeViolations(page, 'Add a part (kind step)')
      await dialog.getByRole('radio', { name: 'A device' }).click()
      await dialog.getByRole('button', { name: 'Next' }).click()
      await expect(dialog.getByRole('heading', { name: 'About the device' })).toBeVisible()
      // A failed save marks the fields with their problems.
      await dialog.getByRole('button', { name: 'Save to My parts' }).click()
      await expect(dialog.locator('[aria-invalid="true"]').first()).toBeVisible()
      await expectNoSeriousAxeViolations(page, 'Add a part (device details, with problems)')
      await fillDevice(dialog, BIG_BOX)
      await dialog.getByRole('button', { name: 'Save to My parts' }).click()
      await expect(dialog).toBeHidden()
      await expect(page.getByRole('article', { name: 'Acme Big Box 3' })).toBeVisible()
      await expectNoSeriousAxeViolations(page, 'My parts (one device)')

      await openSample(page)
      const pi = await paletteRow(page, 'Devices', 'Raspberry Pi 5', 'raspberry-pi-5')
      await pressAndMove(page, await centreOf(pi), await aimAt(page, 7, 1))
      await page.mouse.up()
      const chooser = page.getByTestId('mount-chooser')
      await expect(chooser).toBeVisible()
      await expectNoSeriousAxeViolations(page, 'the mount chooser')
      await chooser.getByRole('button', { name: 'None of these? Needs a mount?' }).click()
      const helper = page.getByRole('dialog', { name: 'Needs a mount?' })
      await expect(helper).toBeVisible()
      await expectNoSeriousAxeViolations(page, 'Needs a mount?')
      await helper.getByRole('button', { name: 'Create a custom mount sized for it' }).click()
      const editor = page.getByTestId('add-part-dialog')
      await expect(editor.getByRole('button', { name: 'Save and place' })).toBeVisible()
      await expectNoSeriousAxeViolations(page, 'Add a part (mount editor)')
    })
  }
})
