import { describe, expect, it } from 'vitest'
import {
  CATALOG,
  FRAME,
  makePlan,
  USER_SECTIONS,
  type PlacementSpec,
} from '@/domain/__fixtures__/frameFixtures'
import { sixthsToMm } from '@/domain/geometry'
import type { Plan } from '@/domain/schema/plan'
import type { DragSubject } from './dragSubject'
import {
  drawingPoint,
  dropIsOk,
  dropText,
  placementAt,
  planDrop,
  planMove,
  slotZones,
  subjectName,
  zoneAt,
  type DrawingPoint,
  type DropContext,
} from './dropTarget'
import { applyMatrix, clientToRack, invertMatrix, type MatrixLike } from './pointer'
import { panelBox, rackLayout, svgYOfSixths } from './rackLayout'
import { placementViews } from './rackModel'

/**
 * The user's 3U + 6U (U1–U9): a blank at U1, a 2U mini PC mount (fixed "bay" slot for mini PCs) at
 * U4–U5, a 1U shelf (open "deck" slot) at U7 and a half-width part in the left half of U9.
 */
const BASE: readonly PlacementSpec[] = [
  { id: 'pl-blank', itemId: 'blank-1u', y: 0 },
  { id: 'pl-pc', itemId: 'mini-pc-mount-2u', y: 18 },
  { id: 'pl-shelf', itemId: 'shelf-1u', y: 36 },
  { id: 'pl-half', itemId: 'half-bay-1u', y: 48, bay: 'left' },
]

function plan(extra: readonly PlacementSpec[] = []): Plan {
  return makePlan({ sections: USER_SECTIONS, placements: [...BASE, ...extra] })
}

const LAYOUT = rackLayout({
  panelWidthMm: FRAME.standard.panelWidthMm,
  innerWidthMm: FRAME.standard.innerWidthMm,
  topSixths: 54,
})

function context(p: Plan = plan(), recording = false): DropContext {
  return {
    plan: p,
    catalog: CATALOG,
    frame: FRAME,
    layout: LAYOUT,
    face: 'front',
    views: placementViews(p.placements, CATALOG).filter((view) => view.face === 'front'),
    recording,
  }
}

/** The drawing point at a rack height (fractional sixths) and an x across the panel (mm). */
function at(rawSixths: number, x = 127): DrawingPoint {
  return { x, y: LAYOUT.topMm - sixthsToMm(rawSixths), rawSixths }
}

/** The middle of U `u`. */
function middleOfU(u: number, x = 127): DrawingPoint {
  return at((u - 1) * 6 + 3, x)
}

const SHELF_2U: DragSubject = { kind: 'item', itemId: 'blank-2u' }
const MINI_PC: DragSubject = { kind: 'device', deviceId: 'test-mini-pc' }
const SBC: DragSubject = { kind: 'device', deviceId: 'test-sbc' }

describe('planDrop: parts on the rails (as click-to-place)', () => {
  it('centres the part on the pointer and snaps it, under any zoom and pan', () => {
    // The screen CTM of the drawing at 50 / 100 / 200 % (1.5 px per mm at 100 %), panned.
    const cases: Array<[number, number, number]> = [
      [0.75, -40, 900],
      [1.5, 12, -300],
      [3, -510, -1600],
    ]
    for (const [pxPerMm, left, top] of cases) {
      const ctm: MatrixLike = {
        a: pxPerMm,
        b: 0,
        c: 0,
        d: pxPerMm,
        e: left - LAYOUT.leftX * pxPerMm,
        f: top,
      }
      const source = { getScreenCTM: () => ({ inverse: () => invertMatrix(ctm) ?? ctm }) }
      // Aim at the middle of U2–U3 (the boundary between them) on screen.
      const aim = applyMatrix(ctm, 127, svgYOfSixths(LAYOUT, 12))
      const rack = clientToRack(source, aim.x, aim.y, LAYOUT)
      expect(rack).not.toBeNull()
      if (rack === null) return
      const drop = planDrop(context(), SHELF_2U, drawingPoint(LAYOUT, rack))
      expect(drop.kind).toBe('place')
      if (drop.kind !== 'place') return
      expect(drop.spot).toEqual({ y: 6, face: 'front', bay: 'full' })
      expect(drop.check.ok).toBe(true)
      expect(dropText(drop)).toBe('Fits at U2–U3')
    }
  })

  it('says what is in the way, in the domain’s words', () => {
    const drop = planDrop(context(), SHELF_2U, at(24))
    expect(drop.kind).toBe('place')
    expect(dropIsOk(drop)).toBe(false)
    expect(dropText(drop)).toBe('It overlaps Mini PC mount 2U (U4–U5).')
  })

  it('places ear-mounted gear directly, on empty space or over a part without slots', () => {
    const drop = planDrop(context(), { kind: 'device', deviceId: 'test-switch' }, middleOfU(8))
    expect(drop).toMatchObject({
      kind: 'place',
      source: { kind: 'device', deviceId: 'test-switch' },
      spot: { y: 42 },
      check: { ok: true },
    })
    const blocked = planDrop(context(), { kind: 'device', deviceId: 'test-switch' }, middleOfU(1))
    expect(blocked.kind).toBe('place')
    expect(dropText(blocked)).toBe('It overlaps Blank 1U (U1).')
  })
})

