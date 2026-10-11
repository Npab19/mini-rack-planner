import { describe, expect, it } from 'vitest'
import { KWS_FRAME, KWS_FRAME_ID, KWS_IDS, kwsCatalog, kwsPlan } from '@/domain/__fixtures__/kws'
import { markSection } from '@/domain/frame'
import { hardwareKey, printKey } from '@/domain/ids'
import { defaultSettings } from '@/domain/schema/settings'
import { sparesText, sparesUsedBy, type SpareContext } from './planOps'

describe('sparesUsedBy', () => {
  const lookup = kwsCatalog()
  const settings = defaultSettings()
  // The user's 3U + 6U (built) plus a planned 3U on top.
  const before = kwsPlan({ sections: [{ u: 3, have: true }, { u: 6, have: true }, 3] })
  const built = markSection(before, 'sec-3', true, '2026-10-11T10:00:00.000Z', KWS_FRAME)

  function context(inventory: SpareContext['inventory']): SpareContext {
    return { lookup, settings, inventory }
  }

  it('takes what a newly built 3U section installs out of the loose spares, never more', () => {
    expect(built.error).toBeUndefined()
    const inventory = {
      [hardwareKey(KWS_IDS.m6x8)]: 20,
      [hardwareKey(KWS_IDS.nyloc)]: 5,
      [printKey(KWS_FRAME_ID, 'plate-3u')]: 1,
      // Rack screws for gear: a section does not install them.
      [hardwareKey(KWS_IDS.m5x10)]: 4,
    }
    expect(sparesUsedBy(before, built.plan, context(inventory))).toEqual({
      [hardwareKey(KWS_IDS.m6x8)]: 16,
      [hardwareKey(KWS_IDS.nyloc)]: 5,
      [printKey(KWS_FRAME_ID, 'plate-3u')]: 1,
    })
  })

  it('uses nothing without spares, or when nothing new is built', () => {
    expect(sparesUsedBy(before, built.plan, context({}))).toEqual({})
    const spares = context({ [hardwareKey(KWS_IDS.m6x8)]: 3 })
    expect(sparesUsedBy(before, before, spares)).toEqual({})
    // Marking it To get again builds nothing.
    expect(sparesUsedBy(built.plan, before, spares)).toEqual({})
  })
})

describe('sparesText', () => {
  it('mentions spares only when some were used', () => {
    expect(sparesText(0)).toBe('')
    expect(sparesText(1)).toBe(' Used 1 loose spare from your inventory.')
    expect(sparesText(16)).toBe(' Used 16 loose spares from your inventory.')
  })
})
