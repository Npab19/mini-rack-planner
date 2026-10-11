/**
 * Spike S2 verification. Drives /dev/spike-dnd in Chromium and checks that palette drops, pointer
 * moves, keyboard moves and touch placement land on the computed U at 50/100/200 % zoom, under
 * both pan/zoom techniques (viewBox and CSS transform).
 *
 * Usage:
 *   npx tsx scripts/spikes/dnd-check.ts                      # exit 1 on any failure
 *   DND_CHECK_SCREENSHOTS=<dir> npx tsx scripts/spikes/dnd-check.ts
 *   DND_CHECK_URL=http://127.0.0.1:5184 npx tsx scripts/spikes/dnd-check.ts
 *     (an already running server, e.g. `vite preview` of a VITE_SPIKES=1 build, which serves the
 *     production CSP; no dev server is started then)
 *
 * Otherwise it starts its own Vite dev server on 127.0.0.1:5181 and always stops it.
 * Talks to localhost only. The oracle for "which U" is the rendered U label, never the app's maths.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
import { CSP } from '../headers.ts'

const PORT = 5181
const EXTERNAL_URL = process.env['DND_CHECK_URL']
const BASE_URL = EXTERNAL_URL ?? `http://127.0.0.1:${PORT}`
const ROUTE = '/dev/spike-dnd'
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCREENSHOT_DIR = process.env['DND_CHECK_SCREENSHOTS']
/**
 * Production CSP with two dev-server-only allowances: the React refresh preamble is an inline
 * script, and the Vite client opens a WebSocket.
 */
const DEV_CSP = CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'").replace(
  "connect-src 'self'",
  `connect-src 'self' ws://127.0.0.1:${PORT}`,
)

type Status = 'pass' | 'fail' | 'info'

interface Row {
  scenario: string
  check: string
  expected: string
  actual: string
  status: Status
}

interface Point {
  x: number
  y: number
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}

interface GhostState {
  u: string
  valid: string
  origin: string
  reason: string
}

type Kind = '1u' | '2u' | 'half'

const HEIGHT_SIXTHS: Record<Kind, number> = { '1u': 6, '2u': 12, half: 3 }
/** Mirrors SEED_PLACEMENTS in the spike: 1U at U8 and ½U in the lower half of U1. */
const SEED: ReadonlyArray<{ y: number; height: number }> = [
  { y: 42, height: 6 },
  { y: 0, height: 3 },
]
const RACK_SIXTHS = 72

const rows: Row[] = []

function record(scenario: string, check: string, expected: string, actual: string, pass?: boolean) {
  const ok = pass ?? expected === actual
  rows.push({ scenario, check, expected, actual, status: ok ? 'pass' : 'fail' })
}

