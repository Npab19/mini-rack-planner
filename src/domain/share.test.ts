import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { SAMPLE_TIME, sampleCatalog, samplePlan } from './__fixtures__/samplePlan'
import { decodeBase64Url, encodeBase64Url } from './base64url'
import { ID_PREFIX } from './ids'
import { PlanLoadError } from './migrate'
import { IdSchema } from './schema/common'
import { PlanSchema, type Plan, type Snapshot } from './schema/plan'
import {
  decodeShare,
  encodeShare,
  MAX_SHARE_JSON_BYTES,
  SHARE_TARGET_LENGTH,
  ShareLinkError,
  shareUrl,
  type ShareErrorReason,
} from './share'

const NOW = new Date('2026-11-01T08:00:00.000Z')

// ---------------------------------------------------------------------------------------------
// Helpers

async function transform(
  bytes: Uint8Array<ArrayBuffer>,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array<ArrayBuffer>> {
  const output = new Blob([bytes]).stream().pipeThrough(stream)
  return new Uint8Array(await new Response(output).arrayBuffer())
}

/** A v1 link carrying any payload, compressed like the real encoder (for forged inputs). */
async function linkOf(payload: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload
  return `p=1.${encodeBase64Url(await transform(bytes, new CompressionStream('deflate-raw')))}`
}

/** The compact JSON inside a link. */
async function payloadOf(link: string): Promise<string> {
  const bytes = decodeBase64Url(link.slice('p=1.'.length))
  return new TextDecoder().decode(await transform(bytes, new DecompressionStream('deflate-raw')))
}

/** Every key of the compact JSON, except inside the custom entries (`u`), which are verbatim. */
function compactKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(compactKeys)
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, inner]) =>
    key === 'u' ? [key] : [key, ...compactKeys(inner)],
  )
}

async function failure(text: string): Promise<ShareLinkError> {
  try {
    await decodeShare(text)
  } catch (error) {
    if (error instanceof ShareLinkError) return error
    throw error
  }
  throw new Error(`expected "${text.slice(0, 40)}" to be rejected`)
}

function snap(snapshot: Snapshot | undefined): Snapshot | undefined {
  return snapshot === undefined ? undefined : { ...snapshot, at: 'any time' }
}

/** A plan without ids, timestamps and revisions: what a link has to preserve. */
function comparable(plan: Plan): unknown {
  const { top, bottom } = plan.frame.caps
  return {
    schema: plan.schema,
    name: plan.name,
    notes: plan.notes,
    frame: {
      frameId: plan.frame.frameId,
      options: plan.frame.options,
      caps: {
        top: { ...top, have: snap(top.have) },
        bottom: { ...bottom, have: snap(bottom.have) },
      },
      sections: plan.frame.sections.map(({ id: _id, ...section }) => ({
        ...section,
        have: snap(section.have),
      })),
    },
    placements: plan.placements.map(({ id: _id, devices, ...placement }) => ({
      ...placement,
      have: snap(placement.have),
      devices: devices.map(({ id: _deviceId, ...device }) => device),
    })),
    equipment: plan.equipment.map(({ id: _id, ...equipment }) => equipment),
    extras: plan.extras.map(({ id: _id, ...extra }) => extra),
    // Source ids of removed sections/placements point at nothing once ids are regenerated.
    retired: plan.retired.map(({ id: _id, sourceId, ...entry }) => ({
      ...entry,
      snapshot: snap(entry.snapshot),
      sourceId: sourceId === 'top' || sourceId === 'bottom' ? sourceId : undefined,
    })),
    custom: plan.custom,
  }
}

/** What a template link must carry: the plan with every kind of ownership and the notes removed. */
function templateOf(plan: Plan): Plan {
  const { top, bottom } = plan.frame.caps
  return {
    ...plan,
    notes: undefined,
    frame: {
      ...plan.frame,
      caps: { top: { ...top, have: undefined }, bottom: { ...bottom, have: undefined } },
      sections: plan.frame.sections.map((section) => ({ ...section, have: undefined })),
    },
    placements: plan.placements.map((placement) => ({
      ...placement,
      have: undefined,
      devices: placement.devices.map((device) => ({ ...device, have: false })),
    })),
    equipment: plan.equipment.map((equipment) => ({ ...equipment, have: false, note: undefined })),
    extras: plan.extras.map((extra) => ({ ...extra, haveQty: 0 })),
    retired: [],
  }
}

