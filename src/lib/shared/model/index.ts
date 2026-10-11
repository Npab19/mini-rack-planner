/**
 * DOM-free model parsing core shared by the ingest worker, Node scripts and tests.
 *
 * Import it from workers or lazily loaded chunks only: it pulls in fflate (and hash-wasm on first
 * hash), which must stay out of the initial bundle. Test fixture builders live in ./testing and are
 * deliberately not exported here.
 */

export * from './types'
export {
  bytesSource,
  blobSource,
  looksLikeZip,
  openZip,
  METHOD_DEFLATE,
  METHOD_STORED,
} from './zip'
export type { ZipArchive, ZipEntry } from './zip'
export {
  childElements,
  decodeXmlEntities,
  firstChild,
  localName,
  ModelXmlScanner,
  parseXml,
  tokenizeXml,
} from './xml'
export type {
  ModelXmlHandler,
  ModelXmlScannerOptions,
  XmlAttributes,
  XmlElement,
  XmlHandler,
} from './xml'
export { normalizePartName } from './opc'
export {
  composeTransforms,
  describeTransform,
  determinant,
  IDENTITY_TRANSFORM,
  isIdentityTransform,
  parseTransform,
  toColumnMajor4x4,
  transformPoint,
} from './transform'
export type { TransformSummary } from './transform'
export {
  analyzeIslands,
  bboxSize,
  computeBBox,
  DEFAULT_WELD_TOLERANCE_MM,
  measureMesh,
  selectTriangles,
  VertexWelder,
  weldTriangleSoup,
} from './mesh'
export type { IslandInfo, IslandSummary, MeshMeasures } from './mesh'
export { parseMeshes, parsePrintTags, parseStructure } from './threemf'
export type {
  AssembleItem,
  BuildItemInfo,
  ComponentInfo,
  MeshOptions,
  ObjectInfo,
  ObjectMesh,
  PartInfo,
  PlateInfo,
  PlateInstance,
  PrintTags,
  SliceFilament,
  SliceInfo,
  SlicePlate,
  ThreeMfMeshes,
  ThreeMfOptions,
  ThreeMfProducer,
  ThreeMfStructure,
} from './threemf'
export { isBinaryStl, parseStl } from './stl'
export type { StlGroup, StlMesh, StlOptions } from './stl'
export {
  canonicalTriangles,
  createSha256,
  geometryKeyG1,
  geometrySignature,
  sha256Hex,
  sha256OfSource,
} from './hash'
export type { GeometrySignature, HashFactory, IncrementalHash, SourceHashOptions } from './hash'
export { describeModel, isModelFileName } from './report'
export type {
  ArchiveReport,
  FailedReport,
  IslandFacts,
  MeshFacts,
  ModelReport,
  ObjectMeshFacts,
  ReportOptions,
  StlReport,
  ThreeMfReport,
  ZipEntryFacts,
  ZipFacts,
} from './report'
export { formatModelReport, formatTransform } from './reportText'
