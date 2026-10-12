/**
 * Requests for the editor's mount dialogs (M3b), so the rack, the tray and the inspector can open
 * them without knowing where they are rendered:
 * - the mount chooser, after a device is dropped on empty rack space (or "Place" from the tray);
 * - "Needs a mount?", when no catalog mount takes a device.
 */
import { create } from 'zustand'
import type { EditorFace } from '@/state/uiStore'

export interface MountChooserRequest {
  deviceId: string
  face: EditorFace
  /** Where the device was dropped (sixths); the chooser offers mounts that fit there. */
  y: number
  /** The tray entry being placed, when it came from Equipment to fit. */
  equipmentId?: string
}

export interface NeedsAMountRequest {
  deviceId: string
  equipmentId?: string
}

interface MountDialogsState {
  chooser: MountChooserRequest | null
  needsAMount: NeedsAMountRequest | null
  openChooser: (request: MountChooserRequest) => void
  openNeedsAMount: (request: NeedsAMountRequest) => void
  close: () => void
}

export const useMountDialogs = create<MountDialogsState>((set) => ({
  chooser: null,
  needsAMount: null,
  openChooser: (request) => set({ chooser: request, needsAMount: null }),
  openNeedsAMount: (request) => set({ needsAMount: request, chooser: null }),
  close: () => set({ chooser: null, needsAMount: null }),
}))
