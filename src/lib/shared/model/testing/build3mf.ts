/**
 * Builds synthetic 3MF packages in memory with fflate's zipSync. Model files are never committed;
 * every fixture comes from here.
 *
 * - `buildCore3mf`: a core-spec package with one inline mesh (what many tools export).
 * - `buildBambu3mf`: a Bambu Studio / OrcaSlicer style project modelled on a MakerWorld print
 *   profile: root objects made of Production-extension components in 3D/Objects/*.model parts,
 *   model_settings.config with "[Print x4]" / "[Optional]" plates, a modifier volume, a non-solid
 *   part, a mirrored component, a 37° build-item rotation, optional inch units and slice info.
 */

import { strToU8, zipSync, type Zippable } from 'fflate'
import { boxMesh, cubeMesh, type GridMesh, mergeMeshes, type TestMesh } from './meshes'

export const CORE_NAMESPACE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02'
export const PRODUCTION_NAMESPACE =
  'http://schemas.microsoft.com/3dmanufacturing/production/2015/06'
const BAMBU_NAMESPACE = 'http://schemas.bambulab.com/package/2021'
const MODEL_RELATIONSHIP = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel'
const THUMBNAIL_RELATIONSHIP =
  'http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail'

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export interface MeshXmlOptions {
  format?: (value: number) => string
  /** Extra attributes for triangle i (e.g. Bambu's paint_color), placed before v1. */
  triangleAttributes?: (triangle: number) => string
  /** Write every third vertex as z, x, y to exercise attribute order. */
  shuffleAttributes?: boolean
}

export function meshXml(mesh: TestMesh, options: MeshXmlOptions = {}): string {
  const format = options.format ?? String
  const lines = ['<mesh>', '<vertices>']
  for (let v = 0; v * 3 + 2 < mesh.positions.length; v++) {
    const [x, y, z] = [0, 1, 2].map((k) => format(mesh.positions[v * 3 + k] ?? 0))
    lines.push(
      options.shuffleAttributes && v % 3 === 2
        ? `<vertex z="${z}" x="${x}" y="${y}"/>`
        : `<vertex x="${x}" y="${y}" z="${z}"/>`,
    )
  }
  lines.push('</vertices>', '<triangles>')
  for (let t = 0; t * 3 + 2 < mesh.indices.length; t++) {
    const [a, b, c] = [0, 1, 2].map((k) => mesh.indices[t * 3 + k] ?? 0)
    const extra = options.triangleAttributes?.(t) ?? ''
    lines.push(`<triangle ${extra}v1="${a}" v2="${b}" v3="${c}"/>`)
  }
  lines.push('</triangles>', '</mesh>')
  return lines.join('\n')
}

export interface ModelXmlOptions {
  unit?: string
  metadata?: Record<string, string>
  /** Declare the Production extension (xmlns:p, requiredextensions="p"). */
  production?: boolean
  resources: string
  build?: string
}

