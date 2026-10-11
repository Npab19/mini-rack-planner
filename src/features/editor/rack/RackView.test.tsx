import 'fake-indexeddb/auto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadBundledCatalog } from '@/catalog/loader'
import { Toaster } from '@/components/ui/sonner'
import { resetDbForTests } from '@/db/db'
import { createPlan } from '@/db/plansRepo'
import { addPlacement } from '@/domain/placement'
import type { Placement, Plan } from '@/domain/schema/plan'
import { buildSamplePlan } from '@/features/plans/sample'
import { stopLibrarySync } from '@/state/catalogStore'
import { usePlanStore } from '@/state/planStore'
import { useUiStore } from '@/state/uiStore'
import { useEditorState, type PlaceSource } from '../editorState'
import { requestAddAtU } from '../toolbar/addAtURequest'
import { requestFit } from '../toolbar/fitRequest'
import { invertMatrix } from './pointer'
import { RackView } from './RackView'

const NOW = '2026-10-11T09:30:00.000Z'
const lookup = loadBundledCatalog().lookup
const BLANK: PlaceSource = { kind: 'item', itemId: 'generic-blank-1u' }

/**
 * The KWS 9U -> 12U sample: 3U (Have) U1–U3 with the power-supplies shelf (U1–U2) and a blank
 * (U3); 6U (Have) U4–U9 with a Lenovo Tiny mount at U4; a new 3U (To get) U10–U12 with a drive
 * rack at U10.
 */
function sample(): Plan {
  return buildSamplePlan(lookup, NOW).plan
}

/** The user's 3U + 6U (both owned) with a 2U shelf across the joint (U3–U4). */
function straddlingPlan(): Plan {
  const base = sample()
  const sections = base.frame.sections.slice(0, 2)
  const plan: Plan = { ...base, frame: { ...base.frame, sections }, placements: [] }
  return addPlacement(plan, lookup, { itemId: 'generic-shelf-2u', y: 12 }).plan
}

async function open(plan: Plan): Promise<void> {
  const stored = await createPlan(plan)
  await act(async () => {
    await usePlanStore.getState().load(stored.id)
  })
}

function current(): Plan {
  const plan = usePlanStore.getState().plan
  if (plan === null) throw new Error('no plan open')
  return plan
}

function placementOf(itemId: string): Placement {
  const found = current().placements.find((placement) => placement.itemId === itemId)
  if (found === undefined) throw new Error(`no ${itemId}`)
  return found
}

function renderRack() {
  return render(
    <>
      <RackView />
      <Toaster />
    </>,
  )
}

/**
 * Gives the drawing a screen CTM (jsdom has no layout): the SVG at the client origin, scaled
 * like its width attribute says. Returns where to point for an x (mm) and a U's middle.
 */
function pointerFor(svg: SVGSVGElement) {
  const [minX = 0, minY = 0, width = 1] = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number)
  const scale = Number(svg.getAttribute('width')) / width
  const ctm = { a: scale, b: 0, c: 0, d: scale, e: -minX * scale, f: -minY * scale }
  Object.defineProperty(svg, 'getScreenCTM', {
    configurable: true,
    value: () => ({ ...ctm, inverse: () => invertMatrix(ctm) }),
  })
  return (u: number, xMm = 127) => {
    const label = svg.querySelector(`[data-u-label="${u}"]`)
    const y = Number(label?.getAttribute('y'))
    return { clientX: (xMm - minX) * scale, clientY: (y - minY) * scale, pointerType: 'mouse' }
  }
}

async function drawing(): Promise<SVGSVGElement> {
  const svg = await screen.findByTestId('rack-svg')
  if (!(svg instanceof SVGSVGElement)) throw new Error('not an svg')
  return svg
}

function rackRegion(): HTMLElement {
  return screen.getByRole('region', { name: 'Rack' })
}

function liveText(): string {
  return within(rackRegion())
    .getAllByRole('status')
    .map((region) => region.textContent ?? '')
    .join(' | ')
}