function info(scenario: string, check: string, actual: string) {
  rows.push({ scenario, check, expected: '(observed)', actual, status: 'info' })
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function fitsOnSeed(kind: Kind, u: number): boolean {
  const y = (u - 1) * 6
  const height = HEIGHT_SIXTHS[kind]
  if (y < 0 || y + height > RACK_SIXTHS) return false
  return !SEED.some((other) => y < other.y + other.height && other.y < y + height)
}

/* ---------------- server ---------------- */

async function startServer(): Promise<ViteDevServer> {
  const server = await createServer({
    root: ROOT,
    configFile: join(ROOT, 'vite.config.ts'),
    // Own optimizer cache: other dev servers may use node_modules/.vite at the same time.
    cacheDir: join(ROOT, 'node_modules', '.vite-spike-dnd'),
    logLevel: 'warn',
    server: {
      host: '127.0.0.1',
      port: PORT,
      strictPort: true,
      // Sent by the server itself: a Playwright-fulfilled document has no loopback address
      // space, so Chrome's local network access check would block the dev WebSocket.
      headers: { 'Content-Security-Policy': DEV_CSP },
      // No file watcher: other engineers edit the tree concurrently; a reload mid-run would flake.
      watch: null,
      // The script collects browser console errors itself.
      forwardConsole: false,
    },
  })
  await server.listen()
  return server
}

/* ---------------- page helpers ---------------- */

async function settle(page: Page): Promise<void> {
  // A string keeps DOM types out of this Node-typed script.
  await page.evaluate(
    'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  )
}

async function box(page: Page, selector: string): Promise<Box> {
  const result = await page.locator(selector).first().boundingBox()
  if (!result) throw new Error(`No bounding box for ${selector}`)
  return result
}

function centre(b: Box): Point {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

async function rowHeightPx(page: Page): Promise<number> {
  const u1 = centre(await box(page, '[data-u-label="1"]'))
  const u2 = centre(await box(page, '[data-u-label="2"]'))
  return Math.abs(u1.y - u2.y)
}

/**
 * Screen point inside U `u`, found from the rendered "U<n>" label: same height as the label
 * (shifted by `frac` of a row, + is lower), horizontally on the rack face inside the canvas.
 */
async function pointInU(page: Page, u: number, frac = 0): Promise<Point> {
  const label = centre(await box(page, `[data-u-label="${u}"]`))
  const face = await box(page, '[data-rack-face]')
  const canvas = await box(page, '[data-testid="rack-canvas"]')
  const row = await rowHeightPx(page)
  return {
    x: clamp(face.x + face.width / 2, canvas.x + 24, canvas.x + canvas.width - 24),
    y: label.y + frac * row,
  }
}

async function isInCanvas(page: Page, y: number, margin = 24): Promise<boolean> {
  const canvas = await box(page, '[data-testid="rack-canvas"]')
  return y >= canvas.y + margin && y <= canvas.y + canvas.height - margin
}

/** Wheel-pans so the given U rows are inside the canvas (our wheel handler pans 1:1 in px). */
async function ensureUsVisible(page: Page, us: number[]): Promise<void> {
  const ys: number[] = []
  for (const u of us) ys.push((await pointInU(page, u)).y)
  const canvas = await box(page, '[data-testid="rack-canvas"]')
  const top = Math.min(...ys)
  const bottom = Math.max(...ys)
  if (top >= canvas.y + 48 && bottom <= canvas.y + canvas.height - 48) return
  const delta = (top + bottom) / 2 - (canvas.y + canvas.height / 2)
  await wheelPan(page, delta)
}

async function wheelPan(page: Page, deltaY: number): Promise<void> {
  const canvas = await box(page, '[data-testid="rack-canvas"]')
  await page.mouse.move(canvas.x + canvas.width - 12, canvas.y + canvas.height / 2)
  await page.mouse.wheel(0, deltaY)
  await settle(page)
}

async function readGhost(page: Page): Promise<GhostState | null> {
  const ghost = page.locator('[data-ghost]')
  if ((await ghost.count()) === 0) return null
  return {
    u: (await ghost.getAttribute('data-ghost-u-start')) ?? '',
    valid: (await ghost.getAttribute('data-ghost-valid')) ?? '',
    origin: (await ghost.getAttribute('data-ghost-origin')) ?? '',
    reason: (await ghost.getAttribute('data-ghost-reason')) ?? '',
  }
}

function describeGhost(ghost: GhostState | null): string {
  if (!ghost) return 'no ghost'
  return `U${ghost.u} ${ghost.valid === 'true' ? 'ok' : `blocked(${ghost.reason})`} [${ghost.origin}]`
}

async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 1500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let value = await read()
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    value = await read()
  }
  return value
}

async function uStartsOf(page: Page, kind: Kind): Promise<string[]> {
  const items = page.locator(`[data-placed-id][data-item-kind="${kind}"]`)
  const starts: string[] = []
  for (let index = 0; index < (await items.count()); index += 1) {
    starts.push((await items.nth(index).getAttribute('data-u-start')) ?? '?')
  }
  return starts.toSorted((a, b) => Number(a) - Number(b))
}

async function waitForStarts(page: Page, kind: Kind, expected: string[]): Promise<string[]> {
  const want = expected.toSorted((a, b) => Number(a) - Number(b)).join(',')
  return waitFor(
    () => uStartsOf(page, kind),
    (starts) => starts.join(',') === want,
  )
}

async function announcement(page: Page): Promise<string> {
  return (await page.getByTestId('announcer').textContent()) ?? ''
}

async function debugAttribute(page: Page, name: string): Promise<string> {
  return (await page.getByTestId('spike-debug').getAttribute(name)) ?? ''
}

function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

async function openSpike(
  context: BrowserContext,
  query: string,
): Promise<{ page: Page; errors: string[] }> {
  const page = await context.newPage()
  const errors = watchErrors(page)
  const response = await page.goto(`${BASE_URL}${ROUTE}?${query}`)
  if (!response?.headers()['content-security-policy'])
    throw new Error('The page was served without a CSP')
  await page.getByTestId('rack-svg').waitFor()
  await page.locator('[data-u-label="12"]').waitFor()
  await settle(page)
  return { page, errors }
}

async function screenshot(page: Page, name: string): Promise<void> {
  if (!SCREENSHOT_DIR) return
  mkdirSync(SCREENSHOT_DIR, { recursive: true })
  await page.screenshot({ path: join(SCREENSHOT_DIR, `${name}.png`) })
}

/* ---------------- desktop scenario ---------------- */

async function desktopScenario(browser: Browser, mode: 'viewbox' | 'css', zoom: 50 | 100 | 200) {
  const scenario = `${mode} ${zoom}%`
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
  try {
    const { page, errors } = await openSpike(context, `mode=${mode}`)
    await page.getByTestId(`zoom-${zoom}`).click()
    await page.getByTestId('pan-right').click()
    await page.getByTestId('pan-down').click()
    await settle(page)
    record(
      scenario,
      'zoom applied',
      String(zoom),
      (await page.getByTestId('rack-canvas').getAttribute('data-zoom')) ?? '',
    )
    const rowPx = await rowHeightPx(page)
    info(scenario, 'U row height (px)', rowPx.toFixed(1))

    // 1) Ghost sweep: one palette drag over every U (centre and ±30 % of the row), then Escape.
    const palette = centre(await box(page, '[data-testid="palette-item-2u"]'))
    await page.mouse.move(palette.x, palette.y)
    await page.mouse.down()
    await ensureUsVisible(page, [5])
    const start = await pointInU(page, 5)
    await page.mouse.move(start.x, start.y, { steps: 15 })
    let probes = 0
    let correct = 0
    const misses: string[] = []
    const swept = new Set<number>()
    for (let pass = 0; pass < 6 && swept.size < 12; pass += 1) {
      for (let u = 1; u <= 12; u += 1) {
        if (swept.has(u) || !(await isInCanvas(page, (await pointInU(page, u)).y, 40))) continue
        swept.add(u)
        for (const frac of [-0.3, 0, 0.3]) {
          const point = await pointInU(page, u, frac)
          await page.mouse.move(point.x, point.y, { steps: 4 })
          const want = { u: String(u), valid: String(fitsOnSeed('2u', u)) }
          const ghost = await waitFor(
            () => readGhost(page),
            (g) => g?.u === want.u && g.valid === want.valid,
            800,
          )
          probes += 1
          if (ghost?.u === want.u && ghost.valid === want.valid) correct += 1
          else misses.push(`U${u}${frac > 0 ? '+' : frac < 0 ? '-' : ''}: ${describeGhost(ghost)}`)
        }
      }
      // Hidden rows (200 %): pan the rest into view while the drag is still active.
      if (swept.size < 12) {
        const hidden = Array.from({ length: 12 }, (_, i) => i + 1).filter((u) => !swept.has(u))
        const target = await pointInU(page, hidden[0] ?? 1)
        const canvas = await box(page, '[data-testid="rack-canvas"]')
        await wheelPan(page, target.y - (canvas.y + canvas.height / 2))
      }
    }
    record(
      scenario,
      'ghost sweep (U under pointer, ✓/✗)',
      `${probes}/${probes}`,
      `${correct}/${probes}`,
      correct === probes && probes >= 36,
    )
    if (misses.length > 0) info(scenario, 'ghost sweep misses', misses.slice(0, 6).join('; '))
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await settle(page)
    record(
      scenario,
      'Escape cancels the palette drag',
      'none',
      (await uStartsOf(page, '2u')).join(',') || 'none',
    )

    // 2) The acceptance drop: 2U from the palette onto U5 with 15 stepped moves.
    await ensureUsVisible(page, [5])
    const source = centre(await box(page, '[data-testid="palette-item-2u"]'))
    await page.mouse.move(source.x, source.y)
    await page.mouse.down()
    const drop = await pointInU(page, 5)
    await page.mouse.move(drop.x, drop.y, { steps: 15 })
    const dropGhost = await waitFor(
      () => readGhost(page),
      (g) => g?.u === '5',
      800,
    )
    record(scenario, 'ghost before drop', 'U5 ok [palette]', describeGhost(dropGhost))
    await page.mouse.up()
    const afterDrop = await waitForStarts(page, '2u', ['5'])
    record(scenario, 'palette drop 2U → U5 (data-u-start)', '5', afterDrop.join(',') || 'none')
    info(scenario, 'drop details', await debugAttribute(page, 'data-last-drop'))
    await screenshot(page, `desktop-${mode}-${zoom}-dropped`)

    // 3) Pointer move of the placed item (Pointer Events + setPointerCapture): U5 → U9.
    await ensureUsVisible(page, [5, 9])
    const from = await pointInU(page, 5)
    const to = await pointInU(page, 9)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 15 })
    const moveGhost = await waitFor(
      () => readGhost(page),
      (g) => g?.u === '9',
      800,
    )
    record(scenario, 'ghost during pointer move', 'U9 ok [move]', describeGhost(moveGhost))
    await page.mouse.up()
    const afterMove = await waitForStarts(page, '2u', ['9'])
    record(scenario, 'pointer move U5 → U9 (data-u-start)', '9', afterMove.join(',') || 'none')

    // 4) Keyboard: ↑ (U10), Shift+↓ (U5), ↑ (U6), ↑ (blocked by the 1U at U8), Delete.
    const item = page.locator('[data-placed-id][data-item-kind="2u"]')
    await item.focus()
    const steps: Array<[key: string, expected: string]> = [
      ['ArrowUp', '10'],
      ['Shift+ArrowDown', '5'],
      ['ArrowUp', '6'],
      ['ArrowUp', '6'],
    ]
    const seen: string[] = []
    for (const [key, expected] of steps) {
      await page.keyboard.press(key)
      seen.push((await waitForStarts(page, '2u', [expected])).join(',') || 'none')
    }
    const blockedMessage = await announcement(page)
    await page.keyboard.press('Delete')
    seen.push((await waitForStarts(page, '2u', [])).join(',') || 'removed')
    const removedMessage = await announcement(page)
    record(scenario, 'keyboard ↑, ⇧↓, ↑, ↑(blocked), Del', '10 5 6 6 removed', seen.join(' '))
    record(
      scenario,
      'aria-live: blocked move and removal',
      "Can't move…overlaps / Removed…",
      `${blockedMessage} / ${removedMessage}`,
      /Can't move .*overlaps/.test(blockedMessage) && removedMessage.startsWith('Removed'),
    )

    // 5) Side effects of dnd-kit on the SVG and the injected styles.
    record(
      scenario,
      'dnd-kit writes to SVG nodes',
      '0',
      await debugAttribute(page, 'data-svg-dnd-mutations'),
    )
    const drops = await debugAttribute(page, 'data-drops')
    record(
      scenario,
      'dnd-kit target agrees with own hit test',
      `${drops}/${drops}`,
      `${await debugAttribute(page, 'data-target-agreed')}/${drops}`,
    )
    info(
      scenario,
      'dnd-kit styles (first in head / overlay overflow / overlay padding / top layer)',
      [
        await debugAttribute(page, 'data-style-first'),
        await debugAttribute(page, 'data-overlay-overflow'),
        await debugAttribute(page, 'data-overlay-padding'),
        await debugAttribute(page, 'data-overlay-top-layer'),
      ].join(' / '),
    )
    record(scenario, 'console errors / CSP violations', '0', String(errors.length))
    if (errors.length > 0) info(scenario, 'first error', errors[0] ?? '')
  } catch (error) {
    record(
      scenario,
      'scenario ran',
      'no exception',
      error instanceof Error ? error.message : String(error),
      false,
    )
  } finally {
    await context.close()
  }
}

