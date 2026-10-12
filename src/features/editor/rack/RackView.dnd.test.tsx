/**
 * Pointer gestures on the rack (M3b): moving placed parts, panning, pinch and wheel zoom, and
 * palette / tray drops. jsdom has no layout, so the drawing gets a screen CTM that follows its
 * size (the zoom) and the scroll position, like a browser's; drops are driven through the rack's
 * registered drop target (`rackDropTarget`), which the dnd-kit host calls in the browser (the E2E
 * specs cover that path).
 */
import 'fake-indexeddb/auto'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadBundledCatalog } from '@/catalog/loader'
import { Toaster } from '@/components/ui/sonner'
import { resetDbForTests } from '@/db/db'
import { createPlan } from '@/db/plansRepo'
import { SIXTH_MM, U_MM } from '@/domain/geometry'
import { addPlacement } from '@/domain/placement'
import type { Placement, Plan } from '@/domain/schema/plan'
import { buildSamplePlan } from '@/features/plans/sample'
import { stopLibrarySync } from '@/state/catalogStore'
import { usePlanStore } from '@/state/planStore'
import { useUiStore } from '@/state/uiStore'
import { useEditorState } from '../editorState'
import { useMountDialogs } from '../mounts/mountDialogsStore'
import { resetRackDrag, startCarrying } from './dragStore'
import type { DragSubject } from './dragSubject'
import { applyMatrix, invertMatrix, type MatrixLike } from './pointer'
import { rackDropTarget } from './rackDropTarget'
import { RackView } from './RackView'

const NOW = '2026-10-11T09:30:00.000Z'
const lookup = loadBundledCatalog().lookup

/**
 * The KWS 9U -> 12U sample: power-supplies shelf U1–U2, blank U3, Lenovo Tiny mount (with its PC)
 * U4, drive rack U10; U5–U9 and U11–U12 are free.
 */
function sample(): Plan {
  return buildSamplePlan(lookup, NOW).plan
}

/** The sample with an empty 2U shelf at U7–U8. */
function withShelf(): Plan {
  return addPlacement(sample(), lookup, { itemId: 'generic-shelf-2u', y: 36 }).plan
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

function liveText(): string {
  return within(screen.getByRole('region', { name: 'Rack' }))
    .getAllByRole('status')
    .map((region) => region.textContent ?? '')
    .join(' | ')
}

interface Camera {
  svg: SVGSVGElement
  scroller: HTMLElement
  /** Client px of a rack height (fractional sixths) and an x across the panel (mm). */
  at: (rawSixths: number, xMm?: number) => { clientX: number; clientY: number }
  /** The middle of U `u`. */
  middle: (u: number, xMm?: number) => { clientX: number; clientY: number }
  /** The drawing point (mm) under a client point, now. */
  drawingAt: (clientX: number, clientY: number) => { x: number; y: number }
}

/** Where the drawing's top left sits on screen before scrolling. */
const ORIGIN = { x: 40, y: 30 }

/**
 * A screen CTM like a browser's: the SVG at ORIGIN, minus the scroll position, scaled by its
 * width attribute (the zoom). The viewport is a big rect, so every point is inside it.
 */
async function camera(): Promise<Camera> {
  const svg = await screen.findByTestId('rack-svg')
  if (!(svg instanceof SVGSVGElement)) throw new Error('not an svg')
  const scroller = screen.getByTestId('rack-scroll')
  function matrix(): MatrixLike {
    const [minX = 0, minY = 0, width = 1] = (svg.getAttribute('viewBox') ?? '')
      .split(' ')
      .map(Number)
    const scale = Number(svg.getAttribute('width')) / width
    return {
      a: scale,
      b: 0,
      c: 0,
      d: scale,
      e: ORIGIN.x - scroller.scrollLeft - minX * scale,
      f: ORIGIN.y - scroller.scrollTop - minY * scale,
    }
  }
  Object.defineProperty(svg, 'getScreenCTM', {
    configurable: true,
    value: () => {
      const m = matrix()
      return { ...m, inverse: () => invertMatrix(m) }
    },
  })
  Object.defineProperty(scroller, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: 0,
      top: 0,
      right: 4000,
      bottom: 4000,
      x: 0,
      y: 0,
      width: 4000,
      height: 4000,
    }),
  })
  // The drawing's top edge (mm in the rack's terms) from the U1 label, which sits mid-U.
  const u1 = Number(svg.querySelector('[data-u-label="1"]')?.getAttribute('y'))
  const topMm = u1 + U_MM / 2
  const at = (rawSixths: number, xMm = 127) => {
    const point = applyMatrix(matrix(), xMm, topMm - rawSixths * SIXTH_MM)
    return { clientX: point.x, clientY: point.y }
  }
  return {
    svg,
    scroller,
    at,
    middle: (u, xMm) => at((u - 1) * 6 + 3, xMm),
    drawingAt: (clientX, clientY) => {
      const inverse = invertMatrix(matrix())
      if (inverse === null) throw new Error('singular')
      return applyMatrix(inverse, clientX, clientY)
    },
  }
}

