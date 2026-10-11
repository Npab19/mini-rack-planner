/**
 * The IndexedDB database (Dexie 4). Every table the app will ever need is declared in version 1 so
 * later milestones add data, not schema upgrades (an upgrade forces every open tab to reload).
 *
 * Only indexed fields are listed in the schema; binary data (model bytes, mesh buffers) is never
 * indexed. Rows store documents as plain JSON next to their indexed copies.
 */
import Dexie, { type EntityTable } from 'dexie'
import type { PlanDocument } from '@/domain/migrate'
import type { CatalogEntry, CatalogKind } from '@/domain/schema/catalog'
import type { DiagnosticEntry } from '@/lib/diagnostics'
import { emitDbEvent } from './events'

export const DB_NAME = 'mrp'

/** A saved plan: the plan JSON plus copies of the fields the Plans page sorts and groups by. */
export interface PlanRow {
  id: string
  rackId: string
  name: string
  /** UTC ISO date-time (normalized so the index sorts chronologically). */
  updatedAt: string
  /** Compare-and-swap revision; authoritative over `plan.rev`. */
  rev: number
  /** Schema version of `plan`. Higher than this app supports: read-only, never overwritten. */
  schema: number
  /** The plan document as JSON. Always read through `migratePlan`. */
  plan: PlanDocument
}

/** A custom catalog entry of the user's library (`custom:` id). */
export interface LibraryRow {
  id: string
  kind: CatalogKind
  updatedAt: string
  entry: CatalogEntry
}

/** Loose spares, keyed by BOM line key (`print:…`, `hw:…`, `device:…`). */
export interface InventoryRow {
  key: string
  qty: number
}

/** Small key/value documents: the global settings (key "settings") and app metadata. */
export interface SettingsRow {
  key: string
  value: unknown
}

/** One entry of the diagnostics ring buffer ("Copy diagnostics"; see diagnosticsRepo.ts). */
export interface DiagnosticRow {
  seq: number
  /** Copy of `entry.at`, indexed. */
  at: string
  /** As recorded by `src/lib/diagnostics` (redacted there); re-validated when loaded. */
  entry: DiagnosticEntry
}

/**
 * Metadata of a model file the user dropped (M7). Files are import-only: they never leave the
 * browser and backups only carry their fingerprints.
 */
export interface ModelFileRow {
  sha256: string
  name: string
  sizeBytes: number
  mediaType?: string
  addedAt: string
  lastUsedAt: string
  /** Parser report and other facts about the file (no geometry). */
  meta?: Record<string, unknown>
}

/** The bytes of a model file, kept apart from its metadata so listings never load blobs. */
export interface ModelBytesRow {
  sha256: string
  blob: Blob
}

/** Parsed mesh buffers, evicted least-recently-used (~150 MB budget). */
export interface MeshCacheRow {
  key: string
  sha256: string
  lastUsedAt: string
  byteLength: number
  data: ArrayBuffer
}

/** Which model file (and alignment) renders a catalog part (`<entry id>/<part id>`). */
export interface PartModelRow {
  partKey: string
  sha256: string
  updatedAt: string
  /** Alignment record (domain `AlignRecord`), validated when read. */
  align?: unknown
}

/** Version 1 schema: primary key first, then indexes. */
export const SCHEMA_V1 = {
  plans: '&id, updatedAt, rackId, name',
  library: '&id, kind, updatedAt',
  inventory: '&key',
  settings: '&key',
  diagnostics: '++seq, at',
  modelFiles: '&sha256, addedAt, lastUsedAt',
  modelBytes: '&sha256',
  meshCache: '&key, sha256, lastUsedAt',
  partModels: '&partKey, sha256',
} as const

/** How long pending saves may run before this tab lets another tab's upgrade proceed. */
const DRAIN_TIMEOUT_MS = 1500

export class MrpDb extends Dexie {
  declare plans: EntityTable<PlanRow, 'id'>
  declare library: EntityTable<LibraryRow, 'id'>
  declare inventory: EntityTable<InventoryRow, 'key'>
  declare settings: EntityTable<SettingsRow, 'key'>
  declare diagnostics: EntityTable<DiagnosticRow, 'seq'>
  declare modelFiles: EntityTable<ModelFileRow, 'sha256'>
  declare modelBytes: EntityTable<ModelBytesRow, 'sha256'>
  declare meshCache: EntityTable<MeshCacheRow, 'key'>
  declare partModels: EntityTable<PartModelRow, 'partKey'>

  constructor(name: string = DB_NAME) {
    super(name)
    this.version(1).stores(SCHEMA_V1)
    // Runs before Dexie's default handler; returning false stops it from closing right away,
    // so pending saves can still land before the other tab's upgrade continues.
    this.on('versionchange', (event) => {
      superseded = true
      emitDbEvent({ type: 'version-change', newVersion: event.newVersion })
      void drainThenClose(this)
      return false
    })
    this.on('blocked', () => emitDbEvent({ type: 'blocked' }))
    this.on('ready', () => emitDbEvent({ type: 'opened' }), true)
  }
}

let instance: MrpDb | undefined
/** Set once another tab upgrades or deletes the database: this tab must not reopen it. */
let superseded = false
const drains = new Set<() => unknown>()

/** The app's database, created lazily (Dexie opens it on first use). */
export function getDb(): MrpDb {
  instance ??= new MrpDb()
  return instance
}

/** True after a `versionchange`: the connection is (being) closed for good until a reload. */
export function isDbSuperseded(): boolean {
  return superseded
}

/** Closes and reopens the connection (Safari drops IndexedDB connections in the background). */
export async function reopenDb(): Promise<void> {
  const db = getDb()
  db.close({ disableAutoOpen: false })
  await db.open()
}

/**
 * Work that must finish before this tab gives up its connection to another tab's upgrade, such
 * as a pending autosave. Returns an unregister function.
 */
export function registerDbDrain(drain: () => unknown): () => void {
  drains.add(drain)
  return () => {
    drains.delete(drain)
  }
}

async function drainThenClose(db: MrpDb): Promise<void> {
  const pending = [...drains].map(async (drain) => drain())
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, DRAIN_TIMEOUT_MS)
  })
  await Promise.race([Promise.allSettled(pending), timeout])
  clearTimeout(timer)
  // disableAutoOpen: a later call must fail instead of silently reopening the upgraded database
  // with this (older) code.
  db.close({ disableAutoOpen: true })
}

/** Closes the connection, deletes the database and forgets the instance (tests only). */
export async function resetDbForTests(): Promise<void> {
  const db = instance
  instance = undefined
  superseded = false
  if (db !== undefined) db.close()
  await Dexie.delete(DB_NAME)
}