/* ---------------- touch scenario ---------------- */

/** Touch press → optional hold → stepped move → release. Touch state lives in one CDP session. */
async function touchDrag(page: Page, from: Point, to: Point, holdMs: number, steps = 15) {
  const session = await page.context().newCDPSession(page)
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', point?: Point) =>
    session.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: point ? [{ x: point.x, y: point.y }] : [],
    })
  try {
    await send('touchStart', from)
    if (holdMs > 0) await page.waitForTimeout(holdMs)
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps
      await send('touchMove', { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })
    }
    await send('touchEnd')
  } finally {
    await session.detach()
  }
  await settle(page)
}

async function touchScenario(browser: Browser, mode: 'viewbox' | 'css') {
  const scenario = `touch ${mode} 100%`
  const context = await browser.newContext({
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
  })
  try {
    const { page, errors } = await openSpike(context, `mode=${mode}&zoom=100`)
    const half = page.getByTestId('palette-item-half')

    // Tap-to-select, then tap a U. Half-U items land in the half that was tapped.
    await half.tap()
    record(
      scenario,
      'tap selects the palette item (aria-pressed)',
      'true',
      (await half.getAttribute('aria-pressed')) ?? '',
    )
    await ensureUsVisible(page, [3])
    const lower = await pointInU(page, 3, 0.25)
    await page.touchscreen.tap(lower.x, lower.y)
    // The seed already has a ½U in the lower half of U1.
    record(
      scenario,
      'tap-to-place ½U in lower half of U3',
      '1,3',
      (await waitForStarts(page, 'half', ['1', '3'])).join(','),
    )
    await half.tap()
    const upper = await pointInU(page, 3, -0.25)
    await page.touchscreen.tap(upper.x, upper.y)
    record(
      scenario,
      'tap-to-place ½U in upper half of U3',
      '1,3,3.5',
      (await waitForStarts(page, 'half', ['1', '3', '3.5'])).join(','),
    )

    // A blocked tap keeps the selection and shows ✗ + reason; the next tap places.
    await page.getByTestId('palette-item-2u').tap()
    await ensureUsVisible(page, [8, 4])
    const blocked = await pointInU(page, 8)
    await page.touchscreen.tap(blocked.x, blocked.y)
    const blockedGhost = await waitFor(
      () => readGhost(page),
      (g) => g?.valid === 'false',
      800,
    )
    record(
      scenario,
      'blocked tap on U8 shows ✗ ghost',
      'U8 blocked(overlap) [tap]',
      describeGhost(blockedGhost),
    )
    record(
      scenario,
      'blocked tap places nothing',
      'none',
      (await uStartsOf(page, '2u')).join(',') || 'none',
    )
    const free = await pointInU(page, 4)
    await page.touchscreen.tap(free.x, free.y)
    record(
      scenario,
      'tap-to-place 2U at U4',
      '4',
      (await waitForStarts(page, '2u', ['4'])).join(','),
    )

    // Long-press (≥ 250 ms) drags a placed item; a quick swipe pans instead.
    await ensureUsVisible(page, [4, 9])
    await touchDrag(page, await pointInU(page, 4), await pointInU(page, 9), 400)
    record(
      scenario,
      'long-press drag 2U U4 → U9',
      '9',
      (await waitForStarts(page, '2u', ['9'])).join(','),
    )
    const centreBefore = await page.getByTestId('rack-canvas').getAttribute('data-center-y')
    const swipeFrom = await pointInU(page, 9)
    await touchDrag(page, swipeFrom, { x: swipeFrom.x, y: swipeFrom.y + 90 }, 0, 6)
    const centreAfter = await page.getByTestId('rack-canvas').getAttribute('data-center-y')
    record(
      scenario,
      'quick swipe on an item pans, item stays',
      'U9, view moved',
      `U${(await uStartsOf(page, '2u')).join(',')}, ${centreBefore === centreAfter ? 'view still' : 'view moved'}`,
    )

    // dnd-kit's touch path: long-press a palette item (250 ms delay constraint), drag, release.
    await ensureUsVisible(page, [11])
    const paletteOne = centre(await box(page, '[data-testid="palette-item-1u"]'))
    await touchDrag(page, paletteOne, await pointInU(page, 11), 400, 20)
    record(
      scenario,
      'long-press palette drag 1U → U11 (dnd-kit)',
      '8,11',
      (await waitForStarts(page, '1u', ['8', '11'])).join(','),
    )
    await screenshot(page, `touch-${mode}`)
    record(scenario, 'console errors / CSP violations', '0', String(errors.length))
    if (errors.length > 0) info(scenario, 'first error', errors[0] ?? '')
  } catch (error) {
    record(
      scenario,
      'scenario ran',
      'no exception',
      error instanceof Error ? error.message : String(error),
      false,
    )
  } finally {
    await context.close()
  }
}

