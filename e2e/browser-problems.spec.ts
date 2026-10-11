import { expect, test } from './fixtures.ts'

/** The slice of the DOM this test touches (e2e is type-checked without the DOM lib). */
type ScriptDocument = {
  createElement: (tag: 'script') => { textContent: string }
  head: { append: (node: unknown) => void }
}

// Self-test of the automatic fixture: if CSP violations stopped being reported, every other spec
// would pass silently while the policy breaks.
test.use({ allowedConsoleErrors: [/Content Security Policy/] })

test('a CSP violation is reported, even after the page navigates away', async ({
  page,
  browserProblems,
}) => {
  test.skip(test.info().project.name !== 'prod-secure', 'checked once, in prod-secure')
  await page.goto('/')
  await page.evaluate(() => {
    const { document } = globalThis as unknown as { document: ScriptDocument }
    const script = document.createElement('script')
    script.textContent = 'void 0'
    document.head.append(script)
  })
  await page.goto('/about')

  await expect
    .poll(() => browserProblems.cspViolations)
    .toEqual([expect.stringMatching(/^script-src(-elem)? blocked inline/)])
  // This violation was provoked on purpose; clear it so the fixture's final check passes.
  browserProblems.cspViolations.length = 0
})
