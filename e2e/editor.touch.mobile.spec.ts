/**
 * M3b touch on a phone (the `mobile` project: iPhone-sized viewport, touch, Chromium): tap-to-place
 * stays the way to place (Place in the Parts sheet, then tap a U), a 250 ms long-press picks a
 * placed part up and moves it, two fingers pinch-zoom the rack, and a quick swipe pans it without
 * moving the part under the finger. Ported from the touch scenarios of the spike S2 check.
 *
 * Long-presses, swipes and pinches go through CDP touch events; touch state lives in one CDP
 * session, so each gesture uses one session from its first touch to its last.
 */
import type { CDPSession, Page } from '@playwright/test'
import { rackPart, rackPoint } from './editorHelpers.ts'
import { expect, test } from './fixtures.ts'

interface Point {
  x: number
  y: number
}

async function openSample(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the sample' }).tap()
  await expect(page).toHaveURL(/\/plan\/[^/]+$/)
  await expect(page.getByTestId('rack-svg')).toBeVisible()
}

type TouchType = 'touchStart' | 'touchMove' | 'touchEnd'

async function touch(session: CDPSession, type: TouchType, points: readonly Point[]) {
  await session.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map((point, id) => ({ x: point.x, y: point.y, id })),
  })
}

/** One finger: press, hold `holdMs`, slide to `to` in steps, lift. */
async function fingerDrag(page: Page, from: Point, to: Point, holdMs: number, steps = 12) {
  const session = await page.context().newCDPSession(page)
  try {
    await touch(session, 'touchStart', [from])
    if (holdMs > 0) await page.waitForTimeout(holdMs)
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps
      await touch(session, 'touchMove', [
        { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t },
      ])
    }
    await touch(session, 'touchEnd', [])
  } finally {
    await session.detach()
  }
}

/** Two fingers around `centre`, `from` px apart, spreading to `to` px apart (vertically). */
async function pinch(page: Page, centre: Point, from: number, to: number, steps = 10) {
  const session = await page.context().newCDPSession(page)
  const fingers = (gap: number): Point[] => [
    { x: centre.x, y: centre.y - gap / 2 },
    { x: centre.x, y: centre.y + gap / 2 },
  ]
  try {
    await touch(session, 'touchStart', fingers(from))
    for (let step = 1; step <= steps; step += 1) {
      await touch(session, 'touchMove', fingers(from + ((to - from) * step) / steps))
    }
    await touch(session, 'touchEnd', [])
  } finally {
    await session.detach()
  }
}

async function zoomOf(page: Page): Promise<number> {
  return Number(await page.getByTestId('rack-svg').getAttribute('data-zoom'))
}

/** Taps Place for a part in the Parts sheet, then taps the U the part should start at. */
async function tapToPlace(page: Page, itemId: string, uStart: number): Promise<void> {
  await page.getByTestId('toolbar-sheet-palette').tap()
  const parts = page.getByRole('dialog', { name: 'Parts' })
  const place = parts.getByTestId(`palette-place-${itemId}`)
  await expect(place).toBeVisible()
  // In the Parts sheet the rows are not draggable: on a phone, tap-to-place is the way.
  await expect(parts.locator('[data-rack-drag-source]')).toHaveCount(0)
  await place.tap()
  // The sheet makes way for the rack.
  await expect(parts).toBeHidden()
  await expect(page.getByTestId('placing-banner')).toContainText('tap a free spot on the rack')
  const point = await rackPoint(page, uStart, 1)
  await page.touchscreen.tap(point.x, point.y)
  await expect(page.getByTestId('placing-banner')).toBeHidden()
}

type Scroller = { scrollTop: number; scrollHeight: number; clientHeight: number }

test('tap to place, then a long-press moves the part', async ({ page }) => {
  await openSample(page)
  await tapToPlace(page, 'generic-blank-1u', 9)
  const placed = rackPart(page, 'Blank panel 1U').filter({
    has: page.locator('[data-selection-ring]'),
  })
  await expect(placed).toHaveAttribute('data-u-start', '9')
  const id = await placed.getAttribute('data-placement-id')
  expect(id).not.toBeNull()
  const blank = page.locator(`[data-placement-id="${id ?? ''}"]`)

  // Hold for longer than 250 ms, then slide down two U's.
  const from = await rackPoint(page, 9, 1)
  const to = await rackPoint(page, 7, 1)
  await fingerDrag(page, from, to, 400)
  await expect(blank).toHaveAttribute('data-u-start', '7')
  await expect(blank).toHaveAccessibleName('Blank panel 1U, U7, To get')
  await expect(page.getByTestId('rack-ghost')).toHaveCount(0)
})

test('two fingers pinch-zoom; a quick swipe pans and leaves the part where it is', async ({
  page,
}) => {
  await openSample(page)
  const before = await zoomOf(page)
  await pinch(page, await rackPoint(page, 6, 1), 80, 200)
  await expect.poll(() => zoomOf(page)).toBeGreaterThan(before * 1.8)

  // The Lenovo mount is at U4: a swipe that starts on it pans the view instead of moving it.
  const lenovo = rackPart(page, 'Lenovo Tiny mount 1U')
  await expect(lenovo).toHaveAttribute('data-u-start', '4')
  const viewport = page.getByTestId('panel-rack')
  const scrollTop = () => viewport.evaluate((element) => (element as unknown as Scroller).scrollTop)
  const start = await rackPoint(page, 4, 1)
  const {
    scrollTop: top,
    scrollHeight,
    clientHeight,
  } = await viewport.evaluate((element) => {
    const { scrollTop: t, scrollHeight: h, clientHeight: c } = element as unknown as Scroller
    return { scrollTop: t, scrollHeight: h, clientHeight: c }
  })
  expect(scrollHeight).toBeGreaterThan(clientHeight)
  // Swipe toward the end with more room: up scrolls down the rack, down scrolls up.
  const up = top < (scrollHeight - clientHeight) / 2
  await fingerDrag(page, start, { x: start.x, y: start.y + (up ? -100 : 100) }, 0, 6)
  await expect.poll(scrollTop).not.toBe(top)
  await expect(lenovo).toHaveAttribute('data-u-start', '4')
})