describe('planDrop: devices', () => {
  it('goes into the slot under the pointer when it fits', () => {
    const drop = planDrop(context(), MINI_PC, at(24, 120))
    expect(drop).toMatchObject({
      kind: 'slot',
      deviceId: 'test-mini-pc',
      holderName: 'Mini PC mount 2U',
      ok: true,
      zone: { placementId: 'pl-pc', slot: { id: 'bay' }, label: 'Mini PC bay' },
    })
    expect(dropText(drop)).toBe('Goes in Mini PC bay of Mini PC mount 2U')
    // An open shelf takes a small board too.
    expect(planDrop(context(), SBC, middleOfU(7))).toMatchObject({
      kind: 'slot',
      ok: true,
      zone: { placementId: 'pl-shelf', slot: { id: 'deck' } },
    })
  })

  it('says why a slot does not take it', () => {
    const drop = planDrop(context(), { kind: 'device', deviceId: 'test-nas' }, at(24))
    expect(drop.kind).toBe('slot')
    expect(dropIsOk(drop)).toBe(false)
    if (drop.kind !== 'slot') return
    expect(drop.reason).toBeDefined()
    expect(dropText(drop)).toBe(drop.reason)
    // A fixed slot holds one device.
    const full = plan().placements.map((placement) =>
      placement.id === 'pl-pc'
        ? {
            ...placement,
            devices: [{ id: 'dev-1', deviceId: 'test-mini-pc', slotId: 'bay', have: false }],
          }
        : placement,
    )
    const occupied = planDrop(context({ ...plan(), placements: full }), MINI_PC, at(24))
    expect(occupied).toMatchObject({ kind: 'slot', ok: false })
    expect(dropText(occupied)).toMatch(/already holds the Test Mini PC; it takes one device\.$/)
  })

  it('moves a tray device in with its tray entry', () => {
    const withTray: Plan = {
      ...plan(),
      equipment: [{ id: 'eq-1', deviceId: 'test-mini-pc', have: true }],
    }
    const drop = planDrop(
      context(withTray),
      { kind: 'device', deviceId: 'test-mini-pc', equipmentId: 'eq-1' },
      at(24),
    )
    expect(drop).toMatchObject({ kind: 'slot', ok: true, equipmentId: 'eq-1' })
  })

  it('refuses a part without slots, outlining it', () => {
    const drop = planDrop(context(), SBC, middleOfU(1))
    expect(drop.kind).toBe('blocked')
    if (drop.kind !== 'blocked') return
    expect(drop.reason).toBe('Blank 1U has no slots for devices.')
    expect(drop.box).toEqual(panelBox(LAYOUT, 0, 6, 'full', 'front'))
    expect(drop.placementId).toBe('pl-blank')
  })

  it('asks for a mount on empty space, at the U under the pointer', () => {
    // The SBC fits the 1U shelf, so it needs 1U: centred on the middle of U8, it starts at U8.
    const drop = planDrop(context(), SBC, middleOfU(8))
    expect(drop).toMatchObject({
      kind: 'chooser',
      deviceId: 'test-sbc',
      face: 'front',
      y: 42,
      heightSixths: 6,
    })
    expect(dropText(drop)).toBe('Choose a mount at U8')
    expect(dropIsOk(drop)).toBe(true)
    // Near the top the mount stays inside the rack.
    expect(planDrop(context(), SBC, at(53.9, 200))).toMatchObject({ kind: 'chooser', y: 48 })
  })

  it('refuses a drop outside the stack and an unknown device', () => {
    expect(planDrop(context(), SBC, at(60))).toEqual({
      kind: 'blocked',
      reason: 'That is outside the rack: drop it on a free U.',
    })
    expect(planDrop(context(), SBC, at(-2))).toMatchObject({ kind: 'blocked' })
    expect(planDrop(context(), { kind: 'device', deviceId: 'gone' }, middleOfU(8))).toEqual({
      kind: 'blocked',
      reason: '"gone" is not in the catalog.',
    })
  })

  it('names what is carried', () => {
    expect(subjectName(SHELF_2U, CATALOG)).toBe('Blank 2U')
    expect(subjectName(MINI_PC, CATALOG)).toBe('Test Mini PC')
    expect(subjectName({ kind: 'item', itemId: 'nope' }, CATALOG)).toBe('nope')
  })
})

