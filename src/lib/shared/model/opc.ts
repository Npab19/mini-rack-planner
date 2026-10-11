/**
 * OPC (Open Packaging Conventions) part names and relationships, as used by 3MF packages:
 * resolving a relationship target or `p:path` to a ZIP entry, and reading `.rels` parts.
 */

import { parseXml, childElements } from './xml'
import type { ZipEntry } from './zip'

export type PartMatch = 'exact' | 'uri-decoded' | 'case-insensitive' | 'id-suffix'

export interface PartHit {
  entry: ZipEntry
  match: PartMatch
}

export interface Relationship {
  target: string
  type: string
}

export function dirOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/') + 1)
}

function decodePartName(name: string): string {
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

/** OPC part names are case-insensitive URIs; some tools also write backslashes. */
function foldPartName(name: string): string {
  return decodePartName(name).replace(/\\/g, '/').toLowerCase()
}

/**
 * Resolves a relationship target or p:path against `baseDir` (a folder ending in `/`, or '' for
 * the package root). Undefined when the path is empty or climbs out of the package.
 */
export function normalizePartName(target: string, baseDir = ''): string | undefined {
  const path = target.replace(/\\/g, '/')
  const joined = path.startsWith('/') ? path.slice(1) : baseDir + path
  const segments: string[] = []
  for (const segment of joined.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return undefined
      segments.pop()
    } else {
      segments.push(segment)
    }
  }
  return segments.length > 0 ? segments.join('/') : undefined
}

/**
 * Finds ZIP entries for part names: exact, then URI-decoded, then case-insensitive, then (for
 * OrcaSlicer's `3D/Objects/<name>_<id>.model`) the only entry in the same folder that ends in the
 * same `_<id>.model`.
 */
export class PartIndex {
  private readonly exact = new Map<string, ZipEntry>()
  private readonly folded = new Map<string, ZipEntry>()
  private readonly files: ZipEntry[]

  constructor(entries: readonly ZipEntry[]) {
    this.files = entries.filter((entry) => !entry.isDirectory)
    for (const entry of this.files) {
      if (!this.exact.has(entry.name)) this.exact.set(entry.name, entry)
      const key = foldPartName(entry.name)
      if (!this.folded.has(key)) this.folded.set(key, entry)
    }
  }

  resolve(target: string, baseDir = ''): PartHit | undefined {
    const name = normalizePartName(target, baseDir)
    if (name === undefined) return undefined
    const exact = this.exact.get(name)
    if (exact) return { entry: exact, match: 'exact' }
    const decoded = this.exact.get(decodePartName(name))
    if (decoded) return { entry: decoded, match: 'uri-decoded' }
    const folded = this.folded.get(foldPartName(name))
    if (folded) return { entry: folded, match: 'case-insensitive' }
    return this.resolveByIdSuffix(foldPartName(name))
  }

  /** Every `*.model` entry in the package. */
  modelEntries(): ZipEntry[] {
    return this.files.filter((entry) => /\.model$/i.test(entry.name))
  }

  private resolveByIdSuffix(folded: string): PartHit | undefined {
    const suffix = /_\d+\.model$/.exec(folded)?.[0]
    if (suffix === undefined) return undefined
    const dir = dirOf(folded)
    const candidates = this.files.filter((entry) => {
      const name = foldPartName(entry.name)
      return dirOf(name) === dir && name.endsWith(suffix)
    })
    const [only] = candidates
    return candidates.length === 1 && only ? { entry: only, match: 'id-suffix' } : undefined
  }
}

/** Relationships of a `.rels` part. */
export function parseRelationships(xml: string, maxDepth?: number): Relationship[] {
  const root = parseXml(xml, maxDepth)
  return childElements(root, 'Relationship').flatMap((element) => {
    const target = element.attrs.get('Target')
    return target === undefined ? [] : [{ target, type: element.attrs.get('Type') ?? '' }]
  })
}
