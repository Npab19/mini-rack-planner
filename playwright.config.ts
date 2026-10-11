import {
  defineConfig,
  devices,
  type PlaywrightTestOptions,
  type PlaywrightWorkerOptions,
  type Project,
} from '@playwright/test'
import { BASE_URL, LAN_HOST, lanBaseUrl } from './e2e/env.ts'
import type { TestOptions } from './e2e/fixtures.ts'

/**
 * E2E runs against a production build that is already being served (no webServer here):
 * the nginx container in CI, or `vite preview` locally. See e2e/env.ts for BASE_URL.
 *
 * Projects:
 *  - prod-secure: desktop Chromium on BASE_URL (localhost, a secure context)
 *  - prod-lan: the same server reached as http://lan.test:<port>, which is not a secure context
 *  - mobile: Chromium with an iPhone-sized touch viewport, runs *.mobile.spec.ts only
 *  - firefox / webkit: only with ALL_BROWSERS=1 (nightly)
 *  - spikes: e2e/spikes/** only with E2E_SPIKES=1; default runs never pick them up
 */
const MOBILE_SPECS = /\.mobile\.spec\.ts$/
const SPIKES = '**/spikes/**'
const desktopIgnore = [MOBILE_SPECS, SPIKES]

const projects: Project<TestOptions & PlaywrightTestOptions, PlaywrightWorkerOptions>[] = [
  {
    name: 'prod-secure',
    testIgnore: desktopIgnore,
    use: { ...devices['Desktop Chrome'] },
  },
  {
    name: 'prod-lan',
    testIgnore: desktopIgnore,
    use: {
      ...devices['Desktop Chrome'],
      baseURL: lanBaseUrl(BASE_URL),
      launchOptions: { args: [`--host-resolver-rules=MAP ${LAN_HOST} 127.0.0.1`] },
    },
  },
  {
    name: 'mobile',
    testMatch: MOBILE_SPECS,
    testIgnore: SPIKES,
    use: { ...devices['iPhone 15'], browserName: 'chromium' },
  },
]

if (process.env.ALL_BROWSERS === '1') {
  projects.push(
    { name: 'firefox', testIgnore: desktopIgnore, use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', testIgnore: desktopIgnore, use: { ...devices['Desktop Safari'] } },
  )
}

if (process.env.E2E_SPIKES === '1') {
  projects.push({ name: 'spikes', testDir: './e2e/spikes', use: { ...devices['Desktop Chrome'] } })
}

export default defineConfig<TestOptions>({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ...(process.env.CI ? [['github'] as const] : []),
    ['list'],
    ['html', { open: 'never' }],
  ],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects,
})
