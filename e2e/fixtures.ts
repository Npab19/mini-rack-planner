import { test as base, expect, type Page } from '@playwright/test'

/**
 * Every E2E test fails on browser console errors, uncaught page errors and Content-Security-Policy
 * violations, so the strict production CSP is exercised on every page the suite visits.
 *
 * CSP violations are pushed into `window.__cspViolations` by an init script and also reported to
 * the test through a binding, so violations from before a navigation or reload are not lost.
 * Violations inside workers fire on the worker scope, not the page; Chromium still logs them as
 * console errors.
 */
export type BrowserProblems = {
  consoleErrors: string[]
  pageErrors: string[]
  cspViolations: string[]
}

export type TestOptions = {
  /** Console errors matching one of these are tolerated (set per project or with `test.use`). */
  allowedConsoleErrors: RegExp[]
}

type Fixtures = TestOptions & {
  /** Collected automatically for every test and checked when the test ends. */
  browserProblems: BrowserProblems
}

/** Browser globals used by the init script (e2e is type-checked without the DOM lib). */
type CspViolationEvent = {
  effectiveDirective: string
  blockedURI: string
  sourceFile: string
  lineNumber: number
}
type PageScope = {
  __cspViolations?: string[]
  /** Installed by page.exposeBinding below; the names must match. */
  __reportCspViolation?: (text: string) => Promise<void>
  addEventListener: (
    type: 'securitypolicyviolation',
    listener: (event: CspViolationEvent) => void,
    capture: boolean,
  ) => void
}

/** Runs in the page before its own scripts. Playwright serializes it: keep it self-contained. */
function listenForCspViolations(): void {
  const scope = globalThis as unknown as PageScope
  const violations: string[] = []
  scope.__cspViolations = violations
  scope.addEventListener(
    'securitypolicyviolation',
    (event) => {
      const blocked = event.blockedURI || 'inline code'
      const where = `${event.sourceFile || 'page'}:${event.lineNumber}`
      const text = `${event.effectiveDirective} blocked ${blocked} (${where})`
      violations.push(text)
      // The page may be navigating away; a lost report is still in __cspViolations.
      scope.__reportCspViolation?.(text).catch(() => undefined)
    },
    true,
  )
}

async function violationsInCurrentPage(page: Page): Promise<string[]> {
  try {
    return await page.evaluate(() => (globalThis as unknown as PageScope).__cspViolations ?? [])
  } catch {
    return [] // page closed or crashed: the binding has already reported what it saw
  }
}

export const test = base.extend<Fixtures>({
  allowedConsoleErrors: [[], { option: true }],
  browserProblems: [
    async ({ page, allowedConsoleErrors }, use) => {
      const problems: BrowserProblems = { consoleErrors: [], pageErrors: [], cspViolations: [] }
      page.on('console', (message) => {
        if (message.type() !== 'error') return
        const text = `${message.text()} (${message.location().url || 'page'})`
        if (!allowedConsoleErrors.some((pattern) => pattern.test(text))) {
          problems.consoleErrors.push(text)
        }
      })
      page.on('pageerror', (error) => problems.pageErrors.push(`${error.name}: ${error.message}`))
      await page.exposeBinding('__reportCspViolation', (_source, text: unknown) => {
        problems.cspViolations.push(String(text))
      })
      await page.addInitScript(listenForCspViolations)

      await use(problems)

      const late = await violationsInCurrentPage(page)
      problems.cspViolations = [...new Set([...problems.cspViolations, ...late])]
      expect(problems, 'console errors, uncaught page errors or CSP violations').toEqual({
        consoleErrors: [],
        pageErrors: [],
        cspViolations: [],
      })
    },
    { auto: true },
  ],
})

export { expect }
