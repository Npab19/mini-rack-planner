/**
 * Shows the "Add a part" dialog for `useAddPart` requests. Safe to render from the app shell: it
 * builds no zod schema at load and loads the dialog (catalog schemas, forms) on the first request.
 * Several hosts (or dialogs) may be mounted at once: only the first one shows (dialogSlot.ts).
 */
import { lazy, Suspense, useState } from 'react'
import { ErrorBoundary } from '@/components/common/ErrorBoundary'
import { useAddPart } from './addPartStore'
import { resetDialogSlotsForTests } from './dialogSlot'

const AddPartDialog = lazy(async () => ({
  default: (await import('./AddPartDialog')).AddPartDialog,
}))

export function AddPartHost() {
  const request = useAddPart((state) => state.request)
  // Loaded on the first request, then kept, so the dialog can animate closed.
  const [loaded, setLoaded] = useState(false)
  if (request !== null && !loaded) setLoaded(true)
  if (!loaded) return null
  return (
    // A dialog that crashed (recorded in diagnostics) tries again with the next request.
    <ErrorBoundary name="add-part" fallback={null} resetKeys={[request]}>
      <Suspense fallback={null}>
        <AddPartDialog />
      </Suspense>
    </ErrorBoundary>
  )
}

/** For tests: forget the mounted dialogs. */
export function resetAddPartHostsForTests(): void {
  resetDialogSlotsForTests()
}
