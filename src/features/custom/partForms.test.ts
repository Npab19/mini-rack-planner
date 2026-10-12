import { describe, expect, it } from 'vitest'
import {
  customDeviceInputOf,
  customFrameInputOf,
  customItemInputOf,
  newCustomDevice,
  newCustomFrame,
  newCustomItem,
} from '@/domain/customParts'
import {
  checkDeviceForm,
  checkFrameForm,
  checkItemForm,
  deviceForm,
  emptyPrintRow,
  formatDuration,
  frameForm,
  heightChoices,
  itemForm,
  parseDuration,
  parseNumber,
  withHolds,
  type DeviceForm,
  type FormCheck,
  type FormIssue,
  type ItemForm,
} from './partForms'

const TODAY = '2026-10-11'
const NONE: ReadonlySet<string> = new Set()

function fields(issues: readonly FormIssue[]): string[] {
  return issues.map((issue) => issue.field)
}

function message(issues: readonly FormIssue[], field: string): string | undefined {
  return issues.find((issue) => issue.field === field)?.message
}

/** The form's domain input; fails the test with the form's problems when there is none. */
function valueOf<T>(check: FormCheck<T>): T {
  if (check.value === undefined) {
    throw new Error(
      `The form has problems: ${check.issues.map((issue) => issue.message).join(' ')}`,
    )
  }
  return check.value
}

const TINY: DeviceForm = {
  ...deviceForm(),
  brand: ' Lenovo ',
  model: 'ThinkCentre M720q Tiny',
  category: 'mini-pc',
  width: '179',
  depth: '183',
  height: '34,5',
  weight: '1320',
  power: 'brick',
}

const MOUNT: ItemForm = {
  ...itemForm(),
  name: 'Tiny mount 1U',
  depth: '190',
  slotW: '180',
  slotD: '184',
  slotH: '36',
  slotCategories: ['mini-pc'],
  prints: [
    { ...emptyPrintRow(), plate: 'Mount', count: '1', grams: '85', time: '2:30', material: 'PETG' },
  ],
  hardware: [{ key: 'hw-1', hardwareId: 'screw-m3x8-shcs', count: '4' }],
  link: 'https://makerworld.com/en/models/1945283-tiny-mount',
  designer: 'Tim',
  license: 'BY-SA',
}

describe('numbers and times', () => {
  it('reads numbers with a decimal point or comma', () => {
    expect(parseNumber('22.5')).toEqual({ kind: 'number', value: 22.5 })
    expect(parseNumber(' 22,5 ')).toEqual({ kind: 'number', value: 22.5 })
    expect(parseNumber('.5')).toEqual({ kind: 'number', value: 0.5 })
    expect(parseNumber('+3')).toEqual({ kind: 'number', value: 3 })
    expect(parseNumber('')).toEqual({ kind: 'empty' })
    for (const text of ['-3', '1e3', 'abc', '1.2.3', '12 mm']) {
      expect(parseNumber(text), text).toEqual({ kind: 'invalid' })
    }
  })

  it('reads print times as minutes, h:mm or hours and minutes', () => {
    const minutes = (text: string) => parseDuration(text)
    expect(minutes('150')).toEqual({ kind: 'number', value: 150 })
    expect(minutes('2:30')).toEqual({ kind: 'number', value: 150 })
    expect(minutes('2h 30m')).toEqual({ kind: 'number', value: 150 })
    expect(minutes('2 hours 5 min')).toEqual({ kind: 'number', value: 125 })
    expect(minutes('2 h')).toEqual({ kind: 'number', value: 120 })
    expect(minutes('45 min')).toEqual({ kind: 'number', value: 45 })
    expect(minutes('1,5h')).toEqual({ kind: 'number', value: 90 })
    expect(minutes('')).toEqual({ kind: 'empty' })
    expect(minutes('2:75')).toEqual({ kind: 'invalid' })
    expect(minutes('soon')).toEqual({ kind: 'invalid' })
    expect(formatDuration(150)).toBe('2:30')
    expect(formatDuration(60)).toBe('1:00')
    expect(formatDuration(45)).toBe('45')
  })

  it('offers the usual heights and keeps an unusual one', () => {
    expect(
      heightChoices(6)
        .map((choice) => choice.label)
        .slice(0, 6),
    ).toEqual(['⅓U', '½U', '⅔U', '1U', '1⅓U', '1½U'])
    expect(heightChoices(5).find((choice) => choice.value === '5')?.label).toBe('⅚U')
  })
})

