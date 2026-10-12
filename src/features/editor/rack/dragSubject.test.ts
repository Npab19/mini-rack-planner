import { describe, expect, it } from 'vitest'
import {
  dragSourceId,
  faceDroppableId,
  placeSourceOf,
  RACK_PART_DRAG_TYPE,
  subjectOfData,
  subjectOfSource,
} from './dragSubject'

describe('drag subjects', () => {
  it('gives every palette row and tray entry its own drag id', () => {
    expect(dragSourceId({ kind: 'item', itemId: 'generic-shelf-2u' })).toBe(
      'palette:item:generic-shelf-2u',
    )
    expect(dragSourceId({ kind: 'device', deviceId: 'raspberry-pi-5' })).toBe(
      'palette:device:raspberry-pi-5',
    )
    expect(dragSourceId({ kind: 'device', deviceId: 'raspberry-pi-5', equipmentId: 'eq-1' })).toBe(
      'tray:eq-1',
    )
    expect(faceDroppableId('rear')).toBe('face:rear')
  })

  it('reads a subject back from drag data, and nothing from anything else', () => {
    expect(subjectOfData({ subject: { kind: 'item', itemId: 'custom:my-shelf' } })).toEqual({
      kind: 'item',
      itemId: 'custom:my-shelf',
    })
    expect(
      subjectOfData({ subject: { kind: 'device', deviceId: 'pi', equipmentId: 'eq-2', x: 1 } }),
    ).toEqual({ kind: 'device', deviceId: 'pi', equipmentId: 'eq-2' })
    expect(subjectOfData({ subject: { kind: 'device', deviceId: 'pi', equipmentId: '' } })).toEqual(
      { kind: 'device', deviceId: 'pi' },
    )
    for (const data of [
      null,
      'item',
      {},
      { subject: [] },
      { subject: { kind: 'item' } },
      { subject: { kind: 'item', itemId: '' } },
      { subject: { kind: 'placement', placementId: 'p' } },
    ]) {
      expect(subjectOfData(data)).toBeNull()
    }
  })

  it('only accepts sources of the rack part type', () => {
    const data = { subject: { kind: 'item', itemId: 'generic-blank-1u' } }
    expect(subjectOfSource({ type: RACK_PART_DRAG_TYPE, data })).toEqual({
      kind: 'item',
      itemId: 'generic-blank-1u',
    })
    expect(subjectOfSource({ type: 'something-else', data })).toBeNull()
    expect(subjectOfSource(null)).toBeNull()
  })

  it('places what click-to-place would place', () => {
    expect(placeSourceOf({ kind: 'item', itemId: 'shelf' })).toEqual({
      kind: 'item',
      itemId: 'shelf',
    })
    expect(placeSourceOf({ kind: 'device', deviceId: 'pdu', equipmentId: 'eq-1' })).toEqual({
      kind: 'device',
      deviceId: 'pdu',
      equipmentId: 'eq-1',
    })
    expect(placeSourceOf({ kind: 'device', deviceId: 'pdu' })).toEqual({
      kind: 'device',
      deviceId: 'pdu',
    })
  })
})
