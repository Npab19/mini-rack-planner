import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { describeError, redact, truncate } from './sanitize'

const ORIGIN = 'http://192.168.1.20:8080'

describe('truncate', () => {
  it('keeps short text and cuts long text to exactly the limit, marked with an ellipsis', () => {
    expect(truncate('short', 10)).toBe('short')
    const cut = truncate('x'.repeat(600), 500)
    expect(cut).toHaveLength(500)
    expect(cut.endsWith('…')).toBe(true)
  })

  it('never splits a surrogate pair', () => {
    const cut = truncate(`ab${'😀'.repeat(10)}`, 4)
    expect(cut.length).toBeLessThanOrEqual(4)
    expect(() => encodeURIComponent(cut)).not.toThrow()
  })
})

describe('redact', () => {
  it('turns URLs on the app origin into paths and drops queries and fragments', () => {
    const stack = `at render (${ORIGIN}/assets/index-BRxk3abc.js:12:345)`
    expect(redact(stack, ORIGIN)).toBe('at render (/assets/index-BRxk3abc.js:12:345)')
    expect(redact(`${ORIGIN}/view#p=1.eJyrVkrLz8lJ`, ORIGIN)).toBe('/view')
    expect(redact('see https://example.com/a?token=secret#x for more')).toBe(
      'see https://example.com/a for more',
    )
    // The dev server's ?t= query sits before the line and column.
    expect(redact(`${ORIGIN}/src/App.tsx?t=1700000000:4:7`, ORIGIN)).toBe('/src/App.tsx:4:7')
  })

  it('removes share link payloads, blob, data and file URLs', () => {
    expect(redact('Invalid link p=1.eJyrVkrLz8lJLVKyUlAqzy_KSVGqBQBV0wdq')).toBe(
      'Invalid link p=<share link>',
    )
    expect(redact('img blob:http://h/5f0c3c1e-0f6a-4b8e-9c55-1a2b3c4d5e6f failed')).toBe(
      'img blob:… failed',
    )
    expect(redact('data:application/json;base64,eyJuYW1lIjoiTXkgcmFjayJ9')).toBe('data:…')
    expect(redact('file:///C:/Users/me/Downloads/rack.3mf')).toBe('file:…')
  })

  it('removes quoted text: names, notes and JSON snippets', () => {
    expect(redact('Cannot import "My secret rack": too new')).toBe('Cannot import "…": too new')
    expect(redact("Cannot read properties of undefined (reading 'foo')")).toBe(
      "Cannot read properties of undefined (reading '…')",
    )
    expect(redact("Can't open 'Nick's rack' now")).toBe("Can't open '…' now")
    expect(redact('Note “buy screws” and ‘spare’ and «x» and `code`')).toBe(
      'Note “…” and ‘…’ and «…» and `…`',
    )
    // V8's JSON.parse error quotes a snippet cut mid-string.
    const parse = `Unexpected token 'o', "{"name":"Bob's homelab","notes":"secr"... is not valid JSON`
    const redacted = redact(parse)
    expect(redacted).not.toMatch(/Bob|homelab|secr/)
    // Escaped JSON inside quotes.
    expect(redact('bad input "{\\"name\\":\\"Garage\\"}" here')).toBe('bad input "…" here')
  })

  it('keeps apostrophes in plain words', () => {
    expect(redact("This plan can't be opened because it's newer")).toBe(
      "This plan can't be opened because it's newer",
    )
  })

  it('removes the names of data files but keeps code files for stack frames', () => {
    expect(redact('Could not read my-rack_v2.3mf or backup.json')).toBe(
      'Could not read <file>.3mf or <file>.json',
    )
    expect(redact('at f (/assets/PlansPage-abc.js:1:2)')).toBe(
      'at f (/assets/PlansPage-abc.js:1:2)',
    )
  })

  it('removes user names from absolute paths and long encoded blobs', () => {
    expect(redact('at x (C:\\Users\\npab1\\repo\\src\\a.ts:1:1)')).toBe(
      'at x (C:\\Users\\…\\repo\\src\\a.ts:1:1)',
    )
    expect(redact(`/@fs/C:/Users/npab1/OneDrive/x.js`, ORIGIN)).toBe(
      '/@fs/C:/Users/…/OneDrive/x.js',
    )
    expect(redact('at y (/home/runner/work/x.js:2:3)')).toBe('at y (/home/…/work/x.js:2:3)')
    const sha = 'a3f1c9e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a4c6e8b0d2f4a6'
    expect(redact(`hash ${sha} not linked`)).toBe('hash <data> not linked')
    // Hashed asset names and plan ids are short enough to stay.
    expect(redact('plan-4k2m9x0c7b1d in index-BRxk3abc.js')).toBe(
      'plan-4k2m9x0c7b1d in index-BRxk3abc.js',
    )
  })

  it('is idempotent', () => {
    const text = `Failed "x" at ${ORIGIN}/a.js?q=1 reading 'y' from z.stl p=1.abc`
    const once = redact(text, ORIGIN)
    expect(redact(once, ORIGIN)).toBe(once)
  })
})

describe('describeError', () => {
  it('describes errors by name and message, with the stack minus its headline', () => {
    const error = new TypeError('boom')
    error.stack = 'TypeError: boom\n    at a (x.js:1:1)\n    at b (x.js:2:2)'
    expect(describeError(error)).toEqual({
      message: 'TypeError: boom',
      stack: 'at a (x.js:1:1)\nat b (x.js:2:2)',
    })
  })

  it('adds the cause', () => {
    const error = new Error('Saving failed', {
      cause: new DOMException('Quota', 'QuotaExceededError'),
    })
    expect(describeError(error).message).toBe(
      'Error: Saving failed [cause: QuotaExceededError: Quota]',
    )
  })

  it('summarizes zod issues by code and schema path, never by value or record key', () => {
    const schema = z.object({ name: z.string(), sections: z.record(z.string(), z.number()) })
    const result = schema.safeParse({ name: 42, sections: { 'custom:my-garage-shelf': 'x' } })
    expect(result.success).toBe(false)
    const { message } = describeError(result.error)
    expect(message).toMatch(
      /^ZodError: 2 issues: invalid_type at name; invalid_type at sections\.…/,
    )
    expect(message).not.toContain('garage')
  })

  it('never serializes non-error values', () => {
    const plan = { name: 'My secret rack', notes: 'hidden' }
    expect(describeError(plan).message).toBe('Non-error object (Object)')
    expect(describeError(undefined).message).toBe('Non-error value: undefined')
    expect(describeError(42).message).toBe('Non-error number: 42')
    expect(describeError('plain text').message).toBe('plain text')
  })

  it('describes rejected DOM events with their target error', () => {
    const event = {
      type: 'error',
      target: { error: new DOMException('Full', 'QuotaExceededError') },
    }
    expect(describeError(event).message).toBe('Object (type: error): QuotaExceededError: Full')
  })

  it('survives hostile values', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('nope')
        },
        getPrototypeOf() {
          throw new Error('nope')
        },
      },
    )
    expect(describeError(hostile).message).toBe('Unreadable error value')
  })
})