function renderRack() {
  return render(
    <>
      <RackView />
      <Toaster />
    </>,
  )
}

const mouse = { pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true } as const

function shapeOf(placement: Placement): HTMLElement {
  return screen.getByTestId(`rack-placement-${placement.id}`)
}

function client(point: { clientX: number; clientY: number }) {
  return { x: point.clientX, y: point.clientY }
}

beforeEach(async () => {
  await resetDbForTests()
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
  vi.useRealTimers()
  cleanup()
  await act(async () => {
    await usePlanStore.getState().unload()
  })
  stopLibrarySync()
  useEditorState.getState().reset()
  useMountDialogs.getState().close()
  resetRackDrag()
  useUiStore.setState({ selection: [], face: 'front', zoom: 1, recordingMode: {} })
})

describe('moving a placed part with the pointer', () => {
  it('moves it after 4 px, with a ghost on the way, in one undo step', async () => {
    await open(sample())
    renderRack()
    const view = await camera()
    const lenovo = placementOf('lenovo-tiny-mount-1u')
    const shape = shapeOf(lenovo)

    fireEvent.pointerDown(shape, { ...mouse, ...view.middle(4) })
    // Within the slop nothing moves yet.
    const start = view.middle(4)
    fireEvent.pointerMove(view.scroller, { ...mouse, ...start, clientY: start.clientY + 3 })
    expect(screen.queryByTestId('rack-ghost')).toBeNull()

    fireEvent.pointerMove(view.scroller, { ...mouse, ...view.middle(7) })
    const ghost = screen.getByTestId('rack-ghost')
    expect(ghost).toHaveAttribute('data-ghost-origin', 'move')
    expect(ghost).toHaveAttribute('data-ghost-u-start', '7')
    expect(ghost).toHaveAttribute('data-ok', 'true')
    expect(shapeOf(lenovo)).toHaveAttribute('data-dragging', 'true')
    // Nothing is written while the part is carried.
    expect(placementOf('lenovo-tiny-mount-1u').y).toBe(18)

    fireEvent.pointerUp(view.scroller, { ...mouse, ...view.middle(7) })
    expect(placementOf('lenovo-tiny-mount-1u')).toMatchObject({ id: lenovo.id, y: 36 })
    expect(liveText()).toContain('Moved Lenovo Tiny mount 1U up to U7.')
    expect(useUiStore.getState().selection).toEqual([lenovo.id])
    expect(screen.queryByTestId('rack-ghost')).toBeNull()
    expect(shapeOf(lenovo)).not.toHaveAttribute('data-dragging')

    // The click the browser sends after the drag is swallowed: it does not clear the selection.
    fireEvent.click(view.svg, view.middle(9))
    expect(useUiStore.getState().selection).toEqual([lenovo.id])

    // One gesture, one undo step.
    act(() => usePlanStore.getState().undo())
    expect(placementOf('lenovo-tiny-mount-1u').y).toBe(18)
  })

  it('keeps the grabbed U under the pointer', async () => {
    await open(sample())
    renderRack()
    const view = await camera()
    const shelf = placementOf('kws-power-supplies-shelf-2u')
    // The 2U shelf (U1–U2) grabbed by its upper U and dropped with the pointer on U9.
    fireEvent.pointerDown(shapeOf(shelf), { ...mouse, ...view.middle(2) })
    fireEvent.pointerMove(view.scroller, { ...mouse, ...view.middle(9) })
    expect(screen.getByTestId('rack-ghost')).toHaveAttribute('data-ghost-u-start', '8')
    fireEvent.pointerUp(view.scroller, { ...mouse, ...view.middle(9) })
    expect(placementOf('kws-power-supplies-shelf-2u').y).toBe(42)
  })

  it('refuses a blocked spot with the reason, changing nothing', async () => {
    await open(sample())
    renderRack()
    const view = await camera()
    const lenovo = placementOf('lenovo-tiny-mount-1u')
    fireEvent.pointerDown(shapeOf(lenovo), { ...mouse, ...view.middle(4) })
    fireEvent.pointerMove(view.scroller, { ...mouse, ...view.middle(3) })
    expect(screen.getByTestId('rack-ghost')).toHaveAttribute('data-ok', 'false')
    expect(screen.getByTestId('rack-ghost-status')).toHaveTextContent(
      'It overlaps Blank panel 1U (U3).',
    )
    fireEvent.pointerUp(view.scroller, { ...mouse, ...view.middle(3) })
    expect(placementOf('lenovo-tiny-mount-1u').y).toBe(18)
    expect(liveText()).toContain(
      "Can't move Lenovo Tiny mount 1U to U3: It overlaps Blank panel 1U (U3).",
    )
  })

  it('puts it back on Escape or when the pointer is cancelled', async () => {
    await open(sample())
    renderRack()
    const view = await camera()
    const lenovo = placementOf('lenovo-tiny-mount-1u')

    fireEvent.pointerDown(shapeOf(lenovo), { ...mouse, ...view.middle(4) })
    fireEvent.pointerMove(view.scroller, { ...mouse, ...view.middle(7) })
    expect(screen.getByTestId('rack-ghost')).toBeInTheDocument()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByTestId('rack-ghost')).toBeNull()
    expect(liveText()).toContain('Move cancelled: Lenovo Tiny mount 1U stays at U4.')
    fireEvent.pointerUp(view.scroller, { ...mouse, ...view.middle(7) })
    expect(placementOf('lenovo-tiny-mount-1u').y).toBe(18)

    fireEvent.pointerDown(shapeOf(lenovo), { ...mouse, ...view.middle(4) })
    fireEvent.pointerMove(view.scroller, { ...mouse, ...view.middle(8) })
    fireEvent.pointerCancel(view.scroller, { ...mouse, ...view.middle(8) })
    expect(screen.queryByTestId('rack-ghost')).toBeNull()
    expect(placementOf('lenovo-tiny-mount-1u').y).toBe(18)
  })

  it('keeps going when a part hands its pointer capture over, and stops when the rack loses it', async () => {
    await open(sample())
    renderRack()
    const view = await camera()
    const lenovo = placementOf('lenovo-tiny-mount-1u')
    const pen = { pointerId: 3, pointerType: 'pen', button: 0, isPrimary: true } as const
    fireEvent.pointerDown(shapeOf(lenovo), { ...pen, ...view.middle(4) })
    fireEvent.pointerMove(view.scroller, { ...pen, ...view.middle(6) })
    // A pen starts captured to the shape under it; the rack taking the capture over makes the
    // shape lose it, and that bubbles up: the move goes on.
    fireEvent.lostPointerCapture(shapeOf(lenovo), { ...pen })
    expect(screen.getByTestId('rack-ghost')).toHaveAttribute('data-ghost-u-start', '6')
    // The rack itself losing it ends the move without moving anything.
    fireEvent.lostPointerCapture(view.scroller, { ...pen })
    expect(screen.queryByTestId('rack-ghost')).toBeNull()
    expect(placementOf('lenovo-tiny-mount-1u').y).toBe(18)
  })

  it('moves a part with a 250 ms long-press on touch; a quicker swipe pans', async () => {
    await open(sample())
    renderRack()
    const view = await camera()
    const lenovo = placementOf('lenovo-tiny-mount-1u')
    const touch = { pointerId: 7, pointerType: 'touch', button: 0, isPrimary: true } as const
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    // A swipe that starts on the part pans the view and never moves the part.
    view.scroller.scrollTop = 200
    const from = view.middle(4)
    fireEvent.pointerDown(shapeOf(lenovo), { ...touch, ...from })
    fireEvent.pointerMove(view.scroller, { ...touch, ...from, clientY: from.clientY + 50 })
    expect(view.scroller.scrollTop).toBe(150)
    act(() => vi.advanceTimersByTime(400))
    expect(screen.queryByTestId('rack-ghost')).toBeNull()
    fireEvent.pointerUp(view.scroller, { ...touch, ...from, clientY: from.clientY + 50 })
    expect(placementOf('lenovo-tiny-mount-1u').y).toBe(18)

    // A long-press picks it up.
    fireEvent.pointerDown(shapeOf(lenovo), { ...touch, ...view.middle(4) })
    act(() => vi.advanceTimersByTime(260))
    expect(screen.getByTestId('rack-ghost')).toHaveAttribute('data-ghost-u-start', '4')
    fireEvent.pointerMove(view.scroller, { ...touch, ...view.middle(8) })
    expect(screen.getByTestId('rack-ghost')).toHaveAttribute('data-ghost-u-start', '8')
    fireEvent.pointerUp(view.scroller, { ...touch, ...view.middle(8) })
    expect(placementOf('lenovo-tiny-mount-1u').y).toBe(42)
  })

  it('does not move parts while placing, or in a read-only plan', async () => {
    await open(sample())
    renderRack()
    const view = await camera()
    const lenovo = placementOf('lenovo-tiny-mount-1u')
    act(() => useEditorState.getState().startPlacing({ kind: 'item', itemId: 'generic-blank-1u' }))
    view.scroller.scrollTop = 100
    fireEvent.pointerDown(shapeOf(lenovo), { ...mouse, ...view.middle(4) })
    fireEvent.pointerMove(view.scroller, { ...mouse, ...view.middle(7) })
    fireEvent.pointerUp(view.scroller, { ...mouse, ...view.middle(7) })
    // It panned instead, and the click after it does not place.
    expect(view.scroller.scrollTop).not.toBe(100)
    fireEvent.click(view.svg, view.middle(7))
    expect(placementOf('lenovo-tiny-mount-1u').y).toBe(18)
    expect(current().placements).toHaveLength(4)
  })
})

