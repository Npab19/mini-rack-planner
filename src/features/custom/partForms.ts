/**
 * The plain-language part forms ("Add a part" and its editors): what each form holds (text as
 * typed, so half-typed numbers are never lost), how a request's prefill or a stored entry fills
 * it, and the live validation that turns it into a domain input (`CustomDeviceInput`,
 * `CustomItemInput`, `CustomFrameInput`). Pure: no React, no storage.
 *
 * Numbers take a decimal comma or point. Print times take minutes ("150"), "2:30" or "2h 30m".
 * Messages say what to type, not what went wrong in code terms.
 */
import { formatU, NOMINAL_OPENING_MM, sixthsToMm, SIXTHS_PER_U } from '@/domain/geometry'
import {
  parseSourceLink,
  type CustomDeviceInput,
  type CustomFrameInput,
  type CustomHolds,
  type CustomItemInput,
  type CustomPowerChoice,
  type SourceLink,
} from '@/domain/customParts'
import type { DeviceCategory, PerHole, RenderStyle } from '@/domain/schema/catalog'
import type { Thread, VerifyMethod } from '@/domain/schema/common'

// ---------------------------------------------------------------------------------------------
// Results

export interface FormIssue {
  /** The field (`data-field` of its control), e.g. "width" or "prints.2.count". */
  field: string
  message: string
}

export interface FormCheck<T> {
  /** Problems that stop saving. */
  issues: FormIssue[]
  /** Worth knowing, saving still works. */
  warnings: FormIssue[]
  /** The domain input, when there are no issues. */
  value?: T
}

// ---------------------------------------------------------------------------------------------
// Numbers and times

export type ParsedNumber =
  { kind: 'empty' } | { kind: 'number'; value: number } | { kind: 'invalid' }

/** "22.5", "22,5", "+3" -> a number; negative numbers and other text are invalid. */
export function parseNumber(text: string): ParsedNumber {
  const value = text.trim()
  if (value === '') return { kind: 'empty' }
  if (!/^\+?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(value)) return { kind: 'invalid' }
  return { kind: 'number', value: Number(value.replace(',', '.').replace(/^\+/, '')) }
}

const DURATION_HM = /^(\d+):([0-5]?\d)$/
const DURATION_WORDS =
  /^(?:(\d+(?:[.,]\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?|s)?)?)?$/

/** Minutes from "150", "2:30", "2h 30m", "2 h", "45 min" or "1.5h". */
export function parseDuration(text: string): ParsedNumber {
  const value = text.trim().toLowerCase()
  if (value === '') return { kind: 'empty' }
  const plain = parseNumber(value)
  if (plain.kind === 'number') return { kind: 'number', value: Math.round(plain.value) }
  const hm = DURATION_HM.exec(value)
  if (hm !== null) return { kind: 'number', value: Number(hm[1]) * 60 + Number(hm[2]) }
  const words = DURATION_WORDS.exec(value)
  if (words !== null && (words[1] !== undefined || words[2] !== undefined)) {
    const hours = Number((words[1] ?? '0').replace(',', '.'))
    return { kind: 'number', value: Math.round(hours * 60 + Number(words[2] ?? '0')) }
  }
  return { kind: 'invalid' }
}

/** 150 -> "2:30", 45 -> "45" (what the time field shows for a stored value). */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return String(minutes)
  const whole = Math.round(minutes)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/** A number as a field shows it: up to 2 decimals, no trailing zeros. */
export function numberText(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return ''
  return String(Math.round(value * 100) / 100)
}

const MAX_MM = 1000

interface NumberRule {
  field: string
  /** "the width" -> "Enter the width in mm." */
  what: string
  unit: string
  /** Shown when empty; undefined: the field is optional. */
  required?: string
  /** Exclusive lower bound (default 0: "above 0"); `atLeast` makes it inclusive. */
  min?: number
  atLeast?: boolean
  max?: number
  /** Whole numbers only. */
  integer?: boolean
}

