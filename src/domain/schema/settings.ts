import { z } from 'zod'
import { IdSchema, MmSchema } from './common'

export const PackPriceSchema = z.object({
  size: z.number().int().positive(),
  price: z.number().nonnegative(),
})
export type PackPrice = z.infer<typeof PackPriceSchema>

/** Global (not per plan) preferences. */
export const SettingsSchema = z.object({
  /** ISO 4217 code. */
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default('USD'),
  /** Filament price per kg, keyed by material ("PLA", "PETG", ...). */
  filamentCostPerKg: z
    .record(z.string().min(1), z.number().nonnegative())
    .default(() => ({ PLA: 20, PETG: 22 })),
  /**
   * Spare fraction added to hardware you still have to install (0.1 = 10 %), keyed by hardware
   * category, with `default` for the rest. See `sparePctFor`.
   */
  sparePct: z
    .record(z.string().min(1), z.number().min(0).max(1))
    .default(() => ({ screw: 0.1, nut: 0.1, insert: 0.1, magnet: 0.05, default: 0 })),
  /** Known pack sizes and prices, keyed by hardware id. */
  packPrices: z.record(IdSchema, z.array(PackPriceSchema)).default(() => ({})),
  printerBedMm: z.object({ x: MmSchema, y: MmSchema, z: MmSchema }).optional(),
})
export type Settings = z.infer<typeof SettingsSchema>

/** Loose spares that are not installed, keyed by BOM line key (see `ids.ts`). */
export const InventorySchema = z.record(z.string().min(1), z.number().nonnegative())
export type Inventory = z.infer<typeof InventorySchema>

export function defaultSettings(): Settings {
  return SettingsSchema.parse({})
}

export function sparePctFor(settings: Settings, category: string): number {
  return settings.sparePct[category] ?? settings.sparePct.default ?? 0
}
