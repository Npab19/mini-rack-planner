/**
 * The drag provider: inert where dnd-kit cannot run (jsdom without ResizeObserver, i.e. every
 * other panel's tests), and with a ResizeObserver it loads dnd-kit lazily, makes the palette's rows
 * and the tray's handles draggable without dnd-kit rewriting their roles or tab stops, and carries
 * a real pointer drag from a palette row to the rack.
 */
import 'fake-indexeddb/auto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useContext } from 'react'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { loadBundledCatalog } from '@/catalog/loader'
import { resetDbForTests } from '@/db/db'
import { createPlan } from '@/db/plansRepo'
import { SIXTH_MM, U_MM } from '@/domain/geometry'
import type { Plan } from '@/domain/schema/plan'
import { buildSamplePlan } from '@/features/plans/sample'
import { stopLibrarySync } from '@/state/catalogStore'
import { usePlanStore } from '@/state/planStore'
import { useUiStore } from '@/state/uiStore'
import { useEditorState } from '../editorState'
import { TrayDragContext } from '../equipment/trayDrag'
import { clearAnnouncement } from '../layout/announcer'
import { EditorLiveRegion } from '../layout/EditorLiveRegion'
import { Palette } from '../palette/Palette'
import { resetRackDrag, useRackDrag } from './dragStore'
import { applyMatrix, invertMatrix } from './pointer'
import { RackDndProvider, RackTrayDraggable } from './RackDndProvider'
import { RackView } from './RackView'

const lookup = loadBundledCatalog().lookup

function sample(): Plan {
  return buildSamplePlan(lookup, '2026-10-11T09:30:00.000Z').plan
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

/** matchMedia that reports a desktop-width window (drags are offered from lg up). */
function setDesktop(desktop: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: desktop && query.includes('min-width'),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  })
}

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

class StubIntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return []
  }
}

/** Shows whether the provider offers the tray its handle (the rack's `RackTrayDraggable`). */
function TrayProbe() {
  const Handle = useContext(TrayDragContext)
  if (Handle === null) return <p data-testid="tray-probe">no tray drags</p>
  return (
    <RackTrayDraggable
      subject={{ equipmentId: 'eq-1', deviceId: 'raspberry-pi-5' }}
      disabled={false}
    >
      {({ ref, isDragging }) => (
        <div
          ref={ref}
          data-testid="tray-probe"
          data-rack-handle={Handle === RackTrayDraggable || undefined}
          data-dragging={isDragging || undefined}
        >
          Raspberry Pi 5
        </div>
      )}
    </RackTrayDraggable>
  )
}

function Editor() {
  return (
    <RackDndProvider>
      <Palette />
      <TrayProbe />
      <RackView />
      <EditorLiveRegion />
    </RackDndProvider>
  )
}

async function searchPalette(query: string): Promise<HTMLElement> {
  fireEvent.change(screen.getByTestId('palette-search'), { target: { value: query } })
  return screen.findByTestId('palette-item-generic-shelf-2u')
}

beforeEach(async () => {
  await resetDbForTests()
  useUiStore.setState({ recordingMode: {}, selection: [], zoom: 1, face: 'front' })
  useEditorState.getState().reset()
  clearAnnouncement()
})

afterEach(async () => {
  cleanup()
  vi.unstubAllGlobals()
  await act(async () => {
    await usePlanStore.getState().unload()
  })
  stopLibrarySync()
  resetRackDrag()
})

