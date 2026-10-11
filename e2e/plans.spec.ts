/**
 * M2 end to end: the Plans page, the New plan wizard (Recording mode), the editor stub (rename,
 * autosave, undo/redo), duplicate/delete, export and import (copy, replace), Settings > Storage,
 * the two-tab conflict banner and axe checks. Every test starts from an empty browser profile
 * (Playwright gives each test its own context), seeds data through the UI, and waits for text,
 * roles or data-testids, never for fixed delays.
 */
import { AxeBuilder } from '@axe-core/playwright'
import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'

const SAMPLE_NAME = 'Sample: KWS 9U → 12U'
const RECORDED_NAME = 'KWS Rack v2: 9U → 12U'

/** Browser globals read inside page.evaluate (e2e is type-checked without the DOM lib). */
type PageGlobals = { location: { origin: string } }

/**
 * Chromium's save dialog (File System Access) would wait for a person; without it the app falls
 * back to an `<a download>` link, which Playwright sees as a download event. Plain-HTTP origins
 * never have the dialog anyway.
 */
async function useLinkDownloads(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const scope = globalThis as unknown as { showSaveFilePicker?: unknown }
    delete scope.showSaveFilePicker
    if (typeof scope.showSaveFilePicker === 'function') {
      Object.defineProperty(scope, 'showSaveFilePicker', { value: undefined, configurable: true })
    }
  })
}

/** Animations as seen from the page (e2e is type-checked without the DOM lib). */
type AnimationLike = {
  finished: Promise<unknown>
  effect: { getTiming(): { iterations?: number } } | null
}

/**
 * Waits for finite CSS animations and transitions (a dialog fading in, a menu fading out): axe
 * measures colours as painted, and a half-faded element always fails the contrast check.
 */
async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const { document } = globalThis as unknown as {
      document: { getAnimations(): AnimationLike[] }
    }
    const finite = document
      .getAnimations()
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)))
  })
}

async function expectNoSeriousAxeViolations(page: Page, what: string): Promise<void> {
  await settleAnimations(page)
  const { violations } = await new AxeBuilder({ page }).analyze()
  const blocking = violations
    .filter(({ impact }) => impact === 'serious' || impact === 'critical')
    .map(({ id, impact, help, nodes }) => {
      const where = nodes.map((node) => `${node.target.join(' ')}: ${node.failureSummary ?? ''}`)
      return [`${impact} ${id}: ${help}`, ...where].join('\n  ')
    })
  expect(blocking, `axe on ${what}`).toEqual([])
}

async function openPlans(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'Your racks' })).toBeVisible()
}

/** The editor's name field; it shows the plan once the store has loaded it. */
function nameField(page: Page): Locator {
  return page.getByTestId('plan-name-input')
}

/** "Saved" once the autosave stored everything (also after a reload restored kept edits). */
async function expectSaved(page: Page): Promise<void> {
  await expect(page.getByTestId('save-state')).toHaveText('Saved')
}

/** Creates the sample plan from the empty Plans page and waits for the editor. */
async function openSample(page: Page): Promise<string> {
  await openPlans(page)
  await page.getByRole('button', { name: 'Open the sample' }).click()
  await expect(page).toHaveURL(/\/plan\/[^/]+$/)
  await expect(nameField(page)).toHaveValue(SAMPLE_NAME)
  return page.url()
}

function planCards(page: Page): Locator {
  return page.getByRole('article')
}

function planCard(page: Page, name: string): Locator {
  return planCards(page).filter({ has: page.getByRole('heading', { name, exact: true }) })
}

async function cardAction(page: Page, planName: string, action: string | RegExp): Promise<void> {
  const label = `Actions for ${planName}`
  await planCard(page, planName).getByRole('button', { name: label, exact: true }).click()
  // A menu that just closed can still be fading out: act in the one that opened.
  await page
    .getByRole('menu', { name: label, exact: true })
    .getByRole('menuitem', { name: action })
    .click()
}

