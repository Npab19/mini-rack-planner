/**
 * Helpers for the editor specs (M3a): the golden shopping list, settings, the record-my-rack
 * wizard, placing on the rack with the mouse, keyboard focus moves, downloads and axe. Everything
 * waits on roles, test ids or attributes, never on fixed delays.
 */
import { readFileSync } from 'node:fs'
import { AxeBuilder } from '@axe-core/playwright'
import type { Locator, Page } from '@playwright/test'
import { expect } from './fixtures.ts'

// ---------------------------------------------------------------------------------------------
// The signed-off golden output: the user's 3U + 6U (built) plus one new 3U, spares off

export interface GoldenLine {
  key: string
  kind: string
  label: string
  need: number
}

function isGoldenLine(value: unknown): value is GoldenLine {
  if (typeof value !== 'object' || value === null) return false
  const line = value as Record<string, unknown>
  return (
    typeof line.key === 'string' &&
    typeof line.kind === 'string' &&
    typeof line.label === 'string' &&
    typeof line.need === 'number'
  )
}

/** The lines of `fixtures/expected/kws-3-6-plus3-top.shopping.json` (the BOM CLI's output). */
export function goldenShoppingLines(): GoldenLine[] {
  const parsed: unknown = JSON.parse(
    readFileSync(
      new URL('../fixtures/expected/kws-3-6-plus3-top.shopping.json', import.meta.url),
      'utf8',
    ),
  )
  const lines =
    typeof parsed === 'object' && parsed !== null && 'lines' in parsed ? parsed.lines : undefined
  if (!Array.isArray(lines) || !lines.every(isGoldenLine)) {
    throw new Error('The golden shopping list has an unexpected shape.')
  }
  return lines
}

/** The KWS +3U numbers the user signed off: 1 plate, 1 connectors, 36/16/24/40/16. */
export const SIGNED_OFF: Readonly<Record<string, number>> = {
  'print:kws-rack-v2/plate-3u': 1,
  'print:kws-rack-v2/frame-connectors': 1,
  'hw:insert-m5x8x7': 36,
  'hw:screw-m6x8-shcs': 16,
  'hw:screw-m6x10-shcs': 24,
  'hw:nut-m6-nyloc': 40,
  'hw:magnet-10x5': 16,
}

/**
 * The shopping list shows exactly the golden lines, each to install and to get in the golden
 * number (spares off, nothing in stock), and no other prints (no once-per-rack parts).
 */