describe('panning and zooming', () => {
  it('pans when the background is dragged, keeping the selection', async () => {
    await open(sample())
    renderRack()
    const view = await camera()
    useUiStore.getState().select([placementOf('generic-blank-1u').id])
    view.scroller.scrollTop = 300
    view.scroller.scrollLeft = 50
    const from = view.middle(7)
    fireEvent.pointerDown(view.svg, { ...mouse, ...from })
    fireEvent.pointerMove(view.scroller, {
      ...mouse,
      clientX: from.clientX + 20,
      clientY: from.clientY + 90,
    })
    expect(view.scroller.scrollTop).toBe(210)
    expect(view.scroller.scrollLeft).toBe(30)
    fireEvent.pointerUp(view.scroller, {
      ...mouse,
      clientX: from.clientX + 20,
      clientY: from.clientY + 90,
    })
    fireEvent.click(view.svg, from)
    expect(useUiStore.getState().selection).toEqual([placementOf('generic-blank-1u').id])
  })

  it('zooms with Ctrl + wheel around the pointer', async () => {
    await open(sample())
    renderRack()
    const view = await camera()
    view.scroller.scrollTop = 120
    const pointer = view.middle(6, 80)
    const before = view.drawingAt(pointer.clientX, pointer.clientY)
    fireEvent.wheel(view.scroller, { ...pointer, ctrlKey: true, deltaY: -200 })
    expect(useUiStore.getState().zoom).toBeCloseTo(Math.exp(0.3), 6)
    const after = view.drawingAt(pointer.clientX, pointer.clientY)
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
    // A plain wheel is left to the browser (it scrolls).
    fireEvent.wheel(view.scroller, { ...pointer, deltaY: -200 })
    expect(useUiStore.getState().zoom).toBeCloseTo(Math.exp(0.3), 6)
  })

  it('keeps the middle of the view still when the toolbar zooms', async () => {
    await open(sample())
    renderRack()
    const view = await camera()
    Object.defineProperty(view.scroller, 'clientWidth', { configurable: true, value: 600 })
    Object.defineProperty(view.scroller, 'clientHeight', { configurable: true, value: 400 })
    view.scroller.scrollTop = 80
    const before = view.drawingAt(300, 200)
    act(() => useUiStore.getState().setZoom(2))
    const after = view.drawingAt(300, 200)
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
  })

  it('pinch-zooms with two fingers around the point between them, which pans with them', async () => {
    await open(sample())
    renderRack()
    const view = await camera()
    view.scroller.scrollTop = 150
    const first = { pointerId: 11, pointerType: 'touch', button: 0, isPrimary: true } as const
    const second = { pointerId: 12, pointerType: 'touch', button: 0, isPrimary: false } as const
    const keep = view.drawingAt(300, 350)
    fireEvent.pointerDown(view.svg, { ...first, clientX: 300, clientY: 300 })
    fireEvent.pointerDown(view.svg, { ...second, clientX: 300, clientY: 400 })
    // The fingers spread to twice the distance and their middle moves 50 px down.
    fireEvent.pointerMove(view.scroller, { ...first, clientX: 300, clientY: 300 })
    fireEvent.pointerMove(view.scroller, { ...second, clientX: 300, clientY: 500 })
    expect(useUiStore.getState().zoom).toBeCloseTo(2, 6)
    const now = view.drawingAt(300, 400)
    expect(now.x).toBeCloseTo(keep.x, 6)
    expect(now.y).toBeCloseTo(keep.y, 6)
    fireEvent.pointerUp(view.scroller, { ...second, clientX: 300, clientY: 500 })
    fireEvent.pointerUp(view.scroller, { ...first, clientX: 300, clientY: 300 })
    // Nothing was placed or moved, and the lift is not a tap.
    expect(current().placements).toHaveLength(4)
  })
})