describe('RackDndProvider', () => {
  it('leaves everything plain where dnd-kit cannot run', async () => {
    setDesktop(true)
    await open(sample())
    render(<Editor />)
    const row = await searchPalette('shelf 2u')
    expect(row).not.toHaveAttribute('data-rack-drag-source')
    expect(row).not.toHaveAttribute('role')
    expect(row).not.toHaveAttribute('aria-roledescription')
    expect(row.querySelector('[data-drag-grip]')).toBeNull()
    expect(screen.getByTestId('tray-probe')).toHaveTextContent('no tray drags')
    // Placing still works the M3a way.
    fireEvent.click(screen.getByTestId('palette-place-generic-shelf-2u'))
    expect(useEditorState.getState().placing).toEqual({
      kind: 'item',
      itemId: 'generic-shelf-2u',
    })
  })

  it('makes palette rows and tray handles draggable without rewriting their roles', async () => {
    setDesktop(true)
    vi.stubGlobal('ResizeObserver', StubResizeObserver)
    vi.stubGlobal('IntersectionObserver', StubIntersectionObserver)
    await open(sample())
    render(<Editor />)
    const row = await searchPalette('shelf 2u')
    await waitFor(() => expect(row).toHaveAttribute('data-rack-drag-source', 'palette'))
    // dnd-kit's Accessibility plugin is off: no role, roledescription, tab stop or aria-pressed.
    for (const attribute of ['role', 'aria-roledescription', 'tabindex', 'aria-pressed']) {
      expect(row).not.toHaveAttribute(attribute)
    }
    expect(row.querySelector('[data-drag-grip]')).not.toBeNull()
    // The row's buttons stay buttons.
    expect(within(row).getByRole('button', { name: 'Place Shelf 2U' })).toBeInTheDocument()
    // The tray gets its handle component.
    expect(screen.getByTestId('tray-probe')).toHaveAttribute('data-rack-handle', 'true')
    // The overlay's wrapper is out of the layout flow.
    const overlay = document.querySelector('[data-dnd-overlay]')
    expect(overlay?.parentElement?.className).toContain('absolute')
  })

  it('offers no drags below lg, where the panels are sheets over the rack', async () => {
    setDesktop(false)
    vi.stubGlobal('ResizeObserver', StubResizeObserver)
    vi.stubGlobal('IntersectionObserver', StubIntersectionObserver)
    await open(sample())
    render(<Editor />)
    // Wait until the host has loaded: the rack's droppable is the last thing to register.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    const row = await searchPalette('shelf 2u')
    expect(row).not.toHaveAttribute('data-rack-drag-source')
    expect(screen.getByTestId('tray-probe')).toHaveTextContent('no tray drags')
  })

  it('carries a pointer drag from a palette row to the U under the pointer', async () => {
    setDesktop(true)
    vi.stubGlobal('ResizeObserver', StubResizeObserver)
    vi.stubGlobal('IntersectionObserver', StubIntersectionObserver)
    // What dnd-kit uses while it drags and jsdom lacks: pointer capture on the body, and the
    // element under a point (its auto-scroller looks for scrollable containers there).
    Object.defineProperty(document.body, 'setPointerCapture', {
      configurable: true,
      value: () => undefined,
    })
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => null })
    Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => [] })
    // Its feedback finishes running animations before it measures the overlay.
    Object.defineProperty(document, 'getAnimations', { configurable: true, value: () => [] })
    Object.defineProperty(Element.prototype, 'getAnimations', {
      configurable: true,
      value: () => [],
    })
    onTestFinished(() => {
      Reflect.deleteProperty(document.body, 'setPointerCapture')
      Reflect.deleteProperty(document, 'elementFromPoint')
      Reflect.deleteProperty(document, 'elementsFromPoint')
      Reflect.deleteProperty(document, 'getAnimations')
      Reflect.deleteProperty(Element.prototype, 'getAnimations')
    })
    await open(sample())
    render(<Editor />)
    const row = await searchPalette('shelf 2u')
    await waitFor(() => expect(row).toHaveAttribute('data-rack-drag-source', 'palette'))

    // The drawing on screen: 1.5 px per mm from (40, 30); the viewport is everything.
    const svg = await screen.findByTestId('rack-svg')
    const scroller = screen.getByTestId('rack-scroll')
    const [minX = 0, , width = 1] = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number)
    const scale = Number(svg.getAttribute('width')) / width
    const ctm = { a: scale, b: 0, c: 0, d: scale, e: 40 - minX * scale, f: 30 }
    Object.defineProperty(svg, 'getScreenCTM', {
      configurable: true,
      value: () => ({ ...ctm, inverse: () => invertMatrix(ctm) }),
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
    const u1 = Number(svg.querySelector('[data-u-label="1"]')?.getAttribute('y'))
    // The middle of U5–U6 (sixth 30).
    const aim = applyMatrix(ctm, 127, u1 + U_MM / 2 - 30 * SIXTH_MM)

    const name = within(row).getByText('Shelf 2U')
    const pointer = { pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true } as const
    fireEvent.pointerDown(name, { ...pointer, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(document, { ...pointer, clientX: 30, clientY: 30 })
    await waitFor(() => expect(useRackDrag.getState().subject).not.toBeNull())
    expect(useRackDrag.getState().subject).toEqual({ kind: 'item', itemId: 'generic-shelf-2u' })
    fireEvent.pointerMove(document, { ...pointer, clientX: aim.x, clientY: aim.y })
    await waitFor(() =>
      expect(screen.getByTestId('rack-ghost')).toHaveAttribute('data-ghost-u-start', '5'),
    )
    fireEvent.pointerUp(document, { ...pointer, clientX: aim.x, clientY: aim.y })
    await waitFor(() =>
      expect(
        current().placements.find((placement) => placement.itemId === 'generic-shelf-2u'),
      ).toMatchObject({ y: 24 }),
    )
    expect(useRackDrag.getState().subject).toBeNull()
  })
})
