/** Plain-text rendering of model reports, for terminals and problem reports. Facts only. */

import { bboxSize } from './mesh'
import { roundTo } from './numbers'
import type { MeshFacts, ModelReport, StlReport, ThreeMfReport, ZipFacts } from './report'
import { describeTransform } from './transform'
import type { Transform3x4, Vec3 } from './types'

type MeshSummary = Partial<MeshFacts> & { triangleCount: number; vertexCount: number }

function round(value: number): number {
  return roundTo(value, 3)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}

function formatSize(size: Vec3 | undefined): string {
  return size ? `${size.map((value) => round(value)).join(' x ')} mm` : 'empty'
}

function formatPoint(point: readonly number[]): string {
  return `(${point.map((value) => round(value)).join(', ')})`
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.round(seconds % 60)
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`
}

/** "identity", or the translation plus whatever else the transform does. */
export function formatTransform(transform: Transform3x4): string {
  const summary = describeTransform(transform)
  if (summary.identity) return 'identity'
  const parts = [`translate${formatPoint(summary.translation)}`]
  if (summary.rotationZDeg === undefined) {
    parts.push(
      `linear [${transform
        .slice(0, 9)
        .map((value) => roundTo(value, 6))
        .join(' ')}]`,
    )
  } else if (summary.rotationZDeg !== 0) {
    parts.push(`rotZ ${summary.rotationZDeg}°`)
  }
  if (summary.mirrored) parts.push('MIRRORED')
  if (summary.axisScale.some((scale) => Math.abs(scale - 1) > 1e-6)) {
    parts.push(`scale ${formatPoint(summary.axisScale)}`)
  }
  return parts.join(' ')
}

function zipLines(zip: ZipFacts): string[] {
  const notes = [
    zip.zip64 ? 'ZIP64' : '',
    zip.prefixBytes > 0 ? `${zip.prefixBytes} prefix bytes` : '',
  ]
  const lines = [`zip: ${[`${zip.entryCount} entries`, ...notes.filter(Boolean)].join(', ')}`]
  const width = Math.min(60, Math.max(10, ...zip.entries.map((entry) => entry.name.length)))
  for (const entry of zip.entries) {
    const packed =
      entry.method === 'stored' ? 'stored' : `${entry.method} ${formatBytes(entry.compressedSize)}`
    const encrypted = entry.encrypted ? ', encrypted' : ''
    lines.push(
      `  ${entry.name.padEnd(width)}  ${formatBytes(entry.size).padStart(10)}  (${packed}${encrypted})`,
    )
  }
  return lines
}

function meshLines(mesh: MeshSummary, indent: string): string[] {
  const counts = `${mesh.triangleCount} triangles, ${mesh.vertexCount} vertices`
  const bbox = mesh.bbox
    ? `, bbox ${formatPoint(mesh.bbox.min)}..${formatPoint(mesh.bbox.max)}`
    : ''
  const lines = [`${indent}${counts}, size ${formatSize(mesh.sizeMm)}${bbox}`]
  if (mesh.signature) {
    const { areaMm2, volMm3, extMm } = mesh.signature
    lines.push(
      `${indent}area ${areaMm2} mm², volume ${volMm3} mm³, extents ${extMm.join(' / ')} mm`,
    )
  }
  if (mesh.g1) lines.push(`${indent}${mesh.g1}`)
  if (mesh.islandCount !== undefined) {
    const listed = mesh.islands?.length ?? 0
    const more = mesh.islandCount > listed ? ` (largest ${listed} listed)` : ''
    lines.push(`${indent}islands: ${mesh.islandCount}${more}`)
    for (const island of mesh.islands ?? []) {
      const triangles = String(island.triangleCount).padStart(7)
      lines.push(
        `${indent}  ${island.kind.padEnd(6)} ${triangles} tri, size ${formatSize(island.sizeMm)}, ` +
          `from ${formatPoint(island.bbox.min)}, volume ${island.volumeMm3} mm³`,
      )
    }
  }
  return lines
}

function metadataLines(report: ThreeMfReport): string[] {
  const lines = ['metadata:']
  for (const key of report.metadataKeys) {
    lines.push(report.metadata ? `  ${key}: ${report.metadata[key] ?? ''}` : `  ${key}`)
  }
  const omitted = report.structure.omittedMetadataKeys
  if (omitted.length > 0) lines.push(`  (description text omitted: ${omitted.join(', ')})`)
  return lines
}

function objectLines(report: ThreeMfReport): string[] {
  const lines = ['objects:']
  for (const object of report.structure.objects) {
    const facts = [object.type, `${object.triangleCount} tri`]
    if (
      object.meshTriangleCount !== undefined &&
      object.meshTriangleCount !== object.triangleCount
    ) {
      facts.push(`own mesh ${object.meshTriangleCount} tri`)
    }
    if (object.faceCount !== undefined) facts.push(`faceCount ${object.faceCount}`)
    if (object.bbox) facts.push(`mesh size ${formatSize(bboxSize(object.bbox))}`)
    const name = object.name === undefined ? '' : ` "${object.name}"`
    lines.push(`  ${object.modelPath} #${object.id}${name}: ${facts.join(', ')}`)
    for (const component of object.components) {
      const state = component.unresolved
        ? 'UNRESOLVED'
        : component.included
          ? 'included'
          : 'skipped'
      const subtype = component.subtype ?? 'no subtype'
      const transform = formatTransform(component.transform)
      lines.push(
        `    -> ${component.path} #${component.objectId} [${subtype}, ${state}] ${transform}`,
      )
    }
  }
  return lines
}

