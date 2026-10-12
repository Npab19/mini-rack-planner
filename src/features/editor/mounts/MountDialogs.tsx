/**
 * The editor's mount dialogs, rendered once per open plan (the editor page mounts this): the mount
 * chooser and "Needs a mount?". The rack, the tray and the inspector open them through
 * `useMountDialogs`. Leaving the editor (or opening another plan) closes whatever is open, so a
 * request never outlives the plan it was made for.
 */
import { useEffect } from 'react'
import { MountChooserDialog } from './MountChooserDialog'
import { useMountDialogs } from './mountDialogsStore'
import { NeedsAMountDialog } from './NeedsAMountDialog'

export function MountDialogs() {
  useEffect(() => () => useMountDialogs.getState().close(), [])
  return (
    <>
      <MountChooserDialog />
      <NeedsAMountDialog />
    </>
  )
}
