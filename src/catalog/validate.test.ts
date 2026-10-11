import { describe, expect, it } from 'vitest'
import { AlignRecordSchema } from '../domain/schema/align'
import { CatalogEntrySchema, type CatalogEntry } from '../domain/schema/catalog'
import { RAW_DEVICE, RAW_FRAME, RAW_MOUNT, rawHardware, testEntries } from './__fixtures__/entries'
import { createLookup } from './resolver'
import {
  alignmentProblems,
  checkIdsLock,
  crossReferenceProblems,
  curationReport,
  formatIdsLock,
  MAX_TEXT_LENGTH,
  parseIdsLock,
  parseReplacedMap,
  publishedKeyKind,
  publishedKeys,
  unknownKeys,
} from './validate'

const lookup = createLookup(testEntries())
const parse = (raw: unknown): CatalogEntry => CatalogEntrySchema.parse(raw)
const [legPrint] = RAW_FRAME.prints

describe('crossReferenceProblems', () => {
  it('accepts a consistent catalog', () => {
    for (const entry of testEntries()) expect(crossReferenceProblems(entry, lookup)).toEqual([])
  })

  it('reports unknown hardware in recipe lines and embeds', () => {
    const frame = parse({
      ...RAW_FRAME,
      prints: [{ ...legPrint, embeds: [{ hardwareId: 'magnet-3x1', perPrint: 2 }] }],
      recipe: [
        ...RAW_FRAME.recipe,
        { id: 'feet', unit: 'bottom', ref: { hardware: 'rubber-foot' }, count: 4 },
      ],
    })
    expect(crossReferenceProblems(frame, lookup)).toEqual([
      'recipe line "feet": unknown hardware "rubber-foot"',
      'print "leg": embeds unknown hardware "magnet-3x1"',
    ])
  })

  it('checks the equipment screws and nut against the frame fastener', () => {
    const frame = parse({
      ...RAW_FRAME,
      equipmentFastener: {
        thread: 'M5',
        perHole: 'screw+nut',
        screwIds: ['screw-m6x8-shcs', 'nut-m6-hex', 'ghost-screw'],
        engagementMm: 6,
      },
    })
    expect(crossReferenceProblems(frame, lookup)).toEqual([
      'equipmentFastener.screwIds: "screw-m6x8-shcs" is M6 but the frame uses M5',
      'equipmentFastener.screwIds: "nut-m6-hex" is not a screw (category "nut")',
      'equipmentFastener.screwIds: "nut-m6-hex" is M6 but the frame uses M5',
      'equipmentFastener.screwIds: "nut-m6-hex" needs spec.lengthMm to pick a long enough screw',
      'equipmentFastener.screwIds: unknown hardware "ghost-screw"',
      'equipmentFastener.nutId: "screw+nut" needs the nut\'s hardware id',
    ])
    const noScrews = parse({
      ...RAW_FRAME,
      equipmentFastener: { ...RAW_FRAME.equipmentFastener, screwIds: [], nutId: 'insert-m5x8x7' },
    })
    expect(crossReferenceProblems(noScrews, lookup)).toEqual([
      'equipmentFastener.screwIds: list at least one screw',
      'equipmentFastener.nutId: "insert-m5x8x7" is not a nut (category "insert")',
    ])
  })

  it('reports unknown devices in slots and unknown frames in compat', () => {
    const [slot] = RAW_MOUNT.slots
    const mount = parse({
      ...RAW_MOUNT,
      slots: [{ ...slot, accepts: { deviceIds: ['lenovo-m720q', 'ghost-pc'] } }],
      compat: { frames: ['test-frame', 'ghost-frame'] },
    })
    expect(crossReferenceProblems(mount, lookup)).toEqual([
      'slot "pc": accepts unknown device "ghost-pc"',
      'compat.frames: unknown frame "ghost-frame"',
    ])
  })

  it('needs hardware sold by length for cut lengths', () => {
    const frame = parse({
      ...RAW_FRAME,
      recipe: [
        {
          id: 'rails',
          unit: 'section',
          ref: { hardware: 'screw-m6x8-shcs' },
          count: 2,
          length: { perU: 44.45 },
        },
      ],
    })
    expect(crossReferenceProblems(frame, lookup)).toEqual([
      'recipe line "rails": a cut length needs hardware sold by length (unit "mm")',
    ])
  })
})