function allIds(plan: Plan): string[] {
  return [
    plan.id,
    plan.rackId,
    ...plan.frame.sections.map((section) => section.id),
    ...plan.placements.flatMap((placement) => [
      placement.id,
      ...placement.devices.map((device) => device.id),
    ]),
    ...plan.equipment.map((equipment) => equipment.id),
    ...plan.extras.map((extra) => extra.id),
    ...plan.retired.map((entry) => entry.id),
  ]
}

// ---------------------------------------------------------------------------------------------

describe('encodeShare / decodeShare with the 12U sample', () => {
  it('round-trips a show-off link (ids and timestamps aside)', async () => {
    const plan = samplePlan()
    const link = await encodeShare(plan, 'showoff')
    const decoded = await decodeShare(link, { catalog: sampleCatalog(), now: NOW })
    expect(decoded.mode).toBe('showoff')
    expect(decoded.warnings).toEqual([])
    expect(comparable(decoded.plan)).toEqual(comparable(plan))
    expect(decoded.plan.notes).toBe(plan.notes)
    expect(decoded.plan.frame.sections.map((section) => section.have?.heightU)).toEqual([
      3,
      6,
      undefined,
    ])
  })

  it('round-trips a template link with everything reset to Need', async () => {
    const plan = samplePlan()
    const decoded = await decodeShare(await encodeShare(plan, 'template'), { now: NOW })
    expect(decoded.mode).toBe('template')
    expect(comparable(decoded.plan)).toEqual(comparable(templateOf(plan)))
  })

  it('strips every kind of ownership and the notes from template links', async () => {
    const link = await encodeShare(samplePlan(), 'template')
    const { plan } = await decodeShare(link)
    const { caps, sections } = plan.frame
    expect([caps.top.have, caps.bottom.have, ...sections.map((section) => section.have)]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ])
    expect(plan.placements.every((placement) => placement.have === undefined)).toBe(true)
    expect(plan.placements.flatMap((placement) => placement.devices.map((d) => d.have))).toEqual([
      false,
      false,
      false,
      false,
      false,
    ])
    expect(plan.equipment).toEqual([
      expect.objectContaining({ deviceId: 'mac-mini-m4', have: false }),
      expect.objectContaining({ deviceId: 'raspberry-pi-5', have: false }),
    ])
    expect(plan.equipment.some((equipment) => equipment.note !== undefined)).toBe(false)
    expect(plan.extras).toEqual([expect.objectContaining({ qty: 4, haveQty: 0 })])
    expect(plan.retired).toEqual([])
    expect(plan.notes).toBeUndefined()
    // Not even inside the link: no Have keys (h), no show-off flag (m), no retired (r), no notes.
    const json = await payloadOf(link)
    const compact: unknown = JSON.parse(json)
    expect(compactKeys(compact)).not.toContain('h')
    expect(compact).not.toHaveProperty('m')
    expect(compact).not.toHaveProperty('r')
    for (const text of ['Built 3U', 'Maybe later', 'kws-blank-1u']) {
      expect(json).not.toContain(text)
    }
  })

  it('keeps what a template still needs: options, labels, names and custom parts', async () => {
    const plan = samplePlan()
    const { plan: decoded } = await decodeShare(await encodeShare(plan, 'template'))
    expect(decoded.name).toBe('KWS 9U → 12U')
    expect(decoded.frame.options).toEqual({ magnets: true })
    expect(decoded.frame.caps.top.options).toEqual({ top: 'handle' })
    expect(decoded.placements.map((placement) => placement.label)).toEqual(
      plan.placements.map((placement) => placement.label),
    )
    expect(decoded.placements[3]?.devices[1]).toMatchObject({
      deviceId: 'ubiquiti-usw-flex-mini',
      slotId: 'deck',
      xMm: 100,
    })
    expect(decoded.custom.devices).toEqual(plan.custom.devices)
  })

  it('regenerates ids and timestamps', async () => {
    const plan = samplePlan()
    const { plan: decoded } = await decodeShare(await encodeShare(plan, 'showoff'), { now: NOW })
    const ids = allIds(decoded)
    expect(ids.every((id) => IdSchema.safeParse(id).success)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
    const original = new Set(allIds(plan))
    expect(ids.some((id) => original.has(id))).toBe(false)
    expect(decoded.createdAt).toBe(NOW.toISOString())
    expect(decoded.updatedAt).toBe(NOW.toISOString())
    expect(decoded.frame.sections[0]?.have?.at).toBe(NOW.toISOString())
    expect(decoded.rev).toBe(0)
    expect(decoded.catalogRev).toBeUndefined()
  })

  it('gives new ids the same prefixes as the editor', async () => {
    const { plan: decoded } = await decodeShare(await encodeShare(samplePlan(), 'showoff'))
    const prefixOf = (id: string) => id.slice(0, id.lastIndexOf('-'))
    expect(prefixOf(decoded.id)).toBe(ID_PREFIX.plan)
    expect(prefixOf(decoded.rackId)).toBe(ID_PREFIX.rack)
    expect(decoded.frame.sections.map((section) => prefixOf(section.id))).toContain(
      ID_PREFIX.section,
    )
    const devices = decoded.placements.flatMap((placement) => placement.devices)
    expect(new Set(devices.map((device) => prefixOf(device.id)))).toEqual(
      new Set([ID_PREFIX.placedDevice]),
    )
    expect(new Set(decoded.retired.map((entry) => prefixOf(entry.id)))).toEqual(
      new Set([ID_PREFIX.retired]),
    )
  })

  it('leaves ids, timestamps, revisions and defaults out of the link', async () => {
    const json = await payloadOf(await encodeShare(samplePlan(), 'showoff'))
    for (const text of [
      'plan-kws-sample',
      'rack-kws-sample',
      'sec-bottom-3u',
      'pl-power',
      'dev-tiny-1',
      'eq-mac',
      'ex-feet',
      'ret-blank',
      'pl-old-blank',
      SAMPLE_TIME,
      'fixture-1',
      '"front"',
      '"full"',
    ]) {
      expect(json).not.toContain(text)
    }
  })

  it('stays under 2,000 characters in both modes', async () => {
    for (const mode of ['template', 'showoff'] as const) {
      const link = await encodeShare(samplePlan(), mode)
      expect(link).toMatch(/^p=1\.[A-Za-z0-9_-]+$/)
      expect(link.length).toBeLessThan(SHARE_TARGET_LENGTH)
    }
  })

  it('encodes the same plan to the same link', async () => {
    expect(await encodeShare(samplePlan(), 'showoff')).toBe(
      await encodeShare(samplePlan(), 'showoff'),
    )
  })

  it('opens a whole URL, a hash, or a fragment wrapped across lines', async () => {
    const link = await encodeShare(samplePlan(), 'template')
    const url = shareUrl('https://rack.example/', link)
    expect(url).toBe(`https://rack.example/view#${link}`)
    const wrapped = link.replace(/(.{60})/g, '$1\n  ')
    for (const text of [url, `#${link}`, ` ${wrapped}\n`]) {
      expect((await decodeShare(text)).plan.name).toBe('KWS 9U → 12U')
    }
  })

  it('keeps unknown catalog ids and warns about each one once', async () => {
    const plan = samplePlan()
    const [first, second] = plan.placements
    if (first === undefined || second === undefined) throw new Error('sample has placements')
    first.itemId = 'mystery-shelf'
    second.itemId = 'mystery-shelf'
    plan.equipment.push({ id: 'eq-x', deviceId: 'mystery-box', have: false })
    const link = await encodeShare(plan, 'showoff')

    const { plan: decoded, warnings } = await decodeShare(link, { catalog: sampleCatalog() })
    expect(decoded.placements.map((placement) => placement.itemId).slice(0, 2)).toEqual([
      'mystery-shelf',
      'mystery-shelf',
    ])
    expect(warnings).toEqual([
      'Unknown part "mystery-shelf": kept as a labelled placeholder.',
      'Unknown device "mystery-box": kept as a labelled placeholder.',
    ])
    expect((await decodeShare(link)).warnings).toEqual([])
  })
})