function readNumber(text: string, rule: NumberRule, issues: FormIssue[]): number | undefined {
  const parsed = parseNumber(text)
  if (parsed.kind === 'empty') {
    if (rule.required !== undefined) issues.push({ field: rule.field, message: rule.required })
    return undefined
  }
  const min = rule.min ?? 0
  const unitText = rule.unit === '' ? '' : ` ${rule.unit}`
  if (parsed.kind === 'invalid') {
    issues.push({
      field: rule.field,
      message: `Enter ${rule.what} as a number${unitText === '' ? '' : ` in${unitText}`}, using digits like 22.5.`,
    })
    return undefined
  }
  const { value } = parsed
  if (rule.integer === true && !Number.isInteger(value)) {
    issues.push({ field: rule.field, message: `Enter ${rule.what} as a whole number.` })
    return undefined
  }
  const tooSmall = rule.atLeast === true ? value < min : value <= min
  if (tooSmall) {
    const bound = rule.atLeast === true ? `${min} or more` : `above ${min}`
    issues.push({ field: rule.field, message: `Enter ${rule.what} as a number ${bound}.` })
    return undefined
  }
  if (rule.max !== undefined && value > rule.max) {
    issues.push({
      field: rule.field,
      message:
        rule.unit === 'mm'
          ? `That is more than ${rule.max} mm: check ${rule.what} (millimetres).`
          : `Enter ${rule.what} of at most ${rule.max}${unitText}.`,
    })
    return undefined
  }
  return value
}

function readLink(text: string, field: string, issues: FormIssue[]): SourceLink | undefined {
  if (text.trim() === '') return undefined
  const link = parseSourceLink(text)
  if (link === undefined) {
    issues.push({
      field,
      message: 'Enter the full web address of the page, like https://makerworld.com/en/models/…',
    })
  }
  return link
}

// ---------------------------------------------------------------------------------------------
// Choices shown in the forms

export interface Choice<T extends string> {
  value: T
  label: string
}

export const DEVICE_CATEGORY_CHOICES: ReadonlyArray<Choice<DeviceCategory>> = [
  { value: 'mini-pc', label: 'Mini PC' },
  { value: 'sbc', label: 'Single-board computer (Raspberry Pi…)' },
  { value: 'nas', label: 'NAS' },
  { value: 'drive', label: 'Hard drive or SSD' },
  { value: 'switch', label: 'Network switch' },
  { value: 'router', label: 'Router' },
  { value: 'gateway', label: 'Gateway or firewall' },
  { value: 'pdu', label: 'Power strip or PDU' },
  { value: 'ups', label: 'UPS' },
  { value: 'power-brick', label: 'Power supply' },
  { value: 'kvm', label: 'KVM' },
  { value: 'patch-panel', label: 'Patch panel' },
  { value: 'other', label: 'Other' },
]

export function deviceCategoryLabel(category: string): string {
  return DEVICE_CATEGORY_CHOICES.find((choice) => choice.value === category)?.label ?? category
}

export const POWER_CHOICES: ReadonlyArray<Choice<CustomPowerChoice>> = [
  { value: 'brick', label: 'A power brick that comes with it' },
  { value: 'ac', label: 'A mains cable into the device (AC)' },
  { value: 'usb-c', label: 'USB-C' },
  { value: 'poe', label: 'PoE from a network switch' },
  { value: 'dc', label: 'DC from the rack (a DC power strip)' },
  { value: 'none', label: 'It needs no power' },
]

export const VERIFY_CHOICES: ReadonlyArray<Choice<VerifyMethod>> = [
  { value: 'unverified', label: 'Not checked yet' },
  { value: 'calipers', label: 'I measured it' },
  { value: 'vendor-spec', label: 'From the maker’s specifications' },
  { value: 'page', label: 'From the design’s page' },
  { value: 'user-files', label: 'From the files I downloaded' },
]

export type ItemHoldsKind = CustomHolds['kind']

export const ITEM_CATEGORY_CHOICES: ReadonlyArray<Choice<string>> = [
  { value: 'mount', label: 'Mount' },
  { value: 'panel', label: 'Panel' },
  { value: 'shelf', label: 'Shelf' },
  { value: 'power', label: 'Power' },
  { value: 'other', label: 'Other' },
]

