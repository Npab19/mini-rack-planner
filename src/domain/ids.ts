/**
 * Id generation and BOM line keys.
 *
 * Ids use crypto.getRandomValues only: crypto.randomUUID needs a secure context, and the app must
 * work on plain-HTTP LAN origins.
 */

// Crockford base32 (lowercase): 32 symbols, so `byte & 31` maps bytes without bias.
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'
const TOKEN_LENGTH = 12

/** Kebab-case (a-z, 0-9, single hyphens between groups); also used by the id schemas. */
export const KEBAB_PATTERN = '[a-z0-9]+(?:-[a-z0-9]+)*'
const KEBAB = new RegExp(`^${KEBAB_PATTERN}$`)

/** Prefixes of generated plan entity ids. Ids are opaque; one prefix per entity keeps them readable. */
export const ID_PREFIX = {
  plan: 'plan',
  rack: 'rack',
  section: 'sec',
  placement: 'pl',
  placedDevice: 'dv',
  equipment: 'eq',
  extra: 'ex',
  retired: 'rt',
} as const

export function randomToken(length = TOKEN_LENGTH): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  let token = ''
  for (const byte of bytes) token += ALPHABET.charAt(byte & 31)
  return token
}

/** New kebab-case id, e.g. `newId('sec')` -> "sec-4k2m9x0c7b1d". */
export function newId(prefix?: string): string {
  if (prefix === undefined) return randomToken()
  if (!KEBAB.test(prefix)) throw new Error(`Id prefix must be kebab-case: "${prefix}"`)
  return `${prefix}-${randomToken()}`
}

// ---------------------------------------------------------------------------------------------
// Line keys: stable keys for BOM lines and inventory (persisted, so the format must not change).

const PRINT_PREFIX = 'print:'
const HARDWARE_PREFIX = 'hw:'
const DEVICE_PREFIX = 'device:'

/** Cut lengths are keyed at 0.01 mm so float noise (133.35000000000002) never splits a line. */
export function roundCutLengthMm(mm: number): number {
  return Math.round(mm * 100) / 100
}

/** Printed part: the same print of the same frame/item aggregates across sections and placements. */
export function printKey(ownerId: string, printId: string): string {
  return `${PRINT_PREFIX}${ownerId}/${printId}`
}

/** Hardware line; cut-to-length stock is keyed per cut length. */
export function hardwareKey(hardwareId: string, cutLengthMm?: number): string {
  if (cutLengthMm === undefined) return `${HARDWARE_PREFIX}${hardwareId}`
  return `${HARDWARE_PREFIX}${hardwareId}@${roundCutLengthMm(cutLengthMm)}`
}

export function deviceKey(deviceId: string): string {
  return `${DEVICE_PREFIX}${deviceId}`
}

/** Global key of a 3D part: `<entry id>/<part id>`. */
export function partKey(ownerId: string, partId: string): string {
  return `${ownerId}/${partId}`
}

export type ParsedLineKey =
  | { kind: 'print'; ownerId: string; printId: string }
  | { kind: 'hardware'; hardwareId: string; cutLengthMm?: number }
  | { kind: 'device'; deviceId: string }

export function parseLineKey(key: string): ParsedLineKey | undefined {
  if (key.startsWith(PRINT_PREFIX)) {
    const rest = key.slice(PRINT_PREFIX.length)
    const slash = rest.lastIndexOf('/')
    if (slash <= 0 || slash === rest.length - 1) return undefined
    return { kind: 'print', ownerId: rest.slice(0, slash), printId: rest.slice(slash + 1) }
  }
  if (key.startsWith(HARDWARE_PREFIX)) {
    const [hardwareId, cut, ...extra] = key.slice(HARDWARE_PREFIX.length).split('@')
    if (!hardwareId || extra.length > 0) return undefined
    if (cut === undefined) return { kind: 'hardware', hardwareId }
    const cutLengthMm = Number(cut)
    if (cut === '' || !Number.isFinite(cutLengthMm)) return undefined
    return { kind: 'hardware', hardwareId, cutLengthMm }
  }
  if (key.startsWith(DEVICE_PREFIX)) {
    const deviceId = key.slice(DEVICE_PREFIX.length)
    return deviceId ? { kind: 'device', deviceId } : undefined
  }
  return undefined
}