/* ---------------- pitfall probe: an SVG node as a dnd-kit draggable ---------------- */

async function svgProbeScenario(browser: Browser, probe: 'svg-default' | 'svg-guarded') {
  const scenario = `probe ${probe}`
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
  try {
    const { page } = await openSpike(context, `probe=${probe}&seed=empty`)
    const rect = page.locator('[data-probe-rect]').first()
    const svg = page.getByTestId('svg-probe')
    await svg.scrollIntoViewIfNeeded()
    /** Rect box relative to its <svg>, so page auto-scroll (dnd-kit AutoScroller) cancels out. */
    const relativeBox = async (): Promise<Box> => {
      const r = await rect.boundingBox()
      const s = await svg.boundingBox()
      if (!r || !s) throw new Error('probe has no box')
      return { x: r.x - s.x, y: r.y - s.y, width: r.width, height: r.height }
    }
    const before = await relativeBox()
    const absolute = await rect.boundingBox()
    if (!absolute) throw new Error('probe rect has no box')
    const grab = centre(absolute)
    await page.mouse.move(grab.x, grab.y)
    await page.mouse.down()
    await page.mouse.move(grab.x + 40, grab.y - 20, { steps: 10 })
    await page.waitForTimeout(250)
    const dragging = (await rect.getAttribute('data-dnd-dragging')) ?? 'absent'
    const copies = await page.locator('[data-probe-rect]').count()
    const during = await relativeBox()
    await page.mouse.up()
    await settle(page)
    // `+ 0` turns -0 into 0 so an unmoved node prints "0,0".
    const moved = `${Math.round(during.x - before.x) + 0},${Math.round(during.y - before.y) + 0}`
    const size = `${before.width.toFixed(0)}x${before.height.toFixed(0)} → ${during.width.toFixed(0)}x${during.height.toFixed(0)} px`
    const observed = `data-dnd-dragging=${dragging}; nodes=${copies}; top-left moved ${moved} px for a 40,-20 px pointer move; size ${size}`
    if (probe === 'svg-guarded') {
      record(
        scenario,
        'Feedback none: SVG node untouched',
        'data-dnd-dragging=absent; nodes=1; moved 0,0',
        `data-dnd-dragging=${dragging}; nodes=${copies}; moved ${moved}`,
        dragging === 'absent' && copies === 1 && moved === '0,0',
      )
    } else {
      info(scenario, 'Feedback default on an SVG node', observed)
    }
    await screenshot(page, `probe-${probe}`)
  } catch (error) {
    record(
      scenario,
      'scenario ran',
      'no exception',
      error instanceof Error ? error.message : String(error),
      false,
    )
  } finally {
    await context.close()
  }
}

