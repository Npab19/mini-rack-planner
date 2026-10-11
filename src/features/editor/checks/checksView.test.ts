import { describe, expect, it } from 'vitest'
import type { Issue } from '@/domain/api'
import { powerSummary, type PowerReport } from '@/domain/power'
import { KWS_FRAME, kwsCatalog, kwsPlan } from '@/domain/__fixtures__/kws'
import { countsText, groupIssues, mergeIssues, powerRows, targetName } from './checksView'

const CATALOG = kwsCatalog()

function issue(severity: Issue['severity'], code: string, targetId?: string): Issue {
  return { severity, code, message: `${code} message`, ...(targetId ? { targetId } : {}) }
}

function emptyPower(overrides: Partial<PowerReport> = {}): PowerReport {
  return {
    acOutletsNeeded: 0,
    acOutletsAvailable: 0,
    acOutletsBatteryBacked: 0,
    poePortsNeeded: 0,
    poePortsAvailable: 0,
    poeBudgetW: 0,
    poeDemandW: 0,
    usbcPortsNeeded: 0,
    usbcPortsAvailable: 0,
    totalTypW: 0,
    totalMaxW: 0,
    bricks: [],
    ...overrides,
  }
}

describe('issues', () => {
  it('groups errors, warnings and info in that order and counts them in words', () => {
    const groups = groupIssues([
      issue('info', 'unverified-holes', 'pl-1'),
      issue('error', 'overlap', 'pl-1'),
      issue('warning', 'depth-overhang', 'pl-2'),
      issue('error', 'overlap', 'pl-2'),
    ])
    expect(groups.map((group) => [group.severity, group.issues.map((i) => i.targetId)])).toEqual([
      ['error', ['pl-1', 'pl-2']],
      ['warning', ['pl-2']],
      ['info', ['pl-1']],
    ])
    expect(countsText(groups)).toBe('2 errors · 1 warning · 1 note')
    expect(countsText([])).toBe('No problems found')
  })

  it('merges plan and stack checks without repeating one', () => {
    const merged = mergeIssues(
      [issue('error', 'overlap', 'pl-1'), issue('warning', 'empty-stack')],
      [issue('warning', 'empty-stack'), issue('info', 'have-changed', 'sec-1')],
    )
    expect(merged.map((i) => i.code)).toEqual(['overlap', 'empty-stack', 'have-changed'])
  })
})

describe('powerRows', () => {
  it('compares outlets and ports with what the plan provides, in words', () => {
    const rows = powerRows(
      emptyPower({
        acOutletsNeeded: 5,
        acOutletsAvailable: 4,
        poePortsNeeded: 2,
        poePortsAvailable: 4,
        poeBudgetW: 60,
        poeDemandW: 14,
        totalTypW: 45,
        totalMaxW: 180,
      }),
    )
    expect(rows.map((row) => [row.id, row.value, row.statusText])).toEqual([
      ['ac', '5 needed · 4 available', '1 short'],
      ['poe', '2 needed · 4 available', 'Enough'],
      ['draw', 'about 45 W typical · up to 180 W', 'Estimate'],
    ])
    expect(rows[0]?.status).toBe('short')
    expect(rows[1]?.detail).toBe('Up to 14 W of a 60 W PoE budget.')
  })

  it('flags a PoE budget overrun and gear that plugs in outside the rack', () => {
    const rows = powerRows(
      emptyPower({
        acOutletsNeeded: 3,
        poePortsNeeded: 2,
        poePortsAvailable: 4,
        poeBudgetW: 10,
        poeDemandW: 14,
        usbcPortsNeeded: 1,
      }),
    )
    expect(rows.map((row) => [row.id, row.status, row.statusText])).toEqual([
      ['ac', 'note', 'Outside the rack'],
      ['poe', 'short', 'Over budget'],
      ['usbc', 'note', 'Outside the rack'],
      ['draw', 'note', 'No data'],
    ])
    expect(rows[0]?.detail).toMatch(/^No power strip or PDU in the plan/)
  })

  it('reads the fixture: a 4-outlet PDU for a PC, a NAS and a Pi', () => {
    const plan = kwsPlan({
      sections: [6],
      placements: [{ id: 'pl-pdu', itemId: 'pdu-4', y: 0 }],
      equipment: [
        { id: 'eq-pc', deviceId: 'lenovo-m720q' },
        { id: 'eq-nas', deviceId: 'nas-2bay' },
        { id: 'eq-pi', deviceId: 'rpi-5' },
      ],
    })
    const [ac] = powerRows(powerSummary(plan, CATALOG))
    // C5 brick 1 + wall bricks 2 + 2.
    expect(ac).toMatchObject({ value: '5 needed · 4 available', statusText: '1 short' })
  })
})

describe('targetName', () => {
  it('names sections, placements, devices in mounts and tray entries', () => {
    const plan = kwsPlan({
      sections: [3, 6],
      placements: [
        {
          id: 'pl-tiny',
          itemId: 'lenovo-tiny-mount',
          y: 18,
          devices: [{ id: 'dv-pc', deviceId: 'lenovo-m720q', slotId: 'bay' }],
        },
      ],
      equipment: [{ id: 'eq-nas', deviceId: 'nas-2bay' }],
    })
    expect(targetName(plan, CATALOG, KWS_FRAME, 'sec-2')).toBe('Section 2 (6U)')
    expect(targetName(plan, CATALOG, KWS_FRAME, 'pl-tiny')).toBe('Lenovo Tiny mount @U4')
    expect(targetName(plan, CATALOG, KWS_FRAME, 'dv-pc')).toBe(
      'Lenovo ThinkCentre M720q Tiny in Lenovo Tiny mount @U4',
    )
    expect(targetName(plan, CATALOG, KWS_FRAME, 'eq-nas')).toBe(
      'Fixture 2-bay NAS (equipment to fit)',
    )
    expect(targetName(plan, CATALOG, KWS_FRAME, 'nothing')).toBeUndefined()
  })
})