describe('checkDeviceForm', () => {
  it('says what to type in every required field', () => {
    const { issues, value } = checkDeviceForm(deviceForm())
    expect(value).toBeUndefined()
    expect(fields(issues)).toEqual(['brand', 'model', 'category', 'width', 'depth', 'height'])
    expect(message(issues, 'width')).toBe('Enter the width in mm.')
    expect(message(issues, 'category')).toBe('Choose what kind of device it is.')
  })

  it('turns a filled form into the device input', () => {
    const { issues, warnings, value } = checkDeviceForm(TINY, TODAY)
    expect(issues).toEqual([])
    expect(warnings).toEqual([])
    expect(value).toEqual({
      brand: 'Lenovo',
      model: 'ThinkCentre M720q Tiny',
      category: 'mini-pc',
      widthMm: 179,
      depthMm: 183,
      heightMm: 34.5,
      weightG: 1320,
      power: 'brick',
      verifiedMethod: 'unverified',
      today: TODAY,
    })
  })

  it('checks numbers, watts and the link as they are typed', () => {
    const { issues } = checkDeviceForm({
      ...TINY,
      width: '0',
      depth: 'deep',
      height: '1200',
      power: 'ac',
      typicalW: '30',
      maxW: '20',
      link: 'not a link',
    })
    expect(message(issues, 'width')).toBe('Enter the width as a number above 0.')
    expect(message(issues, 'depth')).toBe(
      'Enter the depth as a number in mm, using digits like 22.5.',
    )
    expect(message(issues, 'height')).toBe(
      'That is more than 1000 mm: check the height (millimetres).',
    )
    expect(message(issues, 'maxW')).toBe('The maximum cannot be below the typical power.')
    expect(message(issues, 'link')).toMatch(/^Enter the full web address/)
  })

  it('keeps ear-mounted gear’s height, ignores watts without power and warns about width', () => {
    const { value, warnings } = checkDeviceForm({
      ...TINY,
      width: '250',
      earMounted: true,
      rackSixths: '3',
      power: 'none',
      typicalW: 'oops',
    })
    expect(value).toMatchObject({ rackmountSixths: 3, power: 'none' })
    expect(value?.typicalW).toBeUndefined()
    expect(message(warnings, 'width')).toBe(
      'It is wider than the 222.25 mm opening of a 10-inch rack.',
    )
  })

  it('shows a stored device as it was saved', () => {
    const device = newCustomDevice(
      { ...valueOf(checkDeviceForm(TINY, TODAY)), brickPlugsIntoWall: true, typicalW: 9 },
      NONE,
    )
    const form = deviceForm(customDeviceInputOf(device))
    expect(form).toMatchObject({ height: '34.5', power: 'brick', brickWall: true, typicalW: '9' })
    expect(newCustomDevice(valueOf(checkDeviceForm(form, TODAY)), NONE)).toEqual(device)
  })
})