describe('drops from the palette and the tray', () => {
  function target() {
    const found = rackDropTarget()
    if (found === undefined) throw new Error('the rack registered no drop target')
    return found
  }

  function carry(subject: DragSubject, point: { clientX: number; clientY: number }) {
    act(() => {
      startCarrying(subject, 'test-source')
      target().move(subject, client(point))
    })
  }

  function drop(subject: DragSubject, point: { clientX: number; clientY: number } | null) {
    act(() => target().drop(subject, point === null ? null : client(point), 'face:front'))
  }

  const SHELF_2U: DragSubject = { kind: 'item', itemId: 'generic-shelf-2u' }

  for (const zoom of [0.5, 1, 2]) {
    it(`lands a 2U part on the U under the pointer at ${zoom * 100}% (same as a click)`, async () => {
      useUiStore.setState({ zoom })
      await open(sample())
      renderRack()
      const view = await camera()
      view.scroller.scrollTop = 40 * zoom
      view.scroller.scrollLeft = 10
      // Aim at the middle of U5–U6, as a click would.
      const aim = view.at(30)
      carry(SHELF_2U, aim)
      const ghost = screen.getByTestId('rack-ghost')
      expect(ghost).toHaveAttribute('data-ghost-origin', 'drop')
      expect(ghost).toHaveAttribute('data-ghost-u-start', '5')
      expect(screen.getByTestId('rack-ghost-status')).toHaveTextContent('Fits at U5–U6')
      drop(SHELF_2U, aim)
      const added = placementOf('generic-shelf-2u')
      expect(added).toMatchObject({ y: 24, face: 'front', bay: 'full' })
      expect(added.have).toBeUndefined()
      expect(useUiStore.getState().selection).toEqual([added.id])
      expect(liveText()).toContain('Placed Shelf 2U at U5–U6. It is selected.')
      expect(screen.queryByTestId('rack-ghost')).toBeNull()
    })
  }

  it('marks a drop In my rack in Recording mode', async () => {
    await open(sample())
    useUiStore.getState().setRecordingMode(current().id, true)
    renderRack()
    const view = await camera()
    drop(SHELF_2U, view.at(42))
    expect(placementOf('generic-shelf-2u')).toMatchObject({
      y: 36,
      have: expect.objectContaining({ itemId: 'generic-shelf-2u' }),
    })
  })

  it('says why a part cannot go there, adding nothing', async () => {
    await open(sample())
    renderRack()
    const view = await camera()
    carry(SHELF_2U, view.at(24))
    expect(screen.getByTestId('rack-ghost')).toHaveAttribute('data-ok', 'false')
    drop(SHELF_2U, view.at(24))
    expect(current().placements).toHaveLength(4)
    expect(liveText()).toContain(
      "Shelf 2U can't go at U4–U5: It overlaps Lenovo Tiny mount 1U (U4).",
    )
  })

  it('cancels on Escape and ignores a drop outside the rack', async () => {
    await open(sample())
    renderRack()
    await camera()
    act(() => target().cancel(SHELF_2U))
    expect(liveText()).toContain('Cancelled: Shelf 2U was not added.')
    drop(SHELF_2U, null)
    expect(liveText()).toContain('Shelf 2U was not added: drop it on the rack.')
    expect(current().placements).toHaveLength(4)
  })

  it('puts a device from the palette into the slot it is dropped on', async () => {
    await open(withShelf())
    renderRack()
    const view = await camera()
    const pi: DragSubject = { kind: 'device', deviceId: 'raspberry-pi-5' }
    carry(pi, view.middle(7))
    // While a device is carried, every slot on the face is outlined as a drop target.
    expect(document.querySelectorAll('[data-slot-zone]').length).toBeGreaterThan(0)
    const ghost = screen.getByTestId('rack-slot-ghost')
    expect(ghost).toHaveAttribute('data-ok', 'true')
    expect(ghost).toHaveAttribute('data-slot-id', 'shelf')
    drop(pi, view.middle(7))
    const shelf = placementOf('generic-shelf-2u')
    expect(shelf.devices).toEqual([
      expect.objectContaining({ deviceId: 'raspberry-pi-5', slotId: 'shelf', have: false }),
    ])
    expect(liveText()).toContain('Added the Raspberry Pi 5 to Shelf of Shelf 2U.')
    expect(useUiStore.getState().selection).toEqual([shelf.id])
  })

  it('moves a tray device into a slot, keeping In my rack, and refuses a full slot', async () => {
    await open({
      ...withShelf(),
      equipment: [
        { id: 'eq-pi', deviceId: 'raspberry-pi-5', have: true },
        { id: 'eq-pc', deviceId: 'lenovo-thinkcentre-m920q-tiny', have: false },
      ],
    })
    renderRack()
    const view = await camera()
    const pi: DragSubject = { kind: 'device', deviceId: 'raspberry-pi-5', equipmentId: 'eq-pi' }
    drop(pi, view.middle(8))
    expect(placementOf('generic-shelf-2u').devices).toEqual([
      expect.objectContaining({ deviceId: 'raspberry-pi-5', have: true }),
    ])
    expect(current().equipment.map((entry) => entry.id)).toEqual(['eq-pc'])
    expect(liveText()).toContain(
      'Moved the Raspberry Pi 5 from Equipment to fit into Shelf of Shelf 2U (In my rack).',
    )

    // The Lenovo mount's one PC slot is taken.
    const pc: DragSubject = {
      kind: 'device',
      deviceId: 'lenovo-thinkcentre-m920q-tiny',
      equipmentId: 'eq-pc',
    }
    carry(pc, view.middle(4))
    expect(screen.getByTestId('rack-slot-ghost')).toHaveAttribute('data-ok', 'false')
    drop(pc, view.middle(4))
    expect(current().equipment.map((entry) => entry.id)).toEqual(['eq-pc'])
    expect(liveText()).toMatch(
      /already holds the Lenovo ThinkCentre M720q Tiny; it takes one device\./,
    )
  })

  it('refuses a device on a part without slots, outlining the part', async () => {
    await open(sample())
    renderRack()
    const view = await camera()
    const pi: DragSubject = { kind: 'device', deviceId: 'raspberry-pi-5' }
    carry(pi, view.middle(3))
    const ghost = screen.getByTestId('rack-slot-ghost')
    expect(ghost).toHaveAttribute('data-ok', 'false')
    expect(ghost).toHaveAttribute('data-ghost-u-start', '3')
    expect(screen.getByTestId('rack-ghost-status')).toHaveTextContent(
      'Blank panel 1U has no slots for devices.',
    )
    drop(pi, view.middle(3))
    expect(liveText()).toContain(
      "Raspberry Pi 5 can't go there: Blank panel 1U has no slots for devices.",
    )
    expect(placementOf('generic-blank-1u').devices).toEqual([])
  })

  it('asks for a mount when a device is dropped on empty space', async () => {
    await open(sample())
    renderRack()
    const view = await camera()
    const pi: DragSubject = { kind: 'device', deviceId: 'raspberry-pi-5', equipmentId: 'eq-9' }
    carry(pi, view.middle(6))
    expect(screen.getByTestId('rack-ghost')).toHaveAttribute('data-ghost-status', 'choose')
    drop(pi, view.middle(6))
    expect(useMountDialogs.getState().chooser).toEqual({
      deviceId: 'raspberry-pi-5',
      face: 'front',
      y: 30,
      equipmentId: 'eq-9',
    })
    expect(liveText()).toContain('Choose a mount for the Raspberry Pi 5 at U6.')
    expect(current().placements).toHaveLength(4)
  })

  it('places ear-mounted gear directly on empty space', async () => {
    await open(sample())
    renderRack()
    const view = await camera()
    const pdu: DragSubject = { kind: 'device', deviceId: 'deskpi-rackmate-dc-pdu-lite' }
    drop(pdu, view.at(63))
    expect(placementOf('deskpi-rackmate-dc-pdu-lite')).toMatchObject({ face: 'front' })
    expect(useMountDialogs.getState().chooser).toBeNull()
  })
})
