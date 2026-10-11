/**
 * Type-only contracts between domain modules and their callers. No implementations here.
 *
 * Catalog contract: callers pass the shared (base) catalog. Implementations resolve the plan's
 * own entries with `withCustomEntries(catalog, plan.custom)` (idempotent, so passing a lookup
 * that already includes them is fine). Unknown ids never throw: they become placeholder lines,
 * placeholder instances or issues.
 */
import type { CatalogLookup } from './schema/catalog'
import type { Plan } from './schema/plan'
import type { Inventory, Settings } from './schema/settings'

// ---------------------------------------------------------------------------------------------
// BOM (bom.ts)

export type BomLineKind = 'print' | 'hardware' | 'device'
export type BomUnit = 'pcs' | 'mm' | 'plates'

export interface BomProvenance {
  /**
   * Where the quantity comes from, numbered by stack position: "6U section #2", "Joint 3U #1 /
   * 6U #2", "Top", "Rack", "Lenovo Tiny mount @U4", "Retired 3U section", "Designer table".
   */
  label: string
  qty: number
  detail?: string
}

/**
 * One aggregated line. Formulas from the plan:
 * - hardware: install = max(0, target − reusable asBuilt);
 *   spare = install > 0 ? ⌈install × sparePct[category]⌉ : 0;
 *   need = max(0, install + spare − inventory); buy = need rounded up to pack sizes
 * - prints and devices: need = max(0, target − asBuilt − inventory)
 * - embedded hardware comes from prints-to-make × embeds and is never surplus
 * - surplus (owned but no longer used) is computed for reusable lines only
 */
export interface BomLine {
  /** Line key from ids.ts (printKey / hardwareKey / deviceKey); also the inventory key. */
  key: string
  kind: BomLineKind
  refId: string
  label: string
  unit: BomUnit
  category?: string
  /** Quantity the planned rack uses (rounded up once per line). */
  target: number
  /** Quantity already owned: Have snapshots, Have placements/devices/extras, retired entries. */
  asBuilt: number
  install: number
  spare: number
  need: number
  buy: number
  surplus: number
  reusable: boolean
  /** Ships with something else (e.g. a device's power brick): shown, never on the shopping list. */
  included?: boolean
  cutLengthMm?: number
  gramsEach?: number
  minutesEach?: number
  material?: string
  provenance: BomProvenance[]
  /** Plain-language sum, e.g. "36 = 144 in plan − 108 in your rack − 0 spares". */
  why: string
}

export interface BomTotals {
  printsGramsByMaterial: Record<string, number>
  printMinutes: number
  needGramsByMaterial: Record<string, number>
  needMinutes: number
  /** In settings.currency; absent when no price is known. */
  cost?: number
}

export interface BomResult {
  lines: BomLine[]
  totals: BomTotals
  warnings: string[]
}

export type ComputeBom = (
  plan: Plan,
  catalog: CatalogLookup,
  settings: Settings,
  inventory: Inventory,
) => BomResult

// ---------------------------------------------------------------------------------------------
// Checks (checks.ts)

export type IssueSeverity = 'error' | 'warning' | 'info'

export interface Issue {
  severity: IssueSeverity
  /** Stable machine code, e.g. "overlap", "depth-overhang", "unverified-holes". */
  code: string
  message: string
  /** Placement, section or device id the issue points at. */
  targetId?: string
}

export type RunChecks = (plan: Plan, catalog: CatalogLookup, settings: Settings) => Issue[]

// ---------------------------------------------------------------------------------------------
// Power (power.ts)

export interface PowerSummary {
  acOutletsNeeded: number
  acOutletsAvailable: number
  poePortsNeeded: number
  poePortsAvailable: number
  poeBudgetW: number
  poeDemandW: number
  usbcPortsNeeded: number
  usbcPortsAvailable: number
  totalTypW: number
  totalMaxW: number
  /** Power bricks the plan implies (derived "included" accessories). */
  bricks: Array<{ deviceId: string; placementId?: string }>
}

// ---------------------------------------------------------------------------------------------
// 3D assembly (assembly.ts)

export type PartState = 'have' | 'need'

export interface PartInstance {
  /** Unique per instance (stable across recomputes for the same plan). */
  key: string
  /** `<entry id>/<part id>` (partKey in ids.ts): which mesh or proxy to draw. */
  partKey: string
  /** 4×4 transform in mm, column-major like three.js Matrix4.elements (16 numbers). */
  matrix: number[]
  state: PartState
  /** Proxy box size in mm, used until a real mesh is linked. */
  proxyDims: { w: number; h: number; d: number }
  label: string
  /** Section, cap ('top' | 'bottom'), joint or placement id this instance belongs to. */
  sourceId: string
}

export type Assemble = (plan: Plan, catalog: CatalogLookup) => PartInstance[]

// ---------------------------------------------------------------------------------------------
// Share links (share.ts)

/** template: everything reset to Need, inventory/prices/notes stripped. showoff: keeps Have. */
export type ShareMode = 'template' | 'showoff'

// ---------------------------------------------------------------------------------------------
// Stack operations (frame.ts)

export type StackConflictKind =
  'straddle' | 'section-not-empty' | 'unreachable-height' | 'have-locked' | 'out-of-bounds'

export interface StackConflict {
  kind: StackConflictKind
  message: string
  placementIds?: string[]
  sectionIds?: string[]
}

/** Every stack operation is a pure (plan) -> result; one commit is one undo step. */
export interface StackOpResult {
  plan: Plan
  conflicts: StackConflict[]
  /** Set when the operation could not run at all (plan is then unchanged). */
  error?: string
}
