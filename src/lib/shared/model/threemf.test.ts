import { describe, expect, it } from 'vitest'
import { measureMesh } from './mesh'
import {
  BAMBU_FIXTURE,
  buildBambu3mf,
  buildCore3mf,
  buildPrusa3mf,
  contentTypesXml,
  meshXml,
  modelXml,
  PRODUCTION_NAMESPACE,
  relationshipsXml,
  zipPackage,
} from './testing/build3mf'
import { boxMesh, cubeMesh, panelMesh } from './testing/meshes'
import { parseMeshes, parseStructure, type ThreeMfMeshes } from './threemf'
import { describeTransform } from './transform'
import { LimitExceededError, ModelError } from './types'
import { bytesSource, openZip } from './zip'

const INCH = 25.4

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

function meshOf(result: ThreeMfMeshes, objectId: number) {
  const mesh = result.objects.find((object) => object.objectId === objectId)
  if (!mesh) throw new Error(`no mesh for object ${objectId}`)
  return mesh
}

/** A minimal package around a root model, with optional extra parts. */
function packageWith(root: string, extra: Record<string, string> = {}): Uint8Array {
  return zipPackage({
    '[Content_Types].xml': contentTypesXml(),
    '_rels/.rels': relationshipsXml([{ target: '/3D/3dmodel.model' }]),
    '3D/3dmodel.model': root,
    ...extra,
  })
}