/** Renames in the editor heading the way a person does: type, then Enter. */
async function renameInEditor(page: Page, name: string): Promise<void> {
  await nameField(page).fill(name)
  await nameField(page).press('Enter')
}

/** Exports the plan from its card; returns the saved file (under the name the app gave it). */
async function exportPlan(page: Page, planName: string): Promise<{ path: string; name: string }> {
  const downloading = page.waitForEvent('download')
  await cardAction(page, planName, 'Export as file')
  const download = await downloading
  const name = download.suggestedFilename()
  expect(name).toMatch(/^sample-kws-9u-12u-\d{4}-\d{2}-\d{2}\.rackplan\.json$/)
  const path = test.info().outputPath(name)
  await download.saveAs(path)
  return { path, name }
}

/** Picks a file on /import and waits for its preview. */
async function pickImportFile(page: Page, file: { path: string; name: string }): Promise<void> {
  await page.goto('/import')
  await expect(page.getByRole('heading', { level: 1, name: 'Import' })).toBeVisible()
  await page.locator('input[type="file"]').setInputFiles(file.path)
  await expect(page.getByRole('heading', { level: 2, name: /^In / })).toBeFocused()
}

test.describe('Plans page and wizard', () => {
  test('the empty Plans page offers three ways to start', async ({ page }) => {
    await openPlans(page)
    const start = page.getByRole('region', { name: 'Start your first plan' })
    await expect(start.getByRole('button')).toHaveText([
      /Record my rack and plan an upgrade/,
      /Plan a new rack/,
      /Open the sample/,
    ])
    await expect(planCards(page)).toHaveCount(0)
    await expect(start.getByRole('link', { name: 'Import a backup' })).toHaveAttribute(
      'href',
      '/import',
    )
  })

  test('recording a 3U + 6U rack with a 12U goal on top opens the plan in Recording mode', async ({
    page,
  }) => {
    await openPlans(page)
    await page.getByRole('button', { name: 'Record my rack and plan an upgrade' }).click()
    const wizard = page.getByRole('dialog', { name: 'Record my rack' })
    await expect(wizard.getByRole('heading', { name: 'Which frame is your rack?' })).toBeVisible()

    await wizard.getByRole('radio', { name: 'KWS Rack v2', exact: true }).click()
    await wizard.getByRole('button', { name: 'Next' }).click()
    await expect(
      wizard.getByRole('heading', { name: 'What does your rack have today?' }),
    ).toBeFocused()

    await wizard.getByRole('button', { name: '3U + 6U: 3U at the bottom, 6U on top' }).click()
    const rows = wizard.getByRole('list', { name: 'Sections, top to bottom' }).getByRole('listitem')
    await expect(rows).toHaveCount(2)
    // Recording: everything in the preset is already in the rack.
    for (const label of ['6U section, U4–U9', '3U section, U1–U3']) {
      await expect(
        wizard
          .getByRole('radiogroup', { name: `${label}: in my rack or to get` })
          .getByRole('radio', { name: 'In my rack' }),
      ).toBeChecked()
    }
    await expect(wizard.getByText('Total: 9U')).toBeVisible()
    await expectNoSeriousAxeViolations(page, 'the wizard (stack step)')
    await wizard.getByRole('button', { name: 'Next' }).click()

    await expect(wizard.getByRole('heading', { name: 'How tall do you want it?' })).toBeFocused()
    await expect(wizard.getByRole('radio', { name: 'Grow it to a height' })).toBeChecked()
    await expect(wizard.getByRole('radio', { name: 'On top' })).toBeChecked()
    await expect(wizard.getByText('9U → 12U: a new 3U section on top.')).toBeVisible()
    await expect(wizard.getByRole('textbox', { name: 'Plan name' })).toHaveValue(RECORDED_NAME)
    await wizard.getByRole('button', { name: 'Create plan' }).click()

    await expect(page).toHaveURL(/\/plan\/[^/]+$/)
    await expect(wizard).toBeHidden()
    await expect(nameField(page)).toHaveValue(RECORDED_NAME)
    await expect(page.getByRole('heading', { name: 'Recording what you have' })).toBeVisible()
    // Top to bottom: the new 3U to get, then the 6U and 3U already built.
    const sections = page.getByTestId('section-row')
    await expect(sections).toHaveCount(3)
    await expect(sections).toHaveText([
      /3U section U10–U12\s*To get/,
      /6U section U4–U9\s*In my rack/,
      /3U section U1–U3\s*In my rack/,
    ])
    await expect(sections.first()).toHaveAttribute('data-have', 'false')

    await page.getByRole('link', { name: 'Your racks' }).click()
    const card = planCard(page, RECORDED_NAME)
    await expect(card).toBeVisible()
    await expect(card).toContainText('3U + 6U + 3U · 12U')
    await expect(card).toContainText('2 in my rack')
    await expect(card).toContainText('1 to get')
  })

  test('duplicating and deleting plans from their cards', async ({ page }) => {
    await openSample(page)
    await page.getByRole('link', { name: 'Your racks' }).click()
    await expect(planCards(page)).toHaveCount(1)

    await cardAction(page, SAMPLE_NAME, /Duplicate as new idea/)
    const copyName = `${SAMPLE_NAME} (copy)`
    await expect(planCard(page, copyName)).toBeVisible()
    await expect(planCards(page)).toHaveCount(2)

    await cardAction(page, copyName, 'Delete…')
    const confirm = page.getByRole('dialog', { name: `Delete “${copyName}”?` })
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await confirm.getByRole('button', { name: 'Delete plan' }).click()
    await expect(confirm).toBeHidden()
    await expect(planCards(page)).toHaveCount(1)
    await expect(planCard(page, SAMPLE_NAME)).toBeVisible()
    await expect(page.getByText(`Deleted “${copyName}”.`)).toBeVisible()
    // The deleted plan is gone from storage too, not only from the page.
    await page.reload()
    await expect(planCards(page)).toHaveCount(1)
  })
})

