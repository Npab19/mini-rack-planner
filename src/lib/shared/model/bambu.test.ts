import { describe, expect, it } from 'vitest'
import { detectProducer, parseModelSettings, parsePrintTags, parseSliceInfo } from './bambu'
import { parseXml } from './xml'

describe('parsePrintTags', () => {
  it.each([
    [
      '[Print x4] - Magnetic frame - 6U',
      { copies: 4, optional: false, cleanName: 'Magnetic frame - 6U' },
    ],
    [
      '[Optional] - Extension connectors',
      { copies: 1, optional: true, cleanName: 'Extension connectors' },
    ],
    ['[Optional] [Print x2] - Fan grill', { copies: 2, optional: true, cleanName: 'Fan grill' }],
    ['[PRINT X12] Legs', { copies: 12, optional: false, cleanName: 'Legs' }],
    ['(Print ×3) – Stoppers', { copies: 3, optional: false, cleanName: 'Stoppers' }],
    ['[Print 2x] Top connectors', { copies: 2, optional: false, cleanName: 'Top connectors' }],
    ['Handle [x2]', { copies: 2, optional: false, cleanName: 'Handle' }],
    ['Base legs [2x]', { copies: 2, optional: false, cleanName: 'Base legs' }],
    ['Frame connectors', { copies: 1, optional: false, cleanName: 'Frame connectors' }],
    ['', { copies: 1, optional: false, cleanName: '' }],
    ['[Print x0] Broken', { copies: 1, optional: false, cleanName: 'Broken' }],
  ])('%j', (name, expected) => {
    expect(parsePrintTags(name)).toEqual(expected)
  })
})

describe('detectProducer', () => {
  it.each([
    ['BambuStudio-02.01.00.59', 'bambu-studio'],
    ['OrcaSlicer-2.2.0', 'orca-slicer'],
    ['PrusaSlicer-2.8.1+win64', 'prusa-slicer'],
    ['Fusion 360', 'other'],
    [undefined, 'other'],
  ])('%s -> %s', (application, producer) => {
    expect(detectProducer(application)).toBe(producer)
  })
})

describe('parseModelSettings', () => {
  it('reads objects, parts, plates and assembly placements', () => {
    const settings = parseModelSettings(
      parseXml(`<config>
        <object id="9">
          <metadata key="name" value="Plate of legs"/>
          <metadata face_count="48"/>
          <part id="1" subtype="normal_part"><metadata key="name" value="leg"/><mesh_stat face_count="12"/></part>
          <part id="2" subtype="negative_part"><metadata key="name" value="magnet pocket"/></part>
          <part id="3"><metadata key="name" value="no subtype"/></part>
        </object>
        <plate>
          <metadata key="plater_name" value="[Print x2] Legs"/>
          <model_instance><metadata key="object_id" value="9"/><metadata key="instance_id" value="1"/></model_instance>
          <model_instance><metadata key="instance_id" value="0"/></model_instance>
        </plate>
        <assemble><assemble_item object_id="9" instance_id="1" transform="bad" offset="1 2"/></assemble>
      </config>`),
    )
    const object = settings.objects.get(9)
    expect(object?.name).toBe('Plate of legs')
    expect(object?.faceCount).toBe(48)
    expect([...(object?.parts.values() ?? [])]).toEqual([
      { id: 1, name: 'leg', subtype: 'normal_part', faceCount: 12 },
      { id: 2, name: 'magnet pocket', subtype: 'negative_part', faceCount: undefined },
      { id: 3, name: 'no subtype', subtype: 'normal_part', faceCount: undefined },
    ])
    // A plate without plater_id gets its 1-based position; instances without object ids are dropped.
    expect(settings.plates).toEqual([
      {
        id: 1,
        name: '[Print x2] Legs',
        tags: { copies: 2, optional: false, cleanName: 'Legs' },
        instances: [{ objectId: 9, instanceId: 1 }],
      },
    ])
    expect(settings.assembly).toEqual([
      { objectId: 9, instanceId: 1, transform: undefined, offset: undefined },
    ])
  })
})

describe('parseSliceInfo', () => {
  it('tolerates a header-only file (an unsliced project)', () => {
    const info = parseSliceInfo(
      parseXml(
        '<config><header><header_item key="X-BBL-Client-Version" value="01.09.03.50"/></header></config>',
      ),
    )
    expect(info).toEqual({ clientVersion: '01.09.03.50', plates: [] })
  })
})