export async function expectGoldenShoppingList(bom: Locator, golden: readonly GoldenLine[]) {
  await expect(bom.getByRole('tab', { name: /^Shopping list/ })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  const lines = bom.locator('[data-testid^="bom-line-"]')
  await expect(lines).toHaveCount(golden.length)
  for (const line of golden) {
    const row = bom.getByTestId(`bom-line-${line.key}`)
    await expect(row, line.label).toHaveAttribute('data-install', String(line.need))
    await expect(row, line.label).toHaveAttribute('data-need', String(line.need))
    await expect(row, line.label).toHaveAttribute('data-spare', '0')
  }
  await expect(bom.locator('[data-testid^="bom-line-print:"]')).toHaveCount(2)
  await expect(bom.getByTestId('bom-summary')).toContainText(`To get: ${golden.length} lines`)
}

// ---------------------------------------------------------------------------------------------
// Setup through the UI

/** Settings > Costs & spares: every spare percentage to 0, stored (checked after a reload). */
export async function setSparesToZero(page: Page): Promise<void> {
  const ids = ['spare-screw', 'spare-nut', 'spare-insert', 'spare-magnet', 'spare-default']
  await page.goto('/settings')
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
  for (const id of ids) {
    const field = page.locator(`#${id}`)
    await field.fill('0')
    await field.press('Enter')
    await expect(field).toHaveValue('0')
  }
  await page.reload()
  for (const id of ids) await expect(page.locator(`#${id}`)).toHaveValue('0')
}

/**
 * The New plan wizard's Record flow: KWS Rack v2, the 3U + 6U preset (3U at the bottom, both In my
 * rack), "I'll plan it myself". The editor opens in Recording mode.
 */
export async function recordMyRack(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Record my rack and plan an upgrade' }).click()
  const wizard = page.getByRole('dialog', { name: 'Record my rack' })
  await wizard.getByRole('radio', { name: 'KWS Rack v2', exact: true }).click()
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByRole('button', { name: '3U + 6U: 3U at the bottom, 6U on top' }).click()
  for (const label of ['6U section, U4–U9', '3U section, U1–U3']) {
    await expect(
      wizard
        .getByRole('radiogroup', { name: `${label}: in my rack or to get` })
        .getByRole('radio', { name: 'In my rack' }),
    ).toBeChecked()
  }
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByRole('radio', { name: 'I’ll plan it myself' }).click()
  await wizard.getByRole('button', { name: 'Create plan' }).click()
  await expect(page).toHaveURL(/\/plan\/[^/]+$/)
  await expect(page.getByRole('region', { name: 'Recording what you have' })).toBeVisible()
  await expect(page.getByTestId('rack-svg')).toBeVisible()
}

// ---------------------------------------------------------------------------------------------
// The rack

/** Middle of the panel area, in the drawing's millimetres (254 mm panels, 0 = left edge). */
const PANEL_MIDDLE_MM = 127

type Rect = { x: number; y: number; width: number; height: number }

/**
 * The element's box in viewport px, measured by the page itself: WebKit's `boundingBox()` puts
 * SVG `<text>` near the top of the drawing, which would aim the pointer above the rack.
 */
async function clientRect(locator: Locator): Promise<Rect> {
  return locator.evaluate((element) => {
    const { x, y, width, height } = (
      element as { getBoundingClientRect: () => Rect }
    ).getBoundingClientRect()
    return { x, y, width, height }
  })
}

/**
 * Where to point so a part `heightU` tall lands with its bottom at `uStart`: parts are centred on
 * the pointer, so the middle of the U's it covers, across the middle of the panel.
 */
export async function rackPoint(
  page: Page,
  uStart: number,
  heightU: number,
): Promise<{ x: number; y: number }> {
  const svg = page.getByTestId('rack-svg')
  const bottom = svg.locator(`[data-u-label="${uStart}"]`)
  const top = svg.locator(`[data-u-label="${uStart + heightU - 1}"]`)
  await bottom.scrollIntoViewIfNeeded()
  const [box, bottomBox, topBox, viewBox] = await Promise.all([
    clientRect(svg),
    clientRect(bottom),
    clientRect(top),
    svg.getAttribute('viewBox'),
  ])
  if (viewBox === null) throw new Error('The rack drawing has no viewBox.')
  const [minX = 0, , width = 1] = viewBox.split(' ').map(Number)
  const scale = box.width / width
  const middle = (b: { y: number; height: number }) => b.y + b.height / 2
  return {
    x: box.x + (PANEL_MIDDLE_MM - minX) * scale,
    y: (middle(bottomBox) + middle(topBox)) / 2,
  }
}

/**
 * Mouse only: Place in the palette, hover the rack until the ghost says it fits at `uStart`, click.
 * Placing then ends and the new part is selected.
 */
export async function placeWithMouse(
  page: Page,
  itemId: string,
  uStart: number,
  heightU = 1,
): Promise<void> {
  await page.getByTestId(`palette-place-${itemId}`).click()
  await expect(page.getByTestId('placing-banner')).toBeVisible()
  const point = await rackPoint(page, uStart, heightU)
  await page.mouse.move(point.x, point.y)
  const ghost = page.getByTestId('rack-ghost')
  await expect(ghost).toHaveAttribute('data-u-start', String(uStart))
  await expect(ghost).toHaveAttribute('data-ok', 'true')
  await page.mouse.click(point.x, point.y)
  await expect(page.getByTestId('placing-banner')).toBeHidden()
}

/** A placed part on the rack drawing, by its name ("Lenovo Tiny mount 1U, U4, In my rack, …"). */
export function rackPart(page: Page, name: string): Locator {
  return page.getByTestId('rack-svg').getByRole('button', { name: new RegExp(`^${name}, `) })
}

// ---------------------------------------------------------------------------------------------
// Keyboard

type FocusScope = { document: { activeElement: unknown } }

/** Whether the element (or, `within`, something inside it) has focus. */
export async function hasFocus(locator: Locator, within = false): Promise<boolean> {
  return locator.evaluate((element, inside) => {
    const active = (globalThis as unknown as FocusScope).document.activeElement
    const node = element as { contains: (other: unknown) => boolean }
    return inside ? node.contains(active) : element === active
  }, within)
}

/** Presses `key` until the target (or something inside it, `within`) has focus. */
export async function pressUntilFocused(
  page: Page,
  key: string,
  target: Locator,
  { within = false, max = 60 }: { within?: boolean; max?: number } = {},
): Promise<void> {
  for (let presses = 0; presses <= max; presses += 1) {
    if (await hasFocus(target, within)) return
    await page.keyboard.press(key)
  }
  throw new Error(`${key} never reached ${target.toString()}`)
}

/**
 * Arrow keys through a radio group until `radio` is the chosen one. Waits for focus to reach the
 * group and for every press to move the choice, so a slow browser neither misses nor overshoots.
 */
export async function arrowUntilChecked(page: Page, radio: Locator, max = 40): Promise<void> {
  const group = radio.locator('xpath=ancestor::*[@role="radiogroup"][1]')
  const chosenIndex = () =>
    group
      .getByRole('radio')
      .evaluateAll((radios) =>
        radios.findIndex(
          (item) =>
            (item as { getAttribute: (name: string) => string | null }).getAttribute(
              'aria-checked',
            ) === 'true',
        ),
      )
  await expect.poll(() => hasFocus(group, true)).toBe(true)
  for (let presses = 0; presses <= max; presses += 1) {
    if ((await radio.getAttribute('aria-checked')) === 'true') return
    const before = await chosenIndex()
    await page.keyboard.press('ArrowDown')
    await expect.poll(chosenIndex).not.toBe(before)
  }
  throw new Error(`The arrow keys never chose ${radio.toString()}`)
}

// ---------------------------------------------------------------------------------------------
// Downloads and axe

/**
 * Chromium's save dialog (File System Access) would wait for a person; without it the app falls
 * back to an `<a download>` link, which Playwright sees as a download event.
 */
export async function useLinkDownloads(page: Page): Promise<void> {
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

/** Waits for finite animations and transitions: axe measures colours as painted. */
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

export async function expectNoSeriousAxeViolations(page: Page, what: string): Promise<void> {
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

/** The page is no wider than the screen (no sideways scrolling). */
export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = (
      globalThis as unknown as {
        document: { documentElement: { scrollWidth: number; clientWidth: number } }
      }
    ).document.documentElement
    return root.scrollWidth - root.clientWidth
  })
}