function buildAndPlateLines(report: ThreeMfReport): string[] {
  const { buildItems, plates, assembly } = report.structure
  const lines = ['build items:']
  for (const item of buildItems) {
    const printable = item.printable ? '' : ' (not printable)'
    lines.push(`  [${item.index}] #${item.objectId}${printable} ${formatTransform(item.transform)}`)
  }
  lines.push(plates.length > 0 ? 'plates:' : 'plates: none (no model_settings.config)')
  for (const plate of plates) {
    const tags = [`x${plate.tags.copies}`, ...(plate.tags.optional ? ['optional'] : [])].join(', ')
    const instances = plate.instances.map((instance) => {
      const item = instance.buildItemIndex === undefined ? '' : ` (item ${instance.buildItemIndex})`
      return `#${instance.objectId}/${instance.instanceId}${item}`
    })
    const placed = instances.join(', ') || 'empty'
    lines.push(`  ${plate.id} "${plate.name}" -> ${tags}, "${plate.tags.cleanName}": ${placed}`)
  }
  if (assembly.length > 0) lines.push('assembly view:')
  for (const item of assembly) {
    const transform = item.transform ? formatTransform(item.transform) : 'no transform'
    lines.push(`  #${item.objectId}/${item.instanceId}: ${transform}`)
  }
  return lines
}

function sliceLines(report: ThreeMfReport): string[] {
  const info = report.structure.sliceInfo
  if (!info) return ['slice info: none (not sliced)']
  const lines = [
    `slice info: client ${info.clientVersion ?? '?'}, ${info.plates.length} sliced plates`,
  ]
  for (const plate of info.plates) {
    const time = plate.predictionSec === undefined ? '?' : formatDuration(plate.predictionSec)
    const filaments = plate.filaments.map((filament) => {
      const kind = `${filament.type ?? '?'} ${filament.color ?? ''}`
      return `${kind} ${filament.usedG ?? '?'} g / ${filament.usedM ?? '?'} m`
    })
    lines.push(
      `  plate ${plate.index}: ${time}, ${plate.weightG ?? '?'} g, ${filaments.join('; ')}`,
    )
  }
  return lines
}

function threeMfLines(report: ThreeMfReport): string[] {
  const s = report.structure
  const lines = [
    `3MF: producer ${s.producer}, unit ${s.unit} (x${s.unitScaleMm} to mm), root ${s.rootModelPath}`,
    ...zipLines(report.zip),
    ...metadataLines(report),
    `model parts: ${s.modelPaths.join(', ')} (${s.declaredModelPaths.length} declared by the root part)`,
    ...objectLines(report),
    ...buildAndPlateLines(report),
    ...sliceLines(report),
  ]
  if (report.meshes) {
    lines.push('meshes (object-local: component transforms applied, build transforms not):')
    for (const mesh of report.meshes) {
      const name = mesh.name === undefined ? '' : ` "${mesh.name}"`
      const items = mesh.buildItemIndices.join(', ') || 'none'
      const skipped =
        mesh.skippedTriangleCount > 0 ? `, ${mesh.skippedTriangleCount} tri skipped` : ''
      lines.push(
        `  #${mesh.objectId}${name} (build items ${items}${skipped})`,
        ...meshLines(mesh, '    '),
      )
    }
  }
  return lines
}

function stlLines(report: StlReport): string[] {
  const header = report.header ? `, header "${report.header}"` : ''
  const lines = [`STL (${report.format})${header}`]
  for (const group of report.groups) {
    const last = group.firstTriangle + group.triangleCount - 1
    lines.push(`  solid "${group.name}": triangles ${group.firstTriangle}..${last}`)
  }
  lines.push(...meshLines(report.mesh, '  '))
  if (report.skippedTriangleCount > 0)
    lines.push(`  ${report.skippedTriangleCount} triangles skipped`)
  return lines
}

function reportLines(report: ModelReport, depth: number): string[] {
  const hash = report.sha256 ? ` sha256 ${report.sha256}` : ''
  const lines = [
    `${'='.repeat(depth + 2)} ${report.name} (${formatBytes(report.sizeBytes)})${hash}`,
  ]
  switch (report.kind) {
    case '3mf':
      lines.push(...threeMfLines(report))
      break
    case 'stl':
      lines.push(...stlLines(report))
      break
    case 'zip':
      lines.push(...zipLines(report.zip))
      for (const member of report.members) lines.push('', ...reportLines(member, depth + 1))
      break
    case 'error':
      lines.push(`FAILED (${report.error.code}): ${report.error.message}`)
      if (report.zip) lines.push(...zipLines(report.zip))
      break
  }
  const warnings =
    report.kind === '3mf' ? report.structure.warnings : report.kind === 'stl' ? report.warnings : []
  if (warnings.length > 0) lines.push('warnings:', ...warnings.map((warning) => `  ${warning}`))
  return lines
}

/** Plain-text rendering of a report. */
export function formatModelReport(report: ModelReport): string {
  return reportLines(report, 0).join('\n')
}
