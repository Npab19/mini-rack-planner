/**
 * M3b drag and drop on the rack, with a real mouse (ported from the spike S2 check, which this
 * replaces): a 2U part dragged from the palette lands on the U it was aimed at at 50 %, 100 % and
 * 200 % zoom; a placed part moves by pointer; a device dropped on a mount's slot goes in; a device
 * dropped on empty rack space opens the mount chooser, and the mount picked there is placed with
 * the device in it; Escape cancels a drag.
 *
 * "Which U" is read from the rendered U labels, never from the app's maths. Every test opens the
 * sample (KWS 9U -> 12U: shelf U1–U2, blank U3, Lenovo Tiny mount U4, drive rack U10; U5–U9 and
 * U11–U12 free) in a fresh browser profile.
 */
import { rackPart } from './editorHelpers.ts'
import { expect, test } from './fixtures.ts'
import { aimAt, centreOf, openSample, paletteRow, pressAndMove, setZoom } from './rackPointer.ts'

test.describe('Drag and drop on the rack', () => {
  for (const zoom of [50, 100, 200] as const) {
    test(`a 2U part dragged from the palette lands on U5 at ${zoom}% zoom`, async ({ page }) => {
      await openSample(page)
      await setZoom(page, zoom)
      const name = await paletteRow(page, 'Mounts & panels', 'Shelf 2U', 'generic-shelf-2u')
      const target = await aimAt(page, 5, 2)
      await pressAndMove(page, await centreOf(name), target)
      // The chip follows the pointer and the ghost says where it lands.
      await expect(page.getByTestId('rack-drag-chip')).toContainText('Fits at U5–U6')
      const ghost = page.getByTestId('rack-ghost')
      await expect(ghost).toHaveAttribute('data-ghost-origin', 'drop')
      await expect(ghost).toHaveAttribute('data-ghost-u-start', '5')
      await expect(ghost).toHaveAttribute('data-ok', 'true')
      await page.mouse.up()
      const shelf = rackPart(page, 'Shelf 2U')
      await expect(shelf).toHaveAttribute('data-u-start', '5')
      await expect(shelf).toHaveAttribute('data-u-end', '6')
      await expect(shelf).toHaveAttribute('data-have', 'false')
      // The new part is selected, so the inspector shows it.
      await expect(
        page.getByTestId('panel-inspector').getByRole('heading', { level: 2, name: 'Shelf 2U' }),
      ).toBeVisible()
      await expect(page.getByTestId('rack-ghost')).toHaveCount(0)
    })
  }

  test('Escape cancels a palette drag: nothing is added', async ({ page }) => {
    await openSample(page)
    const name = await paletteRow(page, 'Mounts & panels', 'Shelf 2U', 'generic-shelf-2u')
    await pressAndMove(page, await centreOf(name), await aimAt(page, 5, 2))
    await expect(page.getByTestId('rack-ghost')).toHaveAttribute('data-ghost-u-start', '5')
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await expect(page.getByTestId('rack-ghost')).toHaveCount(0)
    await expect(rackPart(page, 'Shelf 2U')).toHaveCount(0)
  })

  test('a placed part moves by pointer to U9, and Undo puts it back', async ({ page }) => {
    await openSample(page)
    await page.getByTestId('toolbar-fit').click()
    const lenovo = rackPart(page, 'Lenovo Tiny mount 1U')
    await expect(lenovo).toHaveAttribute('data-u-start', '4')
    const from = await aimAt(page, 4, 1)
    const to = await aimAt(page, 9, 1)
    await pressAndMove(page, from, to)
    const ghost = page.getByTestId('rack-ghost')
    await expect(ghost).toHaveAttribute('data-ghost-origin', 'move')
    await expect(ghost).toHaveAttribute('data-ghost-u-start', '9')
    await expect(lenovo).toHaveAttribute('data-dragging', 'true')
    await page.mouse.up()
    await expect(lenovo).toHaveAttribute('data-u-start', '9')
    await expect(lenovo).not.toHaveAttribute('data-dragging')
    await page.keyboard.press('ControlOrMeta+Z')
    await expect(lenovo).toHaveAttribute('data-u-start', '4')
  })

  test('a device dropped on a mount’s slot goes in', async ({ page }) => {
    await openSample(page)
    const shelfName = await paletteRow(page, 'Mounts & panels', 'Shelf 2U', 'generic-shelf-2u')
    const slot = await aimAt(page, 6, 2)
    await pressAndMove(page, await centreOf(shelfName), slot)
    await page.mouse.up()
    const shelf = rackPart(page, 'Shelf 2U')
    await expect(shelf).toHaveAttribute('data-u-start', '6')

    const pi = await paletteRow(page, 'Devices', 'Raspberry Pi 5', 'raspberry-pi-5')
    await pressAndMove(page, await centreOf(pi), await aimAt(page, 6, 2))
    const ghost = page.getByTestId('rack-slot-ghost')
    await expect(ghost).toHaveAttribute('data-ok', 'true')
    await expect(page.getByTestId('rack-drag-chip')).toContainText('Goes in Shelf of Shelf 2U')
    await page.mouse.up()
    await expect(shelf).toHaveAccessibleName(/holds Raspberry Pi 5 \(To get\)$/)
  })

  test('a device dropped on empty rack space opens the mount chooser; the pick is placed with it', async ({
    page,
  }) => {
    await openSample(page)
    const pi = await paletteRow(page, 'Devices', 'Raspberry Pi 5', 'raspberry-pi-5')
    await pressAndMove(page, await centreOf(pi), await aimAt(page, 7, 1))
    await expect(page.getByTestId('rack-ghost')).toHaveAttribute('data-ghost-status', 'choose')
    await page.mouse.up()
    const chooser = page.getByTestId('mount-chooser')
    await expect(chooser).toBeVisible()
    await expect(chooser).toContainText('Choose a mount for Raspberry Pi 5')
    await expect(chooser).toContainText('dropped at U7 on the front')
    // Each way says, in words, whether it fits where the device was dropped.
    const shelf1u = chooser.getByRole('button', { name: 'Place on Shelf 1U at U7' })
    await expect(shelf1u).toBeFocused()
    await shelf1u.click()
    await expect(chooser).toBeHidden()
    const shelf = rackPart(page, 'Shelf 1U')
    await expect(shelf).toHaveAttribute('data-u-start', '7')
    await expect(shelf).toHaveAccessibleName(/holds Raspberry Pi 5 \(To get\)$/)
    // The new part is selected and focused on the rack; one undo takes it all back.
    await expect(shelf).toBeFocused()
    await expect(page.getByTestId('panel-equipment')).not.toContainText('Raspberry Pi 5')
    await page.keyboard.press('ControlOrMeta+Z')
    await expect(shelf).toHaveCount(0)
  })

  test('a device dragged from Equipment to fit goes on the mount picked for it', async ({
    page,
  }) => {
    await openSample(page)
    const tray = page.getByTestId('panel-equipment')
    await tray.getByRole('searchbox', { name: 'Add a device' }).fill('Raspberry Pi 5')
    await tray.getByRole('list', { name: 'Matching devices' }).getByRole('button').first().click()
    const handle = tray.locator('[data-testid^="equipment-drag-"]').filter({
      hasText: 'Raspberry Pi 5',
    })
    await expect(handle).toHaveCount(1)
    await handle.scrollIntoViewIfNeeded()
    await pressAndMove(page, await centreOf(handle), await aimAt(page, 7, 1))
    await expect(page.getByTestId('rack-ghost')).toHaveAttribute('data-ghost-status', 'choose')
    await page.mouse.up()
    const chooser = page.getByTestId('mount-chooser')
    await expect(chooser).toContainText('Choose a mount for Raspberry Pi 5')
    await chooser.getByRole('button', { name: 'Place on Shelf 1U at U7' }).click()
    const shelf = rackPart(page, 'Shelf 1U')
    await expect(shelf).toHaveAttribute('data-u-start', '7')
    await expect(shelf).toHaveAccessibleName(/holds Raspberry Pi 5 \(To get\)$/)
    // It left the tray: the device that waited there is the one now in the rack.
    await expect(handle).toHaveCount(0)
  })
})
