/**
 * Pointer helpers for the M3b drag-and-drop specs: open the sample, set the zoom, aim at a U of
 * the rack drawing, press and move the mouse, and find a palette row to drag by its name.
 *
 * Positions on the drawing are measured by the page itself (`getBoundingClientRect`), like
 * `rackPoint` in editorHelpers.ts: WebKit's `boundingBox()` misplaces SVG `<text>`, which would
 * aim the pointer above the rack. "Which U" is read from the rendered U labels, never from the
 * app's maths.
 */
import type { Locator, Page } from '@playwright/test'
import { expect } from './fixtures.ts'

export interface Point {
  x: number
  y: number
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** Middle of the panel area, in the drawing's millimetres (254 mm panels, 0 = left edge). */
const PANEL_MIDDLE_MM = 127

/** The element's box in viewport px, measured by the page. */
async function clientRect(locator: Locator): Promise<Box> {
  return locator.evaluate((element) => {
    const { x, y, width, height } = (
      element as { getBoundingClientRect: () => Box }
    ).getBoundingClientRect()
    return { x, y, width, height }
  })
}

/** Opens the sample (KWS 9U → 12U) from the empty Plans page and waits for the rack. */
export async function openSample(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the sample' }).click()
  await expect(page).toHaveURL(/\/plan\/[^/]+$/)
  await expect(page.getByTestId('rack-svg')).toBeVisible()
}

/** Zoom 50 / 100 / 200 % with the toolbar (100 % first, then step). */
export async function setZoom(page: Page, percent: 50 | 100 | 200): Promise<void> {
  const svg = page.getByTestId('rack-svg')
  await page.getByTestId('toolbar-zoom-reset').click()
  await expect(svg).toHaveAttribute('data-zoom', '1')
  const button = page.getByTestId(percent < 100 ? 'toolbar-zoom-out' : 'toolbar-zoom-in')
  for (let presses = 0; presses < 8; presses += 1) {
    if ((await svg.getAttribute('data-zoom')) === String(percent / 100)) return
    await button.click()
  }
  await expect(svg).toHaveAttribute('data-zoom', String(percent / 100))
}

type Scroller = { scrollTop: number; scrollLeft: number }

/**
 * Where to aim so a part `heightU` tall lands with its bottom at `uStart` (parts are centred on
 * the pointer, as with a click): the middle of the U's it covers, across the middle of the panel.
 * When that point is near an edge of the rack's viewport (where a drag scrolls it), the viewport
 * alone is scrolled to bring it to the middle; the window never scrolls, so earlier aims hold.
 */
export async function aimAt(page: Page, uStart: number, heightU: number): Promise<Point> {
  const viewport = page.getByTestId('panel-rack')
  const svg = page.getByTestId('rack-svg')
  const bottom = svg.locator(`[data-u-label="${uStart}"]`)
  const top = svg.locator(`[data-u-label="${uStart + heightU - 1}"]`)
  async function measure(): Promise<{ aim: Point; view: Box }> {
    const [box, bottomBox, topBox, view, viewBox] = await Promise.all([
      clientRect(svg),
      clientRect(bottom),
      clientRect(top),
      clientRect(viewport),
      svg.getAttribute('viewBox'),
    ])
    if (!viewBox) throw new Error('The rack drawing has no viewBox.')
    const [minX = 0, , width = 1] = viewBox.split(' ').map(Number)
    const scale = box.width / width
    const middle = (b: Box) => b.y + b.height / 2
    const aim = {
      x: box.x + (PANEL_MIDDLE_MM - minX) * scale,
      y: (middle(bottomBox) + middle(topBox)) / 2,
    }
    return { aim, view }
  }
  const { aim, view } = await measure()
  const margin = 80
  const dx = aim.x - (view.x + view.width / 2)
  const dy = aim.y - (view.y + view.height / 2)
  const nearEdge = Math.abs(dx) > view.width / 2 - margin || Math.abs(dy) > view.height / 2 - margin
  if (!nearEdge) return aim
  await viewport.evaluate(
    (element, [x, y]) => {
      const scroller = element as unknown as Scroller
      scroller.scrollLeft += x ?? 0
      scroller.scrollTop += y ?? 0
    },
    [dx, dy],
  )
  return (await measure()).aim
}

/** The middle of an (HTML) element on screen. */
export async function centreOf(locator: Locator): Promise<Point> {
  const box = await clientRect(locator)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** Presses on `from`, moves to `to` in small steps (holding there), but does not release. */
export async function pressAndMove(page: Page, from: Point, to: Point): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 15 })
}

/** The palette row's name: rows are dragged by their name or card, never by a button. */
export async function paletteRow(
  page: Page,
  tab: string,
  query: string,
  id: string,
): Promise<Locator> {
  const palette = page.getByTestId('panel-palette')
  await palette.getByRole('tab', { name: tab }).click()
  await palette.getByTestId('palette-search').fill(query)
  const row = palette.getByTestId(`palette-item-${id}`)
  await expect(row).toHaveAttribute('data-rack-drag-source', 'palette')
  const name = row.locator('p').first()
  // The palette scrolls on its own: bring the row into view before pressing on it.
  await name.scrollIntoViewIfNeeded()
  return name
}
