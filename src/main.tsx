// Must stay the first import: configures zod (jitless) before any schema is built.
import './lib/shared/zod-setup'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import {
  installUpdatePrompt,
  isStaleChunkError,
  notifyNewVersion,
  registerBeforeReload,
} from './app/updatePrompt'
import { registerDbDrain } from './db/db'
import { createDiagnosticsSink, MAX_DIAGNOSTICS } from './db/diagnosticsRepo'
import * as diagnostics from './lib/diagnostics'
// For its side effect: the status banners' store hears database events from the first open on.
import './state/dbStatus'
import './index.css'

// Before the first render: the first lazy route can already fail (an error, a CSP violation, or a
// chunk gone after a deploy).
diagnostics.install({ window })
installUpdatePrompt()
// Keep diagnostics across reloads, so a report made after one still lists what led to it. Best
// effort: without IndexedDB (blocked site data) they stay in memory for this page load.
diagnostics.setSink(createDiagnosticsSink(MAX_DIAGNOSTICS)).catch(() => undefined)

// The open plan is saved before the update prompt reloads, before another tab's database upgrade
// and whenever the page is hidden (with a recovery copy for an immediate reload). Imported
// dynamically on purpose: the plan store builds zod schemas, and every module the entry imports
// statically runs before this file's body, so before the jitless setup above (zod would then
// probe `new Function` and the CSP would report it). Nothing here may build schemas at load.
import('./state/planStore')
  .then(({ installPlanPersistence }) => {
    installPlanPersistence({ registerBeforeReload, registerDbDrain })
  })
  .catch((error: unknown) => {
    // A deploy between loading the page and this chunk: only a reload helps.
    if (isStaleChunkError(error)) notifyNewVersion({ source: 'plan-persistence', error })
    else diagnostics.recordError(error, { source: 'plan-persistence' })
  })

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