function startPlacing(source: PlaceSource): void {
  act(() => useEditorState.getState().startPlacing(source))
}

beforeEach(async () => {
  await resetDbForTests()
  // The toaster follows the colour scheme; jsdom has no matchMedia.
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  })
})

afterEach(async () => {
  cleanup()
  await act(async () => {
    await usePlanStore.getState().unload()
  })
  stopLibrarySync()
  useEditorState.getState().reset()
  useUiStore.setState({ selection: [], face: 'front', zoom: 1, recordingMode: {} })
})

describe('RackView: drawing', () => {
  it('draws the sections with In my rack / To get and the placements with their U range', async () => {
    await open(sample())
    renderRack()
    const svg = await drawing()
    expect(svg).toHaveAttribute('aria-label', 'Rack, front view: 12U, 3 sections, 4 items')

    const [bottom, middle, top] = current().frame.sections
    expect(screen.getByTestId(`rack-section-band-${bottom?.id}`)).toHaveAttribute(
      'data-have',
      'true',
    )
    expect(screen.getByTestId(`rack-section-band-${middle?.id}`)).toHaveAccessibleName(
      '6U section, U4–U9, In my rack',
    )
    const newSection = screen.getByTestId(`rack-section-band-${top?.id}`)
    expect(newSection).toHaveAttribute('data-have', 'false')
    expect(within(newSection).getByText('To get')).toBeInTheDocument()

    const expected: Array<[string, string, string, string]> = [
      ['kws-power-supplies-shelf-2u', '1', '2', 'true'],
      ['generic-blank-1u', '3', '3', 'true'],
      ['lenovo-tiny-mount-1u', '4', '4', 'true'],
      ['two-3-5-drive-rack-1u', '10', '10', 'false'],
    ]
    for (const [itemId, start, end, have] of expected) {
      const element = screen.getByTestId(`rack-placement-${placementOf(itemId).id}`)
      expect(element).toHaveAttribute('data-u-start', start)
      expect(element).toHaveAttribute('data-u-end', end)
      expect(element).toHaveAttribute('data-have', have)
    }
    const driveRack = screen.getByTestId(
      `rack-placement-${placementOf('two-3-5-drive-rack-1u').id}`,
    )
    expect(driveRack).toHaveAccessibleName(
      'Two 3.5-inch drive rack 1U, U10, To get, holds Generic 3.5-inch drive (To get), Generic 3.5-inch drive (To get)',
    )
    // To get is hatched and tagged in words, not only coloured.
    expect(driveRack.querySelector('[data-pattern="need"]')).not.toBeNull()
    expect(within(driveRack).getAllByText('To get').length).toBeGreaterThan(0)
    // The devices are drawn inside their mounts.
    expect(driveRack.querySelectorAll('[data-device-id]')).toHaveLength(2)
  })

  it('lists the stack for screen readers, with buttons that select', async () => {
    await open(sample())
    renderRack()
    await drawing()
    const contents = screen.getByRole('region', { name: 'Rack contents, top to bottom' })
    const buttons = within(contents).getAllByRole('button')
    expect(buttons[0]).toHaveAccessibleName('3U section, U10–U12, To get')
    expect(buttons[1]).toHaveAccessibleName('Two 3.5-inch drive rack 1U, U10, To get')
    // One tab stop for the whole list.
    expect(buttons.filter((button) => button.tabIndex === 0)).toHaveLength(1)
    const lenovo = within(contents).getByRole('button', {
      name: 'Lenovo Tiny mount 1U, U4, In my rack',
    })
    fireEvent.click(lenovo)
    expect(useUiStore.getState().selection).toEqual([placementOf('lenovo-tiny-mount-1u').id])
    expect(useEditorState.getState().inspectorTab).toBe('selection')
    expect(lenovo).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('RackView: click to place', () => {
  it('shows a ghost that fits on a free U and says why on a taken one', async () => {
    await open(sample())
    renderRack()
    const svg = await drawing()
    startPlacing(BLANK)
    const at = pointerFor(svg)

    fireEvent.pointerMove(svg, at(9))
    const ghost = screen.getByTestId('rack-ghost')
    expect(ghost).toHaveAttribute('data-ok', 'true')
    expect(ghost).toHaveAttribute('data-u-start', '9')
    expect(useEditorState.getState().ghost).toMatchObject({ y: 48, heightSixths: 6, ok: true })
    expect(screen.getByTestId('rack-ghost-status')).toHaveTextContent('Fits at U9')

    fireEvent.pointerMove(svg, at(4))
    expect(screen.getByTestId('rack-ghost')).toHaveAttribute('data-ok', 'false')
    expect(screen.getByTestId('rack-ghost-status')).toHaveTextContent(
      'It overlaps Lenovo Tiny mount 1U (U4).',
    )

    fireEvent.pointerLeave(svg, { pointerType: 'mouse' })
    expect(screen.queryByTestId('rack-ghost')).toBeNull()
  })

  it('places on click, then stops placing and selects the new part for the inspector', async () => {
    await open(sample())
    renderRack()
    const svg = await drawing()
    startPlacing(BLANK)
    const at = pointerFor(svg)
    const before = current().placements.length

    // A blocked spot says why and places nothing.
    fireEvent.click(svg, at(4))
    expect(current().placements).toHaveLength(before)
    expect(liveText()).toContain(
      "Blank panel 1U can't go at U4: It overlaps Lenovo Tiny mount 1U (U4).",
    )
    expect(useEditorState.getState().placing).toEqual(BLANK)

    fireEvent.pointerMove(svg, at(9))
    fireEvent.click(svg, at(9))
    expect(current().placements).toHaveLength(before + 1)
    const added = current().placements.at(-1)
    expect(added).toMatchObject({ itemId: 'generic-blank-1u', y: 48 })
    expect(added?.have).toBeUndefined()
    expect(liveText()).toContain('Placed Blank panel 1U at U9. It is selected.')
    expect(useEditorState.getState().placing).toBeNull()
    expect(screen.queryByTestId('rack-ghost')).toBeNull()
    expect(useUiStore.getState().selection).toEqual([added?.id])
    expect(useEditorState.getState().inspectorTab).toBe('selection')
    expect(screen.getByTestId(`rack-placement-${added?.id}`)).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('keeps placing on Shift-click, so several go in a row', async () => {
    await open(sample())
    renderRack()
    const svg = await drawing()
    startPlacing(BLANK)
    const at = pointerFor(svg)
    const before = current().placements.length

    fireEvent.pointerMove(svg, at(9))
    fireEvent.click(svg, { ...at(9), shiftKey: true })
    expect(current().placements).toHaveLength(before + 1)
    expect(liveText()).toContain('Placed Blank panel 1U at U9. Still placing')
    // Still placing; the spot just used now shows as taken.
    expect(useEditorState.getState().placing).toEqual(BLANK)
    expect(screen.getByTestId('rack-ghost')).toHaveAttribute('data-ok', 'false')

    fireEvent.click(svg, { ...at(8), shiftKey: true })
    fireEvent.click(svg, at(7))
    expect(
      current()
        .placements.slice(before)
        .map((placement) => placement.y),
    ).toEqual([48, 42, 36])
    expect(useEditorState.getState().placing).toBeNull()
  })

  it('places a device from the tray once, even on Shift-click', async () => {
    const base = sample()
    await open({
      ...base,
      equipment: [{ id: 'eq-pc', deviceId: 'lenovo-thinkcentre-m720q-tiny', have: true }],
    })
    renderRack()
    const svg = await drawing()
    startPlacing({ kind: 'item', itemId: 'lenovo-tiny-mount-1u', equipmentId: 'eq-pc' })
    fireEvent.click(svg, { ...pointerFor(svg)(9), shiftKey: true })
    expect(current().placements.at(-1)).toMatchObject({
      itemId: 'lenovo-tiny-mount-1u',
      y: 48,
      devices: [expect.objectContaining({ deviceId: 'lenovo-thinkcentre-m720q-tiny', have: true })],
    })
    // It left the tray, so there is nothing more to place.
    expect(current().equipment).toEqual([])
    expect(useEditorState.getState().placing).toBeNull()
  })

  it('marks what is placed In my rack in Recording mode', async () => {
    await open(sample())
    useUiStore.getState().setRecordingMode(current().id, true)
    renderRack()
    const svg = await drawing()
    startPlacing(BLANK)
    fireEvent.click(svg, pointerFor(svg)(8))
    expect(current().placements.at(-1)).toMatchObject({
      itemId: 'generic-blank-1u',
      y: 42,
      have: expect.objectContaining({ itemId: 'generic-blank-1u' }),
    })
  })

  it('places from the keyboard: the focused drawing moves a ghost and Enter places it', async () => {
    await open(sample())
    renderRack()
    const svg = await drawing()
    startPlacing(BLANK)
    // jsdom has no input modality: say this focus came from the keyboard (as after the palette's
    // Place button was pressed with Enter).
    const matches = svg.matches.bind(svg)
    Object.defineProperty(svg, 'matches', {
      configurable: true,
      value: (selector: string) => selector === ':focus-visible' || matches(selector),
    })
    act(() => svg.focus())
    // The lowest free U for a 1U blank is U5.
    expect(screen.getByTestId('rack-ghost')).toHaveAttribute('data-u-start', '5')
    expect(liveText()).toContain('Placing Blank panel 1U')
    expect(liveText()).toContain('U5: free.')

    fireEvent.keyDown(svg, { key: 'ArrowUp' })
    expect(screen.getByTestId('rack-ghost')).toHaveAttribute('data-u-start', '6')
    fireEvent.keyDown(svg, { key: 'ArrowUp', shiftKey: true })
    expect(screen.getByTestId('rack-ghost')).toHaveAttribute('data-u-start', '11')
    expect(liveText()).toContain('U11: free.')
    fireEvent.keyDown(svg, { key: 'ArrowDown' })
    expect(liveText()).toContain('U10: It overlaps Two 3.5-inch drive rack 1U (U10).')
    fireEvent.keyDown(svg, { key: 'Enter' })
    expect(liveText()).toContain("can't go at U10")
    fireEvent.keyDown(svg, { key: 'ArrowDown' })
    fireEvent.keyDown(svg, { key: 'Enter' })
    const added = current().placements.at(-1)
    expect(added).toMatchObject({ itemId: 'generic-blank-1u', y: 48 })
    expect(liveText()).toContain(
      'Placed Blank panel 1U at U9. It is selected; the arrow keys move it.',
    )
    // Placing is over; the new part has focus, so the arrows now move it.
    expect(useEditorState.getState().placing).toBeNull()
    await waitFor(() => expect(screen.getByTestId(`rack-placement-${added?.id}`)).toHaveFocus())
    expect(useEditorState.getState().moving).toBe(added?.id)
  })

  it('starts the keyboard ghost only for keyboard focus, but the arrows work either way', async () => {
    await open(sample())
    renderRack()
    const svg = await drawing()
    startPlacing(BLANK)
    // A mouse click on empty space focuses the drawing too (no focus ring): no announcement.
    act(() => svg.focus())
    expect(screen.queryByTestId('rack-ghost')).toBeNull()
    expect(liveText()).not.toContain('Placing Blank panel 1U')
    // The first key shows the lowest free spot (Enter does not place blind)…
    fireEvent.keyDown(svg, { key: 'Enter' })
    expect(screen.getByTestId('rack-ghost')).toHaveAttribute('data-u-start', '5')
    expect(liveText()).toContain('U5: free.')
    expect(current().placements).toHaveLength(4)
    // …then the arrows move on from there.
    fireEvent.keyDown(svg, { key: 'ArrowUp' })
    expect(screen.getByTestId('rack-ghost')).toHaveAttribute('data-u-start', '6')
    expect(liveText()).toContain('U6: free.')
  })

  it('continues from the pointer ghost when the keys take over', async () => {
    await open(sample())
    renderRack()
    const svg = await drawing()
    startPlacing(BLANK)
    fireEvent.pointerMove(svg, pointerFor(svg)(7))
    expect(screen.getByTestId('rack-ghost')).toHaveAttribute('data-u-start', '7')
    fireEvent.keyDown(svg, { key: 'ArrowUp' })
    expect(screen.getByTestId('rack-ghost')).toHaveAttribute('data-u-start', '8')
  })

  it('opens "Add at U…" when the placing banner asks for it; placing it ends placing', async () => {
    await open(sample())
    renderRack()
    await drawing()
    startPlacing(BLANK)
    act(() => {
      expect(requestAddAtU()).toBe(true)
    })
    const dialog = await screen.findByRole('dialog', { name: 'Add Blank panel 1U at…' })
    fireEvent.click(within(dialog).getByRole('radio', { name: 'U9' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add at U9' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const added = current().placements.at(-1)
    expect(added).toMatchObject({ itemId: 'generic-blank-1u', y: 48 })
    expect(useEditorState.getState().placing).toBeNull()
    expect(useUiStore.getState().selection).toEqual([added?.id])
    // The banner that asked is gone: focus goes to the new part.
    await waitFor(() => expect(screen.getByTestId(`rack-placement-${added?.id}`)).toHaveFocus())
  })

  it('adds what the palette or the inspector asks for, without placing anything', async () => {
    await open(sample())
    renderRack()
    await drawing()
    act(() => {
      expect(requestAddAtU({ kind: 'item', itemId: 'generic-vent-1u' })).toBe(true)
    })
    const dialog = await screen.findByRole('dialog', { name: 'Add Vented panel 1U at…' })
    expect(useEditorState.getState().placing).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add at U5' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const added = current().placements.at(-1)
    expect(added).toMatchObject({ itemId: 'generic-vent-1u', y: 24 })
    expect(useUiStore.getState().selection).toEqual([added?.id])
  })
})

describe('RackView: keyboard editing', () => {
  it('roves with the arrows, selects with Enter and moves the selected item', async () => {
    await open(sample())
    renderRack()
    await drawing()
    const lenovo = placementOf('lenovo-tiny-mount-1u')
    const blank = placementOf('generic-blank-1u')
    const driveRack = placementOf('two-3-5-drive-rack-1u')
    const lenovoShape = screen.getByTestId(`rack-placement-${lenovo.id}`)
    // One tab stop: the top item.
    expect(screen.getByTestId(`rack-placement-${driveRack.id}`)).toHaveAttribute('tabindex', '0')
    expect(lenovoShape).toHaveAttribute('tabindex', '-1')

    act(() => lenovoShape.focus())
    fireEvent.keyDown(lenovoShape, { key: 'ArrowUp' })
    expect(screen.getByTestId(`rack-placement-${driveRack.id}`)).toHaveFocus()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'ArrowDown' })
    expect(lenovoShape).toHaveFocus()

    fireEvent.keyDown(lenovoShape, { key: 'Enter' })
    expect(useUiStore.getState().selection).toEqual([lenovo.id])
    expect(useEditorState.getState().inspectorTab).toBe('selection')
    expect(useEditorState.getState().moving).toBe(lenovo.id)

    fireEvent.keyDown(lenovoShape, { key: 'ArrowUp' })
    expect(placementOf('lenovo-tiny-mount-1u').y).toBe(24)
    expect(liveText()).toContain('Moved Lenovo Tiny mount 1U up to U5.')
    expect(lenovoShape).toHaveFocus()

    fireEvent.keyDown(lenovoShape, { key: 'ArrowDown' })
    fireEvent.keyDown(lenovoShape, { key: 'ArrowDown' })
    expect(placementOf('lenovo-tiny-mount-1u').y).toBe(18)
    expect(liveText()).toContain(
      "Can't move Lenovo Tiny mount 1U down: It overlaps Blank panel 1U (U3).",
    )

    fireEvent.keyDown(lenovoShape, { key: 'ArrowUp', shiftKey: true })
    expect(placementOf('lenovo-tiny-mount-1u').y).toBe(48)

    fireEvent.keyDown(lenovoShape, { key: 'Escape' })
    expect(useUiStore.getState().selection).toEqual([])
    // Alt moves without selecting first.
    const blankShape = screen.getByTestId(`rack-placement-${blank.id}`)
    act(() => blankShape.focus())
    fireEvent.keyDown(blankShape, { key: 'ArrowUp', altKey: true })
    expect(placementOf('generic-blank-1u').y).toBe(18)
  })

  it('rings the keyboard-focused item outside its edges, apart from the selection ring', async () => {
    await open(sample())
    renderRack()
    await drawing()
    const blank = placementOf('generic-blank-1u')
    const shape = screen.getByTestId(`rack-placement-${blank.id}`)
    // jsdom has no input modality: this focus came from the keyboard.
    const matches = shape.matches.bind(shape)
    Object.defineProperty(shape, 'matches', {
      configurable: true,
      value: (selector: string) => selector === ':focus-visible' || matches(selector),
    })
    act(() => shape.focus())
    const ring = document.querySelector(`[data-focus-ring="${blank.id}"]`)
    expect(ring).not.toBeNull()
    fireEvent.keyDown(shape, { key: ' ' })
    expect(shape.querySelector('[data-selection-ring]')).not.toBeNull()
    act(() => shape.blur())
    expect(document.querySelector('[data-focus-ring]')).toBeNull()
  })

  it('removes with Delete (Undo in the toast) and duplicates with Ctrl+D', async () => {
    await open(sample())
    renderRack()
    await drawing()
    const driveRack = placementOf('two-3-5-drive-rack-1u')
    const shape = screen.getByTestId(`rack-placement-${driveRack.id}`)
    act(() => shape.focus())
    fireEvent.keyDown(shape, { key: 'Delete' })
    expect(current().placements.some((placement) => placement.id === driveRack.id)).toBe(false)
    // Its planned drives go back to Equipment to fit.
    expect(current().equipment.map((entry) => entry.deviceId)).toEqual([
      'drive-3-5-inch',
      'drive-3-5-inch',
    ])
    expect(liveText()).toContain('Removed Two 3.5-inch drive rack 1U from U10.')
    // Focus moves on to the next item down.
    await waitFor(() =>
      expect(
        screen.getByTestId(`rack-placement-${placementOf('lenovo-tiny-mount-1u').id}`),
      ).toHaveFocus(),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    expect(current().placements.some((placement) => placement.id === driveRack.id)).toBe(true)

    const blank = placementOf('generic-blank-1u')
    const blankShape = screen.getByTestId(`rack-placement-${blank.id}`)
    act(() => blankShape.focus())
    fireEvent.keyDown(blankShape, { key: 'd', ctrlKey: true })
    const copies = current().placements.filter(
      (placement) => placement.itemId === 'generic-blank-1u',
    )
    expect(copies.map((placement) => placement.y)).toEqual([12, 24])
    expect(liveText()).toContain('Duplicated Blank panel 1U to U5.')
    const copy = copies[1]
    expect(useUiStore.getState().selection).toEqual([copy?.id])
    await waitFor(() => expect(screen.getByTestId(`rack-placement-${copy?.id}`)).toHaveFocus())
  })

  it('removes an owned item to Retired', async () => {
    await open(sample())
    renderRack()
    await drawing()
    const blank = placementOf('generic-blank-1u')
    const shape = screen.getByTestId(`rack-placement-${blank.id}`)
    act(() => shape.focus())
    fireEvent.keyDown(shape, { key: 'Backspace' })
    expect(current().retired).toEqual([
      expect.objectContaining({ kind: 'placement', sourceId: blank.id }),
    ])
    expect(liveText()).toContain('You have it, so it is kept under Retired.')
  })
})

describe('RackView: sections', () => {
  it('selects a section from its band', async () => {
    await open(sample())
    renderRack()
    await drawing()
    const section = current().frame.sections[1]
    fireEvent.click(screen.getByTestId(`rack-section-band-${section?.id}`))
    expect(useUiStore.getState().selection).toEqual([section?.id])
    expect(useEditorState.getState().inspectorTab).toBe('selection')
    expect(liveText()).toContain('Selected Section 2 (6U).')
  })

  it('adds a section from a + handle (In my rack while recording)', async () => {
    await open(sample())
    useUiStore.getState().setRecordingMode(current().id, true)
    renderRack()
    await drawing()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add a section on top' }))
    })
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByText('Top of the rack')).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Add 3U above' }))
    })
    const sections = current().frame.sections
    expect(sections).toHaveLength(4)
    expect(sections[3]).toMatchObject({
      typeId: 's3',
      have: expect.objectContaining({ typeId: 's3' }),
    })
    expect(liveText()).toContain(
      'Added a 3U section on top, marked In my rack. Stack, bottom to top: 3U + 6U + 3U + 3U · 15U.',
    )
    expect(useUiStore.getState().selection).toEqual([sections[3]?.id])
  })

  it('asks what to do with a part across the joint, then inserts with that choice', async () => {
    await open(straddlingPlan())
    renderRack()
    await drawing()
    const shelf = placementOf('generic-shelf-2u')
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', {
          name: 'Add a section between Section 1 (3U) and Section 2 (6U)',
        }),
      )
    })
    await act(async () => {
      fireEvent.click(
        within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Add 3U here' }),
      )
    })
    // The same dialog as the Rack tab's stack editor.
    const dialog = await screen.findByRole('dialog', {
      name: 'Before you add a 3U section between Section 1 (3U) and Section 2 (6U)',
    })
    expect(
      within(dialog).getByText(/Shelf 2U spans Section 1 \(3U\) and Section 2 \(6U\)/),
    ).toBeInTheDocument()
    expect(current().frame.sections).toHaveLength(2)

    fireEvent.click(within(dialog).getByRole('radio', { name: 'Move them with the upper section' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const sections = current().frame.sections
    expect(sections).toHaveLength(3)
    // It moved up with the 6U section, by the new 3U.
    expect(placementOf('generic-shelf-2u')).toMatchObject({ id: shelf.id, y: 30 })
    expect(liveText()).toContain('Added a 3U section between Section 1 (3U) and Section 2 (6U).')
    // The new section is selected for the inspector.
    expect(useUiStore.getState().selection).toEqual([sections[1]?.id])
  })

  it('cancels an insert that would split a part, changing nothing', async () => {
    await open(straddlingPlan())
    renderRack()
    await drawing()
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', {
          name: 'Add a section between Section 1 (3U) and Section 2 (6U)',
        }),
      )
    })
    await act(async () => {
      fireEvent.click(
        within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Add 6U here' }),
      )
    })
    const dialog = await screen.findByRole('dialog', {
      name: 'Before you add a 6U section between Section 1 (3U) and Section 2 (6U)',
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(current().frame.sections).toHaveLength(2)
    expect(placementOf('generic-shelf-2u').y).toBe(12)
  })
})

describe('RackView: zoom', () => {
  it('fits the rack height to the view when the toolbar asks', async () => {
    await open(sample())
    renderRack()
    await drawing()
    const scroller = screen.getByTestId('rack-scroll')
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 416 })
    act(() => {
      expect(requestFit()).toBe(true)
    })
    // 12U + margins = 581.4 mm at 1.5 px/mm into 400 px.
    expect(useUiStore.getState().zoom).toBeCloseTo(400 / (581.4 * 1.5), 3)
    const svg = await drawing()
    expect(Number(svg.getAttribute('height'))).toBeCloseTo(400, 0)
  })
})