describe('decodeShare rejects bad links with typed errors', () => {
  it.each<[string, string, ShareErrorReason]>([
    ['empty text', '', 'malformed'],
    ['another app', 'https://example.com/#section-2', 'malformed'],
    ['no version', 'p=Zm9v', 'malformed'],
    ['version 0', 'p=0.Zm9v', 'malformed'],
    ['a newer link format', 'p=2.Zm9v', 'unsupported-version'],
    ['characters outside base64url', 'p=1.Zm9v+w', 'malformed'],
    ['an impossible length', 'p=1.Zm9vY', 'malformed'],
    ['non-canonical base64url', 'p=1.Zh', 'malformed'],
    ['an empty payload', 'p=1.', 'corrupt'],
    ['an invalid deflate block', `p=1.${encodeBase64Url(new Uint8Array([0xff, 0xff]))}`, 'corrupt'],
    ['an oversized payload', `p=1.${'A'.repeat(400_000)}`, 'too-large'],
    ['oversized text', 'x'.repeat(1_000_000), 'too-large'],
  ])('%s', async (_case, text, reason) => {
    const error = await failure(text)
    expect(error.reason).toBe(reason)
    expect(error).toBeInstanceOf(PlanLoadError)
    expect(error.name).toBe('ShareLinkError')
  })

  it('rejects truncated links and trailing junk as corrupt', async () => {
    const link = await encodeShare(samplePlan(), 'template')
    // Cut on a 4-character boundary so the base64url part stays well-formed.
    const payloadLength = link.length - 'p=1.'.length
    const truncated = link.slice(0, 'p=1.'.length + Math.floor(payloadLength / 8) * 4)
    expect((await failure(truncated)).reason).toBe('corrupt')
    const bytes = decodeBase64Url(link.slice('p=1.'.length))
    const junk = new Uint8Array([...bytes, 1, 2, 3])
    expect((await failure(`p=1.${encodeBase64Url(junk)}`)).reason).toBe('corrupt')
  })

  it('rejects payloads that are not UTF-8 JSON as corrupt', async () => {
    expect((await failure(await linkOf(new Uint8Array([0xc3, 0x28])))).reason).toBe('corrupt')
    expect((await failure(await linkOf('{"n": "unterminated'))).reason).toBe('corrupt')
  })

  it('stops inflating at the size cap (zip bomb)', async () => {
    const bomb = await linkOf(new Uint8Array(16 * 1024 * 1024))
    expect(bomb.length).toBeLessThan(40_000)
    const error = await failure(bomb)
    expect(error.reason).toBe('too-large')
    expect(error.message).toContain(`${MAX_SHARE_JSON_BYTES / 1024} KB`)
  })

  it('rejects JSON that is not a compact plan, with issues', async () => {
    for (const json of ['null', '[1, 2]', '"plan"', '{"n": 5, "f": "kws-v2"}', '{"n": "x"}']) {
      const error = await failure(await linkOf(json))
      expect(error.reason).toBe('invalid')
      expect(error.issues.length).toBeGreaterThan(0)
    }
  })

  it('rejects plans that fail validation, with the plan paths', async () => {
    const longName = JSON.stringify({ n: 'x'.repeat(201), f: 'kws-v2' })
    expect((await failure(await linkOf(longName))).issues).toEqual([
      expect.objectContaining({ path: 'name' }),
    ])
    const badY = JSON.stringify({ n: 'x', f: 'kws-v2', p: [{ i: 'kws-shelf-2u', y: 1.5 }] })
    expect((await failure(await linkOf(badY))).issues).toEqual([
      expect.objectContaining({ path: 'placements.0.y' }),
    ])
  })
})