const DEFAULT_CATEGORY: Readonly<Record<ItemHoldsKind, string>> = {
  nothing: 'panel',
  device: 'mount',
  shelf: 'shelf',
}

/** How a panel looks in the drawing (mounts and shelves look like trays and shelves). */
export const PANEL_LOOK_CHOICES: ReadonlyArray<Choice<RenderStyle>> = [
  { value: 'blank', label: 'Blank' },
  { value: 'vent', label: 'Vent' },
  { value: 'keystone', label: 'Keystone or patch' },
  { value: 'fan', label: 'Fan' },
  { value: 'power', label: 'Power' },
  { value: 'other', label: 'Other' },
]

export type FacesChoice = 'front' | 'rear' | 'both'

export const FACES_CHOICES: ReadonlyArray<Choice<FacesChoice>> = [
  { value: 'front', label: 'Front' },
  { value: 'rear', label: 'Rear' },
  { value: 'both', label: 'Front or rear' },
]

export const THREAD_CHOICES: ReadonlyArray<Choice<Thread>> = [
  { value: 'M6', label: 'M6 (most metal racks)' },
  { value: 'M5', label: 'M5' },
  { value: 'M4', label: 'M4' },
  { value: 'M3', label: 'M3' },
  { value: '10-32', label: '#10-32 (US racks)' },
  { value: '12-24', label: '#12-24' },
]

export const PER_HOLE_CHOICES: ReadonlyArray<Choice<PerHole>> = [
  { value: 'screw+cage-nut', label: 'A screw and a cage nut (square holes)' },
  { value: 'screw', label: 'Just a screw (threaded holes or inserts)' },
  { value: 'screw+nut', label: 'A screw and a nut' },
]

/** Rack heights offered, in sixths: ⅓U to 10U. */
export const HEIGHT_CHOICES_SIXTHS: readonly number[] = [
  2, 3, 4, 6, 8, 9, 12, 15, 18, 24, 30, 36, 42, 48, 54, 60,
]

/** Height choices with `current` added in order when it is not one of them. */
export function heightChoices(current: number | undefined): Array<Choice<string>> {
  const values = new Set(HEIGHT_CHOICES_SIXTHS)
  if (current !== undefined && current > 0) values.add(current)
  return [...values]
    .toSorted((a, b) => a - b)
    .map((sixths) => ({ value: String(sixths), label: formatU(sixths) }))
}

// ---------------------------------------------------------------------------------------------
// Device form

export interface DeviceForm {
  brand: string
  model: string
  category: DeviceCategory | ''
  width: string
  depth: string
  height: string
  weight: string
  power: CustomPowerChoice | ''
  typicalW: string
  maxW: string
  brickWall: boolean
  earMounted: boolean
  /** Rack height in sixths (a height choice). */
  rackSixths: string
  link: string
  checked: VerifyMethod
}

export function deviceForm(input: Partial<CustomDeviceInput> = {}): DeviceForm {
  return {
    brand: input.brand ?? '',
    model: input.model ?? '',
    category: input.category ?? '',
    width: numberText(input.widthMm),
    depth: numberText(input.depthMm),
    height: numberText(input.heightMm),
    weight: numberText(input.weightG),
    power: input.power ?? '',
    typicalW: numberText(input.typicalW),
    maxW: numberText(input.maxW),
    brickWall: input.brickPlugsIntoWall === true,
    earMounted: input.rackmountSixths !== undefined,
    rackSixths: String(input.rackmountSixths ?? SIXTHS_PER_U),
    link: input.sourceUrl ?? '',
    checked: input.verifiedMethod ?? 'unverified',
  }
}

/** Gear wider than the nominal opening cannot sit between the rails. */
function widthWarning(field: string, widthMm: number | undefined, what: string): FormIssue[] {
  if (widthMm === undefined || widthMm <= NOMINAL_OPENING_MM) return []
  return [
    {
      field,
      message: `${what} is wider than the ${NOMINAL_OPENING_MM} mm opening of a 10-inch rack.`,
    },
  ]
}