describe('slot zones and hit-testing', () => {
  it('draws each slot from its layout, inside the part’s panel', () => {
    const view = context().views.find((candidate) => candidate.id === 'pl-pc')
    expect(view).toBeDefined()
    if (view === undefined) return
    const [zone] = slotZones(view, LAYOUT, CATALOG)
    const panel = panelBox(LAYOUT, 18, 12, 'full', 'front')
    // The opening starts after the 16 mm rail; the slot is 16 mm in, 190 mm wide, 80 mm tall,
    // 5 mm above the part's bottom.
    expect(zone?.box.x).toBeCloseTo(32, 6)
    expect(zone?.box.width).toBeCloseTo(190, 6)
    expect(zone?.box.height).toBeCloseTo(80, 6)
    expect((zone?.box.y ?? 0) + (zone?.box.height ?? 0)).toBeCloseTo(
      svgYOfSixths(LAYOUT, 18) - 5,
      6,
    )
    expect(zone?.box.y).toBeGreaterThanOrEqual(panel.y)
  })

  it('finds the placement under a point and the nearest slot when between slots', () => {
    const views = context().views
    expect(placementAt(views, LAYOUT, middleOfU(4))?.id).toBe('pl-pc')
    expect(placementAt(views, LAYOUT, middleOfU(6))).toBeUndefined()
    const view = views.find((candidate) => candidate.id === 'pl-pc')
    if (view === undefined) return
    const zones = slotZones(view, LAYOUT, CATALOG)
    // On the rail beside the slot: still that slot.
    expect(zoneAt(zones, at(24, 5))?.slot.id).toBe('bay')
    expect(zoneAt([], at(24))).toBeUndefined()
  })
})

describe('planMove', () => {
  const snapshot = (p: Plan = plan()) => ({
    plan: p,
    catalog: CATALOG,
    frame: FRAME,
    layout: LAYOUT,
  })

  it('keeps the grabbed point under the pointer and checks the new spot', () => {
    // The blank at U1, grabbed in its middle (3 sixths up), to the middle of U2.
    expect(planMove(snapshot(), 'pl-blank', 3, middleOfU(2))).toMatchObject({
      name: 'Blank 1U',
      y: 6,
      bay: 'full',
      check: { ok: true },
    })
    const blocked = planMove(snapshot(), 'pl-blank', 3, middleOfU(5))
    expect(blocked).toMatchObject({ y: 24, check: { ok: false } })
    expect(blocked?.check.reasons[0]).toBe('It overlaps Mini PC mount 2U (U4–U5).')
    // It never blocks itself.
    expect(planMove(snapshot(), 'pl-pc', 6, at(24))?.check.ok).toBe(true)
    expect(planMove(snapshot(), 'gone', 0, middleOfU(2))).toBeNull()
  })

  it('moves a half-width part to the half under the pointer', () => {
    expect(planMove(snapshot(), 'pl-half', 3, middleOfU(9, 60))).toMatchObject({
      y: 48,
      bay: 'left',
      check: { ok: true },
    })
    expect(planMove(snapshot(), 'pl-half', 3, middleOfU(9, 200))).toMatchObject({
      y: 48,
      bay: 'right',
      check: { ok: true },
    })
  })
})
