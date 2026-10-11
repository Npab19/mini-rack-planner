/**
 * Catalog revision: a short, stable hash of every entry as written in its file. Plans record it
 * (`catalogRev`), diagnostics show it, and `npm run bom` prints the same value for the same files.
 *
 * Synchronous and dependency-free on purpose: `crypto.subtle` is missing on plain-HTTP LAN origins.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compareStrings(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** JSON with object keys sorted, so the key order in a file never changes the revision. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) {
    const fields = Object.keys(value)
      .toSorted(compareStrings)
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    return `{${fields.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** cyrb53 (public domain, by bryc): a fast 53-bit string hash. Not cryptographic. */
export function hash53(text: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

export interface RevisionInput {
  id: string
  /** The entry as written in its file (before schema defaults). */
  raw: unknown
}

/** 14 hex digits over the ids and canonical JSON of all entries; independent of input order. */
export function catalogRevision(entries: readonly RevisionInput[]): string {
  const text = entries
    .toSorted((a, b) => compareStrings(a.id, b.id))
    .map((entry) => `${entry.id}\n${canonicalJson(entry.raw)}\n`)
    .join('')
  return hash53(text).toString(16).padStart(14, '0')
}