describe('parseStructure on a Bambu Studio project', () => {
  it('reads units, producer and metadata, leaving descriptions out', async () => {
    const structure = await parseStructure(bytesSource(buildBambu3mf()))
    expect(structure.rootModelPath).toBe('3D/3dmodel.model')
    expect(structure.unit).toBe('millimeter')
    expect(structure.unitScaleMm).toBe(1)
    expect(structure.producer).toBe('bambu-studio')
    expect(structure.metadata).toEqual(BAMBU_FIXTURE.metadata)
    expect(structure.omittedMetadataKeys).toEqual(['Description', 'ProfileDescription'])
    expect(JSON.stringify(structure)).not.toContain('SECRET-DESCRIPTION')
    expect(structure.modelPaths).toEqual([
      '3D/3dmodel.model',
      '3D/Objects/object_1.model',
      '3D/Objects/object_2.model',
    ])
    expect(structure.declaredModelPaths).toEqual([
      '3D/Objects/object_1.model',
      '3D/Objects/object_2.model',
    ])
    expect(structure.warnings).toEqual([])
    expect(structure.sliceInfo).toBeUndefined()
  })

  it("also reads model parts that only the root part's relationships declare", async () => {
    const root = modelXml({
      resources: `<object id="1">${meshXml(cubeMesh(4))}</object>`,
      build: '<item objectid="1"/>',
    })
    const spare = modelXml({ resources: `<object id="1">${meshXml(boxMesh(1, 2, 3))}</object>` })
    const bytes = packageWith(root, {
      '3D/_rels/3dmodel.model.rels': relationshipsXml([
        { target: '/3D/Objects/spare.model' },
        { target: 'Objects/gone.model' },
      ]),
      '3D/Objects/spare.model': spare,
    })
    const structure = await parseStructure(bytesSource(bytes))
    expect(structure.modelPaths).toEqual(['3D/3dmodel.model', '3D/Objects/spare.model'])
    expect(structure.declaredModelPaths).toEqual(['3D/Objects/spare.model'])
    expect(structure.objects.map((object) => [object.modelPath, object.id, object.isRoot])).toEqual(
      [
        ['3D/3dmodel.model', 1, true],
        ['3D/Objects/spare.model', 1, false],
      ],
    )
    expect(structure.warnings).toEqual([
      '3D/_rels/3dmodel.model.rels names a missing model part "Objects/gone.model"',
    ])
    // parseMeshes reads only what the build reaches.
    const zip = await openZip(bytesSource(bytes))
    await parseMeshes(zip)
    expect(zip.inflatedBytes).toBe(
      ['_rels/.rels', '3D/3dmodel.model'].reduce(
        (sum, name) => sum + (zip.get(name)?.size ?? 0),
        0,
      ),
    )
  })

  it('lists root objects with names, parts, components and counts', async () => {
    const structure = await parseStructure(bytesSource(buildBambu3mf()))
    const roots = structure.objects.filter((object) => object.isRoot)
    expect(
      roots.map((object) => [object.id, object.name, object.triangleCount, object.faceCount]),
    ).toEqual([
      [2, 'Leg 6U', 12, 12],
      [4, 'Leg 6U (mirrored)', 12, 12],
      [6, 'Connector', 12, 36],
    ])
    const leg = roots[0]!
    expect(leg.partNames).toEqual(['Leg 6U.stl'])
    expect(leg.components).toEqual([
      {
        path: '3D/Objects/object_1.model',
        objectId: 1,
        transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, -15, -10, -132],
        subtype: 'normal_part',
        included: true,
      },
    ])
    expect(describeTransform(roots[1]!.components[0]!.transform).mirrored).toBe(true)

    const connector = roots[2]!
    expect(connector.partNames).toEqual(['Connector body', 'Infill modifier'])
    expect(connector.components.map((c) => [c.objectId, c.subtype, c.included])).toEqual([
      [1, 'normal_part', true],
      [2, 'modifier_part', false],
      [3, undefined, false], // type="other" in the model part
    ])
  })

  it('resolves objects per model part: id 1 exists in both sub-models', async () => {
    const structure = await parseStructure(bytesSource(buildBambu3mf()))
    const parts = structure.objects.filter((object) => !object.isRoot)
    expect(
      parts.map((object) => [object.modelPath, object.id, object.type, object.triangleCount]),
    ).toEqual([
      ['3D/Objects/object_1.model', 1, 'model', 12],
      ['3D/Objects/object_2.model', 1, 'model', 12],
      ['3D/Objects/object_2.model', 2, 'model', 12],
      ['3D/Objects/object_2.model', 3, 'other', 0],
    ])
    expect(parts[0]?.bbox).toEqual({ min: [0, 0, 0], max: [30, 20, 264] })
    expect(parts[1]?.bbox).toEqual({ min: [0, 0, 0], max: [40, 40, 10] })
  })

  it('reads build items, plates with print tags, and assembly placements', async () => {
    const structure = await parseStructure(bytesSource(buildBambu3mf()))
    expect(structure.buildItems.map((item) => [item.objectId, item.printable])).toEqual([
      [2, true],
      [4, true],
      [6, true],
      [6, false],
    ])
    structure.buildItems.forEach((item, i) => {
      expect(describeTransform(item.transform).translation).toEqual(
        BAMBU_FIXTURE.buildTranslations[i],
      )
    })
    expect(describeTransform(structure.buildItems[3]!.transform).rotationZDeg).toBeCloseTo(37, 6)

    expect(structure.plates).toEqual([
      {
        id: 1,
        name: '[Print x4] - Magnetic frame - 6U',
        tags: { copies: 4, optional: false, cleanName: 'Magnetic frame - 6U' },
        instances: [
          { objectId: 2, instanceId: 0, buildItemIndex: 0 },
          { objectId: 4, instanceId: 0, buildItemIndex: 1 },
        ],
      },
      {
        id: 2,
        name: '[Optional] - Extension connectors',
        tags: { copies: 1, optional: true, cleanName: 'Extension connectors' },
        instances: [
          { objectId: 6, instanceId: 0, buildItemIndex: 2 },
          { objectId: 6, instanceId: 1, buildItemIndex: 3 },
        ],
      },
    ])
    expect(structure.assembly).toEqual([
      {
        objectId: 2,
        instanceId: 0,
        transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 132],
        offset: [0, 0, 0],
      },
    ])
  })

  it('reads slice info from a sliced project', async () => {
    const structure = await parseStructure(bytesSource(buildBambu3mf({ sliced: true })))
    expect(structure.sliceInfo).toEqual({
      clientVersion: '02.01.00.59',
      plates: [
        {
          index: 1,
          predictionSec: 5274,
          weightG: 125.43,
          filaments: [{ id: 1, type: 'PLA', color: '#1A1A1A', usedG: 125.43, usedM: 41.92 }],
        },
        {
          index: 2,
          predictionSec: 1800,
          weightG: 68,
          filaments: [{ id: 2, type: 'PETG', color: '#FF6A13', usedG: 68, usedM: 22.7 }],
        },
      ],
    })
  })

  it('scales inch packages to millimetres', async () => {
    const structure = await parseStructure(bytesSource(buildBambu3mf({ unit: 'inch' })))
    expect(structure.unit).toBe('inch')
    expect(structure.unitScaleMm).toBe(INCH)
    const legPart = structure.objects.find(
      (object) => object.modelPath === '3D/Objects/object_1.model',
    )
    expect(legPart?.bbox?.max[2]).toBeCloseTo(264 * INCH, 6)
    const translation = describeTransform(structure.buildItems[0]!.transform).translation
    expect(translation[0]).toBeCloseTo(60 * INCH, 6)
    expect(translation[2]).toBeCloseTo(132 * INCH, 6)
  })
})