export function checkDeviceForm(form: DeviceForm, today?: string): FormCheck<CustomDeviceInput> {
  const issues: FormIssue[] = []
  const brand = form.brand.trim()
  const model = form.model.trim()
  if (brand === '') issues.push({ field: 'brand', message: 'Enter the brand, like Lenovo.' })
  if (model === '') {
    issues.push({ field: 'model', message: 'Enter the model, like ThinkCentre M720q.' })
  }
  if (form.category === '') {
    issues.push({ field: 'category', message: 'Choose what kind of device it is.' })
  }
  const size = (field: 'width' | 'depth' | 'height', what: string): number | undefined =>
    readNumber(
      form[field],
      {
        field,
        what: `the ${what}`,
        unit: 'mm',
        required: `Enter the ${what} in mm.`,
        max: MAX_MM,
      },
      issues,
    )
  const widthMm = size('width', 'width')
  const depthMm = size('depth', 'depth')
  const heightMm = size('height', 'height')
  const weightG = readNumber(
    form.weight,
    { field: 'weight', what: 'the weight', unit: 'g' },
    issues,
  )
  const watts = form.power !== '' && form.power !== 'none'
  const typicalW = watts
    ? readNumber(
        form.typicalW,
        { field: 'typicalW', what: 'the typical power', unit: 'W', atLeast: true },
        issues,
      )
    : undefined
  const maxW = watts
    ? readNumber(
        form.maxW,
        { field: 'maxW', what: 'the maximum power', unit: 'W', atLeast: true },
        issues,
      )
    : undefined
  if (typicalW !== undefined && maxW !== undefined && maxW < typicalW) {
    issues.push({ field: 'maxW', message: 'The maximum cannot be below the typical power.' })
  }
  const link = readLink(form.link, 'link', issues)
  const rackmountSixths = form.earMounted ? Number(form.rackSixths) : undefined
  const warnings = widthWarning('width', widthMm, 'It')
  if (issues.length > 0 || form.category === '') return { issues, warnings }
  if (widthMm === undefined || depthMm === undefined || heightMm === undefined) {
    return { issues, warnings }
  }
  return {
    issues,
    warnings,
    value: {
      brand,
      model,
      category: form.category,
      widthMm,
      depthMm,
      heightMm,
      ...(weightG === undefined ? {} : { weightG }),
      ...(form.power === '' ? {} : { power: form.power }),
      ...(typicalW === undefined ? {} : { typicalW }),
      ...(maxW === undefined ? {} : { maxW }),
      ...(form.power === 'brick' && form.brickWall ? { brickPlugsIntoWall: true } : {}),
      ...(rackmountSixths === undefined ? {} : { rackmountSixths }),
      ...(link === undefined ? {} : { sourceUrl: link.url }),
      verifiedMethod: form.checked,
      ...(today === undefined ? {} : { today }),
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Mount / panel / shelf form

export interface PrintRowForm {
  /** React key, stable while the row exists. */
  key: string
  /** The stored print id when editing. */
  id?: string
  plate: string
  count: string
  grams: string
  time: string
  material: string
}

export interface HardwareRowForm {
  key: string
  hardwareId: string
  count: string
}

export interface ItemForm {
  name: string
  category: string
  heightSixths: string
  depth: string
  faces: FacesChoice
  holds: ItemHoldsKind
  slotW: string
  slotD: string
  slotH: string
  slotCategories: DeviceCategory[]
  look: RenderStyle
  prints: PrintRowForm[]
  hardware: HardwareRowForm[]
  link: string
  designer: string
  license: string
  checked: VerifyMethod
}

let rowCounter = 0

/** A fresh React key for a form row. */
export function rowKey(): string {
  rowCounter += 1
  return `row-${rowCounter}`
}

export function emptyPrintRow(): PrintRowForm {
  return { key: rowKey(), plate: '', count: '1', grams: '', time: '', material: '' }
}

function facesChoice(faces: readonly string[] | undefined): FacesChoice {
  const front = faces === undefined || faces.length === 0 || faces.includes('front')
  const rear = faces?.includes('rear') === true
  return front && rear ? 'both' : rear ? 'rear' : 'front'
}

const LOOKS = new Set<string>(PANEL_LOOK_CHOICES.map((choice) => choice.value))

const KNOWN_DEVICE_CATEGORIES = new Set<string>(
  DEVICE_CATEGORY_CHOICES.map((choice) => choice.value),
)

function isKnownCategory(category: string): category is DeviceCategory {
  return KNOWN_DEVICE_CATEGORIES.has(category)
}

export function itemForm(input: Partial<CustomItemInput> = {}): ItemForm {
  const holds = input.holds
  const kind: ItemHoldsKind = holds?.kind ?? 'device'
  const style = input.render?.style
  return {
    name: input.name ?? '',
    category: input.category ?? DEFAULT_CATEGORY[kind],
    heightSixths: String(input.heightSixths ?? SIXTHS_PER_U),
    depth: numberText(input.depthMm),
    faces: facesChoice(input.faces),
    holds: kind,
    slotW: holds === undefined || holds.kind === 'nothing' ? '' : numberText(holds.maxW),
    slotD: holds === undefined || holds.kind === 'nothing' ? '' : numberText(holds.maxD),
    slotH: holds === undefined || holds.kind === 'nothing' ? '' : numberText(holds.maxH),
    slotCategories:
      holds?.kind === 'device' ? (holds.categories ?? []).filter(isKnownCategory) : [],
    look: style !== undefined && LOOKS.has(style) ? style : 'blank',
    prints: (input.prints ?? []).map((row) => ({
      key: rowKey(),
      ...(row.id === undefined ? {} : { id: row.id }),
      plate: row.plate,
      count: String(row.count),
      grams: numberText(row.gramsPerPrint),
      time: row.minutesPerPrint === undefined ? '' : formatDuration(row.minutesPerPrint),
      material: row.material ?? '',
    })),
    hardware: (input.hardware ?? []).map((row) => ({
      key: rowKey(),
      hardwareId: row.hardwareId,
      count: String(row.count),
    })),
    link: input.sourceUrl ?? '',
    designer: input.designer ?? '',
    license: input.license ?? '',
    checked: input.verifiedMethod ?? 'unverified',
  }
}

/** The form after choosing what the part holds; the category follows while it was the default. */
export function withHolds(form: ItemForm, holds: ItemHoldsKind): ItemForm {
  const category =
    form.category === DEFAULT_CATEGORY[form.holds] ? DEFAULT_CATEGORY[holds] : form.category
  return { ...form, holds, category }
}

function renderFor(form: ItemForm): CustomItemInput['render'] {
  if (form.holds === 'device') return { style: 'tray' }
  if (form.holds === 'shelf') return { style: 'shelf' }
  return { style: form.look }
}

function checkPrintRows(form: ItemForm, issues: FormIssue[]): CustomItemInput['prints'] {
  return form.prints.map((row, index) => {
    const field = (name: string): string => `prints.${index}.${name}`
    const plate = row.plate.trim()
    if (plate === '') {
      issues.push({ field: field('plate'), message: 'Name the plate, like “Plate 1”.' })
    }
    const count = readNumber(
      row.count,
      {
        field: field('count'),
        what: 'how many you print',
        unit: '',
        required: 'Enter how many you print (1 or more).',
        integer: true,
        max: 999,
      },
      issues,
    )
    const grams = readNumber(
      row.grams,
      { field: field('grams'), what: 'the grams', unit: 'g', atLeast: true, max: 100_000 },
      issues,
    )
    const time = parseDuration(row.time)
    if (time.kind === 'invalid') {
      issues.push({
        field: field('time'),
        message: 'Enter the print time in minutes, or as 2:30 or 2h 30m.',
      })
    }
    const material = row.material.trim()
    return {
      ...(row.id === undefined ? {} : { id: row.id }),
      plate,
      count: count ?? 1,
      ...(grams === undefined ? {} : { gramsPerPrint: grams }),
      ...(time.kind === 'number' ? { minutesPerPrint: time.value } : {}),
      ...(material === '' ? {} : { material }),
    }
  })
}

function checkHardwareRows(form: ItemForm, issues: FormIssue[]): CustomItemInput['hardware'] {
  return form.hardware.map((row, index) => {
    const count = readNumber(
      row.count,
      {
        field: `hardware.${index}.count`,
        what: 'how many',
        unit: '',
        required: 'Enter how many (1 or more).',
        integer: true,
        max: 9999,
      },
      issues,
    )
    return { hardwareId: row.hardwareId, count: count ?? 1 }
  })
}

function checkHolds(
  form: ItemForm,
  heightSixths: number,
  issues: FormIssue[],
  warnings: FormIssue[],
): CustomHolds | undefined {
  if (form.holds === 'nothing') return { kind: 'nothing' }
  const device = form.holds === 'device'
  const what = device ? 'the largest device it takes' : 'the shelf'
  const maxW = readNumber(
    form.slotW,
    {
      field: 'slotW',
      what: `the width of ${what}`,
      unit: 'mm',
      required: device
        ? 'Enter the width of the largest device it takes, in mm.'
        : 'Enter how wide the shelf is, in mm.',
      max: MAX_MM,
    },
    issues,
  )
  const maxD = readNumber(
    form.slotD,
    {
      field: 'slotD',
      what: `the depth of ${what}`,
      unit: 'mm',
      required: device
        ? 'Enter the depth of the largest device it takes, in mm.'
        : 'Enter how deep the shelf is, in mm.',
      max: MAX_MM,
    },
    issues,
  )
  const maxH = readNumber(
    form.slotH,
    {
      field: 'slotH',
      what: device ? 'the height of the largest device it takes' : 'the room above the shelf',
      unit: 'mm',
      ...(device ? { required: 'Enter the height of the largest device it takes, in mm.' } : {}),
      max: MAX_MM,
    },
    issues,
  )
  warnings.push(...widthWarning('slotW', maxW, device ? 'The device space' : 'The shelf'))
  if (maxH !== undefined && maxH + 5 > sixthsToMm(heightSixths)) {
    warnings.push({
      field: 'slotH',
      message: `Taller than the part (${formatU(heightSixths)}): the rack keeps the space above it free.`,
    })
  }
  if (maxW === undefined || maxD === undefined) return undefined
  if (device) {
    if (maxH === undefined) return undefined
    return {
      kind: 'device',
      maxW,
      maxD,
      maxH,
      ...(form.slotCategories.length === 0 ? {} : { categories: [...form.slotCategories] }),
    }
  }
  return { kind: 'shelf', maxW, maxD, ...(maxH === undefined ? {} : { maxH }) }
}

export function checkItemForm(form: ItemForm, today?: string): FormCheck<CustomItemInput> {
  const issues: FormIssue[] = []
  const warnings: FormIssue[] = []
  const name = form.name.trim()
  if (name === '') {
    issues.push({ field: 'name', message: 'Give the part a name, like “Lenovo Tiny mount 1U”.' })
  }
  const heightSixths = Number(form.heightSixths)
  const depthMm = readNumber(
    form.depth,
    {
      field: 'depth',
      what: 'the depth',
      unit: 'mm',
      required: 'Enter how far it reaches into the rack, in mm.',
      max: MAX_MM,
    },
    issues,
  )
  const holds = checkHolds(form, heightSixths, issues, warnings)
  const prints = checkPrintRows(form, issues)
  const hardware = checkHardwareRows(form, issues)
  const link = readLink(form.link, 'link', issues)
  const designer = form.designer.trim()
  const license = form.license.trim()
  if ((designer !== '' || license !== '') && form.link.trim() === '') {
    issues.push({
      field: 'link',
      message: 'Add the link to the design: the designer and the licence go with it.',
    })
  }
  if (issues.length > 0 || depthMm === undefined || holds === undefined) {
    return { issues, warnings }
  }
  return {
    issues,
    warnings,
    value: {
      name,
      category: form.category,
      heightSixths,
      depthMm,
      faces: form.faces === 'both' ? ['front', 'rear'] : [form.faces],
      holds,
      render: renderFor(form),
      prints: prints ?? [],
      hardware: hardware ?? [],
      ...(link === undefined ? {} : { sourceUrl: link.url }),
      ...(designer === '' ? {} : { designer }),
      ...(license === '' ? {} : { license }),
      verifiedMethod: form.checked,
      ...(today === undefined ? {} : { today }),
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Frame form

export interface FrameForm {
  name: string
  heightU: string
  innerWidth: string
  depth: string
  rearOpen: boolean
  thread: Thread
  perHole: PerHole
  link: string
  checked: VerifyMethod
}

export function frameForm(input: Partial<CustomFrameInput> = {}): FrameForm {
  return {
    name: input.name ?? '',
    heightU: input.heightU === undefined ? '' : String(input.heightU),
    innerWidth: numberText(input.innerWidthMm ?? NOMINAL_OPENING_MM),
    depth: numberText(input.depthMm),
    rearOpen: input.rearOpen ?? true,
    thread: input.thread ?? 'M6',
    perHole: input.perHole ?? 'screw+cage-nut',
    link: input.sourceUrl ?? '',
    checked: input.verifiedMethod ?? 'unverified',
  }
}

/** Most 10-inch gear is designed to 210 mm or less (see GEAR_WIDTH_GUIDE_MM). */
const NARROW_OPENING_MM = 210

export function checkFrameForm(form: FrameForm, today?: string): FormCheck<CustomFrameInput> {
  const issues: FormIssue[] = []
  const warnings: FormIssue[] = []
  const name = form.name.trim()
  if (name === '') issues.push({ field: 'name', message: 'Give the rack a name.' })
  const heightU = readNumber(
    form.heightU,
    {
      field: 'heightU',
      what: 'the height in U',
      unit: 'U',
      required: 'Enter how many U tall the rack is.',
      integer: true,
      max: 60,
    },
    issues,
  )
  const innerWidthMm = readNumber(
    form.innerWidth,
    {
      field: 'innerWidth',
      what: 'the width between the rails',
      unit: 'mm',
      required: 'Enter the width between the rails in mm (usually 210 to 222).',
      min: 150,
      atLeast: true,
      max: 260,
    },
    issues,
  )
  const depthMm = readNumber(
    form.depth,
    {
      field: 'depth',
      what: 'the depth',
      unit: 'mm',
      required: 'Enter how deep the rack is, in mm.',
      max: MAX_MM,
    },
    issues,
  )
  const link = readLink(form.link, 'link', issues)
  if (innerWidthMm !== undefined && innerWidthMm < NARROW_OPENING_MM) {
    warnings.push({
      field: 'innerWidth',
      message: `Narrower than ${NARROW_OPENING_MM} mm: most 10-inch gear will not fit between the rails.`,
    })
  }
  if (form.thread === '12-24') {
    warnings.push({
      field: 'thread',
      message: 'The catalog has no #12-24 screws yet, so the shopping list will not count them.',
    })
  } else if (form.perHole === 'screw+cage-nut' && form.thread !== 'M6') {
    warnings.push({
      field: 'perHole',
      message: `The catalog has no ${form.thread} cage nuts yet, so the shopping list will not count them.`,
    })
  } else if (form.perHole === 'screw+nut' && form.thread === '10-32') {
    warnings.push({
      field: 'perHole',
      message: 'The catalog has no #10-32 nuts yet, so the shopping list will not count them.',
    })
  }
  if (
    issues.length > 0 ||
    heightU === undefined ||
    innerWidthMm === undefined ||
    depthMm === undefined
  ) {
    return { issues, warnings }
  }
  return {
    issues,
    warnings,
    value: {
      name,
      heightU,
      innerWidthMm,
      depthMm,
      rearOpen: form.rearOpen,
      thread: form.thread,
      perHole: form.perHole,
      ...(link === undefined ? {} : { sourceUrl: link.url }),
      verifiedMethod: form.checked,
      ...(today === undefined ? {} : { today }),
    },
  }
}
