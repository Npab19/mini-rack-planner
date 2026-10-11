/**
 * CSV export (RFC 4180) for spreadsheets, Excel first:
 * - a UTF-8 byte order mark, so Excel reads "×" and "½U" instead of mojibake;
 * - CRLF line endings, including after the last row;
 * - cells with a comma, a double quote, CR or LF are quoted, inner quotes doubled;
 * - CSV injection: a cell starting with `=`, `+`, `-`, `@`, a tab or CR gets a leading `'`, so a
 *   spreadsheet shows it as text instead of running it as a formula (plan and part names are
 *   user input, and share links carry them between people).
 *
 * `bomToCsvRows` lays out a BOM: a title row (what, plan, frame), a blank row, the header, then
 * one row per line (prints, hardware, equipment) and a total row for print grams and time.
 */
import type { BomLine, BomLineKind, BomResult } from '@/domain/api'
import { shoppingLines } from '@/domain/bom'

/** Starts a byte stream as UTF-8 for Excel. */
export const UTF8_BOM = '﻿'
export const CSV_LINE_END = '\r\n'

/** Cells starting with one of these are formulas to a spreadsheet. */
const FORMULA_START = /^[=+\-@\t\r]/
const NEEDS_QUOTES = /[",\r\n]/

/** One cell: injection-safe, then quoted when RFC 4180 needs it. */
export function csvCell(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value
  return NEEDS_QUOTES.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}

/** The whole file: BOM, comma-separated cells, CRLF after every row. */
export function toCsv(rows: ReadonlyArray<ReadonlyArray<string>>): string {
  return UTF8_BOM + rows.map((row) => row.map(csvCell).join(',') + CSV_LINE_END).join('')
}

// ---------------------------------------------------------------------------------------------
// BOM

export type BomCsvMode = 'shopping' | 'full'

export interface BomCsvOptions {
  planName: string
  frameName: string
  /** shopping: what to get (Need = to install); full: every line (Need = what the plan uses). */
  mode: BomCsvMode
}

export const BOM_CSV_HEADER = [
  'Section',
  'Item',
  'Spec/material',
  'Need',
  'Spare',
  'Buy',
  'Unit',
  'Grams',
  'Print time',
  'Source',
  'Done',
] as const

const TITLES: Record<BomCsvMode, string> = {
  shopping: 'Shopping list',
  full: 'Full bill of materials',
}

const SECTIONS: Record<BomCsvMode, Record<BomLineKind, string>> = {
  shopping: { print: 'Prints to make', hardware: 'Hardware to buy', device: 'Equipment' },
  full: { print: 'Printed parts', hardware: 'Hardware', device: 'Equipment' },
}

const KIND_ORDER: readonly BomLineKind[] = ['print', 'hardware', 'device']

/** "8 h 48 min", "45 min", "3 h"; empty for nothing. */
export function formatPrintTime(minutes: number): string {
  const total = Math.round(minutes)
  if (!(total > 0)) return ''
  const hours = Math.floor(total / 60)
  const rest = total % 60
  if (hours === 0) return `${rest} min`
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

function number(value: number): string {
  return String(Math.round(value * 1000) / 1000)
}

/** Where a line's parts go, from its provenance; shopping lists only the units still to build. */
export function lineSources(line: BomLine, mode: BomCsvMode): string[] {
  const planned = new Map<string, number>()
  const owned = new Map<string, number>()
  for (const entry of line.provenance) {
    if (!(entry.qty > 0)) continue
    const side = entry.detail?.startsWith('Owned: ') ? owned : planned
    side.set(entry.label, (side.get(entry.label) ?? 0) + entry.qty)
  }
  return [...planned]
    .filter(([label, qty]) => mode === 'full' || qty > (owned.get(label) ?? 0))
    .map(([label]) => label)
}

function specText(line: BomLine): string {
  if (line.included) return 'included with the device'
  if (line.kind === 'print') return line.material ?? ''
  return line.category ?? ''
}

function lineRow(line: BomLine, mode: BomCsvMode): string[] {
  // Prints are counted from what is still to print (after spares) in a shopping list.
  const printed = mode === 'shopping' ? line.need : line.target
  const grams = line.kind === 'print' && line.gramsEach !== undefined ? printed * line.gramsEach : 0
  const minutes =
    line.kind === 'print' && line.minutesEach !== undefined ? printed * line.minutesEach : 0
  return [
    SECTIONS[mode][line.kind],
    line.label,
    specText(line),
    number(mode === 'shopping' ? line.install : line.target),
    line.kind === 'hardware' ? number(line.spare) : '',
    line.included ? '' : number(line.buy),
    line.unit,
    grams > 0 ? number(Math.round(grams)) : '',
    formatPrintTime(minutes),
    lineSources(line, mode).join('; '),
    '',
  ]
}

/**
 * Rows for `toCsv`: title, blank, header, lines grouped prints -> hardware -> equipment (in the
 * BOM's own order within a group), then a total of print grams and time when there are prints.
 */
export function bomToCsvRows(result: BomResult, options: BomCsvOptions): string[][] {
  const { mode } = options
  const source = mode === 'shopping' ? shoppingLines(result) : result.lines
  const lines = KIND_ORDER.flatMap((kind) => source.filter((line) => line.kind === kind))
  const rows = lines.map((line) => lineRow(line, mode))
  let grams = 0
  let minutes = 0
  for (const line of lines) {
    if (line.kind !== 'print') continue
    const printed = mode === 'shopping' ? line.need : line.target
    grams += printed * (line.gramsEach ?? 0)
    minutes += printed * (line.minutesEach ?? 0)
  }
  const total =
    grams > 0 || minutes > 0
      ? [
          [
            'Total',
            '',
            '',
            '',
            '',
            '',
            '',
            grams > 0 ? number(Math.round(grams)) : '',
            formatPrintTime(minutes),
            '',
            '',
          ],
        ]
      : []
  return [
    [TITLES[mode], options.planName, options.frameName],
    [],
    [...BOM_CSV_HEADER],
    ...rows,
    ...total,
  ]
}