test.describe('Editor', () => {
  test('a rename typed in the heading survives an immediate reload', async ({ page }) => {
    await openSample(page)
    // No Enter and no pause: the reload starts while the change is still unsaved.
    await nameField(page).fill('Garage rack')
    await page.reload()
    await expect(nameField(page)).toHaveValue('Garage rack')
    await expectSaved(page)
    // Stored for real (not only the copy kept through the reload).
    await page.reload()
    await expect(nameField(page)).toHaveValue('Garage rack')
    await expectSaved(page)
    await page.getByRole('link', { name: 'Your racks' }).click()
    await expect(planCard(page, 'Garage rack')).toBeVisible()
  })

  test('undo and redo a rename', async ({ page }) => {
    await openSample(page)
    const undo = page.getByRole('button', { name: 'Undo' })
    const redo = page.getByRole('button', { name: 'Redo' })
    await expect(undo).toBeDisabled()

    await renameInEditor(page, 'Office rack')
    await expectSaved(page)
    await expect(undo).toBeEnabled()
    await undo.click()
    await expect(nameField(page)).toHaveValue(SAMPLE_NAME)
    await expect(page.getByRole('status').filter({ hasText: 'Undone.' })).toBeAttached()
    await expect(redo).toBeEnabled()
    await expectSaved(page)

    await redo.click()
    await expect(nameField(page)).toHaveValue('Office rack')
    await expect(redo).toBeDisabled()
    await expectSaved(page)
    await page.reload()
    await expect(nameField(page)).toHaveValue('Office rack')
  })

  test('a save in one tab shows the conflict banner in the other', async ({ page, context }) => {
    const url = await openSample(page)
    const other = await context.newPage()
    const otherProblems: string[] = []
    other.on('console', (message) => {
      if (message.type() === 'error') otherProblems.push(message.text())
    })
    other.on('pageerror', (error) => otherProblems.push(error.message))
    await other.goto(url)
    await expect(nameField(other)).toHaveValue(SAMPLE_NAME)

    await renameInEditor(page, 'Renamed in tab A')
    await expectSaved(page)
    await renameInEditor(other, 'Renamed in tab B')

    const banner = other.getByRole('alert').filter({ hasText: 'This plan changed in another tab' })
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('Your latest changes here are not saved.')
    await expect(banner.getByRole('button', { name: 'Reload' })).toBeVisible()
    await expect(banner.getByRole('button', { name: 'Save as a copy' })).toBeVisible()
    await expect(other.getByTestId('save-state')).toHaveText('Not saved')
    // Tab A saved first and is not told anything.
    await expect(page.getByRole('alert')).toHaveCount(0)

    // Leaving would drop tab B's rename: the editor asks first.
    await other.getByRole('link', { name: 'Your racks' }).click()
    const leave = other.getByRole('dialog', { name: 'Keep your latest changes?' })
    await expect(leave).toBeVisible()
    await leave.getByRole('button', { name: 'Stay here' }).click()
    await expect(leave).toBeHidden()
    await expect(other).toHaveURL(url)

    await banner.getByRole('button', { name: 'Reload' }).click()
    await expect(banner).toBeHidden()
    await expect(nameField(other)).toHaveValue('Renamed in tab A')
    await expectSaved(other)
    expect(otherProblems).toEqual([])
    await other.close()
  })
})