/* ---------------- report ---------------- */

const MAX_CELL = 70

/** Full text of the cells the table had to cut. */
function printDetails(): void {
  const long = rows.filter((row) => row.actual.length > MAX_CELL)
  if (long.length === 0) return
  console.log('\nDetails')
  for (const row of long) console.log(`- [${row.scenario}] ${row.check}: ${row.actual}`)
}

function printTable(): void {
  const headers: Row = {
    scenario: 'scenario',
    check: 'check',
    expected: 'expected',
    actual: 'actual',
    status: 'pass',
  }
  const columns: Array<keyof Row> = ['scenario', 'check', 'expected', 'actual', 'status']
  const limit = (text: string) =>
    text.length > MAX_CELL ? `${text.slice(0, MAX_CELL - 3)}...` : text
  const widths = columns.map((column) =>
    Math.max(column.length, ...rows.map((row) => limit(String(row[column])).length)),
  )
  const line = (values: string[]) =>
    values.map((value, index) => limit(value).padEnd(widths[index] ?? 0)).join(' | ')
  console.log(
    line(columns.map((column) => (column === 'status' ? 'result' : String(headers[column])))),
  )
  console.log(widths.map((width) => '-'.repeat(width)).join('-|-'))
  for (const row of rows) {
    console.log(
      line(
        columns.map((column) =>
          column === 'status' ? row.status.toUpperCase() : String(row[column]),
        ),
      ),
    )
  }
  printDetails()
  const failed = rows.filter((row) => row.status === 'fail').length
  const passed = rows.filter((row) => row.status === 'pass').length
  console.log(`\n${passed} passed, ${failed} failed, ${rows.length - passed - failed} observations`)
}