describe('curationReport', () => {
  it('passes the fixture entries', () => {
    for (const entry of testEntries()) {
      expect(curationReport(entry)).toEqual({ errors: [], warnings: [] })
    }
  })

  it('needs a source and a verified block on every shared entry', () => {
    const bare = parse({
      kind: 'hardware',
      id: 'mystery-nut',
      name: 'Mystery nut',
      category: 'nut',
    })
    expect(curationReport(bare).errors).toEqual([
      'source: link to the page the facts come from',
      'verified: say who checked the facts, when and how',
    ])
  })

  it('checks MakerWorld links and asks for designer and licence credits', () => {
    const withSource = (source: Record<string, unknown>) => parse({ ...RAW_MOUNT, source })
    const wrongId = withSource({
      platform: 'makerworld',
      url: 'https://makerworld.com/en/models/200-tiny-mount',
      modelId: '201',
    })
    expect(curationReport(wrongId)).toEqual({
      errors: ['source.modelId: must be "200", the id in the link'],
      warnings: [
        'source.designer: credit the designer as the page shows them',
        'source.license: add the licence label exactly as the page shows it',
      ],
    })
    const notAModel = withSource({
      platform: 'makerworld',
      url: 'https://makerworld.com/en/@someone',
      designer: 'Someone',
      license: 'BY-SA',
    })
    expect(curationReport(notAModel).errors).toEqual([
      'source.url: use the model page link, https://makerworld.com/en/models/<id>',
    ])
  })

  it('needs a note on unverified entries and keeps text short', () => {
    const unverified = parse({
      ...RAW_DEVICE,
      verified: { ...RAW_DEVICE.verified, method: 'unverified' },
    })
    expect(curationReport(unverified).errors).toEqual([
      'verified.note: say what still needs checking',
    ])
    const essay = parse({
      ...RAW_DEVICE,
      verified: { ...RAW_DEVICE.verified, note: 'x'.repeat(MAX_TEXT_LENGTH + 1) },
    })
    expect(curationReport(essay).errors).toEqual([
      `verified.note: ${MAX_TEXT_LENGTH + 1} characters; the catalog stores facts and links only (max ${MAX_TEXT_LENGTH})`,
    ])
  })
})

describe('unknownKeys', () => {
  it('finds fields the schema dropped, nested ones included', () => {
    const [slot] = RAW_MOUNT.slots
    const raw = {
      ...RAW_MOUNT,
      mount: { front: 4, frontt: 2 },
      slots: [{ ...slot, acceptz: {} }],
      colour: 'red',
    }
    expect(unknownKeys(raw, parse(raw))).toEqual(['mount.frontt', 'slots[0].acceptz', 'colour'])
  })

  it('finds nothing in valid entries', () => {
    for (const raw of [RAW_FRAME, RAW_MOUNT, RAW_DEVICE])
      expect(unknownKeys(raw, parse(raw))).toEqual([])
  })
})

describe('publishedKeys', () => {
  it('lists the entry id and every local id saved data can refer to', () => {
    expect(publishedKeys(parse(RAW_FRAME))).toEqual([
      'test-frame',
      'test-frame#section:s3',
      'test-frame#option:top',
      'test-frame#option:top=handle',
      'test-frame#option:top=flat',
      'test-frame#print:leg',
      'test-frame#part:leg',
    ])
    expect(publishedKeys(parse(RAW_MOUNT))).toEqual([
      'lenovo-tiny-mount',
      'lenovo-tiny-mount#print:mount',
      'lenovo-tiny-mount#slot:pc',
    ])
    expect(publishedKeys(parse(RAW_DEVICE))).toEqual(['lenovo-m720q'])
  })

  it('names the kind of a key', () => {
    expect(publishedKeyKind('test-frame')).toBe('entry')
    expect(publishedKeyKind('test-frame#option:top')).toBe('option')
    expect(publishedKeyKind('test-frame#option:top=flat')).toBe('choice')
    expect(publishedKeyKind('lenovo-tiny-mount#slot:pc')).toBe('slot')
  })
})