describe('parseStructure on an OrcaSlicer project', () => {
  it('resolves <name>_<id>.model parts through URI-decoding, case folding and the id suffix', async () => {
    const structure = await parseStructure(bytesSource(buildBambu3mf({ naming: 'orca' })))
    expect(structure.producer).toBe('orca-slicer')
    expect(structure.modelPaths).toEqual([
      '3D/3dmodel.model',
      '3D/Objects/Leg 6U_2.model',
      '3D/Objects/Verbinder–Füße_6.model',
    ])
    const connector = structure.objects.find((object) => object.isRoot && object.id === 6)
    expect(connector?.components.map((c) => [c.path, c.included])).toEqual([
      ['3D/Objects/Verbinder–Füße_6.model', true],
      ['3D/Objects/Verbinder–Füße_6.model', false],
      ['3D/Objects/Verbinder–Füße_6.model', false],
    ])
    expect(structure.warnings).toEqual([
      'Model part "/3D/OBJECTS/verbinder–füße_6.model" matched 3D/Objects/Verbinder–Füße_6.model (case-insensitive)',
      'Model part "/3D/Objects/Verbinder-Fusse_6.model" matched 3D/Objects/Verbinder–Füße_6.model (id-suffix)',
    ])
  })
})

describe('parseMeshes', () => {
  it('returns object-local meshes: component transforms applied, build transforms not', async () => {
    const result = await parseMeshes(bytesSource(buildBambu3mf()))
    expect(
      result.objects.map((object) => [object.objectId, object.name, object.buildItemIndices]),
    ).toEqual([
      [2, 'Leg 6U', [0]],
      [4, 'Leg 6U (mirrored)', [1]],
      [6, 'Connector', [2, 3]],
    ])
    const leg = meshOf(result, 2)
    expect([leg.vertexCount, leg.triangleCount, leg.skippedTriangleCount]).toEqual([8, 12, 0])
    expect(leg.bbox).toEqual({ min: [-15, -10, -132], max: [15, 10, 132] })
    // The 37° placement is reported, never applied.
    expect(describeTransform(result.buildItems[3]!.transform).rotationZDeg).toBeCloseTo(37, 6)
    expect(meshOf(result, 6).bbox).toEqual({ min: [0, 0, 0], max: [40, 40, 10] })
  })

  it('reverses the winding of mirrored components so normals stay outward', async () => {
    const result = await parseMeshes(bytesSource(buildBambu3mf()))
    const legVolume = measureMesh(meshOf(result, 2)).signedVolumeMm3
    const mirrored = meshOf(result, 4)
    expect(legVolume).toBeCloseTo(30 * 20 * 264, 3)
    expect(measureMesh(mirrored).signedVolumeMm3).toBeCloseTo(legVolume, 3)
    expect(mirrored.bbox).toEqual({ min: [-15, -10, -132], max: [15, 10, 132] })
  })

  it('skips modifier volumes and non-solid object types', async () => {
    const connector = meshOf(await parseMeshes(bytesSource(buildBambu3mf())), 6)
    expect(connector.triangleCount).toBe(12)
    expect(connector.skippedTriangleCount).toBe(24)
  })

  it('scales inch geometry and translations to millimetres', async () => {
    const result = await parseMeshes(bytesSource(buildBambu3mf({ unit: 'inch' })))
    expect(result.unitScaleMm).toBe(INCH)
    const bbox = meshOf(result, 2).bbox!
    expect(bbox.min[0]).toBeCloseTo(-15 * INCH, 4)
    expect(bbox.max[2]).toBeCloseTo(132 * INCH, 4)
    expect(describeTransform(result.buildItems[1]!.transform).translation[0]).toBeCloseTo(
      120 * INCH,
      6,
    )
  })

  it('gives OrcaSlicer projects the same geometry as Bambu ones', async () => {
    const bambu = await parseMeshes(bytesSource(buildBambu3mf()))
    const orca = await parseMeshes(bytesSource(buildBambu3mf({ naming: 'orca' })))
    const summary = (result: ThreeMfMeshes) =>
      result.objects.map((o) => [o.objectId, o.triangleCount, o.skippedTriangleCount, o.bbox])
    expect(summary(orca)).toEqual(summary(bambu))
  })

  it('inflates only the model parts the requested objects reach', async () => {
    const zip = await openZip(bytesSource(buildBambu3mf()))
    const result = await parseMeshes(zip, { objectIds: [6] })
    expect(result.objects.map((object) => object.objectId)).toEqual([6])
    const read = [
      '_rels/.rels',
      '3D/3dmodel.model',
      'Metadata/model_settings.config',
      '3D/Objects/object_2.model',
    ]
    expect(zip.inflatedBytes).toBe(read.reduce((sum, name) => sum + (zip.get(name)?.size ?? 0), 0))
  })

  it('reads core-spec packages with an inline mesh', async () => {
    const bytes = buildCore3mf({ mesh: panelMesh(), name: 'Blank 2U' })
    const structure = await parseStructure(bytesSource(bytes))
    expect(structure.producer).toBe('other')
    expect(structure.plates).toEqual([])
    expect(structure.objects).toMatchObject([
      {
        id: 1,
        name: 'Blank 2U',
        isRoot: true,
        triangleCount: 12,
        bbox: { min: [0, 0, 0], max: [254, 88, 4] },
      },
    ])
    const result = await parseMeshes(bytesSource(bytes))
    expect(result.objects).toHaveLength(1)
    expect(result.objects[0]).toMatchObject({
      objectId: 1,
      name: 'Blank 2U',
      vertexCount: 8,
      triangleCount: 12,
    })
  })

  it('finds the root model without _rels/.rels', async () => {
    const result = await parseMeshes(
      bytesSource(buildCore3mf({ omitRels: true, unit: 'inch', mesh: cubeMesh(1) })),
    )
    expect(result.warnings).toEqual(['No _rels/.rels; looking for the root model by name'])
    expect(result.objects[0]?.bbox?.max).toEqual([INCH, INCH, INCH].map((v) => Math.fround(v)))
  })

  it('builds top-level objects when there is no build section', async () => {
    const root = modelXml({
      resources: [
        `<object id="1" type="model">${meshXml(cubeMesh(10))}</object>`,
        '<object id="2" type="model"><components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 20"/></components></object>',
      ].join('\n'),
    })
    const result = await parseMeshes(bytesSource(packageWith(root)))
    expect(result.objects.map((object) => [object.objectId, object.bbox?.min[2]])).toEqual([
      [2, 20],
    ])
  })

  it('leaves out PrusaSlicer modifier volumes merged into an object mesh', async () => {
    const bytes = buildPrusa3mf()
    const structure = await parseStructure(bytesSource(bytes))
    expect(structure.producer).toBe('prusa-slicer')
    expect(structure.objects[0]).toMatchObject({
      name: 'Bracket',
      triangleCount: 12,
      meshTriangleCount: 24,
      partNames: ['Bracket', 'Infill modifier'],
      parts: [
        { id: 0, name: 'Bracket', subtype: 'ModelPart', triangles: [0, 11] },
        { id: 1, name: 'Infill modifier', subtype: 'ParameterModifier', triangles: [12, 23] },
      ],
    })
    const mesh = (await parseMeshes(bytesSource(bytes))).objects[0]
    expect(mesh).toMatchObject({ triangleCount: 12, vertexCount: 8, skippedTriangleCount: 12 })
    expect(mesh?.bbox).toEqual({ min: [0, 0, 0], max: [30, 30, 10] })
  })

  it('honours whatever prefix the Production namespace is bound to', async () => {
    const root = modelXml({ resources: '', build: '<item objectid="7"/>' })
      .replace(
        '<resources>',
        `<resources>\n<object id="7"><components><component prod:path="/3D/part.model" objectid="1"/></components></object>`,
      )
      .replace('xmlns="', `xmlns:prod="${PRODUCTION_NAMESPACE}" xmlns="`)
    const part = modelXml({
      resources: `<object id="1" type="model">${meshXml(cubeMesh(5))}</object>`,
    })
    const result = await parseMeshes(bytesSource(packageWith(root, { '3D/part.model': part })))
    expect(result.objects[0]?.triangleCount).toBe(12)
  })
})