async function main(): Promise<void> {
  let server: ViteDevServer | undefined
  let browser: Browser | undefined
  const stop = async () => {
    await browser?.close().catch(() => undefined)
    await server?.close().catch(() => undefined)
  }
  process.once('SIGINT', () => {
    void stop().then(() => process.exit(130))
  })
  const started = Date.now()
  try {
    if (!EXTERNAL_URL) server = await startServer()
    console.log(`Checking ${BASE_URL}${ROUTE}`)
    browser = await chromium.launch()
    for (const mode of ['viewbox', 'css'] as const) {
      for (const zoom of [50, 100, 200] as const) await desktopScenario(browser, mode, zoom)
    }
    for (const mode of ['viewbox', 'css'] as const) {
      await touchScenario(browser, mode)
    }
    for (const probe of ['svg-default', 'svg-guarded'] as const) {
      await svgProbeScenario(browser, probe)
    }
  } catch (error) {
    record(
      'setup',
      'server and browser start',
      'ok',
      error instanceof Error ? error.message : String(error),
      false,
    )
  } finally {
    await stop()
  }
  printTable()
  console.log(`Took ${((Date.now() - started) / 1000).toFixed(1)} s`)
  process.exit(rows.some((row) => row.status === 'fail') ? 1 : 0)
}

await main()
