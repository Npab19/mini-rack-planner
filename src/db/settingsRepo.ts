/**
 * Global settings (currency, filament prices, spare percentages, pack prices, printer bed), stored
 * as one document under the key "settings". Reads never fail on bad data: invalid fields fall back
 * to their defaults one by one, so one broken value does not reset everything.
 */
import { SettingsSchema, type Settings } from '@/domain/schema/settings'
import { withRetry } from './retry'

export const SETTINGS_KEY = 'settings'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Stored settings with defaults filled in; invalid fields are replaced by their defaults. */
export function parseSettings(value: unknown): Settings {
  const whole = SettingsSchema.safeParse(value ?? {})
  if (whole.success) return whole.data
  const source = isRecord(value) ? value : {}
  const kept: Record<string, unknown> = {}
  for (const [key, schema] of Object.entries(SettingsSchema.shape)) {
    const field = schema.safeParse(source[key])
    if (field.success && field.data !== undefined) kept[key] = field.data
  }
  return SettingsSchema.parse(kept)
}

export async function getSettings(): Promise<Settings> {
  const row = await withRetry((db) => db.settings.get(SETTINGS_KEY))
  return parseSettings(row?.value)
}

/**
 * Top-level fields to change, or a function of the stored settings that returns them. A record
 * such as `sparePct` is replaced as a whole, so edits of one entry in it should use the function
 * form: it reads the latest stored record inside the write's transaction, so two quick edits (or
 * two tabs) never undo each other.
 */
export type SettingsPatch = Partial<Settings> | ((current: Settings) => Partial<Settings>)

/**
 * Merges `patch` over the stored settings in one read-write transaction and returns the result.
 * A function patch must be pure: a retried transaction runs it again.
 * @throws ZodError when the merged settings are invalid (nothing is written)
 */
export async function updateSettings(patch: SettingsPatch): Promise<Settings> {
  return withRetry((db) =>
    db.transaction('rw', db.settings, async () => {
      const row = await db.settings.get(SETTINGS_KEY)
      const current = parseSettings(row?.value)
      const changes = typeof patch === 'function' ? patch(current) : patch
      const next = SettingsSchema.parse({ ...current, ...changes })
      await db.settings.put({ key: SETTINGS_KEY, value: next })
      return next
    }),
  )
}

/** Replaces the stored settings (backup import). */
export async function replaceSettings(settings: Settings): Promise<Settings> {
  const next = SettingsSchema.parse(settings)
  await withRetry((db) => db.settings.put({ key: SETTINGS_KEY, value: next }))
  return next
}