describe('3MF errors', () => {
  it('reports malformed model XML with the part name', async () => {
    const bytes = packageWith(
      '<model unit="millimeter"><resources><object id="1"></resources></model>',
    )
    const error = await rejection(parseStructure(bytesSource(bytes)))
    expect(error).toBeInstanceOf(ModelError)
    expect(error).toMatchObject({ code: 'xml-malformed' })
    expect((error as ModelError).message).toContain('3D/3dmodel.model')
  })

  it('rejects packages without a model part, unknown units and out-of-range indices', async () => {
    const noModel = zipPackage({ '[Content_Types].xml': contentTypesXml() })
    expect(await rejection(parseStructure(bytesSource(noModel)))).toMatchObject({
      code: 'invalid-3mf',
    })

    const furlongs = packageWith(modelXml({ unit: 'furlong', resources: '' }))
    expect(await rejection(parseStructure(bytesSource(furlongs)))).toMatchObject({
      code: 'invalid-3mf',
    })

    const badIndex = modelXml({
      resources: `<object id="1">${meshXml({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 3] })}</object>`,
      build: '<item objectid="1"/>',
    })
    expect(await rejection(parseMeshes(bytesSource(packageWith(badIndex))))).toMatchObject({
      code: 'invalid-3mf',
    })
  })

  it('warns about missing parts in parseStructure but fails parseMeshes', async () => {
    const root = modelXml({
      production: true,
      resources:
        '<object id="2"><components><component p:path="/3D/Objects/gone.model" objectid="1"/></components></object>',
      build: '<item objectid="2"/>',
    })
    const bytes = packageWith(root)
    const structure = await parseStructure(bytesSource(bytes))
    expect(structure.objects[0]?.components[0]).toMatchObject({ unresolved: true, included: false })
    expect(structure.warnings[0]).toContain('/3D/Objects/gone.model')
    expect(await rejection(parseMeshes(bytesSource(bytes)))).toMatchObject({ code: 'invalid-3mf' })
  })

  it('detects component cycles', async () => {
    const root = modelXml({
      resources: [
        '<object id="1"><components><component objectid="2"/></components></object>',
        '<object id="2"><components><component objectid="1"/></components></object>',
      ].join('\n'),
      build: '<item objectid="1"/>',
    })
    const bytes = packageWith(root)
    expect(await rejection(parseMeshes(bytesSource(bytes)))).toMatchObject({ code: 'invalid-3mf' })
    const structure = await parseStructure(bytesSource(bytes))
    expect(structure.warnings.some((warning) => warning.includes('cycle'))).toBe(true)
  })

  it('ignores a malformed model_settings.config with a warning', async () => {
    const bytes = packageWith(
      modelXml({
        resources: `<object id="1">${meshXml(boxMesh(1, 2, 3))}</object>`,
        build: '<item objectid="1"/>',
      }),
      { 'Metadata/model_settings.config': '<config><plate></config>' },
    )
    const structure = await parseStructure(bytesSource(bytes))
    expect(structure.plates).toEqual([])
    expect(structure.warnings[0]).toContain('Metadata/model_settings.config is malformed')
  })

  it('enforces the triangle cap across model parts', async () => {
    const error = await rejection(
      parseMeshes(bytesSource(buildBambu3mf()), { limits: { maxTriangles: 20 } }),
    )
    expect(error).toBeInstanceOf(LimitExceededError)
    expect(error).toMatchObject({ limit: 'triangles' })
  })
})