test.describe('Export and import', () => {
  test.beforeEach(async ({ page }) => {
    await useLinkDownloads(page)
  })

  test('an exported plan imports as a copy next to the original', async ({ page }) => {
    await openSample(page)
    await page.getByRole('link', { name: 'Your racks' }).click()
    const file = await exportPlan(page, SAMPLE_NAME)

    await pickImportFile(page, file)
    await expect(page.getByRole('list', { name: 'Plans in the file' })).toContainText(
      'Already in this browser',
    )
    await page.getByRole('radio', { name: 'Copy' }).click()
    await page.getByRole('button', { name: 'Import as copies' }).click()
    await expect(
      page.getByRole('heading', { level: 2, name: `Imported ${file.name}` }),
    ).toBeFocused()
    await expect(page.getByText('1 plan added as new plans.')).toBeVisible()

    await page.getByRole('link', { name: 'Back to your racks' }).click()
    await expect(planCards(page)).toHaveCount(2)
    // Copy mode keeps the name when it is free, else adds "(copy)"; Have is reset in the copy.
    const copy = planCard(page, `${SAMPLE_NAME} (copy)`)
    await expect(copy).toBeVisible()
    await expect(copy).toContainText('0 in my rack')
  })

  test('replace asks for a typed confirmation before it deletes anything', async ({ page }) => {
    await openSample(page)
    await page.getByRole('link', { name: 'Your racks' }).click()
    const file = await exportPlan(page, SAMPLE_NAME)
    await cardAction(page, SAMPLE_NAME, /Duplicate from scratch/)
    await expect(planCards(page)).toHaveCount(2)

    await pickImportFile(page, file)
    await page.getByRole('radio', { name: 'Replace everything' }).click()
    const replace = page.getByRole('button', { name: 'Replace everything' })
    await replace.click()
    const confirmation = page.getByRole('textbox', { name: 'Type REPLACE to confirm' })
    await expect(confirmation).toBeFocused()
    await expect(confirmation).toHaveAttribute('aria-invalid', 'true')
    await expect(
      page.getByText('Type REPLACE in capitals to replace everything in this browser.'),
    ).toBeVisible()
    await expect(page.getByRole('heading', { name: /^Imported / })).toHaveCount(0)

    await confirmation.fill('REPLACE')
    await replace.click()
    await expect(
      page.getByRole('heading', { level: 2, name: `Imported ${file.name}` }),
    ).toBeFocused()
    await expect(page.getByText('Plans: 0 added, 1 updated.')).toBeVisible()
    await expect(page.getByText('1 plan that only this browser had were removed.')).toBeVisible()
    await page.getByRole('link', { name: 'Back to your racks' }).click()
    await expect(planCards(page)).toHaveCount(1)
    await expect(planCard(page, SAMPLE_NAME)).toBeVisible()
  })
})

