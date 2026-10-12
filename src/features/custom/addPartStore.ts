/**
 * Requests for the "Add a part" wizard and the custom part editors (M3b), so the palette, the
 * library page and "Needs a mount?" can open them without knowing where they are rendered.
 * `AddPartHost` (safe to render from the app shell) shows the dialog for the current request.
 */
import { create } from 'zustand'
import type { CustomDeviceInput, CustomFrameInput, CustomItemInput } from '@/domain/customParts'
import type { CatalogEntry } from '@/domain/schema/catalog'

export type AddPartRequest =
  | { kind: 'device'; prefill?: Partial<CustomDeviceInput>; editId?: string }
  | { kind: 'item'; prefill?: Partial<CustomItemInput>; editId?: string }
  | { kind: 'frame'; prefill?: Partial<CustomFrameInput>; editId?: string }
  /** Start from a link or a file (MakerWorld or anywhere); the wizard asks what it is. */
  | { kind: 'wizard'; url?: string }

/** Where the saved part goes: the user's library (default) and, from the editor, the open plan. */
export interface AddPartTarget {
  addToOpenPlan?: boolean
  /** After saving from the editor palette, start placing the new item. */
  placeAfterSave?: boolean
  /**
   * With `placeAfterSave`, for a new mount: the Equipment to fit entry it was made for ("Needs a
   * mount?"). Placing the mount then puts that device in it, in the same step.
   */
  placeEquipmentId?: string
  /** Called with the stored entry after a successful save (e.g. to put a device in a new mount). */
  onSaved?: (entry: CatalogEntry) => void
}

interface AddPartState {
  request: (AddPartRequest & AddPartTarget) | null
  open: (request: AddPartRequest & AddPartTarget) => void
  close: () => void
}

export const useAddPart = create<AddPartState>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}))
