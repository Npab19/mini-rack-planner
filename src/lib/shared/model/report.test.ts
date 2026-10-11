import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from './hash'
import { describeModel, type ModelReport } from './report'
import { formatModelReport } from './reportText'
import {
  BAMBU_FIXTURE,
  buildBambu3mf,
  buildCore3mf,
  contentTypesXml,
  zipPackage,
} from './testing/build3mf'
import { buildAsciiStl, buildBinaryStl } from './testing/buildStl'
import { boxMesh, cubeMesh, flipWinding, mergeMeshes, panelMesh } from './testing/meshes'
import { bytesSource } from './zip'

function expectKind<K extends ModelReport['kind']>(
  report: ModelReport,
  kind: K,
): Extract<ModelReport, { kind: K }> {
  if (report.kind !== kind) throw new Error(`expected a ${kind} report, got ${report.kind}`)
  return report as Extract<ModelReport, { kind: K }>
}

/** Reports carry facts, never geometry arrays or description text. */
function expectFactsOnly(report: ModelReport): void {
  const json = JSON.stringify(report)
  expect(json).not.toContain(BAMBU_FIXTURE.descriptionText)
  expect(json).not.toMatch(/"(positions|indices|vertices)"/)
  expect(formatModelReport(report)).not.toContain(BAMBU_FIXTURE.descriptionText)
}

describe('describeModel: 3MF', () => {
  it('lists metadata keys only, unless values are asked for', async () => {
    const bytes = buildBambu3mf({ sliced: true })
    const keysOnly = expectKind(await describeModel('kws.3mf', bytesSource(bytes)), '3mf')
    expect(keysOnly.metadataKeys).toContain('Title')
    expect(keysOnly.metadataKeys).not.toContain('Description')
    expect(keysOnly.metadata).toBeUndefined()
    expect(JSON.stringify(keysOnly)).not.toContain('Test Designer')
    expect(keysOnly.meshes).toBeUndefined()
    expectFactsOnly(keysOnly)

    const withValues = expectKind(
      await describeModel('kws.3mf', bytesSource(bytes), { metadataValues: true, fileHash: true }),
      '3mf',
    )
    expect(withValues.metadata?.['Designer']).toBe('Test Designer')
    expect(withValues.sha256).toBe(await sha256Hex(bytes))
    expect(withValues.zip.entries.map((entry) => entry.name)).toContain(
      'Metadata/slice_info.config',
    )
    expectFactsOnly(withValues)
  })

  it('adds per-object mesh facts with geometry', async () => {
    const report = expectKind(
      await describeModel('kws.3mf', bytesSource(buildBambu3mf()), { geometry: true }),
      '3mf',
    )
    expect(
      report.meshes?.map((mesh) => [
        mesh.objectId,
        mesh.triangleCount,
        mesh.islandCount,
        mesh.sizeMm,
      ]),
    ).toEqual([
      [2, 12, 1, [30, 20, 264]],
      [4, 12, 1, [30, 20, 264]],
      [6, 12, 1, [40, 40, 10]],
    ])
    expect(report.meshes?.[2]?.skippedTriangleCount).toBe(24)
    expect(report.meshes?.[0]?.g1).toMatch(/^g1:[0-9a-f]{64}$/)
    // Mirrored copies keep the signature but not the g1 key: the triangulation is mirrored too.
    expect(report.meshes?.[1]?.signature).toEqual(report.meshes?.[0]?.signature)
    expect(report.meshes?.[1]?.g1).not.toBe(report.meshes?.[0]?.g1)
    expectFactsOnly(report)
  })

  it('renders plates, tags, transforms and slice info as text', async () => {
    const report = await describeModel('kws.3mf', bytesSource(buildBambu3mf({ sliced: true })), {
      geometry: true,
    })
    const text = formatModelReport(report)
    expect(text).toContain(
      '1 "[Print x4] - Magnetic frame - 6U" -> x4, "Magnetic frame - 6U": #2/0 (item 0), #4/0 (item 1)',
    )
    expect(text).toContain('[3] #6 (not printable) translate(467.2, 60, 5) rotZ 37°')
    expect(text).toContain('MIRRORED')
    expect(text).toContain('[modifier_part, skipped]')
    expect(text).toContain('plate 1: 1h 27m 54s, 125.43 g, PLA #1A1A1A 125.43 g / 41.92 m')
    expect(text).toContain('(description text omitted: Description, ProfileDescription)')
  })

  it('reports a failed parse with the archive listing', async () => {
    const broken = zipPackage({
      '[Content_Types].xml': contentTypesXml(),
      '3D/3dmodel.model': '<model><resources><object id="1"></resources></model>',
    })
    const report = expectKind(await describeModel('broken.3mf', bytesSource(broken)), 'error')
    expect(report.error.code).toBe('xml-malformed')
    expect(report.zip?.entries.map((entry) => entry.name)).toEqual([
      '[Content_Types].xml',
      '3D/3dmodel.model',
    ])
    expect(formatModelReport(report)).toContain('FAILED (xml-malformed)')
  })
})

describe('describeModel: STL and archives', () => {
  it('describes an STL, with islands and cavities when geometry is on', async () => {
    const block = mergeMeshes(boxMesh(20, 20, 20), flipWinding(boxMesh(10, 10, 5, [5, 5, 5])))
    const quick = expectKind(
      await describeModel('block.stl', bytesSource(buildBinaryStl(block))),
      'stl',
    )
    expect(quick.mesh).toEqual({
      triangleCount: 24,
      vertexCount: 16,
      bbox: { min: [0, 0, 0], max: [20, 20, 20] },
      sizeMm: [20, 20, 20],
    })
    const full = expectKind(
      await describeModel('block.stl', bytesSource(buildBinaryStl(block)), { geometry: true }),
      'stl',
    )
    expect(
      full.mesh.islands?.map((island) => [island.kind, island.volumeMm3, island.sizeMm]),
    ).toEqual([
      ['solid', 8000, [20, 20, 20]],
      ['cavity', -500, [10, 10, 5]],
    ])
    expect(full.mesh.signature?.volMm3).toBe(7500)
  })

  it('describes the STL and 3MF members of a ZIP and lists everything else', async () => {
    const archive = zipSync({
      'Rack/panel.stl': buildBinaryStl(panelMesh()),
      'Rack/feet.stl': buildAsciiStl([{ name: 'foot', mesh: cubeMesh(8) }]),
      'Rack/handle.3mf': buildCore3mf({ mesh: boxMesh(120, 20, 15), name: 'Handle' }),
      'Rack/LICENSE.txt': new TextEncoder().encode('CC BY'),
      'Rack/inner.zip': zipSync({ 'x.stl': buildBinaryStl(cubeMesh(1)) }),
    })
    const report = expectKind(await describeModel('kws-stls.zip', bytesSource(archive)), 'zip')
    expect(report.zip.entryCount).toBe(5)
    expect(report.members.map((member) => [member.name, member.kind])).toEqual([
      ['Rack/panel.stl', 'stl'],
      ['Rack/feet.stl', 'stl'],
      ['Rack/handle.3mf', '3mf'],
    ])
    const handle = expectKind(report.members[2]!, '3mf')
    expect(handle.structure.objects[0]?.name).toBe('Handle')
  })

  it('reports bytes that are not a model file', async () => {
    const report = expectKind(
      await describeModel('notes.stl', bytesSource(new TextEncoder().encode('just text'))),
      'error',
    )
    expect(report.error.code).toBe('invalid-stl')
  })
})
