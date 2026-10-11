import { describe, expect, it } from 'vitest'
import { loadBundledCatalog } from '@/catalog/loader'
import type { Issue } from '@/domain/api'
import { placingName } from './PlacingBanner'
import { countIssues, issueSummary } from './StatusButtons'

const lookup = loadBundledCatalog().lookup

function issue(severity: Issue['severity']): Issue {
  return { severity, code: 'test', message: 'test' }
}

describe('toolbar summaries', () => {
  it('count errors and warnings (info does not count)', () => {
    const counts = countIssues([issue('error'), issue('warning'), issue('warning'), issue('info')])
    expect(counts).toEqual({ errors: 1, warnings: 2 })
    expect(issueSummary(counts)).toBe('1 error, 2 warnings')
    expect(issueSummary({ errors: 0, warnings: 1 })).toBe('1 warning')
    expect(issueSummary(countIssues([issue('info')]))).toBe('no problems')
  })

  it('name what is being placed, and the tray device going into a mount', () => {
    expect(placingName({ kind: 'item', itemId: 'lenovo-tiny-mount-1u' }, lookup, [])).toBe(
      'Lenovo Tiny mount 1U',
    )
    expect(
      placingName({ kind: 'device', deviceId: 'deskpi-rackmate-dc-pdu-lite' }, lookup, undefined),
    ).toBe('DeskPi RackMate DC PDU Lite (DP-0042)')
    const equipment = [{ id: 'eq-1', deviceId: 'lenovo-thinkcentre-m720q-tiny', have: true }]
    expect(
      placingName(
        { kind: 'item', itemId: 'lenovo-tiny-mount-1u', equipmentId: 'eq-1' },
        lookup,
        equipment,
      ),
    ).toBe('Lenovo Tiny mount 1U for Lenovo ThinkCentre M720q Tiny')
    // Unknown ids and a stale tray entry fall back gracefully.
    expect(placingName({ kind: 'item', itemId: 'gone-mount' }, lookup, [])).toBe('gone-mount')
    expect(
      placingName(
        { kind: 'item', itemId: 'lenovo-tiny-mount-1u', equipmentId: 'eq-missing' },
        lookup,
        equipment,
      ),
    ).toBe('Lenovo Tiny mount 1U')
  })
})
