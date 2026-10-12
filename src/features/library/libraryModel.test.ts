import { describe, expect, it } from 'vitest'
import { crossReferenceProblems, curationReport } from '@/catalog/validate'
import {
  newCustomDevice,
  newCustomFrame,
  newCustomItem,
  type CustomItemInput,
} from '@/domain/customParts'
import {
  catalogBundle,
  CatalogEntrySchema,
  createCatalogLookup,
  HardwareSchema,
  type CatalogEntry,
} from '@/domain/schema/catalog'
import { checkEntryIntegrity } from '@/domain/schema/integrity'
import {
  catalogEntryJson,
  catalogFileName,
  catalogId,
  filterLibrary,
  groupLibrary,
  MAX_SUBMISSION_URL_LENGTH,
  partFacts,
  shareLink,
  shareReport,
  sharedCatalogEntry,
  submissionUrl,
} from './libraryModel'

const TODAY = '2026-10-11'
const NONE: ReadonlySet<string> = new Set()

const SCREW = HardwareSchema.parse({
  kind: 'hardware',
  id: 'screw-m3x8-shcs',
  name: 'M3×8 socket head cap screw',
  category: 'screw',
  spec: { thread: 'M3', lengthMm: 8 },
})
const MY_MAGNET = HardwareSchema.parse({
  kind: 'hardware',
  id: 'custom:my-magnet',
  name: 'My magnet',
  category: 'magnet',
})
const CATALOG = createCatalogLookup(catalogBundle([SCREW, MY_MAGNET]))

const SWITCH = newCustomDevice(
  {
    brand: 'Zeta',
    model: 'Switch 8',
    category: 'switch',
    widthMm: 100,
    depthMm: 98,
    heightMm: 26,
    rackmountSixths: 3,
    today: TODAY,
  },
  NONE,
)

const MOUNT_INPUT: CustomItemInput = {
  name: 'Tiny mount 1U',
  category: 'mount',
  heightSixths: 6,
  depthMm: 190,
  holds: { kind: 'device', maxW: 180, maxD: 184, maxH: 36 },
  prints: [{ plate: 'Mount', count: 1, gramsPerPrint: 85 }],
  hardware: [{ hardwareId: 'screw-m3x8-shcs', count: 4 }],
  sourceUrl: 'https://makerworld.com/en/models/1945283-tiny-mount',
  today: TODAY,
}
const MOUNT = newCustomItem(MOUNT_INPUT, NONE)

const RACK = newCustomFrame(
  {
    name: 'RackMate T1',
    heightU: 8,
    innerWidthMm: 220,
    depthMm: 300,
    rearOpen: true,
    thread: 'M6',
    perHole: 'screw+cage-nut',
    today: TODAY,
  },
  NONE,
)

function parsedJson(part: CatalogEntry): CatalogEntry {
  return CatalogEntrySchema.parse(JSON.parse(catalogEntryJson(part)))
}

describe('groups, search and facts', () => {
  it('groups by kind in a fixed order, each by name', () => {
    const other = { ...SWITCH, id: 'custom:alpha', model: 'Alpha' }
    const groups = groupLibrary([RACK, MOUNT, SWITCH, other])
    expect(groups.map((group) => [group.title, group.entries.map((entry) => entry.id)])).toEqual([
      ['Devices', ['custom:alpha', 'custom:zeta-switch-8']],
      ['Mounts, panels and shelves', ['custom:tiny-mount-1u']],
      ['Rack frames', ['custom:rackmate-t1']],
    ])
    expect(groupLibrary([])).toEqual([])
  })

  it('finds parts by the start of their words', () => {
    const entries = [RACK, MOUNT, SWITCH]
    expect(filterLibrary(entries, 'swi').map((entry) => entry.id)).toEqual(['custom:zeta-switch-8'])
    expect(filterLibrary(entries, 'mount').map((entry) => entry.id)).toEqual([
      'custom:tiny-mount-1u',
    ])
    expect(filterLibrary(entries, '  ')).toHaveLength(3)
    expect(filterLibrary(entries, 'nas')).toEqual([])
  })

  it('says the facts in one line', () => {
    expect(partFacts(SWITCH)).toBe('100 × 98 × 26 mm · Switch · ½U rack ears')
    expect(partFacts(MOUNT)).toBe('1U · Mount · holds a device up to 180 × 184 × 36 mm · 1 print')
    expect(partFacts(RACK)).toBe(
      '8U · 220 mm between the rails · 300 mm deep · M6 screws and cage nuts',
    )
    expect(partFacts(SCREW)).toBe('Screw · M3')
  })
})