describe('ids.lock', () => {
  it('formats sorted unique keys under a comment header and parses them back', () => {
    const text = formatIdsLock(['b', 'a#print:x', 'a', 'b'])
    expect(text.endsWith('a\na#print:x\nb\n')).toBe(true)
    expect(text.split('\n')[0]?.startsWith('# ')).toBe(true)
    expect(parseIdsLock(text)).toEqual(['a', 'a#print:x', 'b'])
    expect(parseIdsLock('# comment\r\n\r\n  kws-rack-v2  \r\n')).toEqual(['kws-rack-v2'])
  })

  const current = new Set(['frame', 'frame#print:new', 'frame#slot:pc', 'screw'])

  it('passes when every locked key is still there and lists new keys', () => {
    expect(checkIdsLock(['frame', 'screw'], current, {})).toEqual({
      problems: [],
      unlocked: ['frame#print:new', 'frame#slot:pc'],
    })
  })

  it('fails when a locked key is gone, unless it maps to a replacement', () => {
    const locked = ['frame', 'frame#print:old', 'gone']
    expect(checkIdsLock(locked, current, {}).problems.map((problem) => problem.file)).toEqual([
      'ids.lock',
      'ids.lock',
    ])
    const replaced = { 'frame#print:old': 'frame#print:new', gone: 'screw' }
    expect(checkIdsLock(locked, current, replaced).problems).toEqual([])
  })

  it('rejects bad replacements', () => {
    const locked = ['frame', 'frame#print:old', 'frame#print:older']
    const replaced = {
      'frame#print:old': 'frame#print:missing',
      'frame#print:older': 'frame#slot:pc',
      'never-published': 'frame',
    }
    expect(checkIdsLock(locked, current, replaced).problems).toEqual([
      {
        file: 'replaced.json',
        message: '"frame#print:old" maps to "frame#print:missing", which is not in the catalog',
      },
      {
        file: 'replaced.json',
        message: '"frame#print:older" (print) cannot be replaced by a slot',
      },
      {
        file: 'replaced.json',
        message: '"never-published" was never published (it is not in ids.lock)',
      },
    ])
  })

  it('reads replaced.json as a map of strings', () => {
    expect(parseReplacedMap({ a: 'b' })).toEqual({ map: { a: 'b' }, problems: [] })
    expect(parseReplacedMap([]).problems).toEqual(['must be a JSON object of id -> id'])
    expect(parseReplacedMap({ a: 1 }).problems).toEqual([
      '"a": the replacement must be an id string',
    ])
  })
})

describe('alignmentProblems', () => {
  const record = (overrides: Record<string, unknown>) =>
    AlignRecordSchema.parse({
      schema: 'mrp.align/1',
      id: 'test-frame-leg',
      catalogPartId: 'test-frame/leg',
      match: { nameHints: ['Legs'] },
      pose: {
        basis: ['+x', '+y', '+z'],
        anchor: { mesh: ['mid', 'min', 'max'], slot: ['mid', 'min', 'max'] },
      },
      provenance: { method: 'curated' },
      ...overrides,
    })

  it('accepts a curated record for an existing 3D part', () => {
    expect(alignmentProblems(record({}), 'test-frame-leg', lookup)).toEqual([])
  })

  it('checks the file name, the provenance and the part', () => {
    expect(
      alignmentProblems(record({ provenance: { method: 'auto' } }), 'other-name', lookup),
    ).toEqual([
      'id must match the file name (other-name.json)',
      'provenance.method: shared alignments are "curated"',
    ])
    expect(
      alignmentProblems(record({ catalogPartId: 'test-frame/arm' }), 'test-frame-leg', lookup),
    ).toEqual(['catalogPartId: "test-frame" has no 3D part "arm"'])
    expect(
      alignmentProblems(record({ catalogPartId: 'ghost/leg' }), 'test-frame-leg', lookup),
    ).toEqual(['catalogPartId: "ghost/leg" must be <frame or item id>/<part id>'])
  })
})

describe('rawHardware fixture helper', () => {
  it('builds valid hardware', () => {
    expect(parse(rawHardware('washer-m6', 'M6 washer', 'washer')).kind).toBe('hardware')
  })
})