export function modelXml(options: ModelXmlOptions): string {
  const namespaces = options.production
    ? ` xmlns:BambuStudio="${BAMBU_NAMESPACE}" xmlns:p="${PRODUCTION_NAMESPACE}" requiredextensions="p"`
    : ''
  const metadata = Object.entries(options.metadata ?? {})
    .map(([name, value]) => ` <metadata name="${escapeXml(name)}">${escapeXml(value)}</metadata>`)
    .join('\n')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<model unit="${options.unit ?? 'millimeter'}" xml:lang="en-US" xmlns="${CORE_NAMESPACE}"${namespaces}>`,
    metadata,
    ` <resources>\n${options.resources}\n </resources>`,
    ` <build>${options.build ?? ''}</build>`,
    '</model>',
    '',
  ].join('\n')
}

export function contentTypesXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    ' <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    ' <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>',
    ' <Default Extension="png" ContentType="image/png"/>',
    '</Types>',
    '',
  ].join('\n')
}

export function relationshipsXml(relationships: { target: string; type?: string }[]): string {
  const lines = relationships.map(
    ({ target, type }, i) =>
      ` <Relationship Target="${escapeXml(target)}" Id="rel-${i + 1}" Type="${type ?? MODEL_RELATIONSHIP}"/>`,
  )
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    ...lines,
    '</Relationships>',
    '',
  ].join('\n')
}

/** Zips package parts (strings are UTF-8 encoded). Level 0 stores, 1-9 deflate. */
export function zipPackage(
  files: Record<string, string | Uint8Array>,
  level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 6,
): Uint8Array<ArrayBuffer> {
  const zippable: Zippable = {}
  for (const [name, content] of Object.entries(files)) {
    zippable[name] = typeof content === 'string' ? strToU8(content) : content
  }
  return zipSync(zippable, { level, mtime: new Date('2026-01-01T00:00:00Z') })
}

export interface Core3mfOptions {
  mesh?: TestMesh
  name?: string
  unit?: string
  /** Build item transform: 12 numbers separated by spaces. */
  itemTransform?: string
  metadata?: Record<string, string>
  /** Leave out _rels/.rels so readers must find the root model by name. */
  omitRels?: boolean
  meshXmlOptions?: MeshXmlOptions
}

/** A core-spec 3MF: one object with an inline mesh and one build item. */
export function buildCore3mf(options: Core3mfOptions = {}): Uint8Array<ArrayBuffer> {
  const mesh = options.mesh ?? cubeMesh(10)
  const name = options.name === undefined ? '' : ` name="${escapeXml(options.name)}"`
  const transform =
    options.itemTransform === undefined ? '' : ` transform="${options.itemTransform}"`
  const files: Record<string, string> = {
    '[Content_Types].xml': contentTypesXml(),
    '3D/3dmodel.model': modelXml({
      unit: options.unit,
      metadata: options.metadata ?? { Application: 'SyntheticCAD 1.0' },
      resources: `<object id="1" type="model"${name}>\n${meshXml(mesh, options.meshXmlOptions)}\n</object>`,
      build: `<item objectid="1"${transform}/>`,
    }),
  }
  if (!options.omitRels) files['_rels/.rels'] = relationshipsXml([{ target: '/3D/3dmodel.model' }])
  return zipPackage(files)
}

/**
 * A PrusaSlicer-style project: one object whose mesh merges a 30 x 30 x 10 body (triangles 0-11)
 * and a 10 mm modifier cube (triangles 12-23); Metadata/Slic3r_PE_model.config tells them apart.
 */
export function buildPrusa3mf(): Uint8Array<ArrayBuffer> {
  const merged = mergeMeshes(boxMesh(30, 30, 10), cubeMesh(10, [10, 10, 0]))
  const volume = (first: number, last: number, name: string, type: string): string =>
    [
      `  <volume firstid="${first}" lastid="${last}">`,
      `   <metadata type="volume" key="name" value="${name}"/>`,
      `   <metadata type="volume" key="volume_type" value="${type}"/>`,
      '  </volume>',
    ].join('\n')
  const config = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<config>',
    ' <object id="1" instances_count="1">',
    '  <metadata type="object" key="name" value="Bracket"/>',
    volume(0, 11, 'Bracket', 'ModelPart'),
    volume(12, 23, 'Infill modifier', 'ParameterModifier'),
    ' </object>',
    '</config>',
    '',
  ].join('\n')
  return zipPackage({
    '[Content_Types].xml': contentTypesXml(),
    '_rels/.rels': relationshipsXml([{ target: '/3D/3dmodel.model' }]),
    '3D/3dmodel.model': modelXml({
      metadata: { 'slic3rpe:Version3mf': '1' },
      resources: `<object id="1" name="Bracket" type="model">\n${meshXml(merged)}\n</object>`,
      build: '<item objectid="1" transform="1 0 0 0 1 0 0 0 1 100 100 5"/>',
    }),
    'Metadata/Slic3r_PE_model.config': config,
  })
}

/** A core-spec 3MF holding a large grid mesh, for performance tests. */
export function buildGrid3mf(grid: GridMesh, level: 0 | 1 | 6 = 1): Uint8Array<ArrayBuffer> {
  const parts: string[] = []
  const p = grid.positions
  for (let i = 0; i + 2 < p.length; i += 3) {
    parts.push(`<vertex x="${p[i] ?? 0}" y="${p[i + 1] ?? 0}" z="${(p[i + 2] ?? 0).toFixed(4)}"/>`)
  }
  const vertices = parts.join('\n')
  parts.length = 0
  const idx = grid.indices
  for (let i = 0; i + 2 < idx.length; i += 3) {
    parts.push(`<triangle v1="${idx[i] ?? 0}" v2="${idx[i + 1] ?? 0}" v3="${idx[i + 2] ?? 0}"/>`)
  }
  const triangles = parts.join('\n')
  const mesh = `<object id="1" type="model"><mesh><vertices>\n${vertices}\n</vertices><triangles>\n${triangles}\n</triangles></mesh></object>`
  return zipPackage(
    {
      '[Content_Types].xml': contentTypesXml(),
      '_rels/.rels': relationshipsXml([{ target: '/3D/3dmodel.model' }]),
      '3D/3dmodel.model': modelXml({ resources: mesh, build: '<item objectid="1"/>' }),
    },
    level,
  )
}

// ---------------------------------------------------------------------------------------------
// Bambu Studio / OrcaSlicer style project
// ---------------------------------------------------------------------------------------------

const ROTATION_DEG = 37
const COS = Math.cos((ROTATION_DEG * Math.PI) / 180)
const SIN = Math.sin((ROTATION_DEG * Math.PI) / 180)

/** Facts the Bambu fixture is built from, for test expectations (file units). */
export const BAMBU_FIXTURE = {
  legObjectId: 2,
  mirroredLegObjectId: 4,
  connectorObjectId: 6,
  legSize: [30, 20, 264],
  /** Component translation that centres the leg on its origin. */
  legOffset: [-15, -10, -132],
  connectorSize: [40, 40, 10],
  plateNames: ['[Print x4] - Magnetic frame - 6U', '[Optional] - Extension connectors'],
  /** Build items: [leg, mirrored leg, connector, connector rotated 37° about Z (not printable)]. */
  buildTranslations: [
    [60, 60, 132],
    [120, 60, 132],
    [367.2, 60, 5],
    [467.2, 60, 5],
  ],
  rotationDeg: ROTATION_DEG,
  metadata: {
    Application: 'BambuStudio-02.01.00.59',
    'BambuStudio:3mfVersion': '1',
    Title: 'Mini rack test frame & connectors',
    Designer: 'Test Designer',
    DesignerUserId: '1234567',
    License: 'BY-NC-SA',
    Origin: 'Original',
    ProfileTitle: '0.20mm Standard @BBL X1C',
    CreationDate: '2026-10-11',
  },
  /** Never to be printed or kept by any reader. */
  descriptionText: 'SECRET-DESCRIPTION: long designer text that must not be copied',
} as const

export interface BambuProjectOptions {
  /** Sub-model naming: Bambu's 3D/Objects/object_N.model or OrcaSlicer's <name>_<id>.model. */
  naming?: 'bambu' | 'orca'
  unit?: 'millimeter' | 'inch'
  /** Add Metadata/slice_info.config, as a sliced project (or .gcode.3mf) has. */
  sliced?: boolean
}

interface PartReferences {
  legPath: string
  connectorPath: string
  /** How each component writes its p:path; Orca variants exercise the resolver's fallbacks. */
  legRef: string
  connectorRef: string
  modifierRef: string
  otherRef: string
}

function partReferences(naming: 'bambu' | 'orca'): PartReferences {
  if (naming === 'bambu') {
    const legPath = '3D/Objects/object_1.model'
    const connectorPath = '3D/Objects/object_2.model'
    return {
      legPath,
      connectorPath,
      legRef: `/${legPath}`,
      connectorRef: `/${connectorPath}`,
      modifierRef: `/${connectorPath}`,
      otherRef: `/${connectorPath}`,
    }
  }
  const connectorPath = '3D/Objects/Verbinder–Füße_6.model'
  return {
    legPath: '3D/Objects/Leg 6U_2.model',
    connectorPath,
    legRef: '/3D/Objects/Leg%206U_2.model', // URI-encoded space
    connectorRef: `/${encodeURI(connectorPath)}`, // URI-encoded UTF-8
    modifierRef: '/3D/OBJECTS/verbinder–füße_6.model', // different case
    otherRef: '/3D/Objects/Verbinder-Fusse_6.model', // mangled name, same _<id>.model suffix
  }
}

function transformText(values: readonly number[]): string {
  return values.map((value) => String(Number(value.toFixed(8)))).join(' ')
}

function translation(values: readonly number[]): string {
  return transformText([1, 0, 0, 0, 1, 0, 0, 0, 1, ...values])
}

function bambuRootModel(refs: PartReferences, unit: string): string {
  const { legOffset, buildTranslations } = BAMBU_FIXTURE
  const [lx = 0, ly = 0, lz = 0] = legOffset
  const [t0 = [], t1 = [], t2 = [], t3 = []] = buildTranslations
  const rotation = transformText([COS, SIN, 0, -SIN, COS, 0, 0, 0, 1, ...t3])
  const resources = [
    '  <object id="2" p:UUID="00000001-61cb-4c03-9d28-80fed5dfa1dc" type="model">',
    `   <components><component p:path="${refs.legRef}" objectid="1" transform="${translation(legOffset)}"/></components>`,
    '  </object>',
    '  <object id="4" p:UUID="00000002-61cb-4c03-9d28-80fed5dfa1dc" type="model">',
    // Mirrored in X (determinant -1): x' = -x - lx keeps the leg centred.
    `   <components><component p:path="${refs.legRef}" objectid="1" transform="${transformText([-1, 0, 0, 0, 1, 0, 0, 0, 1, -lx, ly, lz])}"/></components>`,
    '  </object>',
    '  <object id="6" p:UUID="00000003-61cb-4c03-9d28-80fed5dfa1dc" type="model">',
    '   <components>',
    `    <component p:path="${escapeXml(refs.connectorRef)}" objectid="1" transform="${translation([0, 0, 0])}"/>`,
    `    <component p:path="${escapeXml(refs.modifierRef)}" objectid="2" transform="${translation([0, 0, 0])}"/>`,
    `    <component p:path="${escapeXml(refs.otherRef)}" objectid="3"/>`,
    '   </components>',
    '  </object>',
  ].join('\n')
  const build = [
    '',
    `  <item objectid="2" transform="${translation(t0)}" printable="1"/>`,
    `  <item objectid="4" transform="${translation(t1)}" printable="1"/>`,
    `  <item objectid="6" transform="${translation(t2)}" printable="1"/>`,
    `  <item objectid="6" transform="${rotation}" printable="0"/>`,
    ' ',
  ].join('\n')
  return modelXml({
    unit,
    production: true,
    metadata: {
      ...BAMBU_FIXTURE.metadata,
      Description: `<p>${BAMBU_FIXTURE.descriptionText}</p>`,
      ProfileDescription: BAMBU_FIXTURE.descriptionText,
    },
    resources,
    build,
  })
}

function subModel(unit: string, objects: string[]): string {
  return modelXml({
    unit,
    production: true,
    metadata: { 'BambuStudio:3mfVersion': '1' },
    resources: objects.join('\n'),
  })
}

function legModel(unit: string): string {
  const [sx = 0, sy = 0, sz = 0] = BAMBU_FIXTURE.legSize
  const mesh = meshXml(boxMesh(sx, sy, sz), {
    shuffleAttributes: true,
    triangleAttributes: (t) => (t % 4 === 0 ? 'paint_color="4" ' : ''),
  })
  return subModel(unit, [
    `<object id="1" p:UUID="00010000-81cb-4c03-9d28-80fed5dfa1dc" type="model">\n${mesh}\n</object>`,
  ])
}

function connectorModel(unit: string): string {
  const [sx = 0, sy = 0, sz = 0] = BAMBU_FIXTURE.connectorSize
  const body = meshXml(boxMesh(sx, sy, sz), { format: (value) => value.toExponential(3) })
  const modifier = meshXml(boxMesh(10, 10, 10, [15, 15, 0]))
  const other = meshXml(boxMesh(5, 5, 5, [2, 2, 2]))
  return subModel(unit, [
    `<object id="1" type="model">\n${body}\n</object>`,
    `<object id="2" type="model">\n${modifier}\n</object>`,
    `<object id="3" type="other">\n${other}\n</object>`,
  ])
}

function settingsPart(id: number, subtype: string, name: string): string {
  return [
    `    <part id="${id}" subtype="${subtype}">`,
    `      <metadata key="name" value="${escapeXml(name)}"/>`,
    '      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>',
    '      <mesh_stat face_count="12" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>',
    '    </part>',
  ].join('\n')
}

function modelInstance(objectId: number, instanceId: number): string {
  return [
    '    <model_instance>',
    `      <metadata key="object_id" value="${objectId}"/>`,
    `      <metadata key="instance_id" value="${instanceId}"/>`,
    `      <metadata key="identify_id" value="${100 + objectId * 10 + instanceId}"/>`,
    '    </model_instance>',
  ].join('\n')
}

function modelSettingsXml(): string {
  const [plate1 = '', plate2 = ''] = BAMBU_FIXTURE.plateNames
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<config>',
    '  <object id="2">',
    '    <metadata key="name" value="Leg 6U"/>',
    '    <metadata key="extruder" value="1"/>',
    '    <metadata face_count="12"/>',
    settingsPart(1, 'normal_part', 'Leg 6U.stl'),
    '  </object>',
    '  <object id="4">',
    '    <metadata key="name" value="Leg 6U (mirrored)"/>',
    '    <metadata face_count="12"/>',
    settingsPart(1, 'normal_part', 'Leg 6U.stl'),
    '  </object>',
    '  <object id="6">',
    '    <metadata key="name" value="Connector"/>',
    '    <metadata face_count="36"/>',
    settingsPart(1, 'normal_part', 'Connector body'),
    settingsPart(2, 'modifier_part', 'Infill modifier'),
    '  </object>',
    '  <plate>',
    '    <metadata key="plater_id" value="1"/>',
    `    <metadata key="plater_name" value="${escapeXml(plate1)}"/>`,
    '    <metadata key="locked" value="false"/>',
    modelInstance(2, 0),
    modelInstance(4, 0),
    '  </plate>',
    '  <plate>',
    '    <metadata key="plater_id" value="2"/>',
    `    <metadata key="plater_name" value="${escapeXml(plate2)}"/>`,
    modelInstance(6, 0),
    modelInstance(6, 1),
    '  </plate>',
    '  <assemble>',
    '    <assemble_item object_id="2" instance_id="0" transform="1 0 0 0 1 0 0 0 1 0 0 132" offset="0 0 0"/>',
    '  </assemble>',
    '</config>',
    '',
  ].join('\n')
}

function sliceInfoXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<config>',
    '  <header>',
    '    <header_item key="X-BBL-Client-Type" value="slicer"/>',
    '    <header_item key="X-BBL-Client-Version" value="02.01.00.59"/>',
    '  </header>',
    '  <plate>',
    '    <metadata key="index" value="1"/>',
    '    <metadata key="prediction" value="5274"/>',
    '    <metadata key="weight" value="125.43"/>',
    '    <object identify_id="120" name="Leg 6U" skipped="false"/>',
    '    <filament id="1" tray_info_idx="GFA00" type="PLA" color="#1A1A1A" used_m="41.92" used_g="125.43"/>',
    '  </plate>',
    '  <plate>',
    '    <metadata key="index" value="2"/>',
    '    <metadata key="prediction" value="1800"/>',
    '    <metadata key="weight" value="68.00"/>',
    '    <filament id="2" tray_info_idx="GFG00" type="PETG" color="#FF6A13" used_m="22.70" used_g="68.00"/>',
    '  </plate>',
    '</config>',
    '',
  ].join('\n')
}

/** A Bambu Studio (or OrcaSlicer) project 3MF like a MakerWorld print profile download. */
export function buildBambu3mf(options: BambuProjectOptions = {}): Uint8Array<ArrayBuffer> {
  const naming = options.naming ?? 'bambu'
  const unit = options.unit ?? 'millimeter'
  const refs = partReferences(naming)
  const application = naming === 'orca' ? 'OrcaSlicer-2.2.0' : BAMBU_FIXTURE.metadata.Application
  const root = bambuRootModel(refs, unit).replace(BAMBU_FIXTURE.metadata.Application, application)
  const files: Record<string, string | Uint8Array> = {
    '[Content_Types].xml': contentTypesXml(),
    '_rels/.rels': relationshipsXml([
      { target: '/Metadata/plate_1.png', type: THUMBNAIL_RELATIONSHIP },
      { target: '/3D/3dmodel.model' },
    ]),
    '3D/3dmodel.model': root,
    '3D/_rels/3dmodel.model.rels': relationshipsXml([
      { target: `/${refs.legPath}` },
      { target: `/${refs.connectorPath}` },
    ]),
    [refs.legPath]: legModel(unit),
    [refs.connectorPath]: connectorModel(unit),
    'Metadata/model_settings.config': modelSettingsXml(),
    'Metadata/project_settings.config': '{"printer_model": "Bambu Lab X1 Carbon"}\n',
    'Metadata/plate_1.png': Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
  }
  if (options.sliced) files['Metadata/slice_info.config'] = sliceInfoXml()
  return zipPackage(files)
}
