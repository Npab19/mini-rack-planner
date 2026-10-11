import { describe, expect, it } from 'vitest'
import type { BomLine, BomResult } from '@/domain/api'
import { computeBom } from '@/domain/bom'
import { hardwareKey, printKey } from '@/domain/ids'
import { defaultSettings, type Settings } from '@/domain/schema/settings'
import { KWS_FRAME_ID, KWS_IDS, kwsCatalog, kwsPlan } from '@/domain/__fixtures__/kws'
import {
  BOM_CSV_HEADER,
  bomToCsvRows,
  csvCell,
  formatPrintTime,
  lineSources,
  toCsv,
  UTF8_BOM,
} from './csv'

const NO_SPARES: Settings = { ...defaultSettings(), sparePct: { default: 0 } }

/** The user's rack (3U + 6U built) plus one 3U on top. */
function plusThreeU(settings: Settings = NO_SPARES): BomResult {
  const plan = kwsPlan({ sections: [{ u: 3, have: true }, { u: 6, have: true }, 3] })
  return computeBom(plan, kwsCatalog(), settings, {})
}

/** Data rows by item name (column 2). */
function byItem(rows: string[][]): Map<string, string[]> {
  return new Map(rows.slice(3).map((row) => [row[1] ?? '', row]))
}

describe('csvCell and toCsv', () => {
  it('quotes commas, quotes and line breaks (RFC 4180) and leaves plain text alone', () => {
    expect(csvCell('M6 nyloc nut')).toBe('M6 nyloc nut')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('the "flat" top')).toBe('"the ""flat"" top"')
    expect(csvCell('two\nlines')).toBe('"two\nlines"')
    expect(csvCell('cr\rhere')).toBe('"cr\rhere"')
    expect(csvCell('')).toBe('')
    expect(csvCell('2U shelf; ½U panel × 2')).toBe('2U shelf; ½U panel × 2')
  })

  it('defuses formulas: = + - @ tab and CR at the start get a leading quote', () => {
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`)
    expect(csvCell('+1+1')).toBe("'+1+1")
    expect(csvCell('-2+3')).toBe("'-2+3")
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvCell('\t=1')).toBe("'\t=1")
    expect(csvCell('\r=1')).toBe(`"'\r=1"`)
    // Only the first character matters.
    expect(csvCell('1=1')).toBe('1=1')
    expect(csvCell('a-b')).toBe('a-b')
  })

  it('starts with a UTF-8 byte order mark and ends every row with CRLF', () => {
    const text = toCsv([['Item', 'Need'], ['M5 insert, brass', '36'], [], ['=1+1', '']])
    expect(text.startsWith(UTF8_BOM)).toBe(true)
    expect(text.slice(1)).toBe('Item,Need\r\n"M5 insert, brass",36\r\n\r\n\'=1+1,\r\n')
    // No bare LF anywhere outside quoted cells.
    expect(text.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/)
    expect(toCsv([])).toBe(UTF8_BOM)
  })

  it('encodes as UTF-8 with the EF BB BF signature', async () => {
    const bytes = new Uint8Array(await new Blob([toCsv([['½U × 2']])]).arrayBuffer())
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf])
    expect(new TextDecoder().decode(bytes.slice(3))).toBe('½U × 2\r\n')
  })
})

describe('formatPrintTime', () => {
  it('reads as hours and minutes', () => {
    expect(formatPrintTime(528)).toBe('8 h 48 min')
    expect(formatPrintTime(45)).toBe('45 min')
    expect(formatPrintTime(180)).toBe('3 h')
    expect(formatPrintTime(0)).toBe('')
  })
})

describe('bomToCsvRows', () => {
  const options = { planName: 'Garage rack', frameName: 'KWS Rack v2' }

  it('lays out the golden +3U shopping list: title, header, prints, hardware, total', () => {
    const rows = bomToCsvRows(plusThreeU(), { ...options, mode: 'shopping' })
    expect(rows[0]).toEqual(['Shopping list', 'Garage rack', 'KWS Rack v2'])
    expect(rows[1]).toEqual([])
    expect(rows[2]).toEqual([...BOM_CSV_HEADER])
    const items = rows.slice(3).map((row) => [row[0], row[1], row[3], row[5]])
    expect(items).toEqual([
      ['Prints to make', '3U leg plate (4 legs)', '1', '1'],
      ['Prints to make', 'Frame connectors', '1', '1'],
      ['Hardware to buy', 'M5 heat-set insert (M5x8x7)', '36', '36'],
      ['Hardware to buy', 'M6 nyloc nut', '40', '40'],
      ['Hardware to buy', 'M6×10 socket head cap screw', '24', '24'],
      ['Hardware to buy', 'M6×8 socket head cap screw', '16', '16'],
      ['Hardware to buy', 'Round neodymium magnet 10×5 mm', '16', '16'],
      ['Total', '', '', ''],
    ])
    const table = byItem(rows)
    expect(table.get('3U leg plate (4 legs)')).toEqual([
      'Prints to make',
      '3U leg plate (4 legs)',
      'PETG',
      '1',
      '',
      '1',
      'plates',
      '214',
      '8 h 48 min',
      '3U section #3',
      '',
    ])
    expect(table.get('Frame connectors')?.[9]).toBe('Joint 6U #2 / 3U #3')
    expect(table.get('M5 heat-set insert (M5x8x7)')).toEqual([
      'Hardware to buy',
      'M5 heat-set insert (M5x8x7)',
      'insert',
      '36',
      '0',
      '36',
      'pcs',
      '',
      '',
      '3U section #3',
      '',
    ])
    // 214 g + 68 g; 528 min + 180 min.
    expect(rows.at(-1)).toEqual(['Total', '', '', '', '', '', '', '282', '11 h 48 min', '', ''])
    // Every row has the header's width except the title and blank rows.
    for (const row of rows.slice(2)) expect(row).toHaveLength(BOM_CSV_HEADER.length)
  })

  it('shows spares apart from what the build needs, and packs in Buy', () => {
    const result = plusThreeU(defaultSettings())
    const rows = byItem(bomToCsvRows(result, { ...options, mode: 'shopping' }))
    // 36 + ⌈3.6⌉ spare inserts.
    expect(rows.get('M5 heat-set insert (M5x8x7)')?.slice(3, 6)).toEqual(['36', '4', '40'])
    expect(rows.get('Round neodymium magnet 10×5 mm')?.slice(3, 6)).toEqual(['16', '1', '17'])
  })

  it('lists every line with what the plan uses in full mode', () => {
    const result = plusThreeU()
    const rows = bomToCsvRows(result, { ...options, mode: 'full' })
    expect(rows[0]?.[0]).toBe('Full bill of materials')
    const table = byItem(rows)
    expect(rows.length).toBe(3 + result.lines.length + 1)
    expect(table.get('M5 heat-set insert (M5x8x7)')?.slice(0, 6)).toEqual([
      'Hardware',
      'M5 heat-set insert (M5x8x7)',
      'insert',
      '144',
      '0',
      '36',
    ])
    expect(table.get('6U frame leg')?.slice(3, 9)).toEqual([
      '4',
      '',
      '0',
      'plates',
      '500',
      '21 h 32 min',
    ])
    expect(table.get('3U leg plate (4 legs)')?.[9]).toBe('3U section #1; 3U section #3')
  })

  it('marks included accessories and keeps them off the shopping list', () => {
    const plan = kwsPlan({
      sections: [6],
      equipment: [{ id: 'eq-1', deviceId: 'lenovo-m720q' }],
    })
    const result = computeBom(plan, kwsCatalog(), NO_SPARES, {})
    const full = byItem(bomToCsvRows(result, { ...options, mode: 'full' }))
    const brick = full.get('Power brick for Lenovo ThinkCentre M720q Tiny')
    expect(brick?.[2]).toBe('included with the device')
    expect(brick?.[5]).toBe('')
    const shopping = byItem(bomToCsvRows(result, { ...options, mode: 'shopping' }))
    expect(shopping.has('Power brick for Lenovo ThinkCentre M720q Tiny')).toBe(false)
    expect(shopping.get('Lenovo ThinkCentre M720q Tiny')?.slice(0, 6)).toEqual([
      'Equipment',
      'Lenovo ThinkCentre M720q Tiny',
      'mini-pc',
      '1',
      '',
      '1',
    ])
  })

  it('defuses formulas in plan names and part labels end to end', () => {
    const text = toCsv(
      bomToCsvRows(plusThreeU(), { planName: '=cmd|calc', frameName: '@frame', mode: 'shopping' }),
    )
    expect(text).toContain("'=cmd|calc,'@frame\r\n")
  })
})

describe('lineSources', () => {
  it('names the units still to build for a shopping list, every unit for the full BOM', () => {
    const result = plusThreeU()
    const line = result.lines.find(
      (candidate) => candidate.key === hardwareKey(KWS_IDS.m6x8),
    ) as BomLine
    expect(lineSources(line, 'shopping')).toEqual(['3U section #3'])
    expect(lineSources(line, 'full')).toEqual(['3U section #1', '6U section #2', '3U section #3'])
    const plate = result.lines.find(
      (candidate) => candidate.key === printKey(KWS_FRAME_ID, 'plate-3u'),
    ) as BomLine
    expect(lineSources(plate, 'shopping')).toEqual(['3U section #3'])
  })
})
