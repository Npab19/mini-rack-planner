import { readFileSync } from 'node:fs'
import { AxeBuilder } from '@axe-core/playwright'
import type { APIResponse } from '@playwright/test'
import { CSP } from '../scripts/headers.ts'
import { AXE_LOOKS, showLook } from './editorHelpers.ts'
import { BASE_URL, SERVED_BY_VITE_PREVIEW, isSecureOrigin } from './env.ts'
import { expect, test } from './fixtures.ts'

/** Marker of the SPA shell (index.html), used to prove a response is not the HTML fallback. */
const SPA_SHELL = '<div id="root">'

function packageVersion(): string {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  )
  if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
    const { version } = parsed
    if (typeof version === 'string') return version
  }
  throw new Error('package.json has no version')
}

function expectSecurityHeaders(response: APIResponse): void {
  const headers = response.headers()
  expect(headers['content-security-policy'], `CSP on ${response.url()}`).toBe(CSP)
  expect(headers['x-content-type-options'], `nosniff on ${response.url()}`).toBe('nosniff')
}

test.describe('app shell', () => {
  test('home page renders the plans list', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Your racks' })).toBeVisible()
  })

  test('a deep link renders the editor, also after a reload (SPA fallback)', async ({ page }) => {
    const response = await page.goto('/plan/test')
    expect(response?.status()).toBe(200)
    const editorHeading = page.getByRole('heading', { level: 1, name: 'Rack editor' })
    await expect(editorHeading).toBeVisible()
    await page.reload()
    await expect(editorHeading).toBeVisible()
  })

  test('about page shows the version', async ({ page }) => {
    await page.goto('/about')
    const versionLine = page.getByText(`Version ${packageVersion()}`)
    await expect(versionLine).toBeVisible()
    // CI passes the commit to both the image build and this run; the page shows its first 12 chars.
    const sha = process.env.GIT_SHA
    if (sha) await expect(versionLine).toContainText(`(${sha.slice(0, 12)})`)
  })

  test('secure context follows the origin, and the app renders either way', async ({
    page,
  }, testInfo) => {
    await page.goto('/')
    const secure = await page.evaluate(
      () => (globalThis as unknown as { isSecureContext: boolean }).isSecureContext,
    )
    // prod-lan reaches the server as http://lan.test, like plain-HTTP Docker on a LAN.
    expect(secure).toBe(testInfo.project.name === 'prod-lan' ? false : isSecureOrigin(BASE_URL))
    await expect(page.getByRole('heading', { level: 1, name: 'Your racks' })).toBeVisible()
  })

  for (const look of AXE_LOOKS) {
    test(`home page has no serious or critical axe violations (${look.name})`, async ({ page }) => {
      await showLook(page, look)
      await page.goto('/')
      await expect(page.getByRole('heading', { level: 1, name: 'Your racks' })).toBeVisible()
      const { violations } = await new AxeBuilder({ page }).analyze()
      const blocking = violations
        .filter(({ impact }) => impact === 'serious' || impact === 'critical')
        .map(({ id, impact, help, nodes }) => `${impact} ${id}: ${help} (${nodes.length} nodes)`)
      expect(blocking).toEqual([])
    })
  }
})

// Transport-level checks. Node's request client cannot resolve lan.test and the headers do not
// depend on the browser, so they run once, in prod-secure.
test.describe('response headers', () => {
  test.beforeEach(() => {
    test.skip(
      test.info().project.name !== 'prod-secure',
      'headers are checked once, in prod-secure',
    )
  })

  test('the shell, a deep link and a hashed asset carry the security headers', async ({
    request,
  }) => {
    const home = await request.get('/')
    expect(home.status()).toBe(200)
    expectSecurityHeaders(home)
    const html = await home.text()

    const deepLink = await request.get('/plan/x')
    expect(deepLink.status()).toBe(200)
    expect(await deepLink.text()).toContain(SPA_SHELL)
    expectSecurityHeaders(deepLink)

    const entryScript = /<script[^>]+src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1]
    expect(entryScript, 'index.html references an /assets/*.js entry script').toBeDefined()
    const asset = await request.get(entryScript ?? '/assets/missing-entry.js')
    expect(asset.status()).toBe(200)
    expect(asset.headers()['content-type']).toMatch(/javascript/)
    expectSecurityHeaders(asset)

    if (!SERVED_BY_VITE_PREVIEW) {
      expect(home.headers()['cache-control']).toBe('no-cache')
      expect(asset.headers()['cache-control']).toContain('immutable')
    }
  })

  test('a missing hashed asset is a 404, not the SPA shell', async ({ request }) => {
    test.skip(SERVED_BY_VITE_PREVIEW, 'vite preview serves index.html for unknown paths')
    const missing = await request.get('/assets/does-not-exist.js')
    expect(missing.status()).toBe(404)
    expect(missing.headers()['content-type'] ?? '').not.toContain('text/html')
    expect(await missing.text()).not.toContain(SPA_SHELL)
    expect(missing.headers()['cache-control'] ?? '').not.toContain('immutable')
    expectSecurityHeaders(missing)
  })

  test('the container health check answers', async ({ request }) => {
    test.skip(SERVED_BY_VITE_PREVIEW, '/healthz is served by nginx only')
    const health = await request.get('/healthz')
    expect(health.status()).toBe(200)
    expect((await health.text()).trim()).toBe('ok')
  })
})
