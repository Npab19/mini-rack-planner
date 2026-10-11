/**
 * The backup metadata (last backup, nudge put off) as React state: a live query over its row, so
 * an export or a "Later" in any tab updates every tab.
 */
import { useLiveQuery } from 'dexie-react-hooks'
import { getBackupMeta, type BackupMeta } from '@/db/backupMetaRepo'

export interface BackupMetaView {
  meta: BackupMeta
  /** False until the stored metadata has been read once. */
  loaded: boolean
}

const LOADING: BackupMetaView = { meta: {}, loaded: false }

async function readBackupMeta(): Promise<BackupMetaView> {
  try {
    return { meta: await getBackupMeta(), loaded: true }
  } catch {
    // Storage unavailable (private mode, blocked): as if no backup was ever made.
    return { meta: {}, loaded: true }
  }
}

export function useBackupMeta(): BackupMetaView {
  return useLiveQuery(readBackupMeta, [], LOADING)
}