test.describe('Settings', () => {
  test('the storage panel shows this origin and what the browser allows here', async ({
    page,
  }, testInfo) => {
    await page.goto('/settings')
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
    const origin = await page.evaluate(() => (globalThis as unknown as PageGlobals).location.origin)
    const storage = page.locator('section#storage')
    await expect(storage.getByRole('heading', { name: 'Storage' })).toBeVisible()
    await expect(storage.locator('code')).toHaveText(origin)

    const keep = storage.getByRole('button', { name: 'Keep my data' })
    if (testInfo.project.name === 'prod-lan') {
      // Plain HTTP: no navigator.storage, so the button is gone and the page says why.
      await expect(storage.getByText('Not available on this address.').first()).toBeVisible()
      await expect(keep).toHaveCount(0)
      await expect(
        storage.getByText('This address uses plain HTTP, so some features are limited'),
      ).toBeVisible()
    } else {
      await expect(storage.getByText('Space used')).toBeVisible()
      await expect(
        keep.or(storage.getByText('Yes. The browser will not clear it to free up space.')),
      ).toBeVisible()
    }

    const diagnostics = page.locator('section#diagnostics')
    await expect(diagnostics.getByRole('button', { name: 'Copy diagnostics' })).toBeVisible()
    await expect(diagnostics.getByRole('link', { name: /Report a problem/ })).toHaveAttribute(
      'href',
      /^https:\/\/github\.com\/[^/]+\/mini-rack-planner\/issues\/new\?template=bug\.yml/,
    )
  })
})

test.describe('Accessibility', () => {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`Plans, wizard, editor, Import and Settings have no serious or critical axe violations (${colorScheme})`, async ({
      page,
    }) => {
      await useLinkDownloads(page)
      await page.emulateMedia({ colorScheme })
      await openPlans(page)
      await expectNoSeriousAxeViolations(page, 'the empty Plans page')

      await page.getByRole('button', { name: 'Plan a new rack' }).click()
      const wizard = page.getByRole('dialog', { name: 'Plan a new rack' })
      await expect(
        wizard.getByRole('heading', { name: 'Which frame will you build?' }),
      ).toBeVisible()
      await expectNoSeriousAxeViolations(page, 'the wizard (frame step)')
      await wizard.getByRole('button', { name: 'Close' }).click()
      await expect(wizard).toBeHidden()

      await openSample(page)
      await expectNoSeriousAxeViolations(page, 'the editor')

      await page.getByRole('link', { name: 'Your racks' }).click()
      await expect(planCards(page)).toHaveCount(1)
      await expectNoSeriousAxeViolations(page, 'the Plans page with a plan')
      await cardAction(page, SAMPLE_NAME, 'Delete…')
      await expect(page.getByRole('dialog', { name: /^Delete / })).toBeVisible()
      // The actions menu is closed and gone, so only the dialog and the page behind it count.
      await expect(page.getByRole('menu')).toHaveCount(0)
      await expectNoSeriousAxeViolations(page, 'the delete dialog')
      await page.getByRole('button', { name: 'Cancel' }).click()

      const file = await exportPlan(page, SAMPLE_NAME)
      await pickImportFile(page, file)
      // Replace shows the destructive badge and button.
      await page.getByRole('radio', { name: 'Replace everything' }).click()
      await expectNoSeriousAxeViolations(page, 'Import (Replace selected)')

      await page.goto('/settings')
      await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
      await expect(page.locator('section#storage code')).toBeVisible()
      await expectNoSeriousAxeViolations(page, 'Settings')
    })
  }
})
