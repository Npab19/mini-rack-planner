/**
 * "Export everything", shared by the Backup section and the backup nudge: every plan, the custom
 * parts, the settings and what is on hand (the inventory) in one JSON file. Model files are never in it
 * (import-only); dropping the same files again after a restore relinks them by SHA-256.
 */
import { backupFileName, exportBackup } from '@/db/backup'
import { recordBackup } from '@/db/backupMetaRepo'
import { downloadJson, type DownloadOutcome } from '@/lib/download'
import { plural } from './format'

export interface ExportEverythingResult {
  outcome: DownloadOutcome
  fileName: string
  plans: number
  parts: number
}

/**
 * Exports and saves the backup, then remembers the date (unless the user closed the save dialog).
 * Call it directly from a click handler: the save dialog, where there is one, needs the click's
 * user activation.
 */
export async function exportEverything(): Promise<ExportEverythingResult> {
  const file = await exportBackup({ includeSettings: true })
  const fileName = backupFileName()
  const outcome = await downloadJson(fileName, file)
  if (outcome !== 'cancelled') {
    // The file is out either way; failing to note the date only brings the reminder back.
    await recordBackup(new Date(file.exportedAt)).catch(() => undefined)
  }
  return { outcome, fileName, plans: file.plans.length, parts: file.library.length }
}

/** One sentence for a toast or a status line. */
export function describeExport(result: ExportEverythingResult): string {
  if (result.outcome === 'cancelled') return 'Export cancelled. Nothing was saved.'
  const verb = result.outcome === 'saved' ? 'saved' : 'downloaded'
  const contents = `${plural(result.plans, 'plan')}, ${plural(result.parts, 'custom part')}, settings and parts on hand`
  return `Backup ${verb} as ${result.fileName} (${contents}).`
}