describe('the shared catalog', () => {
  it('turns custom ids into catalog ids', () => {
    expect(catalogId('custom:tiny-mount-1u')).toBe('tiny-mount-1u')
    expect(catalogId('lenovo-tiny-mount-1u')).toBe('lenovo-tiny-mount-1u')
    expect(catalogFileName(MOUNT)).toBe('tiny-mount-1u.json')
  })

  it('exports an entry the catalog accepts, without the defaults it leaves out', () => {
    const json = JSON.parse(catalogEntryJson(MOUNT)) as Record<string, unknown>
    expect(json.id).toBe('tiny-mount-1u')
    expect(json).not.toHaveProperty('bay')
    expect(json).not.toHaveProperty('faces')
    expect(json).not.toHaveProperty('options')
    expect(json.mount).toEqual({ front: 4 })
    expect(catalogEntryJson(MOUNT).endsWith('}\n')).toBe(true)
    for (const part of [SWITCH, MOUNT, RACK]) {
      const entry = parsedJson(part)
      expect(entry.id).toBe(catalogId(part.id))
      // Shared frames and items need a link; this frame has none yet (Share says so).
      expect(checkEntryIntegrity(entry), part.id).toEqual(
        part === RACK ? ['a curated frame needs a source'] : [],
      )
    }
    // (This test catalog has no M6 screws, so they are reported too.)
    expect(shareReport(RACK, CATALOG).needed).toContain(
      'A link to the page its facts come from (edit the part to add one).',
    )
    expect(crossReferenceProblems(parsedJson(MOUNT), CATALOG)).toEqual([])
    // A MakerWorld design: the catalog asks for the designer and the licence.
    expect(curationReport(parsedJson(MOUNT)).warnings).toEqual([
      'source.designer: credit the designer as the page shows them',
      'source.license: add the licence label exactly as the page shows it',
    ])
  })

  it('names the other parts of yours an entry uses', () => {
    const item = newCustomItem(
      { ...MOUNT_INPUT, hardware: [{ hardwareId: 'custom:my-magnet', count: 2 }] },
      NONE,
    )
    const shared = sharedCatalogEntry(item)
    expect(shared.ownRefs).toEqual(['custom:my-magnet'])
    if (shared.entry.kind !== 'item') throw new Error('Expected an item')
    expect(shared.entry.recipe.map((line) => line.ref)).toEqual([
      { print: 'mount' },
      { hardware: 'my-magnet' },
    ])
    const report = shareReport(item, CATALOG)
    expect(report.ownRefs).toEqual(['custom:my-magnet'])
    expect(report.needed).toEqual([])
    expect(report.suggested).toEqual([
      'The designer’s name, as the page shows it.',
      'The licence, exactly as the page shows it.',
    ])
  })

  it('asks for a link before a part without one can be added', () => {
    const { sourceUrl: _ignored, ...withoutLink } = MOUNT_INPUT
    const report = shareReport(newCustomItem(withoutLink, NONE), CATALOG)
    expect(report.needed).toEqual([
      'A link to the page its facts come from (edit the part to add one).',
    ])
  })

  it('opens the submission form with the entry filled in when it fits in the link', () => {
    const url = new URL(submissionUrl(MOUNT, '{"id":"tiny-mount-1u"}'))
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://github.com/Npab19/mini-rack-planner/issues/new',
    )
    expect(Object.fromEntries(url.searchParams)).toEqual({
      template: 'catalog-submission.yml',
      title: 'catalog: Tiny mount 1U',
      kind: 'Item (a printed mount, shelf, panel or accessory)',
      link: 'https://makerworld.com/en/models/1945283-tiny-mount',
      entry: '{"id":"tiny-mount-1u"}',
    })
    // Spaces are %20, not "+", so every field reads back as typed.
    expect(url.search).toContain('title=catalog%3A%20Tiny%20mount%201U')

    const link = shareLink(MOUNT)
    expect(link.prefilled).toBe(true)
    expect(link.url.length).toBeLessThanOrEqual(MAX_SUBMISSION_URL_LENGTH)
    expect(new URL(link.url).searchParams.get('entry')).toBe(catalogEntryJson(MOUNT).trim())
  })

  it('leaves the entry out of the link when it is too long', () => {
    const many = newCustomItem(
      {
        ...MOUNT_INPUT,
        prints: Array.from({ length: 80 }, (_, index) => ({
          plate: `Plate number ${index + 1} of the big rack project`,
          count: 1,
          gramsPerPrint: 12.5,
          minutesPerPrint: 45,
          material: 'PETG',
        })),
      },
      NONE,
    )
    const link = shareLink(many)
    expect(link.prefilled).toBe(false)
    expect(new URL(link.url).searchParams.has('entry')).toBe(false)
    expect(new URL(link.url).searchParams.get('template')).toBe('catalog-submission.yml')
  })
})
