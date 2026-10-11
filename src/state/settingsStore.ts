/**
 * Global settings as React state: a live query over the settings table (updates when any tab
 * writes), parsed defaults while loading or when storage is unavailable. Setters write through the
 * repository; the live query brings the change back.
 */
import { useLiveQuery } from 'dexie-react-hooks'
import { errorMessage, StorageFullError } from '@/db/errors'
import { getSettings, updateSettings, type SettingsPatch } from '@/db/settingsRepo'
import { defaultSettings, type Settings } from '@/domain/schema/settings'
import { reportDbStatus } from './dbStatus'

/** Stable while loading, so memoized consumers do not recompute. */
const DEFAULT_SETTINGS: Settings = defaultSettings()

export interface SettingsView {
  settings: Settings
  /** False until the stored settings have been read once. */
  loaded: boolean
}

async function readSettings(): Promise<SettingsView> {
  try {
    return { settings: await getSettings(), loaded: true }
  } catch {
    // Storage unavailable (private mode, blocked): defaults keep the app usable.
    return { settings: DEFAULT_SETTINGS, loaded: true }
  }
}

const LOADING: SettingsView = { settings: DEFAULT_SETTINGS, loaded: false }

export function useSettingsView(): SettingsView {
  return useLiveQuery(readSettings, [], LOADING)
}

/** The settings (defaults until loaded). */
export function useSettings(): Settings {
  return useSettingsView().settings
}

/**
 * Merges top-level fields into the stored settings, or the fields a function of the stored
 * settings returns (use that to change one entry of a record such as `sparePct`). Failures are
 * reported and rethrown.
 */
export async function saveSettings(patch: SettingsPatch): Promise<Settings> {
  try {
    return await updateSettings(patch)
  } catch (error) {
    if (!(error instanceof StorageFullError)) {
      reportDbStatus({ type: 'write-error', message: errorMessage(error) })
    }
    throw error
  }
}
