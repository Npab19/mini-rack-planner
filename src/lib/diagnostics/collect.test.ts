import { afterEach, describe, expect, it, vi } from 'vitest'
import { PLAN_SCHEMA_VERSION } from '@/domain/schema/plan'
import { collectReport, collectReportInput, setReportContext } from './collect'

afterEach(() => {
  vi.useRealTimers()
})

describe('collectReportInput', () => {
  it('reads versions, the plan schema, the browser and storage', async () => {
    const input = await collectReportInput({
      entries: [],
      secureContext: true,
      now: new Date('2026-10-11T12:00:00.000Z'),
      navigator: {
        userAgent: 'TestBrowser/1.0',
        storage: {
          persisted: () => Promise.resolve(true),
          estimate: () => Promise.resolve({ usage: 2048, quota: 1_000_000 }),
        },
      },
    })
    expect(input).toMatchObject({
      appVersion: __APP_VERSION__,
      gitSha: __GIT_SHA__,
      planSchema: PLAN_SCHEMA_VERSION,
      userAgent: 'TestBrowser/1.0',
      secureContext: true,
      storage: { persisted: true, usage: 2048, quota: 1_000_000 },
      generatedAt: '2026-10-11T12:00:00.000Z',
    })
  })

  it('works without navigator.storage, as on plain-HTTP LAN origins', async () => {
    const input = await collectReportInput({ entries: [], secureContext: false, navigator: {} })
    expect(input.storage).toBeUndefined()
    expect(input.userAgent).toBe('unknown')
  })

  it('does not wait for storage calls that throw or hang', async () => {
    vi.useFakeTimers()
    const pending = collectReportInput({
      entries: [],
      navigator: {
        storage: {
          persisted: () => {
            throw new Error('SecurityError')
          },
          estimate: () => new Promise(() => undefined),
        },
      },
    })
    await vi.advanceTimersByTimeAsync(2000)
    const input = await pending
    expect(input.storage).toEqual({})
  })

  it('includes the context other modules set', async () => {
    setReportContext({ catalogRevision: '0f7e404379b55f' })
    const report = await collectReport({ entries: [], navigator: {} })
    expect(report).toContain('Catalog revision: 0f7e404379b55f')
    expect(report).toContain(`Plan schema: ${PLAN_SCHEMA_VERSION}`)
  })
})