describe('checkItemForm', () => {
  it('asks for a name, a depth and the space it offers', () => {
    const { issues } = checkItemForm(itemForm())
    expect(fields(issues)).toEqual(['name', 'depth', 'slotW', 'slotD', 'slotH'])
    expect(message(issues, 'slotW')).toBe('Enter the width of the largest device it takes, in mm.')
  })

  it('turns a mount with prints and hardware into the item input', () => {
    const { issues, value } = checkItemForm(MOUNT, TODAY)
    expect(issues).toEqual([])
    expect(value).toEqual({
      name: 'Tiny mount 1U',
      category: 'mount',
      heightSixths: 6,
      depthMm: 190,
      faces: ['front'],
      holds: { kind: 'device', maxW: 180, maxD: 184, maxH: 36, categories: ['mini-pc'] },
      render: { style: 'tray' },
      prints: [
        { plate: 'Mount', count: 1, gramsPerPrint: 85, minutesPerPrint: 150, material: 'PETG' },
      ],
      hardware: [{ hardwareId: 'screw-m3x8-shcs', count: 4 }],
      sourceUrl: 'https://makerworld.com/en/models/1945283-tiny-mount',
      designer: 'Tim',
      license: 'BY-SA',
      verifiedMethod: 'unverified',
      today: TODAY,
    })
  })

  it('checks print and hardware rows', () => {
    const { issues } = checkItemForm({
      ...MOUNT,
      prints: [{ ...emptyPrintRow(), plate: ' ', count: '1.5', time: 'soon', grams: '-2' }],
      hardware: [{ key: 'hw-1', hardwareId: 'screw-m3x8-shcs', count: '' }],
    })
    expect(fields(issues)).toEqual([
      'prints.0.plate',
      'prints.0.count',
      'prints.0.grams',
      'prints.0.time',
      'hardware.0.count',
    ])
    expect(message(issues, 'prints.0.count')).toBe('Enter how many you print as a whole number.')
  })

  it('needs the link when a designer or licence is given', () => {
    const { issues } = checkItemForm({ ...MOUNT, link: '' })
    expect(message(issues, 'link')).toBe(
      'Add the link to the design: the designer and the licence go with it.',
    )
  })

  it('makes panels and shelves', () => {
    const panel = withHolds({ ...MOUNT, faces: 'both', look: 'vent' }, 'nothing')
    expect(panel.category).toBe('panel')
    expect(checkItemForm(panel).value).toMatchObject({
      holds: { kind: 'nothing' },
      faces: ['front', 'rear'],
      render: { style: 'vent' },
    })
    const shelf = withHolds({ ...MOUNT, slotH: '' }, 'shelf')
    expect(shelf.category).toBe('shelf')
    expect(checkItemForm(shelf).value?.holds).toEqual({ kind: 'shelf', maxW: 180, maxD: 184 })
    // A category the user chose stays when what it holds changes.
    expect(withHolds({ ...MOUNT, category: 'power' }, 'shelf').category).toBe('power')
  })

  it('notes a device taller than the part', () => {
    const { warnings } = checkItemForm({ ...MOUNT, heightSixths: '3', slotH: '36' })
    expect(message(warnings, 'slotH')).toBe(
      'Taller than the part (½U): the rack keeps the space above it free.',
    )
  })

  it('shows a stored item as it was saved', () => {
    const item = newCustomItem(valueOf(checkItemForm(MOUNT, TODAY)), NONE)
    const form = itemForm(customItemInputOf(item))
    expect(form.prints[0]).toMatchObject({ id: 'mount', time: '2:30', grams: '85' })
    expect(newCustomItem(valueOf(checkItemForm(form, TODAY)), NONE)).toEqual(item)
  })
})

describe('checkFrameForm', () => {
  const RACK = {
    ...frameForm(),
    name: 'RackMate T1',
    heightU: '8',
    innerWidth: '220',
    depth: '300',
  }

  it('starts with the usual 10-inch values and asks for the rest', () => {
    const form = frameForm()
    expect(form).toMatchObject({
      innerWidth: '222.25',
      rearOpen: true,
      thread: 'M6',
      perHole: 'screw+cage-nut',
    })
    expect(fields(checkFrameForm(form).issues)).toEqual(['name', 'heightU', 'depth'])
    expect(message(checkFrameForm({ ...RACK, heightU: '7.5' }).issues, 'heightU')).toBe(
      'Enter the height in U as a whole number.',
    )
    expect(message(checkFrameForm({ ...RACK, innerWidth: '120' }).issues, 'innerWidth')).toBe(
      'Enter the width between the rails as a number 150 or more.',
    )
  })

  it('turns the form into the frame input and notes missing hardware', () => {
    expect(checkFrameForm(RACK, TODAY).value).toEqual({
      name: 'RackMate T1',
      heightU: 8,
      innerWidthMm: 220,
      depthMm: 300,
      rearOpen: true,
      thread: 'M6',
      perHole: 'screw+cage-nut',
      verifiedMethod: 'unverified',
      today: TODAY,
    })
    expect(checkFrameForm({ ...RACK, innerWidth: '205' }).warnings.map((w) => w.field)).toEqual([
      'innerWidth',
    ])
    expect(checkFrameForm({ ...RACK, thread: '12-24' }).warnings.map((w) => w.field)).toEqual([
      'thread',
    ])
    expect(checkFrameForm({ ...RACK, thread: 'M5' }).warnings.map((w) => w.message)).toEqual([
      'The catalog has no M5 cage nuts yet, so the shopping list will not count them.',
    ])
  })

  it('shows a stored frame as it was saved', () => {
    const frame = newCustomFrame(valueOf(checkFrameForm(RACK, TODAY)), NONE)
    const form = frameForm(customFrameInputOf(frame))
    expect(newCustomFrame(valueOf(checkFrameForm(form, TODAY)), NONE)).toEqual(frame)
  })
})