describe('decodeShare against forged links', () => {
  const device = {
    kind: 'device',
    brand: 'Evil',
    model: 'Box',
    category: 'other',
    dims: { w: 10, d: 10, h: 10 },
    verified: { by: 'x', date: '2026-10-11', method: 'unverified' },
  }

  it('refuses custom entries that would shadow a curated id', async () => {
    const json = JSON.stringify({
      n: 'x',
      f: 'kws-v2',
      u: { d: [{ ...device, id: 'lenovo-m920q' }] },
    })
    const error = await failure(await linkOf(json))
    expect(error.reason).toBe('invalid')
    expect(error.issues).toEqual([expect.objectContaining({ path: 'custom.devices.0.id' })])
  })

  it('refuses script URLs in custom entries', async () => {
    const source = { platform: 'other', url: 'javascript:alert(1)' }
    const json = JSON.stringify({
      n: 'x',
      f: 'kws-v2',
      u: { d: [{ ...device, id: 'custom:evil', source }] },
    })
    expect((await failure(await linkOf(json))).reason).toBe('invalid')
  })

  it('ignores ownership inside a template link', async () => {
    const snapshot = { t: 's3', u: 3, o: { magnets: true } }
    const json = JSON.stringify({
      n: 'Forged',
      t: 'secret notes',
      f: 'kws-v2',
      c: { t: { h: {} }, b: { h: {} } },
      s: [{ t: 's3', h: snapshot }],
      p: [
        {
          i: 'kws-shelf-2u',
          y: 0,
          h: { i: 'kws-shelf-2u' },
          d: [{ i: 'mac-mini-m4', s: 'deck', h: 1 }],
        },
      ],
      e: [{ i: 'mac-mini-m4', h: 1, t: 'secret note' }],
      x: [{ i: 'rubber-feet', q: 4, h: 4 }],
      r: [{ k: 'section', v: snapshot }],
    })
    const { plan, mode } = await decodeShare(await linkOf(json))
    expect(mode).toBe('template')
    expect(plan.frame.caps).toEqual({ top: {}, bottom: {} })
    expect(plan.frame.sections[0]?.have).toBeUndefined()
    expect(plan.placements[0]?.have).toBeUndefined()
    expect(plan.placements[0]?.devices[0]?.have).toBe(false)
    expect(plan.equipment[0]).toMatchObject({ have: false })
    expect(plan.equipment[0]?.note).toBeUndefined()
    expect(plan.extras[0]?.haveQty).toBe(0)
    expect(plan.retired).toEqual([])
    expect(plan.notes).toBeUndefined()
  })

  it('rejects flags with unexpected values', async () => {
    for (const json of [
      { n: 'x', f: 'kws-v2', m: 2 },
      { n: 'x', f: 'kws-v2', m: 1, e: [{ i: 'mac-mini-m4', h: true }] },
    ]) {
      expect((await failure(await linkOf(JSON.stringify(json)))).reason).toBe('invalid')
    }
  })

  it('does not let __proto__ keys pollute prototypes', async () => {
    const json = '{"n":"x","f":"kws-v2","__proto__":{"polluted":1},"o":{"__proto__":"y","a":1}}'
    const { plan } = await decodeShare(await linkOf(json))
    expect(plan.frame.options).toEqual({ a: 1 })
    expect(Object.getPrototypeOf(plan.frame.options)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------------------------
// Property: any valid plan survives both modes.

const kebab = fc.stringMatching(/^[a-z][a-z0-9]{0,5}(?:-[a-z0-9]{1,3})?$/)
const text = fc.string({ unit: 'binary', maxLength: 30 })
const optionValues = fc.dictionary(
  kebab,
  fc.oneof(fc.boolean(), fc.integer({ min: -9, max: 999 }), kebab),
  { maxKeys: 3, noNullPrototype: true },
)
const record = { noNullPrototype: true } as const
const snapshot = fc.record(
  {
    at: fc.constant(SAMPLE_TIME),
    typeId: kebab,
    heightU: fc.integer({ min: 1, max: 12 }),
    itemId: kebab,
    options: optionValues,
  },
  { ...record, requiredKeys: ['at', 'options'] },
)
const cap = fc.record({ options: optionValues, have: snapshot }, { ...record, requiredKeys: [] })
const section = fc.record(
  {
    typeId: kebab,
    heightU: fc.integer({ min: 1, max: 12 }),
    options: optionValues,
    have: snapshot,
  },
  { ...record, requiredKeys: ['typeId'] },
)
const placedDevice = fc.record(
  {
    deviceId: kebab,
    slotId: kebab,
    xMm: fc.double({ min: 0, max: 300, noNaN: true }).map((x) => x + 0),
    orientation: fc.constantFrom('flat', 'flat-rotated', 'on-side', 'upright'),
    have: fc.boolean(),
  },
  { ...record, requiredKeys: ['deviceId', 'slotId', 'have'] },
)
const placement = fc.record(
  {
    itemId: kebab,
    name: text,
    heightSixths: fc.integer({ min: 0, max: 72 }),
    y: fc.integer({ min: -12, max: 200 }),
    face: fc.constantFrom('front', 'rear'),
    bay: fc.constantFrom('full', 'left', 'right'),
    options: optionValues,
    have: snapshot,
    label: text,
    devices: fc.array(placedDevice, { maxLength: 3 }),
  },
  { ...record, requiredKeys: ['itemId', 'y', 'face', 'bay', 'devices'] },
)
const equipment = fc.record(
  { deviceId: kebab, have: fc.boolean(), note: text },
  { ...record, requiredKeys: ['deviceId', 'have'] },
)
const extra = fc.record({ itemId: kebab, qty: fc.nat(20), haveQty: fc.nat(20) }, record)
const retired = fc.record(
  {
    kind: fc.constantFrom('section', 'placement', 'extra', 'cap'),
    snapshot,
    sourceId: fc.oneof(fc.constant('top'), fc.constant('bottom'), kebab),
    devices: fc.array(kebab, { maxLength: 2 }),
    qty: fc.nat(9),
  },
  { ...record, requiredKeys: ['kind', 'snapshot'] },
)
const planArbitrary = fc
  .record(
    {
      name: text,
      notes: text,
      frameId: kebab,
      options: optionValues,
      top: cap,
      bottom: cap,
      sections: fc.array(section, { maxLength: 4 }),
      placements: fc.array(placement, { maxLength: 4 }),
      equipment: fc.array(equipment, { maxLength: 3 }),
      extras: fc.array(extra, { maxLength: 2 }),
      retired: fc.array(retired, { maxLength: 2 }),
    },
    { ...record, requiredKeys: ['name', 'frameId', 'options', 'top', 'bottom', 'sections'] },
  )
  .map(({ frameId, options, top, bottom, sections, placements, ...rest }) =>
    PlanSchema.parse({
      ...rest,
      schema: 1,
      id: 'plan-1',
      rackId: 'rack-1',
      createdAt: SAMPLE_TIME,
      updatedAt: SAMPLE_TIME,
      frame: {
        frameId,
        options,
        caps: { top, bottom },
        sections: sections.map((entry, index) => ({ ...entry, id: `sec-${index}` })),
      },
      placements: placements?.map((entry, index) => ({
        ...entry,
        id: `pl-${index}`,
        devices: entry.devices.map((device, at) => ({ ...device, id: `dev-${index}-${at}` })),
      })),
      equipment: rest.equipment?.map((entry, index) => ({ ...entry, id: `eq-${index}` })),
      extras: rest.extras?.map((entry, index) => ({ ...entry, id: `ex-${index}` })),
      retired: rest.retired?.map((entry, index) => ({ ...entry, id: `ret-${index}` })),
    }),
  )

describe('share codec properties', () => {
  test.prop([planArbitrary], { numRuns: 60 })(
    'round-trips any plan: show-off keeps it, template keeps all but ownership',
    async (plan) => {
      const showoff = await decodeShare(await encodeShare(plan, 'showoff'))
      expect(comparable(showoff.plan)).toEqual(comparable(plan))
      const template = await decodeShare(await encodeShare(plan, 'template'))
      expect(comparable(template.plan)).toEqual(comparable(templateOf(plan)))
    },
  )
})
